import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { net } from 'electron'
import { loadSharp } from '../lib/lazyModules'
import { runFormatProcess } from '../lib/spawnProcess'
import { getFormatToolPath } from './formatFactory'
import type { MainDeps } from '../lib/deps'

// 视频转二维码的封面预览：只在用户填了有效链接后读取一次。
// 网页读 og:image / twitter:image 声明的封面；视频文件直链用 ffmpeg 截一帧（仅 Windows 随包带 ffmpeg）。
// 拿到的图都经 sharp 重新编码成小 WebP 再以 data: 交给 renderer，原始响应不会进渲染进程。
// 封面地址由对方网页决定，所以只当图片解码：解不出图就当没有封面，不回传任何响应内容。

const PAGE_TIMEOUT_MS = 8000
const IMAGE_TIMEOUT_MS = 8000
const FRAME_TIMEOUT_MS = 20000
const MAX_PAGE_BYTES = 1.5 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_URL_LENGTH = 4096
const COVER_WIDTH = 640
const COVER_HEIGHT = 360
// 不少视频站对没有浏览器 UA 的请求直接返回空页
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'm3u8', 'ts'])

type CoverResult = { status: 'ok'; image: string; title: string } | { status: 'none'; reason: string; title: string }

function parseHttpUrl(value: unknown, label: string): URL {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) throw new Error(`${label}无效`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}无效`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}只支持 http / https`)
  return url
}

function isVideoPath(url: URL) {
  const extension = url.pathname.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.has(extension)
}

/** 读响应体，超过上限就截断（网页只需要 <head> 里的 meta） */
async function readLimited(response: Response, limit: number, truncate: boolean): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        if (!truncate) throw new Error('文件过大')
        chunks.push(Buffer.from(value.subarray(0, value.byteLength - (total - limit))))
        break
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

async function request(url: URL, timeoutMs: number, referer?: string): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' }
  if (referer) headers.Referer = referer
  try {
    // net.fetch 走系统代理设置，和用户浏览器能打开的范围一致
    return await net.fetch(url.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') throw new Error('网页响应超时')
    throw new Error('网页打不开，请检查链接或网络')
  }
}

function decodeHtml(buffer: Buffer, contentType: string): string {
  const head = buffer.subarray(0, 4096).toString('latin1')
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buffer)
  } catch {
    return new TextDecoder('utf-8').decode(buffer)
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** 取 <meta property|name="key" content="..."> 的值，属性顺序不限 */
function metaContent(html: string, keys: string[]): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    if (!key || !keys.includes(key)) continue
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2]
    if (content?.trim()) return decodeEntities(content.trim())
  }
  return ''
}

function pageTitle(html: string): string {
  const title = metaContent(html, ['og:title', 'twitter:title']) ||
    decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  return title.replace(/\s+/g, ' ').trim().slice(0, 120)
}

async function toCoverDataUrl(input: Buffer | string): Promise<string> {
  const sharp = await loadSharp()
  const buffer = await sharp(input, { animated: false, limitInputPixels: 64_000_000 })
    .rotate()
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()
  return `data:image/webp;base64,${buffer.toString('base64')}`
}

async function fetchImage(url: URL, referer?: string): Promise<string | null> {
  const response = await request(url, IMAGE_TIMEOUT_MS, referer).catch(() => null)
  if (!response?.ok || !/^image\//i.test(response.headers.get('content-type') ?? 'image/')) return null
  const buffer = await readLimited(response, MAX_IMAGE_BYTES, false).catch(() => null)
  if (!buffer?.length) return null
  return toCoverDataUrl(buffer).catch(() => null)
}

/** 视频文件直链：ffmpeg 从第 1 秒截一帧（读取远程视频的开头一小段） */
async function grabFrame(app: MainDeps['app'], url: URL): Promise<string | null> {
  let ffmpeg: string
  try {
    ffmpeg = getFormatToolPath(app, 'ffmpeg')
  } catch {
    return null
  }
  const directory = join(app.getPath('temp'), 'moyu-tools-qr')
  await mkdir(directory, { recursive: true })
  const output = join(directory, `${randomUUID()}.jpg`)
  try {
    await runFormatProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-user_agent', USER_AGENT,
      '-ss', '1', '-i', url.href,
      '-frames:v', '1', '-vf', `scale=${COVER_WIDTH}:-2`, '-y', output
    ], { timeoutMs: FRAME_TIMEOUT_MS })
    return await toCoverDataUrl(await readFile(output))
  } catch {
    return null
  } finally {
    await rm(output, { force: true }).catch(() => {})
  }
}

async function fetchCover(app: MainDeps['app'], url: URL): Promise<CoverResult> {
  if (isVideoPath(url)) {
    const image = await grabFrame(app, url)
    return image
      ? { status: 'ok', image, title: '' }
      : { status: 'none', reason: process.platform === 'win32' ? '没能从视频里截到画面' : '视频文件的封面需要 Windows 版截取', title: '' }
  }

  const response = await request(url, PAGE_TIMEOUT_MS)
  if (!response.ok) return { status: 'none', reason: `网页返回 ${response.status}`, title: '' }
  const contentType = response.headers.get('content-type') ?? ''
  const finalUrl = new URL(response.url || url.href)
  if (/^image\//i.test(contentType)) {
    const buffer = await readLimited(response, MAX_IMAGE_BYTES, false).catch(() => null)
    const image = buffer?.length ? await toCoverDataUrl(buffer).catch(() => null) : null
    return image ? { status: 'ok', image, title: '' } : { status: 'none', reason: '图片无法解析', title: '' }
  }
  if (/^video\//i.test(contentType)) {
    await response.body?.cancel().catch(() => {})
    const image = await grabFrame(app, finalUrl)
    return image ? { status: 'ok', image, title: '' } : { status: 'none', reason: '没能从视频里截到画面', title: '' }
  }
  if (contentType && !/html|xml/i.test(contentType)) {
    await response.body?.cancel().catch(() => {})
    return { status: 'none', reason: '这个链接不是网页，读不到封面', title: '' }
  }

  const html = decodeHtml(await readLimited(response, MAX_PAGE_BYTES, true), contentType)
  const title = pageTitle(html)
  const raw = metaContent(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src', 'image', 'thumbnailurl']) ||
    decodeEntities(/<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? '')
  if (!raw) return { status: 'none', reason: '这个网页没有提供封面', title }
  let imageUrl: URL
  try {
    imageUrl = new URL(raw, finalUrl)
  } catch {
    return { status: 'none', reason: '网页里的封面地址无效', title }
  }
  if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') return { status: 'none', reason: '网页里的封面地址无效', title }
  // 有的图床要求带来源站点；跨站请求 Chromium 只放行站点根地址，带完整路径会被拦成 ERR_BLOCKED_BY_CLIENT
  const image = await fetchImage(imageUrl, `${finalUrl.origin}/`)
  return image ? { status: 'ok', image, title } : { status: 'none', reason: '封面图片读取失败', title }
}

export function registerVideoQrHandlers({
  ipcMain,
  app,
  assertMainWindowSender
}: Pick<MainDeps, 'ipcMain' | 'app' | 'assertMainWindowSender'>): void {
  ipcMain.handle('qr:fetch-cover', async (event, payload) => {
    assertMainWindowSender(event)
    return fetchCover(app, parseHttpUrl(payload?.url, '视频链接'))
  })
}
