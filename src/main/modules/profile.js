import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { loadSharp } from '../lib/lazyModules.js'

// 头像：只接受系统选图对话框返回的本地文件，主进程统一转成 256px PNG。
// 渲染进程拿不到路径，只能通过 moyu-file://avatar/avatar.png 读取结果。
const MAX_BYTES = 5 * 1024 * 1024
const AVATAR_SIZE = 256
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function profileDirectory(app) {
  return join(app.getPath('userData'), 'profile')
}

export function profileAvatarPath(app) {
  return join(profileDirectory(app), 'avatar.png')
}

async function avatarInfo(app) {
  const file = profileAvatarPath(app)
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size === 0) return { status: 'none' }
    return {
      status: 'ok',
      // mtime 作为查询串：换头像后 <img> 不会被 Chromium 的图片缓存挡住
      url: `moyu-file://avatar/avatar.png?v=${Math.round(info.mtimeMs)}`
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'none' }
    throw error
  }
}

export function registerProfileHandlers({ ipcMain, dialog, BrowserWindow, app, assertMainWindowSender }) {
  ipcMain.handle('profile:get-avatar', async (event) => {
    assertMainWindowSender(event)
    return avatarInfo(app)
  })

  ipcMain.handle('profile:choose-avatar', async (event) => {
    assertMainWindowSender(event)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择头像',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' }

    const source = result.filePaths[0]
    if (!ALLOWED_EXTENSIONS.has(extname(source).toLowerCase())) {
      throw new Error('头像只支持 PNG / JPG / WebP')
    }
    const info = await stat(source)
    if (!info.isFile()) throw new Error('请选择一个图片文件')
    if (info.size > MAX_BYTES) throw new Error('头像图片不能超过 5 MB')

    let buffer
    try {
      const sharp = await loadSharp()
      buffer = await sharp(source)
        .rotate()
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer()
    } catch {
      throw new Error('这张图片无法解析，请换一张 PNG / JPG / WebP')
    }

    const directory = profileDirectory(app)
    await mkdir(directory, { recursive: true })
    const target = profileAvatarPath(app)
    const temporary = `${target}.tmp`
    await writeFile(temporary, buffer)
    await rename(temporary, target)
    return avatarInfo(app)
  })

  ipcMain.handle('profile:clear-avatar', async (event) => {
    assertMainWindowSender(event)
    await unlink(profileAvatarPath(app)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    return { status: 'none' }
  })
}
