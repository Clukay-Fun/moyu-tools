import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { PHOTOSHOP_MIN_VERSION, type PhotoshopStatus } from '@shared/photoshop'
import { findPhotoshopApp, photoshopSearchRoots } from './erp/services/psdExport'
import { isPsdPluginInstalled } from './erp/psdPlugin'

// 公共 Photoshop 服务：应用启动时在后台检测一次（只检测，不启动 Photoshop），
// 结果缓存并广播给所有窗口；条码「发送到 Photoshop」和「定制」都读这里。
// 设置页的「重新检测」、安装插件之后会再刷新。

const execFileAsync = promisify(execFile)

let status: PhotoshopStatus = {
  state: 'checking',
  installed: false,
  path: null,
  version: null,
  supported: null,
  pluginInstalled: false,
  checkedAt: null
}
let pending: Promise<PhotoshopStatus> | null = null

async function windowsPhotoshopRegistryPaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Photoshop.exe',
    'HKLM\\SOFTWARE\\Adobe\\Photoshop',
    'HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\Photoshop',
    'HKCU\\SOFTWARE\\Adobe\\Photoshop'
  ]
  const paths = new Set<string>()
  const outputs = await Promise.all(
    keys.map((key) =>
      execFileAsync('reg.exe', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
        .then((result) => result.stdout)
        // 不同版本的 Adobe 安装器写的注册表键不一样，查不到很正常
        .catch(() => '')
    )
  )
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*.+?\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line)
      if (!match) continue
      const raw = match[1].replace(/^"|"$/g, '').replace(/,\s*\d+$/, '')
      for (const part of raw.split(';')) {
        const value = part.trim().replace(/%([^%]+)%/g, (_all, name: string) => process.env[name] ?? `%${name}%`)
        if (/photoshop/i.test(value)) paths.add(value)
      }
    }
  }
  return [...paths]
}

async function findPhotoshopInstallation(): Promise<string | null> {
  const roots = photoshopSearchRoots()
  for (const registeredPath of await windowsPhotoshopRegistryPaths()) {
    const candidate = /\\Photoshop\.exe$/i.test(registeredPath) ? registeredPath : join(registeredPath, 'Photoshop.exe')
    try {
      if (existsSync(candidate) && statSync(candidate).isFile() && basename(candidate).toLowerCase() === 'photoshop.exe') {
        return candidate
      }
    } catch {
      // 回落到下面已知的 Adobe 安装目录
    }
    if (!/\\Photoshop\.exe$/i.test(registeredPath)) roots.unshift(registeredPath)
  }
  return findPhotoshopApp(roots)
}

/** 「Adobe Photoshop 2025.app」「…\Adobe Photoshop 2025\Photoshop.exe」→ 2025 */
export function photoshopYear(path: string | null): number | null {
  const match = path ? /Photoshop[ _-]?(20\d{2})/i.exec(path) : null
  return match ? Number(match[1]) : null
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('photoshop:status', status)
  }
}

export function getPhotoshopStatus(): PhotoshopStatus {
  return status
}

/** 已检测到的 Photoshop 路径；首次检测未完成时为 null */
export function photoshopPath(): string | null {
  return status.path
}

export function refreshPhotoshopStatus(): Promise<PhotoshopStatus> {
  pending ??= findPhotoshopInstallation()
    .catch(() => null)
    .then((path) => {
      const version = photoshopYear(path)
      status = {
        state: 'ready',
        installed: Boolean(path),
        path,
        version,
        supported: version === null ? null : version >= PHOTOSHOP_MIN_VERSION,
        pluginInstalled: isPsdPluginInstalled(),
        checkedAt: new Date().toISOString()
      }
      broadcast()
      return status
    })
    .finally(() => {
      pending = null
    })
  return pending
}

export function registerPhotoshopHandlers(assertMainWindowSender: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle('photoshop:get-status', () => status)
  ipcMain.handle('photoshop:redetect', (event) => {
    assertMainWindowSender(event)
    return refreshPhotoshopStatus()
  })
}
