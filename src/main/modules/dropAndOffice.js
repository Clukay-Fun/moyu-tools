import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { writeFileAtomic } from '../lib/atomicWrite.js'
import { assertOutputFile, availableOutputPath, sanitizeFileBaseName } from '../lib/outputPath.js'
import { FORMAT_EXTENSIONS, FORMAT_MAX_FILE_BYTES, FORMAT_MAX_FILES, registerFormatInput } from './formatFactory.js'
import { ILLUSTRATOR_MAX_BYTES, purgeIllustratorSessions, registerIllustratorInput } from './illustrator.js'
import { registerComResult, runComCommand } from './comWorker.js'

// 统一拖入扫描（F-017：文件夹 / 混合拖入）+ Office 转 PDF + PDF 工具的输出位置管理。
// 这三块放一个模块，是因为它们共用同一套"临时会话表"（dropFileSessions /
// officeInputSessions / pdfOutputSessions）与同一个 purgeOwnerSessions 清理入口，
// 硬拆成三个文件反而会把这份共享状态摊得更散、更难看出谁负责清理谁。
//
// renderer 只提交拖入的路径集合 + 目标区域（及动作），由主进程负责目录识别、
// 递归扫描与按区域规则校验；返回 { files, skipped, errors, truncated }。
// 不向 renderer 暴露任何目录读取 API：renderer 侧模块（PDF / 画布）通过不透明的
// fileId 取回字节，fileId 由扫描会话按 sender 注册，读取时校验归属。

const PDF_OUTPUT_TYPES = {
  pdf: { extension: 'pdf', filterName: 'PDF 文档' },
  png: { extension: 'png', filterName: 'PNG 图片' },
  jpeg: { extension: 'jpg', filterName: 'JPEG 图片' },
  txt: { extension: 'txt', filterName: '文本文件' }
}

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

const officeInputSessions = new Map()
const pdfOutputSessions = new Map()

function getPdfOutputSession(event, sessionId, mode) {
  const session = pdfOutputSessions.get(sessionId)
  if (!session || session.ownerId !== event.sender.id || session.mode !== mode) {
    throw new Error('PDF 输出位置会话不存在、已失效或类型不匹配')
  }
  return session
}

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
  purgeIllustratorSessions(ownerId)
}

export function bindOwnerSessionCleanup(sender) {
  const ownerId = sender.id
  if (boundDropDestroyListeners.has(ownerId)) return
  boundDropDestroyListeners.add(ownerId)
  sender.once('destroyed', () => {
    boundDropDestroyListeners.delete(ownerId)
    purgeOwnerSessions(ownerId)
  })
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

function officeKindConfig(kind) {
  const configs = {
    word: { label: 'Word', extensions: ['doc', 'docx', 'docm', 'rtf'] },
    excel: { label: 'Excel', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb'] },
    powerpoint: { label: 'PowerPoint', extensions: ['ppt', 'pptx', 'pptm'] }
  }
  const config = configs[kind]
  if (!config) throw new Error('不支持的 Office 文件类型')
  return config
}

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

export function registerDropAndOfficeHandlers({
  ipcMain,
  dialog,
  BrowserWindow,
  shell,
  app,
  utilityProcess,
  assertMainWindowSender
}) {
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
    bindOwnerSessionCleanup(event.sender)
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
    await runComCommand({ app, utilityProcess }, event, 'office-to-pdf', {
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
    const reservedOutputPaths = new Set()

    for (const [index, file] of normalizedFiles.entries()) {
      const nameKey = file.name.toLocaleLowerCase('en-US')
      const occurrence = (usedNames.get(nameKey) || 0) + 1
      usedNames.set(nameKey, occurrence)
      const uniqueName = occurrence === 1 ? file.name : `${file.name}-${occurrence}`
      const outputPath = await availableOutputPath(directory, uniqueName, fileType.extension, reservedOutputPaths)
      await writeFileAtomic(outputPath, file.data)
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
}
