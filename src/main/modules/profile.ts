import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { loadSharp } from '../lib/lazyModules'
import type { App, IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import type { MainDeps } from '../lib/deps'

// 头像 / 应用 Logo / 背景图：只接受系统选图对话框返回的本地文件，主进程用 sharp 重新编码后落盘，
// 原文件里的元数据和非图像内容都不会带过来；SVG 等矢量格式不收。
// 渲染进程拿不到路径，只能通过 moyu-file://avatar/avatar.png、moyu-file://brand/<文件名> 读取结果。
const MAX_BYTES = 5 * 1024 * 1024
const BACKGROUND_MAX_BYTES = 20 * 1024 * 1024
const AVATAR_SIZE = 256
const LOGO_SIZE = 256
// 背景图最长边：够 5K 屏铺满，又不会把超大原图整张塞进渲染进程
const BACKGROUND_MAX_EDGE = 3840
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const LOGO_FILE = 'logo.png'
const BACKGROUND_FILE = 'background.webp'

type ProfileImageInfo = { status: 'none' } | { status: 'ok'; url: string }

function profileDirectory(app: App) {
  return join(app.getPath('userData'), 'profile')
}

export function profileAvatarPath(app: App): string {
  return join(profileDirectory(app), 'avatar.png')
}

async function fileInfo(app: App, name: string, host: string): Promise<ProfileImageInfo> {
  const file = join(profileDirectory(app), name)
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size === 0) return { status: 'none' }
    // mtime 作为查询串：换图后不会被 Chromium 的图片缓存挡住
    return { status: 'ok', url: `moyu-file://${host}/${name}?v=${Math.round(info.mtimeMs)}` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { status: 'none' }
    throw error
  }
}

async function brandInfo(app: App) {
  const [logo, background] = await Promise.all([
    fileInfo(app, LOGO_FILE, 'brand'),
    fileInfo(app, BACKGROUND_FILE, 'brand')
  ])
  return { logo, background }
}

/** 系统选图 → 校验扩展名与大小；取消返回 null */
async function pickImage(
  dialog: MainDeps['dialog'],
  BrowserWindow: MainDeps['BrowserWindow'],
  event: IpcMainInvokeEvent,
  { title, maxBytes, label }: { title: string; maxBytes: number; label: string }
): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const options: OpenDialogOptions = {
    title,
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  }
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const source = result.filePaths[0]
  if (!ALLOWED_EXTENSIONS.has(extname(source).toLowerCase())) {
    throw new Error(`${label}只支持 PNG / JPG / WebP`)
  }
  const info = await stat(source)
  if (!info.isFile()) throw new Error('请选择一个图片文件')
  if (info.size > maxBytes) throw new Error(`${label}不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
  return source
}

/** 先写临时文件再改名：写到一半崩溃也不会留下半张图 */
async function saveProfileFile(app: App, name: string, buffer: Buffer) {
  const directory = profileDirectory(app)
  await mkdir(directory, { recursive: true })
  const target = join(directory, name)
  const temporary = `${target}.tmp`
  await writeFile(temporary, buffer)
  await rename(temporary, target)
}

async function removeProfileFile(app: App, name: string) {
  await unlink(join(profileDirectory(app), name)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}

async function avatarInfo(app: App): Promise<ProfileImageInfo> {
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
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { status: 'none' }
    throw error
  }
}

export function registerProfileHandlers({
  ipcMain,
  dialog,
  BrowserWindow,
  app,
  assertMainWindowSender
}: Pick<MainDeps, 'ipcMain' | 'dialog' | 'BrowserWindow' | 'app' | 'assertMainWindowSender'>): void {
  ipcMain.handle('profile:get-avatar', async (event) => {
    assertMainWindowSender(event)
    return avatarInfo(app)
  })

  ipcMain.handle('profile:choose-avatar', async (event) => {
    assertMainWindowSender(event)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
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

  // ── 应用品牌：Logo 与背景图，和头像各存各的文件 ──
  ipcMain.handle('profile:get-brand', async (event) => {
    assertMainWindowSender(event)
    return brandInfo(app)
  })

  ipcMain.handle('profile:choose-logo', async (event) => {
    assertMainWindowSender(event)
    const source = await pickImage(dialog, BrowserWindow, event, { title: '选择应用 Logo', maxBytes: MAX_BYTES, label: 'Logo ' })
    if (!source) return { status: 'cancelled' }
    let buffer
    try {
      const sharp = await loadSharp()
      // Logo 完整显示，不裁切；空白处透明
      buffer = await sharp(source)
        .rotate()
        .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    } catch {
      throw new Error('这张图片无法解析，请换一张 PNG / JPG / WebP')
    }
    await saveProfileFile(app, LOGO_FILE, buffer)
    return (await brandInfo(app)).logo
  })

  ipcMain.handle('profile:clear-logo', async (event) => {
    assertMainWindowSender(event)
    await removeProfileFile(app, LOGO_FILE)
    return { status: 'none' }
  })

  ipcMain.handle('profile:choose-background', async (event) => {
    assertMainWindowSender(event)
    const source = await pickImage(dialog, BrowserWindow, event, {
      title: '选择背景图片',
      maxBytes: BACKGROUND_MAX_BYTES,
      label: '背景图片'
    })
    if (!source) return { status: 'cancelled' }
    let buffer
    try {
      const sharp = await loadSharp()
      buffer = await sharp(source)
        .rotate()
        .resize(BACKGROUND_MAX_EDGE, BACKGROUND_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer()
    } catch {
      throw new Error('这张图片无法解析，请换一张 PNG / JPG / WebP')
    }
    await saveProfileFile(app, BACKGROUND_FILE, buffer)
    return (await brandInfo(app)).background
  })

  ipcMain.handle('profile:clear-background', async (event) => {
    assertMainWindowSender(event)
    await removeProfileFile(app, BACKGROUND_FILE)
    return { status: 'none' }
  })

  ipcMain.handle('profile:clear-avatar', async (event) => {
    assertMainWindowSender(event)
    await unlink(profileAvatarPath(app)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    return { status: 'none' }
  })
}
