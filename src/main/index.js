import {
  app,
  Menu,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  utilityProcess
} from 'electron'
import { initUpdater, updateApi } from './updater.js'
import { getApplicationVersion } from './appVersion.js'
import { registerBoardHandlers } from './modules/board.js'
import { registerComWorkerHandlers, terminateComWorker } from './modules/comWorker.js'
import { registerBarcodeHandlers } from './modules/barcode.js'
import { registerIllustratorHandlers } from './modules/illustrator.js'
import { bindOwnerSessionCleanup, registerDropAndOfficeHandlers } from './modules/dropAndOffice.js'
import { registerDielineHandlers } from './modules/dieline.js'
import { registerFormatFactoryHandlers } from './modules/formatFactory.js'
import {
  closeAllScreenshotWindows,
  ensureScreenCaptureKitBinary,
  ensureScreenshotOverlay,
  initCaptureShortcutFromSettings,
  registerCaptureShortcut,
  registerScreenshotHandlers,
  terminateOcrWorker
} from './modules/screenshot.js'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

// 启动埋点（F-018 验收）：记录进程启动时刻，供 renderer 回报首帧可交互耗时。
// 用进程启动后的最早可用时刻近似"双击 EXE"起点，比 app.ready 更靠前。
const startupBootEpoch = Date.now()
let startupReported = false
function recordStartupReady() {
  if (startupReported) return
  startupReported = true
  const elapsed = Date.now() - startupBootEpoch
  console.log(`startup-ready: ${elapsed}ms`)
  try {
    const logPath = join(app.getPath('userData'), 'startup-log.txt')
    writeFileSync(logPath, `${new Date().toISOString()} startup-ready: ${elapsed}ms\n`, { flag: 'a' })
  } catch (error) {
    console.warn('启动日志写入失败：', error?.message || error)
  }
}

ipcMain.on('startup:report-ready', () => {
  recordStartupReady()
})

let mainWindow = null

function assertMainWindowSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('此操作只允许从主窗口发起')
  }
}

/**
 * 窗口图标。
 * 开发环境用项目内 PNG（assets/app-icon.png）；
 * Windows 打包后用随包资源的 ICO —— 任务栏与窗口标题栏取的是它。
 * macOS 的 Dock 图标由 app bundle 决定，不受此处影响。
 */
function resolveWindowIcon() {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'icon.ico'),
        join(process.resourcesPath, 'app-icon.png')
      ]
    : [
        join(__dirname, '../../build/icon.ico'),
        join(__dirname, '../../assets/app-icon.png')
      ]
  for (const candidate of candidates) {
    if (process.platform !== 'win32' && candidate.endsWith('.ico')) continue
    if (!existsSync(candidate)) continue
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return undefined
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: false,
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 窗口从最小化/隐藏恢复后通知渲染端重新激活画布（F-15）。
  // ⚠ 'restore' 与 'show' 都要接：最小化恢复走 restore，
  //   而截图流程用的是 hide/show，走的是 show，两条路都会让
  //   keyup / mouse:up 这类"结束事件"丢失。
  for (const evt of ['restore', 'show', 'focus']) {
    mainWindow.on(evt, () => {
      if (mainWindow.isDestroyed()) return
      mainWindow.webContents.send('window:revive')
    })
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 未保存的汇总画布：关闭前确认，三选项与新建/打开完全一致（规格 7.2）。
  //
  // 必须异步：选「保存」时要把保存交给 renderer 执行（打包、写盘、
  // 可能弹系统保存对话框），**保存成功才退出**。保存失败或用户在保存
  // 对话框里取消时留在原地——否则等于"点了保存却把改动丢了"。
  // forceClose 标记避免 destroy 后再次触发本处理器造成递归。
  let forceClose = false
  let closing = false
  mainWindow.on('close', (event) => {
    if (forceClose || !boardHasUnsavedChanges) return
    event.preventDefault()
    if (closing) return // 已在处理中，忽略重复的关闭请求
    closing = true

    ;(async () => {
      try {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['保存并退出', '不保存并退出', '取消'],
          defaultId: 0,
          cancelId: 2,
          title: '有未保存的画布',
          message: '汇总画布有未保存的改动',
          detail: '选择「保存并退出」会先保存当前工程；保存失败时不会退出。'
        })
        if (choice.response === 2) return // 取消：什么都不做

        if (choice.response === 0) {
          const saved = await requestRendererSave()
          if (!saved) return // 保存失败或用户取消了保存对话框：留在原地
        }
        forceClose = true
        boardHasUnsavedChanges = false
        mainWindow.destroy()
      } finally {
        closing = false
      }
    })()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    closeAllScreenshotWindows()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('ping', () => 'pong')
ipcMain.handle('app:info', (event) => {
  assertMainWindowSender(event)
  return { version: getApplicationVersion() }
})

// ── 自动更新（GitHub Releases，仅 Windows 安装版）──
ipcMain.handle('update:get-state', (event) => {
  assertMainWindowSender(event)
  return updateApi.getState()
})
ipcMain.handle('update:get-settings', (event) => {
  assertMainWindowSender(event)
  return updateApi.getSettings()
})
ipcMain.handle('update:set-auto-check', (event, enabled) => {
  assertMainWindowSender(event)
  return updateApi.setAutoCheck(enabled)
})
ipcMain.handle('update:check', (event) => {
  assertMainWindowSender(event)
  return updateApi.check()
})
ipcMain.handle('update:download', (event) => {
  assertMainWindowSender(event)
  return updateApi.download()
})
ipcMain.handle('update:install', (event) => {
  assertMainWindowSender(event)
  return updateApi.install()
})
ipcMain.handle('update:open-releases', (event) => {
  assertMainWindowSender(event)
  return updateApi.openReleases()
})

const ALLOWED_EXTERNAL_URLS = new Set([
  'https://github.com/Clukay-Fun/moyu-tools'
])

ipcMain.handle('app:open-external', async (event, value) => {
  assertMainWindowSender(event)
  const url = String(value || '')
  if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error('不允许打开此链接')
  await shell.openExternal(url)
  return { status: 'opened' }
})

// ── 汇总画布项目文件 .moyuboard（F-009 S5）────────────────────
// 文件 IPC（board:save / board:open / recovery:*）已拆到 ./modules/board.js；
// 这里只留下跟 mainWindow 生命周期强耦合的"未保存改动"关闭握手。
registerBoardHandlers({ ipcMain, dialog, BrowserWindow, app, assertMainWindowSender })

// 格式工厂 IPC（format:*）已拆到 ./modules/formatFactory.js。
registerFormatFactoryHandlers({ ipcMain, dialog, BrowserWindow, app, assertMainWindowSender })

// 刀模发送到 Illustrator（dieline:*）：渲染层给 SVG，主进程交给 COM worker 打开。
registerDielineHandlers({ ipcMain, assertMainWindowSender, app, utilityProcess })

// Office/Adobe COM 联动的公共基础设施（com:probe / com:show-result）已拆到 ./modules/comWorker.js。
registerComWorkerHandlers({ ipcMain, shell, app, utilityProcess, assertMainWindowSender })

// 条码/图片文件保存 IPC（barcode:* / image:save-file）已拆到 ./modules/barcode.js。
registerBarcodeHandlers({ ipcMain, dialog, BrowserWindow, clipboard, app, utilityProcess, assertMainWindowSender })

// Illustrator 批处理 IPC（illustrator:*）已拆到 ./modules/illustrator.js。
registerIllustratorHandlers({
  ipcMain, dialog, BrowserWindow, app, utilityProcess, assertMainWindowSender, bindOwnerSessionCleanup
})

// 统一拖入扫描 + Office 转 PDF + PDF 输出位置管理已拆到 ./modules/dropAndOffice.js。
registerDropAndOfficeHandlers({ ipcMain, dialog, BrowserWindow, shell, app, utilityProcess, assertMainWindowSender })

// 区域截图（含 macOS 原生抓屏、覆盖层、钉图、OCR）+ 全局截图快捷键
// 已拆到 ./modules/screenshot.js。
registerScreenshotHandlers({
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
  getMainWindow: () => mainWindow
})

/**
 * 汇总画布是否有未保存改动。
 * 由 renderer 上报——关闭确认必须在主进程做：renderer 的 beforeunload 是同步的，
 * 无法在其中等待对话框，也拦不住"退出应用"这条路径。
 */
let boardHasUnsavedChanges = false

/** 关闭流程里等待 renderer 保存结果的握手表。 */
const pendingCloseSaves = new Map()
let closeSaveSeq = 0

/**
 * 请 renderer 执行一次保存，等待其结果。
 * @returns {Promise<boolean>} 是否真的保存成功
 *
 * 超时兜底：renderer 卡死时不能让窗口永远关不掉，
 * 但超时按**失败**处理——宁可让用户再点一次，也不能悄悄丢改动。
 */
function requestRendererSave(timeoutMs = 120000) {
  const target = mainWindow?.webContents
  if (!target || target.isDestroyed()) return Promise.resolve(false)
  const id = ++closeSaveSeq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCloseSaves.delete(id)
      resolve(false)
    }, timeoutMs)
    pendingCloseSaves.set(id, (ok) => {
      clearTimeout(timer)
      pendingCloseSaves.delete(id)
      resolve(Boolean(ok))
    })
    target.send('board:request-save', id)
  })
}

ipcMain.on('board:save-result', (event, id, ok) => {
  if (event.sender !== mainWindow?.webContents) return
  pendingCloseSaves.get(id)?.(ok)
})

ipcMain.on('board:dirty', (event, dirty) => {
  if (event.sender !== mainWindow?.webContents) return
  boardHasUnsavedChanges = Boolean(dirty)
})

app.whenReady().then(() => {
  // 隐藏 Electron 默认原生菜单栏（File/Edit/...），应用使用自身渲染层界面。
  Menu.setApplicationMenu(null)
  // macOS 首次截图若在点击后才编译 ScreenCaptureKit 侧车，会额外等待约一秒。
  // 启动后后台预热；失败时 promise 会自行复位，真正截图仍会重试并给出明确错误。
  if (process.platform === 'darwin') {
    void ensureScreenCaptureKitBinary({ app, __dirname }).catch((error) => {
      console.warn('ScreenCaptureKit 侧车预热失败：', error?.message || error)
    })
  }
  // BrowserWindow.icon 不控制 macOS Dock；开发模式显式使用项目图标，
  // 方便本机预览与 Windows 打包后的品牌视觉保持一致。
  if (process.platform === 'darwin') {
    const dockIcon = resolveWindowIcon()
    if (dockIcon && !dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  }
  createWindow()
  initUpdater(mainWindow)
  // 预先加载隐藏的截图壳。后续点击只更新屏幕数据，不再创建窗口或重跑页面初始化。
  void ensureScreenshotOverlay({ BrowserWindow, __dirname }, screen.getPrimaryDisplay()).catch((error) => {
    console.warn('截图覆盖层预加载失败：', error?.message || error)
  })
  // 启动时按用户设置注册；没配过就是默认组合（F-16）
  initCaptureShortcutFromSettings(app)
  registerCaptureShortcut({ app, globalShortcut, getMainWindow: () => mainWindow })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出时释放全局快捷键。will-quit 比 before-quit 更靠后，
// 是 Electron 文档指定的注销时机。
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  terminateOcrWorker()
  terminateComWorker()
})
