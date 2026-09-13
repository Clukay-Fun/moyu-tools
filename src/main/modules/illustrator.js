import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { assertOutputFile, availableOutputPath } from '../lib/outputPath.js'
import { cancelComCommand, registerComResult, runComCommand } from './comWorker.js'

// Illustrator 批处理（导出 PDF / 最小化 PDF / 文字转曲）。
// registerIllustratorInput / ILLUSTRATOR_MAX_BYTES 也被 index.js 的统一拖入
// 扫描（DROP_REGION_CONFIG.illustrator）复用，所以要导出，不能只在本模块内用。

export const ILLUSTRATOR_MAX_BYTES = 2 * 1024 * 1024 * 1024

const illustratorInputSessions = new Map()
const activeIllustratorTasks = new Map()

function illustratorSession(event, inputId) {
  const input = illustratorInputSessions.get(inputId)
  if (!input || input.ownerId !== event.sender.id) {
    throw new Error('Illustrator 文件会话不存在或无权访问')
  }
  return input
}

export async function registerIllustratorInput(filePath, ownerId) {
  if (extname(filePath).toLowerCase() !== '.ai') {
    throw new Error(`${basename(filePath)} 不是 Illustrator 文件`)
  }
  const info = await stat(filePath)
  if (!info.isFile() || info.size > ILLUSTRATOR_MAX_BYTES) {
    throw new Error(`${basename(filePath)} 不是文件或超过 2 GB`)
  }
  for (const input of illustratorInputSessions.values()) {
    if (input.ownerId === ownerId && input.path === filePath) {
      return { id: input.id, name: input.name, size: input.size }
    }
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
    try {
      if (entry.isDirectory()) {
        await collectIllustratorFolder(entryPath, ownerId, output)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.ai') {
        output.push(await registerIllustratorInput(entryPath, ownerId))
      }
    } catch {
      // 单个无权限目录或失效文件不应中断整次文件夹导入。
    }
  }
  return output
}

/** 供 index.js 的 purgeOwnerSessions 在 sender 销毁时一并回收。 */
export function purgeIllustratorSessions(ownerId) {
  for (const [id, entry] of illustratorInputSessions) {
    if (entry.ownerId === ownerId) illustratorInputSessions.delete(id)
  }
}

export function registerIllustratorHandlers({
  ipcMain,
  dialog,
  BrowserWindow,
  app,
  utilityProcess,
  assertMainWindowSender,
  bindOwnerSessionCleanup
}) {
  ipcMain.handle('illustrator:pick-files', async (event) => {
    assertMainWindowSender(event)
    bindOwnerSessionCleanup(event.sender)
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
    bindOwnerSessionCleanup(event.sender)
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
    bindOwnerSessionCleanup(event.sender)
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
    // 同批不同来源文件夹里可能有同名文件（如两个 logo.ai），若合流到同一个
    // 输出目录，这一批里没有谁先写盘，磁盘检查看谁都"不存在"——必须靠这个
    // 跨迭代共享的 reserved 集合互相占位，否则后一个会静默盖掉前一个的结果。
    const reservedOutputPaths = new Set()
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
        outputPath: await availableOutputPath(directory, outputBase, extension, reservedOutputPaths),
        name: input.name
      })
    }

    const taskId = randomUUID()
    activeIllustratorTasks.set(event.sender.id, taskId)
    try {
      const result = await runComCommand(
        { app, utilityProcess },
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
}
