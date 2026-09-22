import { contextBridge, ipcRenderer, webUtils } from 'electron'

// 按业务分组排列，方法名本身保持不变（renderer 侧已有大量 window.api.xxx()
// 直接调用，包括 screenshot.js / pin.js 这两个独立渲染入口——重命名成嵌套
// 命名空间要同步改掉所有调用方，风险和收益不成比例，这里只做分组整理，
// 不改公开接口形状）。

contextBridge.exposeInMainWorld(
  'api',
  Object.freeze({
    // ── 应用本身 ──────────────────────────────────────────────
    ping: () => ipcRenderer.invoke('ping'),
    getAppInfo: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    reportStartupReady: () => ipcRenderer.send('startup:report-ready'),
    onWindowRevive: (handler) => {
      const listener = () => handler()
      ipcRenderer.on('window:revive', listener)
      return () => ipcRenderer.removeListener('window:revive', listener)
    },

    // ── 汇总画布（board:* / recovery:*）──────────────────────────
    setBoardDirty: (dirty) => ipcRenderer.send('board:dirty', Boolean(dirty)),
    saveBoard: (payload) => ipcRenderer.invoke('board:save', payload),
    openBoard: () => ipcRenderer.invoke('board:open'),
    writeRecovery: (payload) => ipcRenderer.invoke('recovery:write', payload),
    readRecovery: () => ipcRenderer.invoke('recovery:read'),
    clearRecovery: () => ipcRenderer.invoke('recovery:clear'),
    onBoardSaveRequest: (handler) => {
      const listener = (_event, id) => handler(id)
      ipcRenderer.on('board:request-save', listener)
      return () => ipcRenderer.off('board:request-save', listener)
    },
    reportBoardSaveResult: (id, ok) => ipcRenderer.send('board:save-result', id, Boolean(ok)),

    // ── 统一拖入扫描（drop:*）：renderer 只提交路径 + 区域/动作，
    //    主进程递归扫描并校验，供 PDF / Illustrator / 格式工厂共用 ──
    scanDroppedPaths: (payload) => ipcRenderer.invoke('drop:scan-paths', payload),
    readDroppedFile: (filePath) => ipcRenderer.invoke('drop:read-file', filePath),
    getPathForFile: (file) => webUtils.getPathForFile(file),

    // ── Office / Adobe COM 联动基础设施（com:*）──────────────────
    probeCom: () => ipcRenderer.invoke('com:probe'),
    showComResult: (resultId) => ipcRenderer.invoke('com:show-result', resultId),

    // ── 条码（barcode:* / image:save-file）───────────────────────
    saveBarcodeFile: (payload) => ipcRenderer.invoke('barcode:save-file', payload),
    saveBarcodeFiles: (payload) => ipcRenderer.invoke('barcode:save-files', payload),
    copyBarcodeVector: (data) => ipcRenderer.invoke('barcode:copy-vector', data),
    exportBarcodeEps: (payload) => ipcRenderer.invoke('barcode:export-eps', payload),
    illustratorUngroupedCopy: (payload) =>
      ipcRenderer.invoke('barcode:illustrator-ungrouped-copy', payload),
    openBarcodeInIllustrator: (payload) => ipcRenderer.invoke('barcode:open-illustrator', payload),
    exportDielineAi: (payload) => ipcRenderer.invoke('dieline:export-ai', payload),
    openBarcodeInPhotoshop: (payload) => ipcRenderer.invoke('barcode:open-photoshop', payload),
    saveImageFile: (payload) => ipcRenderer.invoke('image:save-file', payload),
    onBarcodeSaveProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('barcode:save-progress', listener)
      return () => ipcRenderer.removeListener('barcode:save-progress', listener)
    },

    // ── Illustrator 批处理（illustrator:*）───────────────────────
    pickIllustratorFiles: () => ipcRenderer.invoke('illustrator:pick-files'),
    addDroppedIllustratorFiles: (paths) => ipcRenderer.invoke('illustrator:add-paths', paths),
    pickIllustratorFolder: () => ipcRenderer.invoke('illustrator:pick-folder'),
    removeIllustratorInputs: (inputIds) => ipcRenderer.invoke('illustrator:remove-inputs', inputIds),
    runIllustratorTask: (payload) => ipcRenderer.invoke('illustrator:run', payload),
    cancelIllustratorTask: () => ipcRenderer.invoke('illustrator:cancel'),
    onIllustratorProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('illustrator:progress', listener)
      return () => ipcRenderer.removeListener('illustrator:progress', listener)
    },

    // ── Office 转 PDF（office:*）─────────────────────────────────
    pickOfficeFile: (kind) => ipcRenderer.invoke('office:pick-file', kind),
    convertOfficeToPdf: (payload) => ipcRenderer.invoke('office:to-pdf', payload),

    // ── 格式工厂（format:*）──────────────────────────────────────
    getFormatStatus: () => ipcRenderer.invoke('format:get-status'),
    pickFormatFiles: (payload) => ipcRenderer.invoke('format:pick-files', payload),
    addDroppedFormatFiles: (paths, kind) =>
      ipcRenderer.invoke('format:add-paths', { paths, kind }),
    pickFormatFolder: (payload) => ipcRenderer.invoke('format:pick-folder', payload),
    removeFormatInputs: (inputIds) => ipcRenderer.invoke('format:remove-inputs', inputIds),
    runFormatTask: (payload) => ipcRenderer.invoke('format:run', payload),
    cancelFormatTask: (taskId) => ipcRenderer.invoke('format:cancel', taskId),
    saveFormatResults: (resultIds) => ipcRenderer.invoke('format:save-results', resultIds),
    onFormatProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('format:progress', listener)
      return () => ipcRenderer.removeListener('format:progress', listener)
    },

    // ── PDF 工具（pdf:*）─────────────────────────────────────────
    choosePdfOutput: (payload) => ipcRenderer.invoke('pdf:choose-output', payload),
    createDefaultPdfOutput: (file, outputKind) => {
      const sourcePath = webUtils.getPathForFile(file)
      if (!sourcePath) return Promise.resolve(null)
      return ipcRenderer.invoke('pdf:default-output', { sourcePath, outputKind })
    },
    createDefaultPdfDropOutput: (fileId, outputKind) =>
      ipcRenderer.invoke('pdf:default-drop-output', { fileId, outputKind }),
    releasePdfOutput: (sessionId) => ipcRenderer.invoke('pdf:release-output', sessionId),
    savePdfFile: (payload) => ipcRenderer.invoke('pdf:save-file', payload),
    savePdfFiles: (payload) => ipcRenderer.invoke('pdf:save-files', payload),
    showPdfOutput: (path) => ipcRenderer.invoke('pdf:show-item', path),
    onPdfSaveProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('pdf:save-progress', listener)
      return () => ipcRenderer.removeListener('pdf:save-progress', listener)
    },

    // ── 区域截图 / 钉图 / OCR（screenshot:*）──────────────────────
    startScreenshot: () => ipcRenderer.invoke('screenshot:start'),
    getScreenshotSession: (sessionId) => ipcRenderer.invoke('screenshot:get-session', sessionId),
    onScreenshotSession: (handler) => {
      const listener = (_event, sessionId) => handler(sessionId)
      ipcRenderer.on('screenshot:begin-session', listener)
      return () => ipcRenderer.removeListener('screenshot:begin-session', listener)
    },
    reportScreenshotReady: (sessionId) => ipcRenderer.invoke('screenshot:overlay-ready', sessionId),
    completeScreenshot: (payload) => ipcRenderer.invoke('screenshot:complete', payload),
    cancelScreenshot: (sessionId) => ipcRenderer.invoke('screenshot:cancel', sessionId),
    saveScreenshot: (payload) => ipcRenderer.invoke('screenshot:save', payload),
    copyScreenshot: (data) => ipcRenderer.invoke('screenshot:copy', data),
    recognizeScreenshot: (data) => ipcRenderer.invoke('screenshot:ocr', data),
    copyScreenshotText: (text) => ipcRenderer.invoke('screenshot:copy-text', text),
    pinScreenshot: (data) => ipcRenderer.invoke('screenshot:pin', data),
    getPinnedScreenshot: (pinId) => ipcRenderer.invoke('screenshot:pin-get', pinId),
    resizePinnedScreenshot: (payload) => ipcRenderer.invoke('screenshot:pin-resize', payload),
    setPinnedScreenshotOpacity: (payload) => ipcRenderer.invoke('screenshot:pin-opacity', payload),
    copyPinnedScreenshot: (pinId) => ipcRenderer.invoke('screenshot:pin-copy', pinId),
    closePinnedScreenshot: (pinId) => ipcRenderer.invoke('screenshot:pin-close', pinId),
    onScreenshotCaptured: (callback) => {
      const listener = (_event, result) => callback(result)
      ipcRenderer.on('screenshot:captured', listener)
      return () => ipcRenderer.removeListener('screenshot:captured', listener)
    },
    onScreenshotCancelled: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('screenshot:cancelled', listener)
      return () => ipcRenderer.removeListener('screenshot:cancelled', listener)
    },
    onScreenshotOcrProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('screenshot:ocr-progress', listener)
      return () => ipcRenderer.removeListener('screenshot:ocr-progress', listener)
    },

    // ── 全局截图快捷键设置（shortcut:*，F-16）─────────────────────
    onCaptureShortcut: (handler) => {
      const listener = () => handler()
      ipcRenderer.on('shortcut:capture', listener)
      return () => ipcRenderer.off('shortcut:capture', listener)
    },
    onShortcutStatus: (handler) => {
      const listener = (_event, payload) => handler(payload)
      ipcRenderer.on('shortcut:status', listener)
      return () => ipcRenderer.off('shortcut:status', listener)
    },
    reportShortcutReady: () => ipcRenderer.send('shortcut:ready'),
    getCaptureShortcut: () => ipcRenderer.invoke('shortcut:get'),
    setCaptureShortcut: (payload) => ipcRenderer.invoke('shortcut:set', payload),
    resetCaptureShortcut: () => ipcRenderer.invoke('shortcut:reset'),

    // ── 自动更新（update:*，GitHub Releases）──────────────────────
    update: {
      getState: () => ipcRenderer.invoke('update:get-state'),
      getSettings: () => ipcRenderer.invoke('update:get-settings'),
      setAutoCheck: (enabled) => ipcRenderer.invoke('update:set-auto-check', enabled),
      check: () => ipcRenderer.invoke('update:check'),
      download: () => ipcRenderer.invoke('update:download'),
      install: () => ipcRenderer.invoke('update:install'),
      openReleases: () => ipcRenderer.invoke('update:open-releases'),
      onState: (handler) => {
        const listener = (_event, payload) => handler(payload)
        ipcRenderer.on('update:state', listener)
        return () => ipcRenderer.removeListener('update:state', listener)
      }
    }
  })
)
