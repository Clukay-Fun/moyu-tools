import { net, protocol } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { erpDataDir } from './paths'

export const MOYU_FILE_SCHEME = 'moyu-file'

/** 必须在 app ready 之前调用：让 moyu-file:// 能像 http 一样被 <img> 加载。 */
export function registerMoyuFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MOYU_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/**
 * moyu-file://erp/<相对路径> → userData/erp/<相对路径>。
 * 只解析到数据目录内部；`..`、绝对路径、其他 host 一律 404，不能借它读任意文件。
 */
export function resolveMoyuFile(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MOYU_FILE_SCHEME}:` || parsed.hostname !== 'erp') return null
  const root = erpDataDir()
  const target = resolve(root, decodeURIComponent(parsed.pathname).replace(/^\/+/, ''))
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

export function handleMoyuFileProtocol(): void {
  protocol.handle(MOYU_FILE_SCHEME, (request) => {
    const path = resolveMoyuFile(request.url)
    if (!path) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })
}
