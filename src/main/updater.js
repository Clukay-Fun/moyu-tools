import { app, shell } from 'electron'
import { getApplicationVersion } from './appVersion.js'
import updater from 'electron-updater'
const { autoUpdater } = updater
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// GitHub Releases 自动更新（仅 Windows 安装版）。
// 开发模式与便携版不连接正式更新源：dev 不检查，portable 只提示手动下载。
const RELEASES_PAGE = 'https://github.com/Clukay-Fun/moyu-tools/releases'
const PREFS_PATH = join(app.getPath('userData'), 'updates.json')
const DEFAULT_PREFS = { autoCheck: true }

let mainWindow = null
let prefs = { ...DEFAULT_PREFS }
let checking = false
let downloading = false

const state = {
  status: 'idle',
  currentVersion: getApplicationVersion(),
  availableVersion: null,
  releaseNotes: null,
  progress: null,
  lastCheckedAt: null,
  autoCheck: DEFAULT_PREFS.autoCheck,
  portable: false,
  message: null
}

function loadPrefs() {
  try {
    const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_PREFS, ...parsed }
  } catch {
    // 文件缺失或损坏：回退默认
  }
  return { ...DEFAULT_PREFS }
}

function savePrefs(next) {
  prefs = { ...prefs, ...next }
  try {
    writeFileSync(PREFS_PATH, JSON.stringify(prefs), 'utf8')
  } catch {
    // 写入失败不阻塞更新流程
  }
}

function emit() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', state)
  }
}

function patch(next) {
  Object.assign(state, next)
  emit()
}

function normalizeNotes(notes) {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'string' ? n : n?.notes || '')).join('\n\n')
  }
  return ''
}

function isUpdateable() {
  return process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR
}

function doCheck() {
  if (!isUpdateable()) {
    patch({
      status: state.portable ? 'portable' : 'unsupported',
      message: state.portable
        ? '便携版不支持自动更新，请前往 GitHub 手动下载'
        : '当前运行方式不支持自动更新'
    })
    return { ok: false, message: state.message }
  }
  if (checking || downloading) return { ok: false, message: '更新任务正在进行' }
  checking = true
  patch({ status: 'checking', message: null })
  autoUpdater
    .checkForUpdates()
    .catch((err) => patch({ status: 'error', message: err?.message || '检查更新失败' }))
    .finally(() => {
      checking = false
    })
  return { ok: true }
}

export function initUpdater(window) {
  mainWindow = window
  prefs = loadPrefs()
  state.autoCheck = prefs.autoCheck
  state.portable = !!process.env.PORTABLE_EXECUTABLE_DIR
  state.currentVersion = getApplicationVersion()

  if (!isUpdateable()) {
    patch({
      status: state.portable ? 'portable' : 'unsupported',
      message: state.portable
        ? '便携版不支持自动更新，请前往 GitHub 手动下载'
        : '当前运行方式不支持自动更新'
    })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.on('checking-for-update', () => patch({ status: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    patch({
      status: 'available',
      availableVersion: info?.version || null,
      releaseNotes: normalizeNotes(info?.releaseNotes),
      lastCheckedAt: Date.now(),
      message: null
    })
  )
  autoUpdater.on('update-not-available', (info) =>
    patch({ status: 'up-to-date', availableVersion: info?.version || null, lastCheckedAt: Date.now(), message: null })
  )
  autoUpdater.on('download-progress', (p) =>
    patch({
      status: 'downloading',
      progress: {
        percent: Math.floor(Number(p?.percent) || 0),
        transferred: p?.transferred || 0,
        total: p?.total || 0
      }
    })
  )
  autoUpdater.on('update-downloaded', () => patch({ status: 'downloaded', lastCheckedAt: Date.now(), message: null }))
  autoUpdater.on('error', (err) =>
    patch({ status: 'error', message: err?.message || '更新过程出错', lastCheckedAt: Date.now() })
  )

  // 主窗可交互约 5 秒后后台检查；不阻塞启动。
  if (prefs.autoCheck) setTimeout(doCheck, 5000)
  else patch({ status: 'idle' })
}

export const updateApi = {
  getState: () => state,
  getSettings: () => ({ autoCheck: state.autoCheck, portable: state.portable }),
  setAutoCheck: (enabled) => {
    savePrefs({ autoCheck: Boolean(enabled) })
    patch({ autoCheck: prefs.autoCheck })
    return { autoCheck: prefs.autoCheck }
  },
  check: () => {
    return doCheck()
  },
  download: () => {
    if (downloading || state.status !== 'available') return { ok: false, message: '当前没有可下载的更新' }
    downloading = true
    patch({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0 } })
    autoUpdater
      .downloadUpdate()
      .catch((err) => patch({ status: 'error', message: err?.message || '下载失败' }))
      .finally(() => {
        downloading = false
      })
    return { ok: true }
  },
  install: () => {
    if (state.status !== 'downloaded') return { ok: false, message: '尚未下载完成' }
    autoUpdater.quitAndInstall(true)
    return { ok: true }
  },
  openReleases: () => {
    shell.openExternal(RELEASES_PAGE)
    return { ok: true }
  }
}
