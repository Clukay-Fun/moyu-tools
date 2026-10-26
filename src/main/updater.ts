import { app, Notification, shell, type BrowserWindow } from 'electron'
import { getApplicationVersion } from './appVersion'
import updater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
const { autoUpdater } = updater
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// GitHub Releases 自动更新（仅 Windows 安装版）。
// 开发模式与便携版不连接正式更新源：dev 不检查，portable 只提示手动下载。
//
// 安装时机只由用户决定：下载完成后保持 downloaded，「稍后安装」后正常退出也不会装
// （autoInstallOnAppQuit = false）；只有点「立即重启安装」才 quitAndInstall。
// 顶栏胶囊、设置页、toast、任务栏进度都读这里同一份 state。
const RELEASES_PAGE = 'https://github.com/Clukay-Fun/moyu-tools/releases'
const PREFS_PATH = join(app.getPath('userData'), 'updates.json')
const DEFAULT_PREFS: UpdatePrefs = { autoCheck: true }
// 进度事件很密，推给渲染进程时节流；完成、出错等状态变化不节流
const PROGRESS_EMIT_INTERVAL_MS = 250

interface UpdatePrefs {
  autoCheck: boolean
  /** 用户已同意下载、还没装的版本；下次启动检查到同一版本时直接复用缓存 */
  pendingVersion?: string
  /** 已提醒过「下载完成」的版本 */
  notifiedVersion?: string
  /** 点了「立即重启安装」时记下：重启后据此判断装没装上 */
  installingVersion?: string
  installingFrom?: string
  installingNotes?: string
  /** 上一次运行的版本：老版本升上来时没有 installingVersion，也能认出版本变了 */
  lastRunVersion?: string
  /** 已提示过「已更新到」的版本 */
  celebratedVersion?: string
}

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'portable'
  | 'unsupported'

interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  releaseNotes: string | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  lastCheckedAt: number | null
  autoCheck: boolean
  promptOnAvailable: boolean
  portable: boolean
  message: string | null
  /** 出错时的原始信息（已去掉用户目录），设置页折叠显示 */
  errorDetail: string | null
  /** 出错发生在哪一步：决定设置页给「重试下载」还是「重新检查」 */
  errorStage: 'check' | 'download' | 'install' | null
  /** 本次启动确认已升级到新版本，未提示过 */
  justUpdated: { version: string; notes: string } | null
}

let getWindow: () => BrowserWindow | null = () => null
let prefs: UpdatePrefs = { ...DEFAULT_PREFS }
let checking = false
let downloading = false
/** 这次下载是启动时自动复用缓存触发的：完成后不再提醒 */
let resumingPending = false
let lastProgressEmit = 0
let progressEmitTimer: NodeJS.Timeout | null = null

const state: UpdateState = {
  status: 'idle',
  currentVersion: getApplicationVersion(),
  availableVersion: null,
  releaseNotes: null,
  progress: null,
  lastCheckedAt: null,
  autoCheck: DEFAULT_PREFS.autoCheck,
  promptOnAvailable: false,
  portable: false,
  message: null,
  errorDetail: null,
  errorStage: null,
  justUpdated: null
}

function loadPrefs(): UpdatePrefs {
  try {
    const parsed = JSON.parse(readFileSync(PREFS_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_PREFS, ...parsed }
  } catch {
    // 文件缺失或损坏：回退默认
  }
  return { ...DEFAULT_PREFS }
}

function savePrefs(next: Partial<UpdatePrefs>) {
  prefs = { ...prefs, ...next }
  try {
    writeFileSync(PREFS_PATH, JSON.stringify(prefs), 'utf8')
  } catch {
    // 写入失败不阻塞更新流程
  }
}

function liveWindow() {
  const window = getWindow()
  return window && !window.isDestroyed() ? window : null
}

function send(channel: string, payload?: unknown) {
  liveWindow()?.webContents.send(channel, payload)
}

function emit() {
  if (progressEmitTimer) {
    clearTimeout(progressEmitTimer)
    progressEmitTimer = null
  }
  lastProgressEmit = Date.now()
  send('update:state', state)
}

function patch(next: Partial<UpdateState>) {
  Object.assign(state, next)
  emit()
}

/** 下载进度：状态立即更新，推送按间隔合并，最后一次一定会发出去 */
function patchProgress(progress: NonNullable<UpdateState['progress']>) {
  Object.assign(state, { status: 'downloading', progress })
  setTaskbarProgress()
  const wait = PROGRESS_EMIT_INTERVAL_MS - (Date.now() - lastProgressEmit)
  if (wait <= 0) emit()
  else if (!progressEmitTimer) progressEmitTimer = setTimeout(emit, wait)
}

/** 任务栏 / Dock 进度：下载中显示真实比例，总大小未知时用系统的不确定进度，其余状态清掉 */
function setTaskbarProgress() {
  const window = liveWindow()
  if (!window) return
  if (state.status !== 'downloading') {
    window.setProgressBar(-1)
    return
  }
  const progress = state.progress
  if (!progress?.total) window.setProgressBar(2, { mode: 'indeterminate' })
  else window.setProgressBar(Math.min(1, Math.max(0, progress.percent / 100)))
}

function normalizeNotes(notes: UpdateInfo['releaseNotes']): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'string' ? n : n?.note || '')).join('\n\n')
  }
  return ''
}

function normalizeUpdateError(error: unknown, fallback: string): string {
  const message = String((error as { message?: unknown } | null)?.message || error || '').trim()
  const normalized = message.toLowerCase()
  if (normalized.includes('err_proxy_connection_failed') || normalized.includes('proxy connection failed')) {
    return '无法连接更新服务器，请检查系统代理设置或网络连接后重试'
  }
  if (normalized.includes('etimedout') || normalized.includes('timed out') || normalized.includes('econnrefused')) {
    return '更新服务器连接超时，请检查网络连接后重试'
  }
  if (normalized.includes('err_internet_disconnected') || normalized.includes('err_network_changed') || normalized.includes('econnreset') || normalized.includes('enotfound')) {
    return '网络连接中断，请检查网络后重试'
  }
  if (normalized.includes('status code 404') || normalized.includes('cannot find latest')) {
    return '暂时找不到可用的更新，请稍后重试'
  }
  if (normalized.includes('sha512 checksum mismatch') || normalized.includes('checksum')) {
    return '下载的安装包校验失败，请重试下载'
  }
  return fallback
}

/** 折叠在「错误详情」里的原始信息：去掉用户目录和 token 一类参数，限长 */
function errorDetailOf(error: unknown): string {
  const raw = String((error as { stack?: unknown; message?: unknown } | null)?.message || error || '')
  return raw
    .split(homedir()).join('~')
    .replace(/([?&](?:token|access_token|X-Amz-[\w-]+|sig|signature)=)[^&\s]+/gi, '$1***')
    .slice(0, 500)
}

function fail(stage: NonNullable<UpdateState['errorStage']>, error: unknown, fallback: string) {
  patch({
    status: 'error',
    message: normalizeUpdateError(error, fallback),
    errorDetail: errorDetailOf(error),
    errorStage: stage,
    lastCheckedAt: Date.now()
  })
  setTaskbarProgress()
}

function isUpdateable() {
  return process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR
}

function unsupportedPatch() {
  patch({
    status: state.portable ? 'portable' : 'unsupported',
    message: state.portable
      ? '便携版不支持自动更新，请前往 GitHub 手动下载'
      : '当前运行方式不支持自动更新'
  })
  return { ok: false, message: state.message }
}

function doCheck(source: 'manual' | 'startup' = 'manual') {
  if (!isUpdateable()) return unsupportedPatch()
  if (checking || downloading || state.status === 'installing') return { ok: false, message: '更新任务正在进行' }
  // 已下载好的更新不要被一次重新检查冲掉安装入口
  if (state.status === 'downloaded') return { ok: false, message: '更新已下载，可在设置中重启安装' }
  checking = true
  patch({ status: 'checking', message: null, errorDetail: null, errorStage: null, promptOnAvailable: source === 'startup' })
  autoUpdater
    .checkForUpdates()
    .catch((err) => fail('check', err, '检查更新失败'))
    .finally(() => {
      checking = false
    })
  return { ok: true }
}

function startDownload(resume = false) {
  if (!isUpdateable()) return unsupportedPatch()
  if (downloading || state.status === 'installing') return { ok: false, message: '更新正在下载' }
  if (!state.availableVersion || (state.status !== 'available' && state.status !== 'error')) {
    return { ok: false, message: '当前没有可下载的更新' }
  }
  downloading = true
  resumingPending = resume
  if (prefs.pendingVersion !== state.availableVersion) savePrefs({ pendingVersion: state.availableVersion })
  patch({
    status: 'downloading',
    progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    message: null,
    errorDetail: null,
    errorStage: null,
    promptOnAvailable: false
  })
  setTaskbarProgress()
  autoUpdater
    .downloadUpdate()
    .catch((err) => fail('download', err, '下载失败'))
    .finally(() => {
      downloading = false
    })
  return { ok: true }
}

/** 下载完成提醒：每个版本一次；窗口在前台发应用内 toast，不在前台发系统通知 */
function notifyDownloaded() {
  const version = state.availableVersion
  if (!version || prefs.notifiedVersion === version) return
  savePrefs({ notifiedVersion: version })
  if (resumingPending) return
  // 应用内 toast 总是发；窗口不在前台时再加一条系统通知（不支持就只靠顶栏胶囊）
  send('update:downloaded-toast', { version })
  if (liveWindow()?.isFocused() || !Notification.isSupported()) return
  const notification = new Notification({
    title: '摸鱼工具箱更新已下载',
    body: `v${version} 已准备就绪，打开软件后可选择安装。`
  })
  notification.on('click', () => {
    const target = liveWindow()
    if (!target) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    send('update:open-settings')
  })
  notification.show()
}

/**
 * 启动时核对上次的安装结果：只有当前真实运行版本等于安装目标才算成功。
 * 从不会记 installingVersion 的老版本升上来时，靠 lastRunVersion 认出版本变了。
 */
function reconcileInstall() {
  const current = state.currentVersion
  const { installingVersion, installingFrom, installingNotes, lastRunVersion, celebratedVersion } = prefs
  if (installingVersion) {
    if (current === installingVersion && current !== installingFrom) {
      if (celebratedVersion !== current) state.justUpdated = { version: current, notes: installingNotes || '' }
    } else {
      Object.assign(state, {
        status: 'error',
        message: `上次更新到 v${installingVersion} 没有完成，可以重新检查更新`,
        errorDetail: `当前运行版本 v${current}`,
        errorStage: 'install'
      })
    }
  } else if (lastRunVersion && lastRunVersion !== current && celebratedVersion !== current) {
    state.justUpdated = { version: current, notes: '' }
  }
  savePrefs({
    lastRunVersion: current,
    installingVersion: undefined,
    installingFrom: undefined,
    installingNotes: undefined,
    // 已经装上的版本不再算「待安装」
    ...(prefs.pendingVersion === current ? { pendingVersion: undefined, notifiedVersion: undefined } : {})
  })
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  prefs = loadPrefs()
  state.autoCheck = prefs.autoCheck
  state.portable = !!process.env.PORTABLE_EXECUTABLE_DIR
  state.currentVersion = getApplicationVersion()
  reconcileInstall()

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => patch({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    patch({
      status: 'available',
      availableVersion: info?.version || null,
      releaseNotes: normalizeNotes(info?.releaseNotes),
      lastCheckedAt: Date.now(),
      message: null
    })
    // 上次已经同意下载这个版本：复用缓存（缓存失效会重新下载），不再弹「发现新版本」
    if (info?.version && info.version === prefs.pendingVersion) {
      state.promptOnAvailable = false
      startDownload(true)
    }
  })
  autoUpdater.on('update-not-available', (info) =>
    patch({ status: 'up-to-date', availableVersion: info?.version || null, lastCheckedAt: Date.now(), message: null, promptOnAvailable: false })
  )
  autoUpdater.on('download-progress', (p: ProgressInfo) =>
    patchProgress({
      percent: Math.floor(Number(p?.percent) || 0),
      transferred: p?.transferred || 0,
      total: p?.total || 0,
      bytesPerSecond: p?.bytesPerSecond || 0
    })
  )
  autoUpdater.on('update-downloaded', (info) => {
    patch({
      status: 'downloaded',
      availableVersion: info?.version || state.availableVersion,
      progress: state.progress?.total ? { ...state.progress, percent: 100, transferred: state.progress.total } : state.progress,
      lastCheckedAt: Date.now(),
      message: null,
      errorDetail: null,
      errorStage: null
    })
    setTaskbarProgress()
    notifyDownloaded()
    resumingPending = false
  })
  autoUpdater.on('update-cancelled', () => {
    patch({ status: state.availableVersion ? 'available' : 'idle', progress: null })
    setTaskbarProgress()
  })
  autoUpdater.on('error', (err) => {
    // 正在安装时出错（安装包丢失等）回到可重试；其他阶段按当前状态归类
    const stage = state.status === 'installing' ? 'install' : downloading || state.status === 'downloading' ? 'download' : 'check'
    fail(stage, err, stage === 'download' ? '下载失败' : stage === 'install' ? '启动安装失败' : '更新过程出错')
  })

  if (!isUpdateable()) {
    // 「上次更新没有完成」比「不支持自动更新」更要紧，留着它
    if (state.errorStage !== 'install') unsupportedPatch()
    return
  }
  // 主窗可交互约 5 秒后后台检查；不阻塞启动。
  if (prefs.autoCheck) setTimeout(() => doCheck('startup'), 5000)
  else if (state.status !== 'error') patch({ status: 'idle' })
}

export const updateApi = {
  getState: () => state,
  getSettings: () => ({ autoCheck: state.autoCheck, portable: state.portable }),
  setAutoCheck: (enabled: unknown) => {
    savePrefs({ autoCheck: Boolean(enabled) })
    patch({ autoCheck: prefs.autoCheck })
    return { autoCheck: prefs.autoCheck }
  },
  check: () => {
    return doCheck()
  },
  download: () => startDownload(),
  install: () => {
    if (state.status !== 'downloaded' || !state.availableVersion) return { ok: false, message: '尚未下载完成' }
    if (!isUpdateable()) return unsupportedPatch()
    savePrefs({
      installingVersion: state.availableVersion,
      installingFrom: state.currentVersion,
      installingNotes: state.releaseNotes || ''
    })
    patch({ status: 'installing', message: null })
    setTaskbarProgress()
    // isSilent=true：不弹安装向导；isForceRunAfter=true：装完重新打开软件（不传的话 NSIS 静默安装后不会启动）
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return { ok: true }
  },
  dismissJustUpdated: () => {
    if (state.justUpdated) savePrefs({ celebratedVersion: state.justUpdated.version })
    state.justUpdated = null
    return { ok: true }
  },
  openReleases: () => {
    shell.openExternal(RELEASES_PAGE)
    return { ok: true }
  }
}
