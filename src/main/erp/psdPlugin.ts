import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 随应用分发的插件目录（开发时在项目根，打包后在 resources） */
export function bundledPluginDirectory(): string {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'photoshop-plugin')
    : join(app.getAppPath(), 'photoshop-plugin')
  return join(root, 'moyu-psd')
}

/** macOS 装到 userData 供 UXP Developer Tools 加载；Windows 装到当前用户的 CEP 扩展目录 */
export function installedPluginDirectory(): string {
  return process.platform === 'darwin'
    ? join(app.getPath('userData'), 'photoshop-plugin', 'moyu-psd')
    : join(app.getPath('appData'), 'Adobe', 'CEP', 'extensions', 'com.clukay.moyu.psd')
}

export function isPsdPluginInstalled(): boolean {
  const manifest = process.platform === 'darwin' ? 'manifest.json' : join('CSXS', 'manifest.xml')
  return existsSync(join(installedPluginDirectory(), manifest))
}
