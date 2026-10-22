import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { state } from './appState'
import { resolveAttachmentPath } from './services/attachments'
import { resolvePsdAssetPath, resolvePsdBridgeOutputPath, resolvePsdCutoutResultPath } from './services/psdExport'

export const MOYU_FILE_SCHEME = 'moyu-file'

/** 必须在 app ready 之前调用：让 moyu-file:// 能像 http 一样被 <img> 加载。 */
export function registerMoyuFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MOYU_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }
  ])
}

/**
 * 本地图片只开放四类：单据附件、已导入素材、桥接 outputs 里的预览、抠图结果。
 * 每个 resolver 自己做目录收口（`..`、绝对路径会被拒绝），其他 host 一律 404。
 */
function resolveMoyuFile(host: string, rel: string): string | null {
  if (host === 'attachments') return resolveAttachmentPath(state.attachmentsDir, rel)
  if (host === 'psd-assets') return resolvePsdAssetPath(state.psdAssetsDir, rel)
  if (host === 'psd-bridge') return resolvePsdBridgeOutputPath(state.psdBridgeDir, rel)
  if (host === 'psd-cutout') return resolvePsdCutoutResultPath(state.db, Number(rel))
  return null
}

export function handleMoyuFileProtocol(): void {
  protocol.handle(MOYU_FILE_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      const full = resolveMoyuFile(url.host, decodeURIComponent(url.pathname.replace(/^\/+/, '')))
      if (!full) return new Response('Not found', { status: 404 })
      return net.fetch(pathToFileURL(full).toString())
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  })
}
