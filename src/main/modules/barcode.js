import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSharp } from '../lib/lazyModules.js'
import { assertOutputFile, sanitizeFileBaseName } from '../lib/outputPath.js'
import { registerComResult, runComCommand } from './comWorker.js'

// 条码文件落盘（单个/批量保存、复制矢量到剪贴板、转 Illustrator/Photoshop）。
// image:save-file 不是条码专属（编辑后的截图/图片另存为），但同样是
// "小文件 + 保存对话框"的模式，体量太小不值得单独开一个模块，放在这里。

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

export function registerBarcodeHandlers({ ipcMain, dialog, BrowserWindow, clipboard, app, utilityProcess, assertMainWindowSender }) {
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
        { app, utilityProcess },
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
      await runComCommand({ app, utilityProcess }, event, 'illustrator-svg', {
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
      await runComCommand({ app, utilityProcess }, event, 'illustrator-svg', { inputPath }, { timeoutMs: 10 * 60 * 1000 })
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
      await runComCommand({ app, utilityProcess }, event, 'photoshop-open', { inputPath }, { timeoutMs: 10 * 60 * 1000 })
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
    const errors = []
    let saved = 0

    // 逐个 try/catch 而不是整批一次失败就抛出：磁盘中途满了、某个文件名在
    // 当前系统下恰好不合法这类问题只影响那一个文件，不该让前面已经成功写盘
    // 的文件也白跑一遍——批量重试时只需要重试 errors 里记录的那几个。
    for (const [index, file] of normalizedFiles.entries()) {
      const nameKey = file.name.toLocaleLowerCase('en-US')
      const occurrence = (usedNames.get(nameKey) || 0) + 1
      usedNames.set(nameKey, occurrence)
      const uniqueName = occurrence === 1 ? file.name : `${file.name}-${occurrence}`
      const filePath = join(directory, `${uniqueName}.${file.fileType.extension}`)
      try {
        await writeFile(filePath, await withBarcodePngDensity(file.data, file.fileType, payload?.density), file.fileType.encoding || undefined)
        saved += 1
      } catch (error) {
        errors.push({ index, name: uniqueName, message: error instanceof Error ? error.message : String(error) })
      }
      event.sender.send('barcode:save-progress', {
        completed: index + 1,
        total: normalizedFiles.length,
        name: uniqueName
      })
    }

    return {
      status: 'saved',
      saved,
      failed: errors.length,
      errors,
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
}
