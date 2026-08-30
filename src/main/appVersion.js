import { app } from 'electron'
import { readFileSync } from 'node:fs'

export function getApplicationVersion() {
  if (app.isPackaged) return app.getVersion()

  try {
    const packageUrl = new URL('../../package.json', import.meta.url)
    const manifest = JSON.parse(readFileSync(packageUrl, 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version) return manifest.version
  } catch {
    // 开发产物结构异常时仍回退 Electron 提供的版本，避免设置页读取失败。
  }

  return app.getVersion()
}
