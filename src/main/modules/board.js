import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../lib/atomicWrite.js'
import { sanitizeFileBaseName } from '../lib/outputPath.js'

// 汇总画布项目文件 .moyuboard 的持久化（F-009 S5）与崩溃恢复快照（U5 / 规格 7.3）。
//
// 不含窗口关闭前的"未保存改动"握手（board:dirty / board:save-result /
// requestRendererSave）——那部分跟 mainWindow 的生命周期强耦合，留在
// src/main/index.js 的 createWindow() 旁边，跟真正的窗口关闭事件放在一起
// 比拆过来更好读。

export const MOYUBOARD_MAX_BYTES = 512 * 1024 * 1024

// 只有真的经"打开"或"另存为"对话框选中过的路径才允许后续静默覆盖——
// 不能只信 renderer 传来的 payload.path，那样任何能构造这个 IPC 调用的代码
// 路径都能让主进程写到任意文件。按 sender 隔离：不同窗口不共享授权。
const boardAuthorizedPaths = new WeakMap()

function authorizeBoardPath(sender, filePath) {
  let set = boardAuthorizedPaths.get(sender)
  if (!set) { set = new Set(); boardAuthorizedPaths.set(sender, set) }
  set.add(filePath)
}

function isBoardPathAuthorized(sender, filePath) {
  return Boolean(filePath && boardAuthorizedPaths.get(sender)?.has(filePath))
}

// 同一份工程的保存必须串行：并发调用（例如用户在保存对话框还没关闭时
// 又触发了自动保存）如果交错写同一个临时文件名，后完成的一个会覆盖前一个
// 还没来得及 rename 的临时文件，两次保存互相踩踏。按 sender 排队。
const boardSaveQueues = new WeakMap()

function enqueueBoardSave(sender, task) {
  const previous = boardSaveQueues.get(sender) || Promise.resolve()
  const next = previous.then(task, task)
  boardSaveQueues.set(sender, next.catch(() => {}))
  return next
}

function recoveryFilePath(app) {
  return join(app.getPath('userData'), 'board-recovery.moyuboard')
}

/**
 * 注册画布文件 IPC。调用方负责传入 assertMainWindowSender——
 * 校验逻辑依赖 index.js 里那个会被重新赋值的 mainWindow，
 * 传函数引用而非取值，闭包会一直看到最新的窗口实例。
 */
export function registerBoardHandlers({ ipcMain, dialog, BrowserWindow, app, assertMainWindowSender }) {
  ipcMain.handle('board:save', async (event, payload) => {
    assertMainWindowSender(event)
    const data = payload?.data instanceof Uint8Array ? Buffer.from(payload.data) : null
    if (!data || !data.byteLength) throw new Error('画布数据为空')
    if (data.byteLength > MOYUBOARD_MAX_BYTES) {
      throw new Error(`画布文件超过 ${MOYUBOARD_MAX_BYTES / 1024 / 1024} MB`)
    }
    return enqueueBoardSave(event.sender, async () => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender)
      const defaultName = `${sanitizeFileBaseName(payload?.name, 'board')}.moyuboard`
      const canOverwriteDirectly = Boolean(payload?.path && payload.overwrite)
        && isBoardPathAuthorized(event.sender, payload.path)
      if (payload?.path && payload.overwrite && !canOverwriteDirectly) {
        // 未经对话框授权的路径不直接拒绝，改走另存为对话框——renderer 可能只是
        // 丢了授权记录（比如重启后仅恢复了工程路径字符串），用户体验上仍应该
        // 能保存，只是要再确认一次落盘位置，而不是让主进程静默写任意路径。
        console.warn('[board:save] 路径未经授权，改走另存为对话框：', payload.path)
      }
      const target = canOverwriteDirectly
        ? { canceled: false, filePath: payload.path }
        : await dialog.showSaveDialog(ownerWindow, {
          title: '保存汇总画布',
          defaultPath: payload?.path || defaultName,
          filters: [{ name: '摸鱼画布', extensions: ['moyuboard'] }]
        })
      if (target.canceled || !target.filePath) return { status: 'cancelled' }
      // 原子写入：先写临时文件再 rename。写到一半失败/被杀/断电时，
      // 原工程文件（如果本来就存在）必须原样保留，不能变成半份数据。
      await writeFileAtomic(target.filePath, data)
      authorizeBoardPath(event.sender, target.filePath)
      return { status: 'saved', path: target.filePath, bytes: data.byteLength }
    })
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
    authorizeBoardPath(event.sender, filePath)
    return { status: 'opened', path: filePath, data: new Uint8Array(data) }
  })

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
    await writeFileAtomic(recoveryFilePath(app), Buffer.concat([header, meta, data]))
    return { status: 'written', bytes: data.byteLength }
  })

  ipcMain.handle('recovery:read', async (event) => {
    assertMainWindowSender(event)
    const filePath = recoveryFilePath(app)
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
    const filePath = recoveryFilePath(app)
    if (existsSync(filePath)) await rm(filePath, { force: true })
    return { status: 'cleared' }
  })
}
