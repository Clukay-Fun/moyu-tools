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
import { spawn } from 'node:child_process'
import { initUpdater, updateApi } from './updater.js'
import { getApplicationVersion } from './appVersion.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join } from 'node:path'

const require = createRequire(import.meta.url)

// 重型依赖改为首次使用时动态加载，缩短主进程冷启动关键路径（F-018）。
let sharpModulePromise = null
async function loadSharp() {
  if (!sharpModulePromise) sharpModulePromise = import('sharp').then((mod) => mod.default)
  return sharpModulePromise
}

let tesseractModulePromise = null
async function loadTesseract() {
  if (!tesseractModulePromise) tesseractModulePromise = import('tesseract.js')
  return tesseractModulePromise
}

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

const BARCODE_FILE_TYPES = {
  svg: {
    extension: 'svg',
    filterName: 'SVG 矢量图',
    encoding: 'utf8'
  },
  png: {
    extension: 'png',
    filterName: 'PNG 图片',
    encoding: null
  }
}

const IMAGE_FILE_TYPES = {
  png: {
    extension: 'png',
    filterName: 'PNG 图片'
  },
  jpeg: {
    extension: 'jpg',
    filterName: 'JPEG 图片'
  },
  webp: {
    extension: 'webp',
    filterName: 'WebP 图片'
  },
  tiff: {
    extension: 'tiff',
    filterName: 'TIFF 图片'
  }
}

const PDF_OUTPUT_TYPES = {
  pdf: {
    extension: 'pdf',
    filterName: 'PDF 文档'
  },
  png: {
    extension: 'png',
    filterName: 'PNG 图片'
  },
  jpeg: {
    extension: 'jpg',
    filterName: 'JPEG 图片'
  },
  txt: {
    extension: 'txt',
    filterName: '文本文件'
  }
}

const screenshotSessions = new Map()
let reusableScreenshotOverlay = null
let screenshotOverlayReadyPromise = null
const pinnedScreenshotSessions = new Map()
const formatInputSessions = new Map()
const formatResultSessions = new Map()
const formatTasks = new Map()
const illustratorInputSessions = new Map()
const officeInputSessions = new Map()
const pdfOutputSessions = new Map()
const comResultSessions = new Map()
const activeIllustratorTasks = new Map()
const comPendingRequests = new Map()
let ocrWorkerPromise = null
let ocrProgressTarget = null
let ocrBusy = false
let mainWindow = null
let comWorker = null
let comWorkerStderr = ''


const FORMAT_EXTENSIONS = {
  video: new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']),
  audio: new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma']),
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.gif', '.avif'])
}
const FORMAT_MAX_FILES = 100
const FORMAT_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
const FORMAT_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000
const FORMAT_ACTIONS = new Map([
  ['视频转换', 'video-convert'],
  ['视频压缩', 'video-compress'],
  ['抽取音频', 'extract-audio'],
  ['音频转换', 'audio-convert'],
  ['图片转换', 'image-convert'],
  ['图片压缩', 'image-compress']
])

const OCR_MODELS = [
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

// 零售合规条码 PNG 的物理分辨率（pHYs）。canvas.toBlob() 不写 pHYs，
// Photoshop/Illustrator 会按 72/96 DPI 解释，物理尺寸就错了。
// 单个保存 / 批量保存 / 转入 Photoshop 三条落盘链路统一经过本函数；
// 剪贴板直接写入 SVG 矢量数据，不经过 PNG，因此不涉及 DPI 元数据。
const BARCODE_PNG_DPI = 300

// 仅在渲染层显式声明 density 时写入（零售合规码），通用六码不受影响。
// 写入失败必须抛错：若静默降级，保存会报成功但文件仍是 96 DPI，
// 与"PNG 元数据 density=300"的验收标准直接冲突。
async function withBarcodePngDensity(data, fileType, density) {
  if (fileType?.extension !== 'png' || !density) return data

  const value = Number(density)
  if (!Number.isFinite(value) || value <= 0 || value > 4800) {
    throw new Error(`条码 PNG 分辨率无效：${density}`)
  }

  try {
    return await (await loadSharp())(data).withMetadata({ density: value }).png().toBuffer()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`条码 PNG 写入 ${value} DPI 元数据失败：${reason}`)
  }
}

function normalizeBarcodeData(type, rawData) {
  const fileType = BARCODE_FILE_TYPES[type]

  if (!fileType || !['string', 'object'].includes(typeof rawData)) {
    throw new Error('不支持的条码文件数据')
  }

  const data = rawData instanceof Uint8Array
    ? Buffer.from(rawData)
    : rawData

  if (
    (type === 'svg' && typeof data !== 'string') ||
    (type === 'png' && !Buffer.isBuffer(data))
  ) {
    throw new Error('条码文件格式与数据不匹配')
  }

  return { data, fileType }
}

function sanitizeFileBaseName(name, fallback = 'file') {
  return String(name || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || fallback
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1')
    .trim()
}

function assertMainWindowSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('此操作只允许从主窗口发起')
  }
}

function comWorkerPath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'workers', 'com-worker.cjs')
    : join(app.getAppPath(), 'resources', 'com-worker.cjs')
}

function winaxModulePath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'winax')
    : join(app.getAppPath(), 'node_modules', 'winax')
}

function rejectComRequests(error) {
  for (const pending of comPendingRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  comPendingRequests.clear()
}

function ensureComWorker() {
  if (process.platform !== 'win32') {
    throw new Error('Office 与 Adobe 联动仅支持 Windows')
  }
  if (comWorker) return comWorker

  const child = utilityProcess.fork(comWorkerPath(), [], {
    env: {
      ...process.env,
      MOYU_WINAX_MODULE: winaxModulePath()
    },
    stdio: 'pipe',
    serviceName: 'moyu-tools-com'
  })
  comWorker = child
  comWorkerStderr = ''
  child.stderr?.on('data', (chunk) => {
    comWorkerStderr = `${comWorkerStderr}${chunk}`.slice(-4000)
  })
  child.on('message', (message) => {
    const pending = comPendingRequests.get(message?.id)
    if (!pending) return
    if (message.type === 'progress') {
      if (!pending.sender.isDestroyed()) {
        pending.sender.send(pending.progressChannel, {
          completed: message.completed,
          total: message.total,
          name: message.name,
          message: message.message
        })
      }
      return
    }
    if (message.type !== 'result') return
    clearTimeout(pending.timer)
    comPendingRequests.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else if (message.error === 'TASK_CANCELLED') pending.reject(new Error('TASK_CANCELLED'))
    else pending.reject(new Error(message.error || 'COM 任务执行失败'))
  })
  child.once('exit', (code) => {
    if (comWorker !== child) return
    comWorker = null
    const detail = comWorkerStderr.trim()
    rejectComRequests(new Error(
      `COM 任务进程已退出（${code ?? '未知'}）${detail ? `：${detail}` : ''}`
    ))
  })
  child.once('error', (error) => {
    if (comWorker === child) comWorker = null
    rejectComRequests(error)
  })
  return child
}

function runComCommand(event, command, payload, options = {}) {
  if (comPendingRequests.size) {
    throw new Error('已有 Office 或 Adobe 任务正在执行，请等待当前任务完成')
  }
  const worker = ensureComWorker()
  const id = options.id || randomUUID()
  const timeoutMs = options.timeoutMs || 3 * 60 * 1000

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!comPendingRequests.delete(id)) return
      reject(new Error('COM 任务执行超时，请关闭软件中的弹窗后重试'))
      if (comWorker === worker) {
        comWorker = null
        worker.kill()
        rejectComRequests(new Error('COM 任务进程已因超时重启，请重试'))
      }
    }, timeoutMs)
    comPendingRequests.set(id, {
      sender: event.sender,
      progressChannel: options.progressChannel || 'com:progress',
      resolve,
      reject,
      timer
    })
    worker.postMessage({
      type: 'request',
      id,
      command,
      payload
    })
  })
}

function cancelComCommand(id) {
  if (comWorker && comPendingRequests.has(id)) {
    comWorker.postMessage({ type: 'cancel', id })
    return true
  }
  return false
}

async function availableOutputPath(directory, baseName, extension) {
  const safeBase = sanitizeFileBaseName(baseName, 'output')
  for (let occurrence = 1; occurrence <= 999; occurrence += 1) {
    const suffix = occurrence === 1 ? '' : `-${occurrence}`
    const candidate = join(directory, `${safeBase}${suffix}.${extension}`)
    const exists = await stat(candidate).then(() => true).catch(() => false)
    if (!exists) return candidate
  }
  throw new Error('输出目录中同名文件过多，请先整理后重试')
}

async function assertOutputFile(filePath, label) {
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile() || info.size < 1) {
    throw new Error(`${label} 未生成输出文件`)
  }
  return info
}

function registerComResult(ownerId, filePath) {
  const id = randomUUID()
  comResultSessions.set(id, {
    id,
    ownerId,
    path: filePath,
    name: basename(filePath)
  })
  return { id, name: basename(filePath) }
}

function getPdfOutputSession(event, sessionId, mode) {
  const session = pdfOutputSessions.get(sessionId)
  if (!session || session.ownerId !== event.sender.id || session.mode !== mode) {
    throw new Error('PDF 输出位置会话不存在、已失效或类型不匹配')
  }
  return session
}

function illustratorSession(event, inputId) {
  const input = illustratorInputSessions.get(inputId)
  if (!input || input.ownerId !== event.sender.id) {
    throw new Error('Illustrator 文件会话不存在或无权访问')
  }
  return input
}

async function registerIllustratorInput(filePath, ownerId) {
  if (extname(filePath).toLowerCase() !== '.ai') {
    throw new Error(`${basename(filePath)} 不是 Illustrator 文件`)
  }
  const info = await stat(filePath)
  if (!info.isFile() || info.size > 2 * 1024 * 1024 * 1024) {
    throw new Error(`${basename(filePath)} 不是文件或超过 2 GB`)
  }
  const id = randomUUID()
  const input = {
    id,
    ownerId,
    path: filePath,
    name: basename(filePath),
    size: info.size
  }
  illustratorInputSessions.set(id, input)
  return { id, name: input.name, size: input.size }
}

async function collectIllustratorFolder(directory, ownerId, output = []) {
  if (output.length >= 500) return output
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (output.length >= 500) break
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectIllustratorFolder(entryPath, ownerId, output)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.ai') {
      output.push(await registerIllustratorInput(entryPath, ownerId))
    }
  }
  return output
}

// ── 统一拖入扫描（F-017：文件夹 / 混合拖入）─────────────────────────────
// renderer 只提交拖入的路径集合 + 目标区域（及动作），由主进程负责目录识别、
// 递归扫描与按区域规则校验；返回 { files, skipped, errors, truncated }。
// 不向 renderer 暴露任何目录读取 API：renderer 侧模块（PDF / 画布）通过不透明的
// fileId 取回字节，fileId 由扫描会话按 sender 注册，读取时校验归属。
const ILLUSTRATOR_MAX_BYTES = 2 * 1024 * 1024 * 1024
const DROP_SCAN_MAX_ROOTS = 1000
const DROP_MAX_FILES = 100
const DROP_PDF_MAX_BYTES = 150 * 1024 * 1024
const DROP_PDF_MAX_TOTAL = 300 * 1024 * 1024
const DROP_CANVAS_MAX_BYTES = 100 * 1024 * 1024
const DROP_CANVAS_MAX_TOTAL = 300 * 1024 * 1024

// renderer 侧模块（PDF / 画布）的临时读取会话：fileId -> { ownerId, path, name }。
// 读取后即销毁；未消费的会话设超时回收，并在 sender 销毁时统一清理。
const dropFileSessions = new Map()
const DROP_FILE_SESSION_TTL = 5 * 60 * 1000
const PDF_DEFAULT_OUTPUT_DIRECTORIES = Object.freeze({
  jpeg: 'JPEG',
  png: 'PNG',
  split: 'PDF-Pages',
  watermark: 'Watermarked',
  images: 'Images'
})
// 每个 sender 仅绑定一次 destroyed 清理，避免连续拖入累积监听器。
const boundDropDestroyListeners = new Set()

function purgeOwnerSessions(ownerId) {
  for (const [id, entry] of dropFileSessions) {
    if (entry.ownerId === ownerId) dropFileSessions.delete(id)
  }
  for (const [id, entry] of pdfOutputSessions) {
    if (entry.ownerId === ownerId) pdfOutputSessions.delete(id)
  }
  for (const [id, entry] of officeInputSessions) {
    if (entry.ownerId === ownerId) officeInputSessions.delete(id)
  }
}

async function registerOfficeDropInput(filePath, ownerId, kind) {
  const info = await stat(filePath)
  if (!info.isFile() || info.size > ILLUSTRATOR_MAX_BYTES) {
    throw new Error('Office 文件无效或超过 2 GB')
  }
  const id = randomUUID()
  officeInputSessions.set(id, {
    id,
    ownerId,
    kind,
    path: filePath,
    name: basename(filePath),
    size: info.size
  })
  return { id, name: basename(filePath), size: info.size, kind }
}

const DROP_REGION_CONFIG = {
  illustrator: () => ({
    extensions: ['.ai'],
    maxFiles: 500,
    maxBytes: ILLUSTRATOR_MAX_BYTES,
    register: registerIllustratorInput
  }),
  format: (kind) => {
    if (!FORMAT_EXTENSIONS[kind]) throw new Error('不支持的格式工厂输入类型')
    return {
      extensions: [...FORMAT_EXTENSIONS[kind]],
      maxFiles: FORMAT_MAX_FILES,
      maxBytes: FORMAT_MAX_FILE_BYTES,
      register: (filePath, ownerId) => registerFormatInput(filePath, ownerId, kind)
    }
  },
  pdf: (action) => {
    if (action === 'image') {
      return {
        extensions: ['.png', '.jpg', '.jpeg', '.webp'],
        maxFiles: DROP_MAX_FILES,
        maxBytes: DROP_PDF_MAX_BYTES,
        maxTotalBytes: DROP_PDF_MAX_TOTAL,
        register: null
      }
    }
    if (action === 'word' || action === 'excel' || action === 'powerpoint') {
      return {
        extensions: officeKindConfig(action).extensions,
        // Office 转 PDF 为单输入模型，仅取首个匹配文件，避免注册多余会话。
        maxFiles: 1,
        maxBytes: ILLUSTRATOR_MAX_BYTES,
        maxTotalBytes: ILLUSTRATOR_MAX_BYTES,
        register: (filePath, ownerId) => registerOfficeDropInput(filePath, ownerId, action)
      }
    }
    return {
      extensions: ['.pdf'],
      maxFiles: DROP_MAX_FILES,
      maxBytes: DROP_PDF_MAX_BYTES,
      maxTotalBytes: DROP_PDF_MAX_TOTAL,
      register: null
    }
  },
  canvas: () => ({
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    maxFiles: DROP_MAX_FILES,
    maxBytes: DROP_CANVAS_MAX_BYTES,
    maxTotalBytes: DROP_CANVAS_MAX_TOTAL,
    register: null
  })
}

function resolveDropConfig(region, action) {
  const factory = DROP_REGION_CONFIG[region]
  if (!factory) throw new Error('不支持的拖入区域')
  const config = factory(action)
  if (!config) throw new Error('拖入区域缺少配置')
  return config
}

async function scanDroppedPaths({ paths, region, action, ownerId }) {
  const config = resolveDropConfig(region, action)
  const { extensions, maxFiles, maxBytes, maxTotalBytes = null, register } = config
  // 统一规范化为带点形式，兼容 officeKindConfig 返回的无点扩展名（doc/xls 等）。
  const extSet = new Set(
    extensions.map((value) => {
      const lower = value.toLowerCase()
      return lower.startsWith('.') ? lower : `.${lower}`
    })
  )

  const collected = []
  let totalBytes = 0
  let skipped = 0
  let truncated = false
  const errors = []

  async function walk(current) {
    if (collected.length >= maxFiles) {
      truncated = true
      return
    }
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      errors.push(`${basename(current)}：${error.message}`)
      return
    }
    // 跳过符号链接（含符号链接目录），避免循环扫描。
    if (info.isSymbolicLink()) {
      skipped += 1
      return
    }
    if (info.isDirectory()) {
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch (error) {
        errors.push(`${basename(current)}：${error.message}`)
        return
      }
      for (const entry of entries) {
        if (collected.length >= maxFiles) {
          truncated = true
          break
        }
        await walk(join(current, entry.name))
      }
      return
    }
    if (!info.isFile()) {
      skipped += 1
      return
    }
    if (!extSet.has(extname(current).toLowerCase()) || info.size > maxBytes) {
      skipped += 1
      return
    }
    // 沿用各区域总大小上限，避免大目录在读取前就撑爆内存。
    if (maxTotalBytes != null && totalBytes + info.size > maxTotalBytes) {
      skipped += 1
      return
    }
    totalBytes += info.size
    collected.push({ path: current, name: basename(current), size: info.size })
  }

  for (const root of paths) {
    if (collected.length >= maxFiles) {
      truncated = true
      break
    }
    await walk(root)
  }

  const files = []
  for (const item of collected) {
    try {
      if (register) {
        files.push(await register(item.path, ownerId))
      } else {
        // renderer 侧模块：注册不透明 fileId，读取时按 sender 校验归属。
        const id = randomUUID()
        dropFileSessions.set(id, { ownerId, path: item.path, name: item.name })
        setTimeout(() => dropFileSessions.delete(id), DROP_FILE_SESSION_TTL)
        files.push({ id, name: item.name, size: item.size })
      }
    } catch (error) {
      errors.push(`${item.name}：${error.message}`)
    }
  }

  return { status: 'selected', files, skipped, errors, truncated }
}

ipcMain.handle('drop:scan-paths', async (event, payload) => {
  assertMainWindowSender(event)
  const { paths, region, action } = payload || {}
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > DROP_SCAN_MAX_ROOTS) {
    throw new Error(`一次只能拖入 1–${DROP_SCAN_MAX_ROOTS} 个路径`)
  }
  const ownerId = event.sender.id
  // 每个 sender 仅绑定一次：renderer 报错 / 切换 / 关闭时统一回收残留临时会话，
  // 避免连续拖入累积 destroyed 监听器（MaxListenersExceededWarning）。
  if (!boundDropDestroyListeners.has(ownerId)) {
    boundDropDestroyListeners.add(ownerId)
    event.sender.once('destroyed', () => {
      boundDropDestroyListeners.delete(ownerId)
      purgeOwnerSessions(ownerId)
    })
  }
  return scanDroppedPaths({ paths, region, action, ownerId })
})

// renderer 侧模块（PDF / 画布）按已扫描的 fileId 取回字节，重建 File 对象。
// 只允许读取本 sender 自己扫描会话产生的文件，读取后销毁会话。
ipcMain.handle('drop:read-file', async (event, fileId) => {
  assertMainWindowSender(event)
  if (typeof fileId !== 'string' || !fileId) throw new Error('文件标识无效')
  const entry = dropFileSessions.get(fileId)
  if (!entry || entry.ownerId !== event.sender.id) {
    throw new Error('文件会话不存在或无权访问')
  }
  dropFileSessions.delete(fileId)
  const data = await readFile(entry.path)
  return { name: entry.name, size: data.length, bytes: data }
})

function registerDefaultPdfOutput(ownerId, sourcePath, outputKind) {
  const childDirectory = PDF_DEFAULT_OUTPUT_DIRECTORIES[outputKind]
  if (!childDirectory) throw new Error('不支持的 PDF 默认输出目录')
  const id = randomUUID()
  const outputPath = join(dirname(sourcePath), childDirectory)
  pdfOutputSessions.set(id, {
    id,
    ownerId,
    mode: 'directory',
    path: outputPath
  })
  return { status: 'selected', id, mode: 'directory', path: outputPath, automatic: true }
}

ipcMain.handle('pdf:default-output', async (event, payload) => {
  assertMainWindowSender(event)
  const sourcePath = payload?.sourcePath
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('PDF 来源文件无效')
  const info = await stat(sourcePath).catch(() => null)
  if (!info?.isFile()) throw new Error('PDF 来源文件不存在')
  return registerDefaultPdfOutput(event.sender.id, sourcePath, payload?.outputKind)
})

ipcMain.handle('pdf:default-drop-output', async (event, payload) => {
  assertMainWindowSender(event)
  const entry = dropFileSessions.get(payload?.fileId)
  if (!entry || entry.ownerId !== event.sender.id) {
    throw new Error('拖入文件会话不存在或无权访问')
  }
  return registerDefaultPdfOutput(event.sender.id, entry.path, payload?.outputKind)
})

ipcMain.handle('pdf:release-output', (event, sessionId) => {
  assertMainWindowSender(event)
  const session = pdfOutputSessions.get(sessionId)
  if (!session || session.ownerId !== event.sender.id) return { status: 'missing' }
  pdfOutputSessions.delete(sessionId)
  return { status: 'released' }
})

function officeKindConfig(kind) {
  const configs = {
    word: {
      label: 'Word',
      extensions: ['doc', 'docx', 'docm', 'rtf']
    },
    excel: {
      label: 'Excel',
      extensions: ['xls', 'xlsx', 'xlsm', 'xlsb']
    },
    powerpoint: {
      label: 'PowerPoint',
      extensions: ['ppt', 'pptx', 'pptm']
    }
  }
  const config = configs[kind]
  if (!config) throw new Error('不支持的 Office 文件类型')
  return config
}

function getFormatResultDirectory() {
  return join(app.getPath('userData'), 'format-results')
}

function getFormatToolPath(tool) {
  const override = tool === 'ffmpeg'
    ? process.env.MOYU_FFMPEG_PATH
    : process.env.MOYU_FFPROBE_PATH
  if (!app.isPackaged && override) return override
  if (process.platform !== 'win32') {
    throw new Error('音视频格式工厂当前只随 Windows 发布包提供')
  }
  const fileName = `${tool}.exe`
  return app.isPackaged
    ? join(process.resourcesPath, 'tools', 'ffmpeg', fileName)
    : join(app.getAppPath(), 'build', 'ffmpeg', fileName)
}

function normalizeFormatKind(value) {
  if (!Object.hasOwn(FORMAT_EXTENSIONS, value)) throw new Error('不支持的格式工厂输入类型')
  return value
}

function getFormatInput(event, inputId) {
  const input = formatInputSessions.get(inputId)
  if (!input || input.ownerId !== event.sender.id) {
    throw new Error('格式工厂文件会话不存在或无权访问')
  }
  return input
}

function getFormatResult(event, resultId) {
  const result = formatResultSessions.get(resultId)
  if (!result || result.ownerId !== event.sender.id) {
    throw new Error('格式工厂结果会话不存在或无权访问')
  }
  return result
}

async function registerFormatInput(filePath, ownerId, kind) {
  const extension = extname(filePath).toLowerCase()
  if (!FORMAT_EXTENSIONS[kind].has(extension)) {
    throw new Error(`${basename(filePath)} 不是受支持的${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}文件`)
  }
  const info = await stat(filePath)
  if (!info.isFile() || info.size > FORMAT_MAX_FILE_BYTES) {
    throw new Error(`${basename(filePath)} 不是文件或超过 4 GB`)
  }

  const id = randomUUID()
  let dimensions = null
  let previewData = null
  if (kind === 'image') {
    const metadata = await (await loadSharp())(filePath, { animated: true }).metadata()
    dimensions = {
      width: metadata.width || 0,
      height: metadata.height || 0
    }
    previewData = new Uint8Array(
      await (await loadSharp())(filePath, { animated: true })
        .resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
    )
  }

  const input = {
    id,
    ownerId,
    path: filePath,
    name: basename(filePath),
    size: info.size,
    kind,
    extension,
    dimensions
  }
  formatInputSessions.set(id, input)
  return {
    id,
    name: input.name,
    size: input.size,
    kind,
    dimensions,
    previewData
  }
}

function sanitizeProcessError(error, paths = []) {
  let message = error instanceof Error ? error.message : String(error)
  paths.filter(Boolean).forEach((filePath) => {
    message = message.replaceAll(filePath, basename(filePath))
  })
  const normalized = message.toLowerCase()
  if (normalized.includes('no space left on device') || normalized.includes('disk full')) {
    return '磁盘空间不足，请清理输出磁盘后重试'
  }
  if (normalized.includes('permission denied') || normalized.includes('read-only file system')) {
    return '没有写入权限，请更换输出位置'
  }
  if (normalized.includes('invalid data found') || normalized.includes('moov atom not found') ||
      normalized.includes('error while decoding')) {
    return '输入文件已损坏或编码格式无法读取'
  }
  if (normalized.includes('unknown encoder') || normalized.includes('encoder not found')) {
    return '发布包缺少所需编码器，请重新安装完整版本'
  }
  if (normalized.includes('does not contain any stream') || normalized.includes('matches no streams') ||
      normalized.includes('output file does not contain any stream')) {
    return '输入文件没有可用的音轨'
  }
  if (normalized.includes('timed out') || normalized.includes('执行超时')) {
    return '转换超时，请检查文件是否损坏或尝试较小文件'
  }
  return message.slice(-2000)
}

function runFormatProcess(command, args, options = {}) {
  const {
    timeoutMs = FORMAT_PROCESS_TIMEOUT_MS,
    task,
    onStderr
  } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    if (task) task.process = child

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('格式转换任务执行超时'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2 * 1024 * 1024)
      onStderr?.(chunk)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (task) task.process = null
      if (task?.cancelled) {
        reject(new Error('TASK_CANCELLED'))
      } else if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(stderr.slice(-4000) || `进程退出码 ${code}`))
      }
    })
  })
}

async function probeFormatMedia(input) {
  const result = await runFormatProcess(
    getFormatToolPath('ffprobe'),
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      input.path
    ],
    { timeoutMs: 3000 }
  )
  const data = JSON.parse(result.stdout)
  const video = data.streams?.find((stream) => stream.codec_type === 'video')
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio')
  return {
    duration: Number(data.format?.duration) || 0,
    bitrate: Number(data.format?.bit_rate) || 0,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    videoCodec: video?.codec_name || '',
    audioCodec: audio?.codec_name || '',
    sampleRate: Number(audio?.sample_rate) || 0
  }
}

function parseFfmpegTime(value) {
  const match = String(value).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function buildFfmpegArgs(action, input, outputPath, options) {
  const target = String(options?.target || '').toLowerCase()
  const quality = Math.min(35, Math.max(18, Number(options?.quality) || 23))
  const bitrate = Math.min(320, Math.max(64, Number(options?.audioBitrate) || 192))
  const sampleRate = [32000, 44100, 48000].includes(Number(options?.sampleRate))
    ? Number(options.sampleRate)
    : 44100
  const maxWidth = Math.min(3840, Math.max(0, Number(options?.maxWidth) || 0))
  const scaleArgs = maxWidth ? ['-vf', `scale='min(${maxWidth},iw)':-2`] : []

  if (action === 'video-convert') {
    if (!['mp4', 'mkv', 'webm'].includes(target)) throw new Error('不支持的视频输出格式')
    return target === 'webm'
      ? ['-y', '-i', input.path, ...scaleArgs, '-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus', outputPath]
      : ['-y', '-i', input.path, ...scaleArgs, '-c:v', 'libx264', '-crf', String(quality), '-preset', 'medium', '-c:a', 'aac', '-b:a', `${bitrate}k`, outputPath]
  }
  if (action === 'video-compress') {
    return ['-y', '-i', input.path, ...scaleArgs, '-c:v', 'libx264', '-crf', String(quality), '-preset', 'medium', '-c:a', 'aac', '-b:a', `${bitrate}k`, '-movflags', '+faststart', outputPath]
  }
  if (action === 'extract-audio' || action === 'audio-convert') {
    const prefix = ['-y', '-i', input.path, '-vn', '-ar', String(sampleRate)]
    if (target === 'mp3') return [...prefix, '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, outputPath]
    if (target === 'aac' || target === 'm4a') return [...prefix, '-c:a', 'aac', '-b:a', `${bitrate}k`, outputPath]
    if (target === 'wav') return [...prefix, '-c:a', 'pcm_s16le', outputPath]
    if (target === 'flac') return [...prefix, '-c:a', 'flac', outputPath]
    throw new Error('不支持的音频输出格式')
  }
  throw new Error('不支持的 FFmpeg 任务')
}

function formatOutputExtension(action, options, input) {
  const target = String(options?.target || '').toLowerCase()
  if (action === 'video-compress') return 'mp4'
  if (['video-convert', 'extract-audio', 'audio-convert', 'image-convert'].includes(action)) {
    return target === 'jpeg' ? 'jpg' : target
  }
  if (action === 'image-compress') {
    return input.extension === '.jpeg' ? 'jpg' : input.extension.slice(1)
  }
  throw new Error('无法确定输出格式')
}

async function processFormatImage(action, input, outputPath, options) {
  const target = formatOutputExtension(action, options, input)
  const quality = Math.min(100, Math.max(10, Number(options?.quality) || 82))
  const maxWidth = Math.min(12000, Math.max(0, Number(options?.maxWidth) || 0))
  let pipeline = (await loadSharp())(input.path, { animated: target === 'gif', limitInputPixels: 400_000_000 })
    .rotate()
  if (maxWidth) {
    pipeline = pipeline.resize({
      width: maxWidth,
      fit: 'inside',
      withoutEnlargement: true
    })
  }
  if (target === 'jpg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true })
  else if (target === 'png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  else if (target === 'webp') pipeline = pipeline.webp({ quality, effort: 5 })
  else if (target === 'avif') pipeline = pipeline.avif({ quality, effort: 5 })
  else if (target === 'tif' || target === 'tiff') pipeline = pipeline.tiff({ compression: 'lzw', quality })
  else if (target === 'gif') pipeline = pipeline.gif({ effort: 7, colours: Math.max(32, Math.round(quality * 2.56)) })
  else throw new Error('不支持的图片输出格式')
  const info = await pipeline.toFile(outputPath)
  return { width: info.width, height: info.height, format: info.format }
}

async function registerFormatResult(event, outputPath, input, metadata = null) {
  const info = await stat(outputPath)
  const id = randomUUID()
  const result = {
    id,
    ownerId: event.sender.id,
    path: outputPath,
    name: basename(outputPath),
    size: info.size,
    inputId: input.id,
    inputName: input.name,
    metadata
  }
  formatResultSessions.set(id, result)
  return {
    id,
    inputId: input.id,
    inputName: input.name,
    name: result.name,
    size: result.size,
    metadata
  }
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

async function ensureOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const languageDirectory = join(app.getPath('userData'), 'ocr-data')
      await mkdir(languageDirectory, { recursive: true })
      await Promise.all(
        OCR_MODELS.map((model) =>
          copyFileIfChanged(model.source, join(languageDirectory, `${model.code}.traineddata.gz`))
        )
      )
      const { createWorker, OEM } = await loadTesseract()
      return createWorker(
        OCR_MODELS.map((model) => model.code),
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
    pinnedScreenshotSessions.forEach((session) => session.window.close())
    if (reusableScreenshotOverlay && !reusableScreenshotOverlay.isDestroyed()) {
      reusableScreenshotOverlay.destroy()
    }
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

ipcMain.handle('com:probe', async (event) => {
  assertMainWindowSender(event)
  return runComCommand(event, 'probe', {})
})

ipcMain.handle('illustrator:pick-files', async (event) => {
  assertMainWindowSender(event)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: '选择 Illustrator 文件',
    filters: [{ name: 'Adobe Illustrator', extensions: ['ai'] }],
    properties: ['openFile', 'multiSelections']
  })
  if (result.canceled) return []
  const files = []
  for (const filePath of result.filePaths.slice(0, 500)) {
    files.push(await registerIllustratorInput(filePath, event.sender.id))
  }
  return files
})

ipcMain.handle('illustrator:add-paths', async (event, paths) => {
  assertMainWindowSender(event)
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) {
    throw new Error('一次只能拖入 1–500 个 Illustrator 文件')
  }
  const files = []
  const errors = []
  for (const filePath of paths) {
    try {
      if (typeof filePath !== 'string' || !filePath) throw new Error('文件路径无效')
      files.push(await registerIllustratorInput(filePath, event.sender.id))
    } catch (error) {
      errors.push(error.message)
    }
  }
  return { status: 'selected', files, errors }
})

ipcMain.handle('illustrator:pick-folder', async (event) => {
  assertMainWindowSender(event)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: '选择 Illustrator 文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return []
  return collectIllustratorFolder(result.filePaths[0], event.sender.id)
})

ipcMain.handle('illustrator:remove-inputs', (event, inputIds) => {
  assertMainWindowSender(event)
  const ids = Array.isArray(inputIds) ? inputIds : []
  for (const id of ids) {
    const input = illustratorInputSessions.get(id)
    if (input?.ownerId === event.sender.id) illustratorInputSessions.delete(id)
  }
  return { status: 'removed' }
})

ipcMain.handle('illustrator:run', async (event, payload) => {
  assertMainWindowSender(event)
  const ids = Array.isArray(payload?.inputIds) ? payload.inputIds : []
  if (!ids.length || ids.length > 500) {
    throw new Error('请选择 1–500 个 Illustrator 文件')
  }
  const action = ['standard-pdf', 'minimal-pdf', 'outline'].includes(payload?.action)
    ? payload.action
    : null
  if (!action) throw new Error('不支持的 Illustrator 任务')
  if (activeIllustratorTasks.has(event.sender.id)) {
    throw new Error('已有 Illustrator 任务正在执行')
  }

  const inputs = ids.map((id) => illustratorSession(event, id))
  let outputDirectory = null
  if (!payload.sameDirectory) {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showOpenDialog(ownerWindow, {
      title: '选择 Illustrator 输出文件夹',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (selection.canceled || !selection.filePaths[0]) return { status: 'cancelled', outputs: [] }
    outputDirectory = selection.filePaths[0]
  }

  const files = []
  for (const input of inputs) {
    const sourceBase = basename(input.path, extname(input.path))
    const directory = outputDirectory || dirname(input.path)
    const extension = action === 'outline' ? 'ai' : 'pdf'
    const outputBase = action === 'outline'
      ? `${sourceBase}-OL`
      : action === 'minimal-pdf'
        ? `${sourceBase}-min`
        : sourceBase
    files.push({
      inputPath: input.path,
      outputPath: await availableOutputPath(directory, outputBase, extension),
      name: input.name
    })
  }

  const taskId = randomUUID()
  activeIllustratorTasks.set(event.sender.id, taskId)
  try {
    const result = await runComCommand(
      event,
      'illustrator-batch',
      { action, files },
      {
        id: taskId,
        timeoutMs: 2 * 60 * 60 * 1000,
        progressChannel: 'illustrator:progress'
      }
    )
    for (const output of result.outputs) {
      await assertOutputFile(output.outputPath, output.name)
    }
    const outputs = result.outputs.map((output) => registerComResult(event.sender.id, output.outputPath))
    return { status: 'completed', outputs }
  } catch (error) {
    if (error.message === 'TASK_CANCELLED') return { status: 'cancelled', outputs: [] }
    throw error
  } finally {
    activeIllustratorTasks.delete(event.sender.id)
  }
})

ipcMain.handle('illustrator:cancel', (event) => {
  assertMainWindowSender(event)
  const taskId = activeIllustratorTasks.get(event.sender.id)
  return { status: taskId && cancelComCommand(taskId) ? 'cancelling' : 'idle' }
})

ipcMain.handle('office:pick-file', async (event, kind) => {
  assertMainWindowSender(event)
  const config = officeKindConfig(kind)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: `选择 ${config.label} 文件`,
    filters: [{ name: `${config.label} 文档`, extensions: config.extensions }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return null
  const filePath = result.filePaths[0]
  const info = await stat(filePath)
  if (!info.isFile() || info.size > 2 * 1024 * 1024 * 1024) {
    throw new Error('Office 文件无效或超过 2 GB')
  }
  const id = randomUUID()
  officeInputSessions.set(id, {
    id,
    ownerId: event.sender.id,
    kind,
    path: filePath,
    name: basename(filePath),
    size: info.size
  })
  return { id, name: basename(filePath), size: info.size, kind }
})

ipcMain.handle('office:to-pdf', async (event, payload) => {
  assertMainWindowSender(event)
  const inputId = payload?.inputId
  const input = officeInputSessions.get(inputId)
  if (!input || input.ownerId !== event.sender.id) {
    throw new Error('Office 文件会话不存在或无权访问')
  }
  const destination = getPdfOutputSession(event, payload?.destinationId, 'file')
  const outputPath = destination.path
  await runComCommand(event, 'office-to-pdf', {
    kind: input.kind,
    inputPath: input.path,
    outputPath
  }, { timeoutMs: 20 * 60 * 1000 })
  await assertOutputFile(outputPath, `${officeKindConfig(input.kind).label} 转 PDF`)
  return {
    status: 'completed',
    result: registerComResult(event.sender.id, outputPath)
  }
})

ipcMain.handle('com:show-result', async (event, resultId) => {
  assertMainWindowSender(event)
  const result = comResultSessions.get(resultId)
  if (!result || result.ownerId !== event.sender.id) {
    throw new Error('输出文件会话不存在或无权访问')
  }
  shell.showItemInFolder(result.path)
  return { status: 'shown' }
})

// Spike / 正式链路：把条码 SVG 交给 Illustrator，递归解组后（可选）执行 app.copy()。
// mode='inspect' 只返回结构统计；mode='copy' 额外全选并复制到 Illustrator 原生剪贴板。
// ⚠ 仅 Windows + 已安装 Illustrator 可用；"复制后未编组"只对 Illustrator 承诺。
ipcMain.handle('barcode:illustrator-ungrouped-copy', async (event, payload) => {
  assertMainWindowSender(event)
  const normalized = normalizeBarcodeData('svg', payload?.data)
  if (Buffer.byteLength(normalized.data) > 20 * 1024 * 1024) {
    throw new Error('条码 SVG 超过 20 MB')
  }
  const temporaryDirectory = join(app.getPath('temp'), 'moyu-tools-com')
  await mkdir(temporaryDirectory, { recursive: true })
  const inputPath = join(temporaryDirectory, `${randomUUID()}.svg`)
  await writeFile(inputPath, normalized.data, 'utf8')
  try {
    const mode = ['copy', 'roundtrip'].includes(payload?.mode) ? payload.mode : 'inspect'
    const result = await runComCommand(
      event,
      'illustrator-ungrouped-copy',
      { inputPath, mode },
      { timeoutMs: 10 * 60 * 1000 }
    )
    // 失败语义：worker 在 report.error 或空报告时已抛错，
    // runComCommand 会 reject，本 IPC 直接以 Promise 抛错传出，不再包 status:'error'。
    const fields = result?.fields || {}
    // 判据：inspect 看 beforeGroups；roundtrip 以**粘贴后** pastedGroups 为准。
    const ungrouped =
      mode === 'roundtrip' ? Number(fields.pastedGroups) === 0 : Number(fields.beforeGroups) === 0
    return { status: 'ok', mode, ungrouped, fields, report: result.report }
  } finally {
    await unlink(inputPath).catch(() => {})
  }
})

ipcMain.handle('barcode:export-eps', async (event, payload) => {
  assertMainWindowSender(event)
  const normalized = normalizeBarcodeData('svg', payload?.data)
  if (Buffer.byteLength(normalized.data) > 20 * 1024 * 1024) {
    throw new Error('条码 SVG 超过 20 MB')
  }
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const selection = await dialog.showSaveDialog(ownerWindow, {
    title: '保存 EPS 条码',
    defaultPath: `${sanitizeFileBaseName(payload?.name, 'barcode')}.eps`,
    filters: [{ name: 'EPS 矢量图', extensions: ['eps'] }]
  })
  if (selection.canceled || !selection.filePath) return { status: 'cancelled' }
  const temporaryDirectory = join(app.getPath('temp'), 'moyu-tools-com')
  await mkdir(temporaryDirectory, { recursive: true })
  const inputPath = join(temporaryDirectory, `${randomUUID()}.svg`)
  await writeFile(inputPath, normalized.data, 'utf8')
  try {
    await runComCommand(event, 'illustrator-svg', {
      inputPath,
      outputPath: selection.filePath
    }, { timeoutMs: 10 * 60 * 1000 })
    await assertOutputFile(selection.filePath, 'EPS 条码')
    return {
      status: 'saved',
      result: registerComResult(event.sender.id, selection.filePath)
    }
  } finally {
    await unlink(inputPath).catch(() => {})
  }
})

ipcMain.handle('barcode:open-illustrator', async (event, payload) => {
  assertMainWindowSender(event)
  const normalized = normalizeBarcodeData('svg', payload?.data)
  const temporaryDirectory = join(app.getPath('temp'), 'moyu-tools-com')
  await mkdir(temporaryDirectory, { recursive: true })
  const inputPath = join(temporaryDirectory, `${randomUUID()}.svg`)
  await writeFile(inputPath, normalized.data, 'utf8')
  try {
    await runComCommand(event, 'illustrator-svg', { inputPath }, { timeoutMs: 10 * 60 * 1000 })
    return { status: 'opened' }
  } finally {
    await unlink(inputPath).catch(() => {})
  }
})

ipcMain.handle('barcode:open-photoshop', async (event, payload) => {
  assertMainWindowSender(event)
  const normalized = normalizeBarcodeData('png', payload?.data)
  const temporaryDirectory = join(app.getPath('temp'), 'moyu-tools-com')
  await mkdir(temporaryDirectory, { recursive: true })
  const inputPath = join(temporaryDirectory, `${randomUUID()}.png`)
  await writeFile(inputPath, await withBarcodePngDensity(normalized.data, normalized.fileType, payload?.density))
  try {
    await runComCommand(event, 'photoshop-open', { inputPath }, { timeoutMs: 10 * 60 * 1000 })
    return { status: 'opened' }
  } finally {
    await unlink(inputPath).catch(() => {})
  }
})

ipcMain.handle('barcode:copy-vector', (event, data) => {
  assertMainWindowSender(event)
  const normalized = normalizeBarcodeData('svg', data)
  const buffer = Buffer.from(normalized.data, 'utf8')
  if (buffer.byteLength > 20 * 1024 * 1024) {
    throw new Error('条码 SVG 超过 20 MB，已拒绝复制')
  }

  const format = process.platform === 'darwin' ? 'public.svg-image' : 'image/svg+xml'
  clipboard.writeBuffer(format, buffer)
  const copied = clipboard.readBuffer(format)
  if (!copied.equals(buffer)) throw new Error('条码 SVG 写入剪贴板失败')

  return { status: 'copied', format, bytes: buffer.byteLength }
})

ipcMain.handle('barcode:save-file', async (event, payload) => {
  assertMainWindowSender(event)
  const { data, fileType } = normalizeBarcodeData(payload?.type, payload?.data)

  if (Buffer.byteLength(data) > 20 * 1024 * 1024) {
    throw new Error('条码文件超过 20 MB，已拒绝保存')
  }

  const safeBaseName = sanitizeFileBaseName(payload.name, 'barcode')
  const defaultPath = `${safeBaseName}.${fileType.extension}`
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(ownerWindow, {
    title: `保存 ${fileType.extension.toUpperCase()} 条码`,
    defaultPath,
    filters: [
      {
        name: fileType.filterName,
        extensions: [fileType.extension]
      }
    ]
  })

  if (result.canceled || !result.filePath) {
    return { status: 'cancelled' }
  }

  await writeFile(result.filePath, await withBarcodePngDensity(data, fileType, payload?.density), fileType.encoding || undefined)
  return { status: 'saved', path: result.filePath }
})

ipcMain.handle('barcode:save-files', async (event, payload) => {
  assertMainWindowSender(event)
  if (!Array.isArray(payload?.files) || payload.files.length === 0 || payload.files.length > 500) {
    throw new Error('批量条码数量必须在 1–500 之间')
  }

  const normalizedFiles = payload.files.map((file) => {
    const normalized = normalizeBarcodeData(payload.type, file?.data)
    return {
      ...normalized,
      name: sanitizeFileBaseName(file?.name, 'barcode')
    }
  })
  const totalBytes = normalizedFiles.reduce((total, file) => total + Buffer.byteLength(file.data), 0)

  if (totalBytes > 100 * 1024 * 1024) {
    throw new Error('批量条码总大小超过 100 MB，已拒绝保存')
  }

  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: '选择批量条码保存文件夹',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  })

  if (result.canceled || !result.filePaths[0]) {
    return { status: 'cancelled', saved: 0 }
  }

  const directory = result.filePaths[0]
  const usedNames = new Map()

  for (const [index, file] of normalizedFiles.entries()) {
    const nameKey = file.name.toLocaleLowerCase('en-US')
    const occurrence = (usedNames.get(nameKey) || 0) + 1
    usedNames.set(nameKey, occurrence)
    const uniqueName = occurrence === 1 ? file.name : `${file.name}-${occurrence}`
    const filePath = join(directory, `${uniqueName}.${file.fileType.extension}`)
    await writeFile(filePath, await withBarcodePngDensity(file.data, file.fileType, payload?.density), file.fileType.encoding || undefined)
    event.sender.send('barcode:save-progress', {
      completed: index + 1,
      total: normalizedFiles.length,
      name: uniqueName
    })
  }

  return {
    status: 'saved',
    saved: normalizedFiles.length,
    directory
  }
})

ipcMain.handle('image:save-file', async (event, payload) => {
  assertMainWindowSender(event)
  const fileType = IMAGE_FILE_TYPES[payload?.type]
  const data = payload?.data instanceof Uint8Array
    ? Buffer.from(payload.data)
    : null

  if (!fileType || !data) {
    throw new Error('不支持的图片文件数据')
  }

  if (data.byteLength > 100 * 1024 * 1024) {
    throw new Error('图片文件超过 100 MB，已拒绝保存')
  }

  const safeBaseName = sanitizeFileBaseName(payload.name, 'edited-image')
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(ownerWindow, {
    title: `保存 ${fileType.filterName}`,
    defaultPath: `${safeBaseName}.${fileType.extension}`,
    filters: [
      {
        name: fileType.filterName,
        extensions: [fileType.extension]
      }
    ]
  })

  if (result.canceled || !result.filePath) {
    return { status: 'cancelled' }
  }

  const outputData = payload.type === 'tiff'
    ? await (await loadSharp())(data, { limitInputPixels: 400_000_000 })
      .tiff({ compression: 'lzw', quality: 92 })
      .toBuffer()
    : data
  await writeFile(result.filePath, outputData)
  return { status: 'saved', path: result.filePath }
})

ipcMain.handle('format:get-status', async (event) => {
  assertMainWindowSender(event)
  let ffmpegReady = false
  let ffmpegMessage = ''
  let ffmpegVersion = ''
  let missingEncoders = []
  try {
    const [ffmpegPath, ffprobePath] = [
      getFormatToolPath('ffmpeg'),
      getFormatToolPath('ffprobe')
    ]
    const [ffmpegInfo, ffprobeInfo] = await Promise.all([
      stat(ffmpegPath).catch(() => null),
      stat(ffprobePath).catch(() => null)
    ])
    ffmpegReady = Boolean(ffmpegInfo?.isFile() && ffprobeInfo?.isFile())
    if (!ffmpegReady) {
      ffmpegMessage = '请先执行 npm run build:tools:win'
    } else {
      const [versionResult, encodersResult] = await Promise.all([
        runFormatProcess(ffmpegPath, ['-version'], { timeoutMs: 5000 }),
        runFormatProcess(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 8000 })
      ])
      ffmpegVersion = versionResult.stdout.split(/\r?\n/, 1)[0].trim()
      const requiredEncoders = ['libx264', 'libvpx-vp9', 'libopus', 'libmp3lame']
      missingEncoders = requiredEncoders.filter((encoder) =>
        !encodersResult.stdout.includes(encoder)
      )
      if (missingEncoders.length) {
        ffmpegReady = false
        ffmpegMessage = `FFmpeg 缺少编码器：${missingEncoders.join('、')}`
      }
    }
  } catch (error) {
    ffmpegMessage = error.message
  }
  return {
    ffmpegReady,
    ffmpegMessage,
    ffmpegVersion,
    missingEncoders,
    sharp: (await loadSharp()).versions,
    platform: process.platform
  }
})

ipcMain.handle('format:pick-files', async (event, payload) => {
  assertMainWindowSender(event)
  const kind = normalizeFormatKind(payload?.kind)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const extensions = [...FORMAT_EXTENSIONS[kind]].map((extension) => extension.slice(1))
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: `选择${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}文件`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '支持的文件', extensions }]
  })
  if (result.canceled) return { status: 'cancelled', files: [] }
  if (result.filePaths.length > FORMAT_MAX_FILES) {
    throw new Error(`一次最多选择 ${FORMAT_MAX_FILES} 个文件`)
  }
  const files = []
  const errors = []
  for (const filePath of result.filePaths) {
    try {
      files.push(await registerFormatInput(filePath, event.sender.id, kind))
    } catch (error) {
      errors.push(error.message)
    }
  }
  return { status: 'selected', files, errors }
})

ipcMain.handle('format:add-paths', async (event, payload) => {
  assertMainWindowSender(event)
  const kind = normalizeFormatKind(payload?.kind)
  const paths = payload?.paths
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > FORMAT_MAX_FILES) {
    throw new Error(`一次只能拖入 1–${FORMAT_MAX_FILES} 个文件`)
  }
  const files = []
  const errors = []
  for (const filePath of paths) {
    try {
      if (typeof filePath !== 'string' || !filePath) throw new Error('文件路径无效')
      files.push(await registerFormatInput(filePath, event.sender.id, kind))
    } catch (error) {
      errors.push(error.message)
    }
  }
  return { status: 'selected', files, errors }
})

ipcMain.handle('format:pick-folder', async (event, payload) => {
  assertMainWindowSender(event)
  const kind = normalizeFormatKind(payload?.kind)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: '选择批量转换文件夹',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return { status: 'cancelled', files: [] }
  const directory = result.filePaths[0]
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && FORMAT_EXTENSIONS[kind].has(extname(entry.name).toLowerCase()))
    .slice(0, FORMAT_MAX_FILES)
  const files = []
  const errors = []
  for (const entry of candidates) {
    try {
      files.push(await registerFormatInput(join(directory, entry.name), event.sender.id, kind))
    } catch (error) {
      errors.push(error.message)
    }
  }
  return {
    status: 'selected',
    files,
    errors,
    truncated: candidates.length === FORMAT_MAX_FILES
  }
})

ipcMain.handle('format:remove-inputs', (event, inputIds) => {
  assertMainWindowSender(event)
  const ids = Array.isArray(inputIds) ? inputIds : []
  let removed = 0
  ids.forEach((id) => {
    const input = formatInputSessions.get(id)
    if (input?.ownerId === event.sender.id) {
      formatInputSessions.delete(id)
      removed += 1
    }
  })
  return { status: 'removed', count: removed }
})

ipcMain.handle('format:run', async (event, payload) => {
  assertMainWindowSender(event)
  const action = FORMAT_ACTIONS.get(payload?.action)
  if (!action) throw new Error('不支持的格式工厂任务')
  const inputIds = Array.isArray(payload?.inputIds) ? payload.inputIds : []
  if (!inputIds.length || inputIds.length > FORMAT_MAX_FILES) {
    throw new Error(`任务文件数量必须在 1–${FORMAT_MAX_FILES} 之间`)
  }
  const inputs = inputIds.map((id) => getFormatInput(event, id))
  const expectedKind = action.startsWith('video') || action === 'extract-audio'
    ? 'video'
    : action.startsWith('audio')
      ? 'audio'
      : 'image'
  if (inputs.some((input) => input.kind !== expectedKind)) {
    throw new Error('任务中包含与当前功能不匹配的文件')
  }

  const taskId = typeof payload?.taskId === 'string' && payload.taskId.length <= 80
    ? payload.taskId
    : randomUUID()
  if (formatTasks.has(taskId)) throw new Error('已有同名格式转换任务正在执行')
  const task = {
    id: taskId,
    ownerId: event.sender.id,
    cancelled: false,
    process: null
  }
  formatTasks.set(taskId, task)
  const outputDirectory = join(getFormatResultDirectory(), randomUUID())
  await mkdir(outputDirectory, { recursive: true })
  const results = []
  const errors = []

  try {
    for (const [index, input] of inputs.entries()) {
      if (task.cancelled) return { status: 'cancelled', taskId, results, errors }
      const extension = formatOutputExtension(action, payload?.options, input)
      const base = sanitizeFileBaseName(basename(input.name, extname(input.name)), `file-${index + 1}`)
      const suffix = action.includes('compress') ? 'compressed' : extension
      const outputPath = join(outputDirectory, `${base}-${suffix}.${extension}`)
      event.sender.send('format:progress', {
        taskId,
        status: 'running',
        inputId: input.id,
        completed: index,
        total: inputs.length,
        fileProgress: 0,
        name: input.name
      })

      try {
        let metadata
        if (input.kind === 'image') {
          metadata = await processFormatImage(action, input, outputPath, payload?.options)
          event.sender.send('format:progress', {
            taskId,
            status: 'running',
            inputId: input.id,
            completed: index,
            total: inputs.length,
            fileProgress: 1,
            name: input.name
          })
        } else {
          const sourceMetadata = await probeFormatMedia(input)
          if (action === 'extract-audio' && !sourceMetadata.audioCodec) {
            throw new Error('输入文件没有可用的音轨')
          }
          let stderrBuffer = ''
          const args = buildFfmpegArgs(action, input, outputPath, payload?.options)
          await runFormatProcess(getFormatToolPath('ffmpeg'), args, {
            task,
            onStderr: (chunk) => {
              stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2000)
              const matches = [...stderrBuffer.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)]
              const seconds = matches.length ? parseFfmpegTime(matches.at(-1)[1]) : 0
              const fileProgress = sourceMetadata.duration
                ? Math.min(0.99, seconds / sourceMetadata.duration)
                : 0
              event.sender.send('format:progress', {
                taskId,
                status: 'running',
                inputId: input.id,
                completed: index,
                total: inputs.length,
                fileProgress,
                name: input.name
              })
            }
          })
          metadata = await probeFormatMedia({ path: outputPath })
        }
        results.push(await registerFormatResult(event, outputPath, input, metadata))
      } catch (error) {
        if (error.message === 'TASK_CANCELLED') {
          return { status: 'cancelled', taskId, results, errors }
        }
        errors.push({
          inputId: input.id,
          name: input.name,
          message: sanitizeProcessError(error, [input.path, outputPath])
        })
      }

      event.sender.send('format:progress', {
        taskId,
        status: 'running',
        inputId: input.id,
        completed: index + 1,
        total: inputs.length,
        fileProgress: 1,
        name: input.name
      })
    }
    event.sender.send('format:progress', {
      taskId,
      status: 'complete',
      completed: inputs.length,
      total: inputs.length,
      fileProgress: 1
    })
    return { status: 'complete', taskId, results, errors }
  } finally {
    formatTasks.delete(taskId)
  }
})

ipcMain.handle('format:cancel', (event, taskId) => {
  assertMainWindowSender(event)
  const task = formatTasks.get(taskId)
  if (!task || task.ownerId !== event.sender.id) return { status: 'not-running' }
  task.cancelled = true
  if (task.process && !task.process.killed) task.process.kill()
  return { status: 'cancelling' }
})

ipcMain.handle('format:save-results', async (event, resultIds) => {
  assertMainWindowSender(event)
  const ids = Array.isArray(resultIds) ? resultIds : []
  if (!ids.length || ids.length > FORMAT_MAX_FILES) throw new Error('没有可保存的转换结果')
  const results = ids.map((id) => getFormatResult(event, id))
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)

  if (results.length === 1) {
    const result = results[0]
    const extension = extname(result.name).slice(1)
    const selection = await dialog.showSaveDialog(ownerWindow, {
      title: '保存格式转换结果',
      defaultPath: result.name,
      filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }]
    })
    if (selection.canceled || !selection.filePath) return { status: 'cancelled', saved: 0 }
    await copyFile(result.path, selection.filePath)
    return { status: 'saved', saved: 1, path: selection.filePath }
  }

  const selection = await dialog.showOpenDialog(ownerWindow, {
    title: '选择格式转换结果保存文件夹',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  })
  if (selection.canceled || !selection.filePaths[0]) return { status: 'cancelled', saved: 0 }
  const directory = selection.filePaths[0]
  const usedNames = new Map()
  for (const [index, result] of results.entries()) {
    const key = result.name.toLocaleLowerCase('en-US')
    const occurrence = (usedNames.get(key) || 0) + 1
    usedNames.set(key, occurrence)
    const extension = extname(result.name)
    const base = basename(result.name, extension)
    const uniqueName = occurrence === 1 ? result.name : `${base}-${occurrence}${extension}`
    await copyFile(result.path, join(directory, uniqueName))
    event.sender.send('format:progress', {
      status: 'saving',
      completed: index + 1,
      total: results.length,
      name: uniqueName
    })
  }
  return { status: 'saved', saved: results.length, directory }
})

ipcMain.handle('pdf:choose-output', async (event, payload) => {
  assertMainWindowSender(event)
  const mode = payload?.mode === 'directory' ? 'directory' : 'file'
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  let outputPath

  if (mode === 'directory') {
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: '选择 PDF 工具输出文件夹',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' }
    outputPath = result.filePaths[0]
  } else {
    const fileType = PDF_OUTPUT_TYPES[payload?.type]
    if (!fileType) throw new Error('不支持的 PDF 输出类型')
    const safeBaseName = sanitizeFileBaseName(payload?.name, 'pdf-output')
    const result = await dialog.showSaveDialog(ownerWindow, {
      title: `选择 ${fileType.filterName} 输出位置`,
      defaultPath: `${safeBaseName}.${fileType.extension}`,
      filters: [{ name: fileType.filterName, extensions: [fileType.extension] }]
    })
    if (result.canceled || !result.filePath) return { status: 'cancelled' }
    outputPath = result.filePath
  }

  const id = randomUUID()
  pdfOutputSessions.set(id, {
    id,
    ownerId: event.sender.id,
    mode,
    path: outputPath
  })
  return { status: 'selected', id, mode, path: outputPath }
})

ipcMain.handle('pdf:save-file', async (event, payload) => {
  assertMainWindowSender(event)
  const fileType = PDF_OUTPUT_TYPES[payload?.type]
  const data = payload?.data instanceof Uint8Array
    ? Buffer.from(payload.data)
    : null

  if (!fileType || !data) {
    throw new Error('不支持的 PDF 工具输出数据')
  }

  if (data.byteLength > 500 * 1024 * 1024) {
    throw new Error('输出文件超过 500 MB，已拒绝保存')
  }

  const destination = getPdfOutputSession(event, payload?.destinationId, 'file')
  await writeFile(destination.path, data)
  return { status: 'saved', path: destination.path }
})

ipcMain.handle('pdf:save-files', async (event, payload) => {
  assertMainWindowSender(event)
  const fileType = PDF_OUTPUT_TYPES[payload?.type]

  if (
    !fileType ||
    !Array.isArray(payload?.files) ||
    payload.files.length === 0 ||
    payload.files.length > 500
  ) {
    throw new Error('PDF 批量输出数量必须在 1–500 之间')
  }

  const normalizedFiles = payload.files.map((file) => {
    if (!(file?.data instanceof Uint8Array)) {
      throw new Error('PDF 批量输出包含无效文件数据')
    }

    return {
      name: sanitizeFileBaseName(file.name, 'pdf-output'),
      data: Buffer.from(file.data)
    }
  })
  const totalBytes = normalizedFiles.reduce((total, file) => total + file.data.byteLength, 0)

  if (totalBytes > 500 * 1024 * 1024) {
    throw new Error('PDF 批量输出总大小超过 500 MB，已拒绝保存')
  }

  const destination = getPdfOutputSession(event, payload?.destinationId, 'directory')
  const directory = destination.path
  await mkdir(directory, { recursive: true })
  const usedNames = new Map()

  for (const [index, file] of normalizedFiles.entries()) {
    const nameKey = file.name.toLocaleLowerCase('en-US')
    const occurrence = (usedNames.get(nameKey) || 0) + 1
    usedNames.set(nameKey, occurrence)
    const uniqueName = occurrence === 1 ? file.name : `${file.name}-${occurrence}`
    const outputPath = await availableOutputPath(directory, uniqueName, fileType.extension)
    await writeFile(outputPath, file.data)
    event.sender.send('pdf:save-progress', {
      completed: index + 1,
      total: normalizedFiles.length,
      name: uniqueName
    })
  }

  return {
    status: 'saved',
    saved: normalizedFiles.length,
    directory
  }
})

ipcMain.handle('pdf:show-item', async (event, payload) => {
  assertMainWindowSender(event)
  if (typeof payload?.path !== 'string' || !payload.path.trim()) {
    throw new Error('没有可打开的输出位置')
  }
  if (payload.directory) {
    const error = await shell.openPath(payload.path)
    if (error) throw new Error(error)
  } else {
    shell.showItemInFolder(payload.path)
  }
  return { status: 'shown' }
})

/**
 * 判断抓到的是不是黑帧。
 *
 * 全屏 Space 切换期间抓屏会拿到纯黑的过渡帧。宁可让用户重试，
 * 也不能把一张黑图当成截图交出去——用户会以为是自己框错了。
 */
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

/** 亮度低于此值的画面视为黑帧。留一点余量以容忍深色壁纸的极端情况。 */
const BLANK_CAPTURE_THRESHOLD = 8

/** 黑帧重试前给屏幕采集器一帧恢复时间；不改变任何应用窗口状态。 */
const CAPTURE_RETRY_DELAY_MS = 140

let screenCaptureKitBinaryPromise = null

async function ensureScreenCaptureKitBinary() {
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
async function captureDisplayScreenCaptureKit(display, physicalWidth, physicalHeight) {
  const binary = await ensureScreenCaptureKitBinary()
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
function createScreenshotOverlay(display) {
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
      // 完成位图解码与两帧绘制，避免“数据已到但窗口迟迟不出现”。
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
async function ensureScreenshotOverlay(display) {
  if (reusableScreenshotOverlay && !reusableScreenshotOverlay.isDestroyed()) {
    reusableScreenshotOverlay.setBounds(display.bounds, false)
    return reusableScreenshotOverlay
  }
  if (screenshotOverlayReadyPromise) return screenshotOverlayReadyPromise

  screenshotOverlayReadyPromise = (async () => {
    const overlay = createScreenshotOverlay(display)
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
      return captureDisplayScreenCaptureKit(display, physicalWidth, physicalHeight)
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
  const overlay = await ensureScreenshotOverlay(display)
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

// ── 汇总画布项目文件 .moyuboard（F-009 S5）────────────────────
const MOYUBOARD_MAX_BYTES = 512 * 1024 * 1024

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

ipcMain.handle('board:save', async (event, payload) => {
  assertMainWindowSender(event)
  const data = payload?.data instanceof Uint8Array ? Buffer.from(payload.data) : null
  if (!data || !data.byteLength) throw new Error('画布数据为空')
  if (data.byteLength > MOYUBOARD_MAX_BYTES) {
    throw new Error(`画布文件超过 ${MOYUBOARD_MAX_BYTES / 1024 / 1024} MB`)
  }
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const defaultName = `${sanitizeFileBaseName(payload?.name, 'board')}.moyuboard`
  const target = payload?.path && payload.overwrite
    ? { canceled: false, filePath: payload.path }
    : await dialog.showSaveDialog(ownerWindow, {
      title: '保存汇总画布',
      defaultPath: defaultName,
      filters: [{ name: '摸鱼画布', extensions: ['moyuboard'] }]
    })
  if (target.canceled || !target.filePath) return { status: 'cancelled' }
  await writeFile(target.filePath, data)
  return { status: 'saved', path: target.filePath, bytes: data.byteLength }
})

ipcMain.handle('board:open', async (event) => {
  assertMainWindowSender(event)
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(ownerWindow, {
    title: '打开汇总画布',
    properties: ['openFile'],
    filters: [{ name: '摸鱼画布', extensions: ['moyuboard'] }]
  })
  if (result.canceled || !result.filePaths?.length) return { status: 'cancelled' }
  const filePath = result.filePaths[0]
  const stats = await stat(filePath)
  if (stats.size > MOYUBOARD_MAX_BYTES) {
    throw new Error(`画布文件超过 ${MOYUBOARD_MAX_BYTES / 1024 / 1024} MB`)
  }
  const data = await readFile(filePath)
  return { status: 'opened', path: filePath, data: new Uint8Array(data) }
})

// ── 崩溃恢复快照（U5 / 规格 7.3）─────────────────────────────
//
// 恢复文件放在 userData 下，**不覆盖用户的正式工程**。
// 同时只维护当前画布一份。

function recoveryFilePath() {
  return join(app.getPath('userData'), 'board-recovery.moyuboard')
}

/**
 * 原子写：先写同目录下的临时文件，fsync 后再 rename 覆盖。
 *
 * 直接写目标文件的话，进程在写到一半时被杀（而这正是恢复功能要应对的
 * 场景）会留下半个文件，下次启动读到的是"看起来有、其实坏掉"的快照——
 * 比没有快照更糟。rename 在同一文件系统内是原子的。
 */
async function writeFileAtomic(filePath, data) {
  const temporary = `${filePath}.${process.pid}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filePath)
}

ipcMain.handle('recovery:write', async (event, payload) => {
  assertMainWindowSender(event)
  const data = payload?.data instanceof Uint8Array ? Buffer.from(payload.data) : null
  if (!data || !data.byteLength) throw new Error('恢复数据为空')
  if (data.byteLength > MOYUBOARD_MAX_BYTES) {
    throw new Error(`恢复数据超过 ${MOYUBOARD_MAX_BYTES / 1024 / 1024} MB`)
  }
  const meta = Buffer.from(JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    projectPath: typeof payload?.projectPath === 'string' ? payload.projectPath : null,
    byteLength: data.byteLength
  }))
  // 头 4 字节记元数据长度，随后是元数据 JSON，再是画布字节
  const header = Buffer.alloc(4)
  header.writeUInt32LE(meta.byteLength, 0)
  await writeFileAtomic(recoveryFilePath(), Buffer.concat([header, meta, data]))
  return { status: 'written', bytes: data.byteLength }
})

ipcMain.handle('recovery:read', async (event) => {
  assertMainWindowSender(event)
  const filePath = recoveryFilePath()
  if (!existsSync(filePath)) return { status: 'none' }
  const raw = await readFile(filePath)
  // 任何不自洽都必须报错，绝不返回半份快照
  if (raw.byteLength < 4) return { status: 'corrupt', reason: '恢复文件头不完整' }
  const metaLength = raw.readUInt32LE(0)
  if (metaLength <= 0 || 4 + metaLength > raw.byteLength) {
    return { status: 'corrupt', reason: '恢复文件元数据长度越界' }
  }
  let meta
  try {
    meta = JSON.parse(raw.subarray(4, 4 + metaLength).toString('utf8'))
  } catch {
    return { status: 'corrupt', reason: '恢复文件元数据无法解析' }
  }
  if (!Number.isInteger(meta?.version) || meta.version < 1) {
    return { status: 'corrupt', reason: '恢复文件版本无法识别' }
  }
  if (meta.version > 1) {
    return { status: 'corrupt', reason: `恢复文件版本 ${meta.version} 高于本程序支持的 1` }
  }
  const board = raw.subarray(4 + metaLength)
  if (!board.byteLength) return { status: 'corrupt', reason: '恢复文件缺少画布数据' }
  if (meta.byteLength !== board.byteLength) {
    return { status: 'corrupt', reason: '恢复文件已截断' }
  }
  return {
    status: 'found',
    savedAt: meta.savedAt,
    projectPath: meta.projectPath,
    data: new Uint8Array(board)
  }
})

ipcMain.handle('recovery:clear', async (event) => {
  assertMainWindowSender(event)
  const filePath = recoveryFilePath()
  if (existsSync(filePath)) await rm(filePath, { force: true })
  return { status: 'cleared' }
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

function isScreenshotActionSender(event) {
  if (mainWindow && event.sender === mainWindow.webContents) return true
  return [...screenshotSessions.values()].some((session) =>
    !session.overlay.isDestroyed() && event.sender === session.overlay.webContents)
}

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
    const worker = await ensureOcrWorker()
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

// ── 全局截图快捷键（规格 6 / F-16）──────────────────────────
//
// 只在应用运行期间有效，退出时注销——全局快捷键是进程级资源，
// 不注销会一直占着，直到下次开机。
//
// F-16：默认 Ctrl+Shift+A 与飞书冲突。这类冲突**不是两边都能同时解决的**，
// 所以不去抢占，改为让用户自己改或关掉。设置存在 userData 下，
// 与工程文件分开。
const DEFAULT_CAPTURE_SHORTCUT = 'Control+Shift+A'
const SHORTCUT_SETTINGS_FILE = () => join(app.getPath('userData'), 'shortcuts.json')

/** 当前生效的加速键；null 表示用户主动关闭了全局快捷键。 */
let captureShortcut = DEFAULT_CAPTURE_SHORTCUT

function readShortcutSettings() {
  try {
    const raw = readFileSync(SHORTCUT_SETTINGS_FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    // 显式的 null 表示"用户关掉了"，与"没配过"不同，不能被默认值覆盖
    if (Object.prototype.hasOwnProperty.call(parsed, 'capture')) {
      return parsed.capture === null ? null : String(parsed.capture)
    }
  } catch { /* 文件不存在或损坏都按默认处理 */ }
  return DEFAULT_CAPTURE_SHORTCUT
}

function writeShortcutSettings(accelerator) {
  try {
    writeFileSync(SHORTCUT_SETTINGS_FILE(), JSON.stringify({ capture: accelerator }, null, 2), 'utf8')
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

/** 注册失败的提示；渲染端就绪前先攒着，就绪后再送一次。 */
let pendingShortcutNotice = null

function notifyShortcutStatus(payload) {
  const target = mainWindow?.webContents
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
function triggerCaptureShortcut() {
  if (screenshotSessions.size > 0) return
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
/** 当前已注册成功的加速键，用于精确注销。null 表示当前没有注册任何键。 */
let registeredShortcut = null

function registerCaptureShortcut() {
  // ⚠ 只注销**自己上一次注册的那个**，不要用 unregisterAll()。
  //   unregisterAll 会清掉进程里所有全局快捷键——现在只有一个所以看不出
  //   问题，但将来任何一个新增的全局键都会被这里悄悄清掉。
  if (registeredShortcut) {
    try { globalShortcut.unregister(registeredShortcut) } catch { /* 已经没了就算了 */ }
    registeredShortcut = null
  }
  if (captureShortcut === null) {
    notifyShortcutStatus({ ok: true, disabled: true, accelerator: null,
      message: '全局截图快捷键已关闭，可继续用界面上的截图按钮。' })
    return { ok: true, disabled: true }
  }
  if (!isValidAccelerator(captureShortcut)) {
    notifyShortcutStatus({ ok: false, accelerator: captureShortcut,
      message: `快捷键「${captureShortcut}」格式无效，需要至少一个修饰键加一个普通按键。` })
    return { ok: false, reason: 'invalid' }
  }
  let ok = false
  try {
    ok = globalShortcut.register(captureShortcut, triggerCaptureShortcut)
  } catch {
    ok = false
  }
  // register 返回 false 或抛错都算失败；无论哪种，应用都要继续跑
  if (!ok) {
    notifyShortcutStatus({
      ok: false,
      accelerator: captureShortcut,
      reason: 'taken',
      message: `快捷键 ${captureShortcut} 已被其他应用占用，未能注册。` +
        '可以在设置里换一个组合，或关闭全局快捷键；界面上的截图按钮不受影响。'
    })
    return { ok: false, reason: 'taken' }
  }
  registeredShortcut = captureShortcut
  notifyShortcutStatus({ ok: true, accelerator: captureShortcut })
  return { ok: true, accelerator: captureShortcut }
}

// ── 设置页用的 IPC ──────────────────────────────────────────

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
  const result = registerCaptureShortcut()
  if (!result.ok) {
    captureShortcut = previous
    registerCaptureShortcut() // 把原来能用的那个恢复回去
    return { ok: false, reason: result.reason, accelerator: previous,
      message: result.reason === 'taken'
        ? `${next} 已被其他应用占用，已保留原有设置。`
        : `${next} 格式无效，已保留原有设置。` }
  }
  writeShortcutSettings(captureShortcut)
  return { ok: true, accelerator: captureShortcut, disabled: captureShortcut === null }
})

ipcMain.handle('shortcut:reset', (event) => {
  assertMainWindowSender(event)
  const previous = captureShortcut
  captureShortcut = DEFAULT_CAPTURE_SHORTCUT
  const result = registerCaptureShortcut()
  if (!result.ok) {
    captureShortcut = previous
    registerCaptureShortcut()
    return { ok: false, reason: result.reason, accelerator: previous,
      message: `默认组合 ${DEFAULT_CAPTURE_SHORTCUT} 当前被其他应用占用，已保留原有设置。` }
  }
  writeShortcutSettings(captureShortcut)
  return { ok: true, accelerator: captureShortcut }
})

// 渲染端就绪后补发注册结果
ipcMain.on('shortcut:ready', (event) => {
  if (event.sender !== mainWindow?.webContents) return
  if (!pendingShortcutNotice) return
  event.sender.send('shortcut:status', pendingShortcutNotice)
  pendingShortcutNotice = null
})

app.whenReady().then(() => {
  // 隐藏 Electron 默认原生菜单栏（File/Edit/...），应用使用自身渲染层界面。
  Menu.setApplicationMenu(null)
  // macOS 首次截图若在点击后才编译 ScreenCaptureKit 侧车，会额外等待约一秒。
  // 启动后后台预热；失败时 promise 会自行复位，真正截图仍会重试并给出明确错误。
  if (process.platform === 'darwin') {
    void ensureScreenCaptureKitBinary().catch((error) => {
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
  void ensureScreenshotOverlay(screen.getPrimaryDisplay()).catch((error) => {
    console.warn('截图覆盖层预加载失败：', error?.message || error)
  })
  // 启动时按用户设置注册；没配过就是默认组合（F-16）
  captureShortcut = readShortcutSettings()
  registerCaptureShortcut()

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
  ocrWorkerPromise?.then((worker) => worker.terminate()).catch(() => {})
  if (comWorker) {
    comWorker.kill()
    comWorker = null
  }
})
