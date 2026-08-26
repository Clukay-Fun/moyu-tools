import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld(
  'api',
  Object.freeze({
    ping: () => ipcRenderer.invoke('ping'),
    getAppInfo: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    probeCom: () => ipcRenderer.invoke('com:probe'),
    saveBarcodeFile: (payload) => ipcRenderer.invoke('barcode:save-file', payload),
    saveBarcodeFiles: (payload) => ipcRenderer.invoke('barcode:save-files', payload),
    copyBarcodeVector: (data) => ipcRenderer.invoke('barcode:copy-vector', data),
    exportBarcodeEps: (payload) => ipcRenderer.invoke('barcode:export-eps', payload),
    illustratorUngroupedCopy: (payload) =>
      ipcRenderer.invoke('barcode:illustrator-ungrouped-copy', payload),
    openBarcodeInIllustrator: (payload) => ipcRenderer.invoke('barcode:open-illustrator', payload),
    openBarcodeInPhotoshop: (payload) => ipcRenderer.invoke('barcode:open-photoshop', payload),
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
    reportStartupReady: () => ipcRenderer.send('startup:report-ready'),
    saveImageFile: (payload) => ipcRenderer.invoke('image:save-file', payload),
    // 全局截图快捷键设置（F-16）
    // 窗口恢复后重新激活画布（F-15）
    onWindowRevive: (handler) => {
      const listener = () => handler()
      ipcRenderer.on('window:revive', listener)
      return () => ipcRenderer.removeListener('window:revive', listener)
    },
    getCaptureShortcut: () => ipcRenderer.invoke('shortcut:get'),
    setCaptureShortcut: (payload) => ipcRenderer.invoke('shortcut:set', payload),
    resetCaptureShortcut: () => ipcRenderer.invoke('shortcut:reset'),
    pickIllustratorFiles: () => ipcRenderer.invoke('illustrator:pick-files'),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    addDroppedIllustratorFiles: (paths) => ipcRenderer.invoke('illustrator:add-paths', paths),
    // 统一拖入扫描：renderer 只提交路径 + 区域/动作，主进程递归扫描并校验。
    scanDroppedPaths: (payload) => ipcRenderer.invoke('drop:scan-paths', payload),
    readDroppedFile: (filePath) => ipcRenderer.invoke('drop:read-file', filePath),
    pickIllustratorFolder: () => ipcRenderer.invoke('illustrator:pick-folder'),
    removeIllustratorInputs: (inputIds) => ipcRenderer.invoke('illustrator:remove-inputs', inputIds),
    runIllustratorTask: (payload) => ipcRenderer.invoke('illustrator:run', payload),
    cancelIllustratorTask: () => ipcRenderer.invoke('illustrator:cancel'),
    pickOfficeFile: (kind) => ipcRenderer.invoke('office:pick-file', kind),
    convertOfficeToPdf: (payload) => ipcRenderer.invoke('office:to-pdf', payload),
    showComResult: (resultId) => ipcRenderer.invoke('com:show-result', resultId),
    getFormatStatus: () => ipcRenderer.invoke('format:get-status'),
    pickFormatFiles: (payload) => ipcRenderer.invoke('format:pick-files', payload),
    addDroppedFormatFiles: (paths, kind) =>
      ipcRenderer.invoke('format:add-paths', { paths, kind }),
    pickFormatFolder: (payload) => ipcRenderer.invoke('format:pick-folder', payload),
    removeFormatInputs: (inputIds) => ipcRenderer.invoke('format:remove-inputs', inputIds),
    runFormatTask: (payload) => ipcRenderer.invoke('format:run', payload),
    cancelFormatTask: (taskId) => ipcRenderer.invoke('format:cancel', taskId),
    saveFormatResults: (resultIds) => ipcRenderer.invoke('format:save-results', resultIds),
    choosePdfOutput: (payload) => ipcRenderer.invoke('pdf:choose-output', payload),
    savePdfFile: (payload) => ipcRenderer.invoke('pdf:save-file', payload),
    savePdfFiles: (payload) => ipcRenderer.invoke('pdf:save-files', payload),
    showPdfOutput: (path) => ipcRenderer.invoke('pdf:show-item', path),
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
    onBarcodeSaveProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('barcode:save-progress', listener)
      return () => ipcRenderer.removeListener('barcode:save-progress', listener)
    },
    onIllustratorProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('illustrator:progress', listener)
      return () => ipcRenderer.removeListener('illustrator:progress', listener)
    },
    onPdfSaveProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('pdf:save-progress', listener)
      return () => ipcRenderer.removeListener('pdf:save-progress', listener)
    },
    onFormatProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('format:progress', listener)
      return () => ipcRenderer.removeListener('format:progress', listener)
    },
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
    // 自动更新（GitHub Releases）
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
