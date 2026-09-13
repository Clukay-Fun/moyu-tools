import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runFormatProcess } from '../lib/spawnProcess.js'
import { loadTesseract } from '../lib/lazyModules.js'
import { sanitizeFileBaseName } from '../lib/outputPath.js'

// 区域截图（含 macOS ScreenCaptureKit 原生抓屏、覆盖层窗口、钉图、OCR）
// + 全局截图快捷键。快捷键放在同一个模块里，是因为触发函数需要直接读
// screenshotSessions（"已经有一个覆盖层时连按要忽略"），拆开反而要为这一个
// 判断单独导出一个只读接口，不如放在一起自然。

const screenshotSessions = new Map()
let reusableScreenshotOverlay = null
let screenshotOverlayReadyPromise = null
const pinnedScreenshotSessions = new Map()

/** 亮度低于此值的画面视为黑帧。留一点余量以容忍深色壁纸的极端情况。 */
const BLANK_CAPTURE_THRESHOLD = 8
/** 黑帧重试前给屏幕采集器一帧恢复时间；不改变任何应用窗口状态。 */
const CAPTURE_RETRY_DELAY_MS = 140

function isBlankCapture(image) {
  if (!image || image.isEmpty()) return true
  const size = image.getSize()
  if (!size.width || !size.height) return true
  // 缩到很小再逐像素看，避免对全屏位图做全量扫描
  const small = image.resize({ width: 24, height: 16, quality: 'good' })
  const buf = small.toBitmap()
  if (!buf || !buf.length) return true
  let max = 0
  for (let i = 0; i < buf.length; i += 4) {
    max = Math.max(max, buf[i], buf[i + 1], buf[i + 2])
    if (max > BLANK_CAPTURE_THRESHOLD) return false
  }
  return true
}

let screenCaptureKitBinaryPromise = null

export async function ensureScreenCaptureKitBinary({ app, __dirname }) {
  if (screenCaptureKitBinaryPromise) return screenCaptureKitBinaryPromise
  screenCaptureKitBinaryPromise = (async () => {
    const sourceCandidates = [
      join(process.resourcesPath, 'native', 'macos', 'screen-capture.swift'),
      join(app.getAppPath(), 'native', 'macos', 'screen-capture.swift'),
      join(__dirname, '..', '..', 'native', 'macos', 'screen-capture.swift')
    ]
    const source = sourceCandidates.find((candidate) => existsSync(candidate))
    if (!source) throw new Error('缺少 macOS ScreenCaptureKit 侧车源码')
    const directory = join(app.getPath('temp'), 'moyu-tools-native')
    const binary = join(directory, 'screen-capture')
    await mkdir(directory, { recursive: true })
    const sourceStat = await stat(source)
    const binaryStat = await stat(binary).catch(() => null)
    if (!binaryStat || binaryStat.mtimeMs < sourceStat.mtimeMs) {
      await runFormatProcess('xcrun', [
        'swiftc', '-parse-as-library', '-O', source,
        '-o', binary,
        '-framework', 'AppKit',
        '-framework', 'CoreGraphics',
        '-framework', 'ScreenCaptureKit'
      ], { timeoutMs: 120000 })
    }
    return binary
  })().catch((error) => {
    screenCaptureKitBinaryPromise = null
    throw error
  })
  return screenCaptureKitBinaryPromise
}

/** macOS 原生抓屏：保留屏幕上的全部应用，包括工具箱自身。 */
async function captureDisplayScreenCaptureKit({ app, __dirname, nativeImage }, display, physicalWidth, physicalHeight) {
  const binary = await ensureScreenCaptureKitBinary({ app, __dirname })
  const directory = join(app.getPath('temp'), 'moyu-tools-native')
  const output = join(directory, `capture-${randomUUID()}.png`)
  try {
    await runFormatProcess(binary, [
      output,
      String(display.id),
      String(physicalWidth),
      String(physicalHeight)
    ], {
      timeoutMs: 30000
    })
    const data = await readFile(output)
    const thumbnail = nativeImage.createFromBuffer(data)
    if (thumbnail.isEmpty()) throw new Error('ScreenCaptureKit 返回了无效图像')
    // data 已经是 Swift 侧车编码好的 PNG；把它原样交给 renderer，避免主进程
    // 再做一次 nativeImage.toPNG()（Retina 全屏图会因此多耗约半秒）。
    return { thumbnail, data, backend: 'ScreenCaptureKit' }
  } finally {
    await unlink(output).catch(() => {})
  }
}

/**
 * 创建截图覆盖窗口。
 *
 * 继续使用工具箱已验证的 BrowserWindow 组合；electron-screenshots 的
 * panel/toolbar + kiosk 参数在 Electron 43/macOS 上会阻断覆盖层显示，不能照搬。
 */
function createScreenshotOverlay({ BrowserWindow, __dirname }, display) {
  const overlay = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    // macOS Stage Manager 会把普通窗口强制钳进可用工作区（左侧舞台栏 + 顶部菜单栏），
    // 导致截图覆盖层只盖住屏幕的一部分，看起来像叠了两张画面。
    enableLargerThanScreen: process.platform === 'darwin',
    resizable: false,
    movable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 截图壳常驻隐藏时 Chromium 默认暂停 rAF；关闭节流后才能在显示前
      // 完成位图解码与两帧绘制，避免"数据已到但窗口迟迟不出现"。
      backgroundThrottling: false
    }
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  overlay.setBounds(display.bounds, false)
  return overlay
}

function hideScreenshotOverlay(overlay) {
  if (!overlay || overlay.isDestroyed()) return
  overlay.hide()
}

/**
 * 截图窗口只创建和加载一次，后续截图仅替换会话数据并重新显示。
 * 这是参考 electron-screenshots singleWindow 思路的本项目实现，不引入其 React UI。
 */
export async function ensureScreenshotOverlay({ BrowserWindow, __dirname }, display) {
  if (reusableScreenshotOverlay && !reusableScreenshotOverlay.isDestroyed()) {
    reusableScreenshotOverlay.setBounds(display.bounds, false)
    return reusableScreenshotOverlay
  }
  if (screenshotOverlayReadyPromise) return screenshotOverlayReadyPromise

  screenshotOverlayReadyPromise = (async () => {
    const overlay = createScreenshotOverlay({ BrowserWindow, __dirname }, display)
    reusableScreenshotOverlay = overlay
    overlay.on('closed', () => {
      if (reusableScreenshotOverlay === overlay) reusableScreenshotOverlay = null
      screenshotOverlayReadyPromise = null
      for (const [sessionId, session] of screenshotSessions) {
        if (session.overlay !== overlay) continue
        screenshotSessions.delete(sessionId)
        session.owner.send('screenshot:cancelled')
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      await overlay.loadURL(new URL('screenshot.html', process.env.ELECTRON_RENDERER_URL).toString())
    } else {
      await overlay.loadFile(join(__dirname, '../renderer/screenshot.html'))
    }
    return overlay
  })().catch((error) => {
    reusableScreenshotOverlay = null
    screenshotOverlayReadyPromise = null
    throw error
  })
  return screenshotOverlayReadyPromise
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1')
    .trim()
}

async function copyFileIfChanged(source, destination) {
  const [sourceInfo, destinationInfo] = await Promise.all([
    stat(source),
    stat(destination).catch(() => null)
  ])
  if (!destinationInfo || destinationInfo.size !== sourceInfo.size) {
    await copyFile(source, destination)
  }
}

const OCR_MODELS_CACHE = { value: null }
function getOcrModels(require) {
  if (OCR_MODELS_CACHE.value) return OCR_MODELS_CACHE.value
  const { dirname } = require('node:path')
  OCR_MODELS_CACHE.value = [
    {
      code: 'eng',
      source: join(
        dirname(require.resolve('@tesseract.js-data/eng/package.json')),
        '4.0.0',
        'eng.traineddata.gz'
      )
    },
    {
      code: 'chi_sim',
      source: join(
        dirname(require.resolve('@tesseract.js-data/chi_sim/package.json')),
        '4.0.0',
        'chi_sim.traineddata.gz'
      )
    }
  ]
  return OCR_MODELS_CACHE.value
}

let ocrWorkerPromise = null
let ocrProgressTarget = null
let ocrBusy = false

async function ensureOcrWorker({ app, require }) {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const languageDirectory = join(app.getPath('userData'), 'ocr-data')
      await mkdir(languageDirectory, { recursive: true })
      const models = getOcrModels(require)
      await Promise.all(
        models.map((model) =>
          copyFileIfChanged(model.source, join(languageDirectory, `${model.code}.traineddata.gz`))
        )
      )
      const { createWorker, OEM } = await loadTesseract()
      return createWorker(
        models.map((model) => model.code),
        OEM.LSTM_ONLY,
        {
          langPath: languageDirectory,
          gzip: true,
          cacheMethod: 'none',
          logger: (message) => {
            if (ocrProgressTarget && !ocrProgressTarget.isDestroyed()) {
              ocrProgressTarget.send('screenshot:ocr-progress', {
                status: message.status,
                progress: Number.isFinite(message.progress) ? message.progress : 0
              })
            }
          }
        }
      )
    })().catch((error) => {
      ocrWorkerPromise = null
      throw error
    })
  }
  return ocrWorkerPromise
}

/** 应用退出前终止 OCR worker，供 index.js 的 before-quit 调用。 */
export function terminateOcrWorker() {
  return ocrWorkerPromise?.then((worker) => worker.terminate()).catch(() => {})
}

// ── 全局截图快捷键（规格 6 / F-16）──────────────────────────
//
// 只在应用运行期间有效，退出时注销——全局快捷键是进程级资源，
// 不注销会一直占着，直到下次开机。
//
// F-16：默认 Ctrl+Shift+A 与飞书冲突。这类冲突**不是两边都能同时解决的**，
// 所以不去抢占，改为让用户自己改或关掉。设置存在 userData 下，
// 与工程文件分开。
const DEFAULT_CAPTURE_SHORTCUT = 'Control+Shift+A'

/** 当前生效的加速键；null 表示用户主动关闭了全局快捷键。 */
let captureShortcut = DEFAULT_CAPTURE_SHORTCUT
/** 当前已注册成功的加速键，用于精确注销。null 表示当前没有注册任何键。 */
let registeredShortcut = null
/** 注册失败的提示；渲染端就绪前先攒着，就绪后再送一次。 */
let pendingShortcutNotice = null

function shortcutSettingsFile(app) {
  return join(app.getPath('userData'), 'shortcuts.json')
}

function readShortcutSettings(app) {
  try {
    const raw = readFileSync(shortcutSettingsFile(app), 'utf8')
    const parsed = JSON.parse(raw)
    // 显式的 null 表示"用户关掉了"，与"没配过"不同，不能被默认值覆盖
    if (Object.prototype.hasOwnProperty.call(parsed, 'capture')) {
      return parsed.capture === null ? null : String(parsed.capture)
    }
  } catch { /* 文件不存在或损坏都按默认处理 */ }
  return DEFAULT_CAPTURE_SHORTCUT
}

function writeShortcutSettings(app, accelerator) {
  try {
    writeFileSync(shortcutSettingsFile(app), JSON.stringify({ capture: accelerator }, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error('保存快捷键设置失败：', error)
    return false
  }
}

/**
 * 校验加速键字符串。
 *
 * Electron 的 register 对畸形字符串会**抛错**而不是返回 false，
 * 不先校验的话用户随手输入的内容会把注册流程打断。
 */
function isValidAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return false
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return false // 全局快捷键必须带修饰键，否则会吃掉普通按键
  const mods = new Set(['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl',
    'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'])
  const key = parts[parts.length - 1]
  if (mods.has(key)) return false // 末位必须是真实按键，不能只有修饰键
  return parts.slice(0, -1).every((p) => mods.has(p))
}

function notifyShortcutStatus(getMainWindow, payload) {
  const target = getMainWindow()?.webContents
  if (!target || target.isDestroyed() || target.isLoading()) {
    pendingShortcutNotice = payload
    return
  }
  target.send('shortcut:status', payload)
}

/**
 * 触发截图。
 *
 * 已有覆盖层时直接忽略：连按不能叠出第二层，否则两层覆盖会互相遮挡，
 * 用户既选不中区域也关不掉。screenshotSessions 是覆盖层的唯一真值。
 */
function triggerCaptureShortcut(getMainWindow) {
  if (screenshotSessions.size > 0) return
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 不改变窗口状态。截图捕获的是用户按下快捷键那一刻真实可见的画面，
  // 覆盖层在冻结帧绘制完成后再一次性显示，避免全屏 Space 跳转和双画面闪烁。
  mainWindow.webContents.send('shortcut:capture')
}

/**
 * 按当前设置注册快捷键。
 *
 * 三种结果都要明确告诉用户，不能静默：
 *   · 关闭   —— 用户主动选择，不算失败
 *   · 成功   —— 显示当前生效的组合
 *   · 被占用 —— **明确说"已被其他应用占用"**，不含糊成"注册失败"
 */
export function registerCaptureShortcut({ app, globalShortcut, getMainWindow }) {
  // ⚠ 只注销**自己上一次注册的那个**，不要用 unregisterAll()。
  //   unregisterAll 会清掉进程里所有全局快捷键——现在只有一个所以看不出
  //   问题，但将来任何一个新增的全局键都会被这里悄悄清掉。
  if (registeredShortcut) {
    try { globalShortcut.unregister(registeredShortcut) } catch { /* 已经没了就算了 */ }
    registeredShortcut = null
  }
  if (captureShortcut === null) {
    notifyShortcutStatus(getMainWindow, { ok: true, disabled: true, accelerator: null,
      message: '全局截图快捷键已关闭，可继续用界面上的截图按钮。' })
    return { ok: true, disabled: true }
  }
  if (!isValidAccelerator(captureShortcut)) {
    notifyShortcutStatus(getMainWindow, { ok: false, accelerator: captureShortcut,
      message: `快捷键「${captureShortcut}」格式无效，需要至少一个修饰键加一个普通按键。` })
    return { ok: false, reason: 'invalid' }
  }
  let ok = false
  try {
    ok = globalShortcut.register(captureShortcut, () => triggerCaptureShortcut(getMainWindow))
  } catch {
    ok = false
  }
  // register 返回 false 或抛错都算失败；无论哪种，应用都要继续跑
  if (!ok) {
    notifyShortcutStatus(getMainWindow, {
      ok: false,
      accelerator: captureShortcut,
      reason: 'taken',
      message: `快捷键 ${captureShortcut} 已被其他应用占用，未能注册。` +
        '可以在设置里换一个组合，或关闭全局快捷键；界面上的截图按钮不受影响。'
    })
    return { ok: false, reason: 'taken' }
  }
  registeredShortcut = captureShortcut
  notifyShortcutStatus(getMainWindow, { ok: true, accelerator: captureShortcut })
  return { ok: true, accelerator: captureShortcut }
}

export function initCaptureShortcutFromSettings(app) {
  captureShortcut = readShortcutSettings(app)
}

/** 主窗口销毁时一并收掉所有钉图窗口与截图覆盖层，供 index.js 调用。 */
export function closeAllScreenshotWindows() {
  pinnedScreenshotSessions.forEach((session) => session.window.close())
  if (reusableScreenshotOverlay && !reusableScreenshotOverlay.isDestroyed()) {
    reusableScreenshotOverlay.destroy()
  }
}

export function registerScreenshotHandlers({
  ipcMain,
  dialog,
  BrowserWindow,
  clipboard,
  nativeImage,
  desktopCapturer,
  screen,
  globalShortcut,
  app,
  require,
  __dirname,
  assertMainWindowSender,
  getMainWindow
}) {
  function isScreenshotActionSender(event) {
    const mainWindow = getMainWindow()
    if (mainWindow && event.sender === mainWindow.webContents) return true
    return [...screenshotSessions.values()].some((session) =>
      !session.overlay.isDestroyed() && event.sender === session.overlay.webContents)
  }

  ipcMain.handle('screenshot:start', async (event) => {
    assertMainWindowSender(event)
    const cursorPoint = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursorPoint)
    const physicalWidth = Math.max(1, Math.round(display.bounds.width * display.scaleFactor))
    const physicalHeight = Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
    const grabElectron = async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: physicalWidth, height: physicalHeight },
        fetchWindowIcons: false
      })
      const source = sources.find((c) => String(c.display_id) === String(display.id)) || sources[0]
      return source ? { thumbnail: source.thumbnail, backend: 'desktopCapturer' } : null
    }
    const grab = async () => {
      // macOS 不回退到 desktopCapturer：原生路径负责稳定地保留当前屏幕内容，
      // 并避免 Electron 在 Stage Manager 下产生错误的显示器边界映射。
      if (process.platform === 'darwin') {
        return captureDisplayScreenCaptureKit({ app, __dirname, nativeImage }, display, physicalWidth, physicalHeight)
      }
      return grabElectron()
    }

    let source = await grab()
    // 抓到黑帧多半是合成器还没画完，再等一拍重抓一次。
    // 只重试一次：真没权限时不该让用户干等。
    if (source && isBlankCapture(source.thumbnail)) {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_DELAY_MS))
      source = await grab()
    }

    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('无法读取屏幕画面，请检查系统录屏权限')
    }
    if (isBlankCapture(source.thumbnail)) {
      throw new Error('屏幕画面尚未就绪，请重试')
    }

    const sessionId = randomUUID()
    const data = source.data || source.thumbnail.toPNG()
    const overlay = await ensureScreenshotOverlay({ BrowserWindow, __dirname }, display)
    const session = {
      data,
      displayBounds: display.bounds,
      imageSize: source.thumbnail.getSize(),
      backend: source.backend,
      owner: event.sender,
      overlay
    }
    screenshotSessions.set(sessionId, session)
    overlay.webContents.send('screenshot:begin-session', sessionId)

    return { status: 'started', sessionId }
  })

  // ready-to-show 只说明 HTML 已载入，不代表冻结截图已经解码并画进 canvas。
  // 覆盖层必须等 renderer 报告首帧绘制完成后再一次性显示，否则用户会先看到
  // 底下的实时桌面、再看到冻结帧，视觉上就像叠了两张画面。
  ipcMain.handle('screenshot:overlay-ready', (event, sessionId) => {
    const session = screenshotSessions.get(sessionId)
    if (!session || event.sender !== session.overlay.webContents) {
      throw new Error('截图覆盖层会话无效')
    }
    if (!session.overlay.isDestroyed() && !session.overlay.isVisible()) {
      session.overlay.show()
      session.overlay.focus()
    }
    return { status: 'ready' }
  })

  ipcMain.handle('screenshot:get-session', (event, sessionId) => {
    const session = screenshotSessions.get(sessionId)
    if (!session || event.sender !== session.overlay.webContents) {
      throw new Error('截图会话已失效或无权访问')
    }
    return {
      data: new Uint8Array(session.data),
      imageSize: session.imageSize,
      displayBounds: session.displayBounds,
      backend: session.backend
    }
  })

  ipcMain.handle('screenshot:complete', (event, payload) => {
    const session = screenshotSessions.get(payload?.sessionId)
    if (!session || event.sender !== session.overlay.webContents) {
      throw new Error('截图会话已失效或无权访问')
    }
    let data
    let width
    let height
    if (payload?.data instanceof Uint8Array) {
      if (payload.data.byteLength > 100 * 1024 * 1024) throw new Error('截图数据超过 100 MB')
      const finalImage = nativeImage.createFromBuffer(Buffer.from(payload.data))
      if (finalImage.isEmpty()) throw new Error('最终截图数据无效')
      data = finalImage.toPNG()
      ;({ width, height } = finalImage.getSize())
    } else {
      const rect = payload.rect || {}
      const scaleX = session.imageSize.width / session.displayBounds.width
      const scaleY = session.imageSize.height / session.displayBounds.height
      const x = Math.max(0, Math.min(session.imageSize.width - 1, Math.round(Number(rect.x) * scaleX)))
      const y = Math.max(0, Math.min(session.imageSize.height - 1, Math.round(Number(rect.y) * scaleY)))
      width = Math.max(
        1,
        Math.min(session.imageSize.width - x, Math.round(Number(rect.width) * scaleX))
      )
      height = Math.max(
        1,
        Math.min(session.imageSize.height - y, Math.round(Number(rect.height) * scaleY))
      )
      data = nativeImage.createFromBuffer(session.data).crop({ x, y, width, height }).toPNG()
    }
    screenshotSessions.delete(payload.sessionId)
    hideScreenshotOverlay(session.overlay)
    session.owner.send('screenshot:captured', {
      data: new Uint8Array(data),
      width,
      height
    })
    return { status: 'captured', width, height }
  })

  ipcMain.handle('screenshot:cancel', (event, sessionId) => {
    const session = screenshotSessions.get(sessionId)
    if (session && event.sender !== session.overlay.webContents) {
      throw new Error('截图会话无权访问')
    }
    if (session) {
      screenshotSessions.delete(sessionId)
      hideScreenshotOverlay(session.overlay)
      session.owner.send('screenshot:cancelled')
    }
    return { status: 'cancelled' }
  })

  ipcMain.handle('screenshot:save', async (event, payload) => {
    if (!isScreenshotActionSender(event)) {
      throw new Error('只有主窗口或当前截图覆盖层可以保存截图')
    }
    const data = payload?.data instanceof Uint8Array ? Buffer.from(payload.data) : null
    if (!data || data.byteLength > 100 * 1024 * 1024) {
      throw new Error('截图数据无效或超过 100 MB')
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(ownerWindow, {
      title: '保存截图',
      defaultPath: `${sanitizeFileBaseName(payload.name, 'screenshot')}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return { status: 'cancelled' }
    await writeFile(result.filePath, data)
    return { status: 'saved', path: result.filePath }
  })

  ipcMain.handle('screenshot:copy', (event, data) => {
    if (!isScreenshotActionSender(event)) {
      throw new Error('只有主窗口或当前截图覆盖层可以复制截图')
    }
    if (!(data instanceof Uint8Array) || data.byteLength > 100 * 1024 * 1024) {
      throw new Error('截图数据无效或超过 100 MB')
    }
    const image = nativeImage.createFromBuffer(Buffer.from(data))
    if (image.isEmpty()) throw new Error('无法解析截图数据')
    clipboard.writeImage(image)
    return { status: 'copied', size: image.getSize() }
  })

  ipcMain.handle('screenshot:ocr', async (event, data) => {
    if (!isScreenshotActionSender(event)) {
      throw new Error('只有主窗口或当前截图覆盖层可以执行截图 OCR')
    }
    if (ocrBusy) throw new Error('已有 OCR 任务正在执行')
    if (!(data instanceof Uint8Array) || data.byteLength > 100 * 1024 * 1024) {
      throw new Error('OCR 图片数据无效或超过 100 MB')
    }

    const image = nativeImage.createFromBuffer(Buffer.from(data))
    if (image.isEmpty()) throw new Error('无法解析 OCR 图片')
    ocrBusy = true
    ocrProgressTarget = event.sender

    try {
      const worker = await ensureOcrWorker({ app, require })
      const result = await worker.recognize(Buffer.from(data))
      return {
        status: 'recognized',
        text: normalizeOcrText(result.data.text),
        confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0
      }
    } finally {
      ocrBusy = false
      ocrProgressTarget = null
    }
  })

  ipcMain.handle('screenshot:copy-text', (event, text) => {
    if (!isScreenshotActionSender(event)) {
      throw new Error('只有主窗口或当前截图覆盖层可以复制 OCR 文字')
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('OCR 文本无效或超过 2 MB')
    }
    clipboard.writeText(text)
    return { status: 'copied', length: text.length }
  })

  function getPinnedScreenshotSession(event, pinId) {
    const session = pinnedScreenshotSessions.get(pinId)
    if (!session || event.sender !== session.window.webContents) {
      throw new Error('钉图会话不存在或无权访问')
    }
    return session
  }

  ipcMain.handle('screenshot:pin', async (event, data) => {
    if (!isScreenshotActionSender(event)) {
      throw new Error('只有主窗口或当前截图覆盖层可以创建钉图')
    }
    if (!(data instanceof Uint8Array) || data.byteLength > 100 * 1024 * 1024) {
      throw new Error('钉图数据无效或超过 100 MB')
    }

    const buffer = Buffer.from(data)
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) throw new Error('无法解析钉图数据')
    const originalSize = image.getSize()
    const scale = Math.min(1, 520 / originalSize.width, 420 / originalSize.height)
    const width = Math.max(160, Math.round(originalSize.width * scale))
    const height = Math.max(120, Math.round(originalSize.height * scale))
    const pinId = randomUUID()
    const pinWindow = new BrowserWindow({
      width,
      height,
      minWidth: 120,
      minHeight: 90,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    pinnedScreenshotSessions.set(pinId, {
      data: buffer,
      image,
      originalSize,
      window: pinWindow
    })
    pinWindow.once('ready-to-show', () => pinWindow.show())
    pinWindow.on('closed', () => pinnedScreenshotSessions.delete(pinId))

    if (process.env.ELECTRON_RENDERER_URL) {
      const pinUrl = new URL('pin.html', process.env.ELECTRON_RENDERER_URL)
      pinUrl.searchParams.set('pin', pinId)
      await pinWindow.loadURL(pinUrl.toString())
    } else {
      await pinWindow.loadFile(join(__dirname, '../renderer/pin.html'), {
        query: { pin: pinId }
      })
    }

    return { status: 'pinned', pinId, width, height }
  })

  ipcMain.handle('screenshot:pin-get', (event, pinId) => {
    const session = getPinnedScreenshotSession(event, pinId)
    return {
      data: new Uint8Array(session.data),
      originalSize: session.originalSize,
      opacity: session.window.getOpacity()
    }
  })

  ipcMain.handle('screenshot:pin-resize', (event, payload) => {
    const session = getPinnedScreenshotSession(event, payload?.pinId)
    const scale = Math.min(3, Math.max(0.2, Number(payload?.scale)))
    if (!Number.isFinite(scale)) throw new Error('钉图缩放比例无效')
    const width = Math.max(120, Math.round(session.originalSize.width * scale))
    const height = Math.max(90, Math.round(session.originalSize.height * scale))
    session.window.setSize(width, height, true)
    return { status: 'resized', width, height, scale }
  })

  ipcMain.handle('screenshot:pin-opacity', (event, payload) => {
    const session = getPinnedScreenshotSession(event, payload?.pinId)
    const opacity = Math.min(1, Math.max(0.3, Number(payload?.opacity)))
    if (!Number.isFinite(opacity)) throw new Error('钉图透明度无效')
    session.window.setOpacity(opacity)
    return { status: 'updated', opacity }
  })

  ipcMain.handle('screenshot:pin-copy', (event, pinId) => {
    const session = getPinnedScreenshotSession(event, pinId)
    clipboard.writeImage(session.image)
    return { status: 'copied', size: session.originalSize }
  })

  ipcMain.handle('screenshot:pin-close', (event, pinId) => {
    const session = getPinnedScreenshotSession(event, pinId)
    session.window.close()
    return { status: 'closed' }
  })

  // ── 设置页用的快捷键 IPC ──────────────────────────────────────

  ipcMain.handle('shortcut:get', (event) => {
    assertMainWindowSender(event)
    return {
      accelerator: captureShortcut,
      default: DEFAULT_CAPTURE_SHORTCUT,
      disabled: captureShortcut === null
    }
  })

  /**
   * 修改快捷键。
   *
   * ⚠ 新组合注册失败时必须**回滚到旧的**并重新注册——否则用户填了一个被占用的
   * 组合，结果连原来能用的那个也没了，等于把功能弄丢。
   */
  ipcMain.handle('shortcut:set', (event, payload) => {
    assertMainWindowSender(event)
    const next = payload?.accelerator ?? null
    if (next !== null && !isValidAccelerator(next)) {
      return { ok: false, reason: 'invalid', accelerator: captureShortcut,
        message: '需要至少一个修饰键加一个普通按键，例如 Control+Shift+A。' }
    }
    const previous = captureShortcut
    captureShortcut = next
    const result = registerCaptureShortcut({ app, globalShortcut, getMainWindow })
    if (!result.ok) {
      captureShortcut = previous
      registerCaptureShortcut({ app, globalShortcut, getMainWindow }) // 把原来能用的那个恢复回去
      return { ok: false, reason: result.reason, accelerator: previous,
        message: result.reason === 'taken'
          ? `${next} 已被其他应用占用，已保留原有设置。`
          : `${next} 格式无效，已保留原有设置。` }
    }
    writeShortcutSettings(app, captureShortcut)
    return { ok: true, accelerator: captureShortcut, disabled: captureShortcut === null }
  })

  ipcMain.handle('shortcut:reset', (event) => {
    assertMainWindowSender(event)
    const previous = captureShortcut
    captureShortcut = DEFAULT_CAPTURE_SHORTCUT
    const result = registerCaptureShortcut({ app, globalShortcut, getMainWindow })
    if (!result.ok) {
      captureShortcut = previous
      registerCaptureShortcut({ app, globalShortcut, getMainWindow })
      return { ok: false, reason: result.reason, accelerator: previous,
        message: `默认组合 ${DEFAULT_CAPTURE_SHORTCUT} 当前被其他应用占用，已保留原有设置。` }
    }
    writeShortcutSettings(app, captureShortcut)
    return { ok: true, accelerator: captureShortcut }
  })

  // 渲染端就绪后补发注册结果
  ipcMain.on('shortcut:ready', (event) => {
    if (event.sender !== getMainWindow()?.webContents) return
    if (!pendingShortcutNotice) return
    event.sender.send('shortcut:status', pendingShortcutNotice)
    pendingShortcutNotice = null
  })
}
