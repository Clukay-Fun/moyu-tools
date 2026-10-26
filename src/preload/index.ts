import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { erpApi } from './erp'
import type { PhotoshopStatus } from '@shared/photoshop'

// 参数都是 renderer 传来的不可信数据，类型一律 unknown，由主进程逐项校验。
type Listener = (value?: unknown) => void

// 按业务分组排列，方法名本身保持不变（renderer 侧已有大量 window.api.xxx()
// 直接调用，包括 screenshot.js / pin.js 这两个独立渲染入口——重命名成嵌套
// 命名空间要同步改掉所有调用方，风险和收益不成比例，这里只做分组整理，
// 不改公开接口形状）。

const api = Object.freeze({
  // ── 应用本身 ──────────────────────────────────────────────
  ping: () => ipcRenderer.invoke('ping'),
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url: unknown) => ipcRenderer.invoke('app:open-external', url),
  setTitleBarTheme: (theme: unknown) => ipcRenderer.invoke('window:set-titlebar-theme', theme),
  reportStartupReady: () => ipcRenderer.send('startup:report-ready'),

  // ── 个人头像（profile:*）：只经系统选图对话框，renderer 不接触文件路径 ──
  profile: {
    getAvatar: () => ipcRenderer.invoke('profile:get-avatar'),
    chooseAvatar: () => ipcRenderer.invoke('profile:choose-avatar'),
    clearAvatar: () => ipcRenderer.invoke('profile:clear-avatar'),
    // 应用品牌：Logo 与背景图，同样只经系统选图对话框
    getBrand: () => ipcRenderer.invoke('profile:get-brand'),
    chooseLogo: () => ipcRenderer.invoke('profile:choose-logo'),
    clearLogo: () => ipcRenderer.invoke('profile:clear-logo'),
    chooseBackground: () => ipcRenderer.invoke('profile:choose-background'),
    clearBackground: () => ipcRenderer.invoke('profile:clear-background')
  },

  onWindowRevive: (handler: Listener) => {
    const listener = () => handler()
    ipcRenderer.on('window:revive', listener)
    return () => void ipcRenderer.removeListener('window:revive', listener)
  },
  onFullscreenChange: (handler: Listener) => {
    const listener = (_event: IpcRendererEvent, fullscreen: unknown) => handler(Boolean(fullscreen))
    ipcRenderer.on('window:fullscreen', listener)
    return () => void ipcRenderer.removeListener('window:fullscreen', listener)
  },

  // ── 汇总画布（board:* / recovery:*）──────────────────────────
  setBoardDirty: (dirty: unknown) => ipcRenderer.send('board:dirty', Boolean(dirty)),
  saveBoard: (payload: unknown) => ipcRenderer.invoke('board:save', payload),
  openBoard: () => ipcRenderer.invoke('board:open'),
  writeRecovery: (payload: unknown) => ipcRenderer.invoke('recovery:write', payload),
  readRecovery: () => ipcRenderer.invoke('recovery:read'),
  clearRecovery: () => ipcRenderer.invoke('recovery:clear'),
  onBoardSaveRequest: (handler: Listener) => {
    const listener = (_event: IpcRendererEvent, id: unknown) => handler(id)
    ipcRenderer.on('board:request-save', listener)
    return () => void ipcRenderer.off('board:request-save', listener)
  },
  reportBoardSaveResult: (id: unknown, ok: unknown) => ipcRenderer.send('board:save-result', id, Boolean(ok)),

  // ── 统一拖入扫描（drop:*）：renderer 只提交路径 + 区域/动作，
  //    主进程递归扫描并校验，供 PDF / Illustrator / 格式工厂共用 ──
  scanDroppedPaths: (payload: unknown) => ipcRenderer.invoke('drop:scan-paths', payload),
  readDroppedFile: (filePath: unknown) => ipcRenderer.invoke('drop:read-file', filePath),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // ── Office / Adobe COM 联动基础设施（com:*）──────────────────
  probeCom: () => ipcRenderer.invoke('com:probe'),
  showComResult: (resultId: unknown) => ipcRenderer.invoke('com:show-result', resultId),

  // ── 条码（barcode:* / image:save-file）───────────────────────
  saveBarcodeFile: (payload: unknown) => ipcRenderer.invoke('barcode:save-file', payload),
  saveBarcodeFiles: (payload: unknown) => ipcRenderer.invoke('barcode:save-files', payload),
  copyBarcodeVector: (data: unknown) => ipcRenderer.invoke('barcode:copy-vector', data),
  exportBarcodeEps: (payload: unknown) => ipcRenderer.invoke('barcode:export-eps', payload),
  illustratorUngroupedCopy: (payload: unknown) =>
    ipcRenderer.invoke('barcode:illustrator-ungrouped-copy', payload),
  openBarcodeInIllustrator: (payload: unknown) => ipcRenderer.invoke('barcode:open-illustrator', payload),
  sendDielineToIllustrator: (payload: unknown) => ipcRenderer.invoke('dieline:send-illustrator', payload),
  openBarcodeInPhotoshop: (payload: unknown) => ipcRenderer.invoke('barcode:open-photoshop', payload),
  saveImageFile: (payload: unknown) => ipcRenderer.invoke('image:save-file', payload),
  onBarcodeSaveProgress: (callback: Listener) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('barcode:save-progress', listener)
    return () => void ipcRenderer.removeListener('barcode:save-progress', listener)
  },

  // ── Illustrator 批处理（illustrator:*）───────────────────────
  pickIllustratorFiles: () => ipcRenderer.invoke('illustrator:pick-files'),
  addDroppedIllustratorFiles: (paths: unknown) => ipcRenderer.invoke('illustrator:add-paths', paths),
  pickIllustratorFolder: () => ipcRenderer.invoke('illustrator:pick-folder'),
  removeIllustratorInputs: (inputIds: unknown) => ipcRenderer.invoke('illustrator:remove-inputs', inputIds),
  runIllustratorTask: (payload: unknown) => ipcRenderer.invoke('illustrator:run', payload),
  cancelIllustratorTask: () => ipcRenderer.invoke('illustrator:cancel'),
  onIllustratorProgress: (callback: Listener) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('illustrator:progress', listener)
    return () => void ipcRenderer.removeListener('illustrator:progress', listener)
  },

  // ── Office 转 PDF（office:*）─────────────────────────────────
  pickOfficeFile: (kind: unknown) => ipcRenderer.invoke('office:pick-file', kind),
  convertOfficeToPdf: (payload: unknown) => ipcRenderer.invoke('office:to-pdf', payload),

  // ── 格式工厂（format:*）──────────────────────────────────────
  getFormatStatus: () => ipcRenderer.invoke('format:get-status'),
  pickFormatFiles: (payload: unknown) => ipcRenderer.invoke('format:pick-files', payload),
  addDroppedFormatFiles: (paths: unknown, kind: unknown) =>
    ipcRenderer.invoke('format:add-paths', { paths, kind }),
  pickFormatFolder: (payload: unknown) => ipcRenderer.invoke('format:pick-folder', payload),
  removeFormatInputs: (inputIds: unknown) => ipcRenderer.invoke('format:remove-inputs', inputIds),
  runFormatTask: (payload: unknown) => ipcRenderer.invoke('format:run', payload),
  cancelFormatTask: (taskId: unknown) => ipcRenderer.invoke('format:cancel', taskId),
  saveFormatResults: (resultIds: unknown) => ipcRenderer.invoke('format:save-results', resultIds),
  onFormatProgress: (callback: Listener) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('format:progress', listener)
    return () => void ipcRenderer.removeListener('format:progress', listener)
  },

  // ── 视频转二维码（qr:*）：封面只回传重新编码后的 data: 图片 ──
  fetchVideoCover: (url: unknown) => ipcRenderer.invoke('qr:fetch-cover', { url }),

  // ── PDF 工具（pdf:*）─────────────────────────────────────────
  choosePdfOutput: (payload: unknown) => ipcRenderer.invoke('pdf:choose-output', payload),
  createDefaultPdfOutput: (file: File, outputKind: unknown) => {
    const sourcePath = webUtils.getPathForFile(file)
    if (!sourcePath) return Promise.resolve(null)
    return ipcRenderer.invoke('pdf:default-output', { sourcePath, outputKind })
  },
  createDefaultPdfDropOutput: (fileId: unknown, outputKind: unknown) =>
    ipcRenderer.invoke('pdf:default-drop-output', { fileId, outputKind }),
  releasePdfOutput: (sessionId: unknown) => ipcRenderer.invoke('pdf:release-output', sessionId),
  savePdfFile: (payload: unknown) => ipcRenderer.invoke('pdf:save-file', payload),
  savePdfFiles: (payload: unknown) => ipcRenderer.invoke('pdf:save-files', payload),
  showPdfOutput: (path: unknown) => ipcRenderer.invoke('pdf:show-item', path),
  onPdfSaveProgress: (callback: Listener) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('pdf:save-progress', listener)
    return () => void ipcRenderer.removeListener('pdf:save-progress', listener)
  },

  // ── 区域截图 / 钉图 / OCR（screenshot:*）──────────────────────
  startScreenshot: () => ipcRenderer.invoke('screenshot:start'),
  getScreenshotSession: (sessionId: unknown) => ipcRenderer.invoke('screenshot:get-session', sessionId),
  onScreenshotSession: (handler: Listener) => {
    const listener = (_event: IpcRendererEvent, sessionId: unknown) => handler(sessionId)
    ipcRenderer.on('screenshot:begin-session', listener)
    return () => void ipcRenderer.removeListener('screenshot:begin-session', listener)
  },
  reportScreenshotReady: (sessionId: unknown) => ipcRenderer.invoke('screenshot:overlay-ready', sessionId),
  completeScreenshot: (payload: unknown) => ipcRenderer.invoke('screenshot:complete', payload),
  cancelScreenshot: (sessionId: unknown) => ipcRenderer.invoke('screenshot:cancel', sessionId),
  saveScreenshot: (payload: unknown) => ipcRenderer.invoke('screenshot:save', payload),
  copyScreenshot: (data: unknown) => ipcRenderer.invoke('screenshot:copy', data),
  recognizeScreenshot: (data: unknown) => ipcRenderer.invoke('screenshot:ocr', data),
  copyScreenshotText: (text: unknown) => ipcRenderer.invoke('screenshot:copy-text', text),
  pinScreenshot: (data: unknown) => ipcRenderer.invoke('screenshot:pin', data),
  getPinnedScreenshot: (pinId: unknown) => ipcRenderer.invoke('screenshot:pin-get', pinId),
  resizePinnedScreenshot: (payload: unknown) => ipcRenderer.invoke('screenshot:pin-resize', payload),
  setPinnedScreenshotOpacity: (payload: unknown) => ipcRenderer.invoke('screenshot:pin-opacity', payload),
  copyPinnedScreenshot: (pinId: unknown) => ipcRenderer.invoke('screenshot:pin-copy', pinId),
  closePinnedScreenshot: (pinId: unknown) => ipcRenderer.invoke('screenshot:pin-close', pinId),
  onScreenshotCaptured: (callback: Listener) => {
    const listener = (_event: IpcRendererEvent, result: unknown) => callback(result)
    ipcRenderer.on('screenshot:captured', listener)
    return () => void ipcRenderer.removeListener('screenshot:captured', listener)
  },
  onScreenshotCancelled: (callback: Listener) => {
    const listener = () => callback()
    ipcRenderer.on('screenshot:cancelled', listener)
    return () => void ipcRenderer.removeListener('screenshot:cancelled', listener)
  },
  onScreenshotOcrProgress: (callback: Listener) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('screenshot:ocr-progress', listener)
    return () => void ipcRenderer.removeListener('screenshot:ocr-progress', listener)
  },

  // ── 全局截图快捷键设置（shortcut:*，F-16）─────────────────────
  onCaptureShortcut: (handler: Listener) => {
    const listener = () => handler()
    ipcRenderer.on('shortcut:capture', listener)
    return () => void ipcRenderer.off('shortcut:capture', listener)
  },
  onShortcutStatus: (handler: Listener) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('shortcut:status', listener)
    return () => void ipcRenderer.off('shortcut:status', listener)
  },
  reportShortcutReady: () => ipcRenderer.send('shortcut:ready'),
  getCaptureShortcut: () => ipcRenderer.invoke('shortcut:get'),
  setCaptureShortcut: (payload: unknown) => ipcRenderer.invoke('shortcut:set', payload),
  resetCaptureShortcut: () => ipcRenderer.invoke('shortcut:reset'),

  // ── 自动更新（update:*，GitHub Releases）──────────────────────
  update: {
    getState: () => ipcRenderer.invoke('update:get-state'),
    getSettings: () => ipcRenderer.invoke('update:get-settings'),
    setAutoCheck: (enabled: unknown) => ipcRenderer.invoke('update:set-auto-check', enabled),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    openReleases: () => ipcRenderer.invoke('update:open-releases'),
    skipVersion: (version: unknown) => ipcRenderer.invoke('update:skip-version', version),
    dismissJustUpdated: () => ipcRenderer.invoke('update:dismiss-just-updated'),
    onState: (handler: Listener) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload)
      ipcRenderer.on('update:state', listener)
      return () => void ipcRenderer.removeListener('update:state', listener)
    },
    // 下载完成提醒（每个版本主进程只发一次）
    onDownloadedToast: (handler: Listener) => {
      const listener = (_event: IpcRendererEvent, payload: unknown) => handler(payload)
      ipcRenderer.on('update:downloaded-toast', listener)
      return () => void ipcRenderer.removeListener('update:downloaded-toast', listener)
    },
    // 点系统通知后要求打开「设置 › 更新与关于」
    onOpenSettings: (handler: Listener) => {
      const listener = () => handler()
      ipcRenderer.on('update:open-settings', listener)
      return () => void ipcRenderer.removeListener('update:open-settings', listener)
    }
  },

  // ── 公共 Photoshop 服务（photoshop:*）：条码与「定制」共用的检测结果 ──
  photoshop: {
    getStatus: (): Promise<PhotoshopStatus> => ipcRenderer.invoke('photoshop:get-status'),
    redetect: (): Promise<PhotoshopStatus> => ipcRenderer.invoke('photoshop:redetect'),
    onStatus: (handler: (status: PhotoshopStatus) => void) => {
      const listener = (_event: IpcRendererEvent, payload: PhotoshopStatus) => handler(payload)
      ipcRenderer.on('photoshop:status', listener)
      return () => void ipcRenderer.removeListener('photoshop:status', listener)
    }
  },

  // ── 库存 / 定制（erp:*，原 ajuan-erp）：白名单见 ./erp.ts ──
  erp: erpApi
})

/** window.api 的完整类型：库存 / 定制的 TS 与原工具箱 // @ts-check 的 JS 都从这里取 */
export type MoyuApi = typeof api

contextBridge.exposeInMainWorld('api', api)
