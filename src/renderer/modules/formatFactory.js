import { cleanIpcError } from '../comErrors.js'

/**
 * 格式工厂页面（视频转换/压缩、音频转换/抽取、图片转换/压缩）。
 * 从 main.js 原样搬出。与 illustrator.js 不同，这里跟全局的顶部子菜单
 * 导航系统（state.selections / renderSubmenu）双向耦合——顶部子菜单点击时
 * 由 main.js 反过来调用这里导出的 setFormatAction，所以不能像 illustrator
 * 那样完全自包含，需要把 state / renderSubmenu 当依赖传进来。
 *
 * @param {object} deps
 * @param {object} deps.state 全局共享状态（读取/写入 state.selections.video）
 * @param {(module: string, indicatorFromTop?: number|null) => void} deps.renderSubmenu
 * @param {(message: string) => void} deps.showToast
 * @param {(element: Element, onDrop: (files: FileList) => void) => void} deps.bindFileDropZone
 * @param {(files: FileList) => string[]} deps.droppedFilePaths
 * @returns {{ setFormatAction: (action: string, indicatorFromTop?: number|null) => void, isBusy: () => boolean }}
 */
export function initFormatFactory({ state, renderSubmenu, showToast, bindFileDropZone, droppedFilePaths }) {
  const formatActionConfigs = {
    视频转换: {
      kind: 'video',
      mark: 'VID',
      copy: '转换为 MP4、MKV 或 WebM。',
      runLabel: '视频转换',
      targets: [['mp4', 'MP4 · H.264'], ['mkv', 'MKV · H.264'], ['webm', 'WebM · VP9']]
    },
    视频压缩: {
      kind: 'video',
      mark: 'ZIP',
      copy: '使用 H.264 CRF 档位缩小视频体积。',
      runLabel: '视频压缩'
    },
    抽取音频: {
      kind: 'video',
      mark: 'MP3',
      copy: '从视频中导出 MP3、AAC、WAV 或 FLAC。',
      runLabel: '抽取音频',
      targets: [['mp3', 'MP3'], ['m4a', 'AAC / M4A'], ['wav', 'WAV'], ['flac', 'FLAC']]
    },
    音频转换: {
      kind: 'audio',
      mark: 'AUD',
      copy: '在常用音频格式之间批量转换。',
      runLabel: '音频转换',
      targets: [['mp3', 'MP3'], ['m4a', 'AAC / M4A'], ['wav', 'WAV'], ['flac', 'FLAC']]
    },
    图片转换: {
      kind: 'image',
      mark: 'IMG',
      copy: '由 sharp 批量输出常用图片格式。',
      runLabel: '图片转换',
      targets: [['webp', 'WebP'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['avif', 'AVIF'], ['tiff', 'TIFF'], ['gif', 'GIF']]
    },
    图片压缩: {
      kind: 'image',
      mark: 'MIN',
      copy: '保持原格式，按质量与最大宽度批量压缩。',
      runLabel: '图片压缩'
    }
  }

  const formatFileList = document.querySelector('#format-file-list')
  const formatEmpty = document.querySelector('#format-empty')
  const formatOptions = document.querySelector('#format-options')
  const formatRunButton = document.querySelector('#format-run-task')
  const formatCancelButton = document.querySelector('#format-cancel-task')
  const formatSaveButton = document.querySelector('#format-save-results')
  const formatProgressFill = document.querySelector('#format-progress-fill')
  const formatStatusText = document.querySelector('#format-status-text')
  const formatRuntimeState = document.querySelector('#format-runtime-state')
  const formatEngineDetailButton = document.querySelector('#format-engine-detail')
  const formatState = {
    inputs: [],
    results: [],
    progressByInput: new Map(),
    errorsByInput: new Map(),
    cancelledInputIds: new Set(),
    busy: false,
    saving: false,
    taskId: '',
    ffmpegReady: false,
    sharpReady: false,
    engineDetail: ''
  }

  function formatConfig() {
    return formatActionConfigs[state.selections.video] || formatActionConfigs.视频转换
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  function renderFormatFiles() {
    formatFileList.replaceChildren()
    formatEmpty.hidden = formatState.inputs.length > 0
    const resultInputIds = new Set(formatState.results.map((result) => result.inputId))
    const fragment = document.createDocumentFragment()
    formatState.inputs.forEach((input) => {
      const row = document.createElement('article')
      const nameNode = document.createElement('span')
      const name = document.createElement('b')
      const detail = document.createElement('small')
      const size = document.createElement('span')
      const target = document.createElement('span')
      const status = document.createElement('span')
      const remove = document.createElement('button')
      const error = formatState.errorsByInput.get(input.id)
      const progress = formatState.progressByInput.get(input.id)
      row.className = 'format-file-item'
      nameNode.className = 'format-name'
      detail.className = 'format-detail'
      size.className = 'format-size'
      target.className = 'format-target'
      status.className = 'format-file-status'
      remove.className = 'format-remove'
      remove.type = 'button'
      remove.dataset.inputId = input.id
      remove.setAttribute('aria-label', `移除 ${input.name}`)
      remove.textContent = '×'
      remove.disabled = formatState.busy
      name.textContent = input.name
      const inputDetail = input.dimensions?.width
        ? `${input.dimensions.width} × ${input.dimensions.height}`
        : (input.name.split('.').at(-1) || input.kind).toUpperCase()
      detail.textContent = error || inputDetail
      detail.title = error || ''
      size.textContent = formatSize(input.size)
      target.textContent = formatOptions.querySelector('#format-target')?.selectedOptions?.[0]?.textContent
        || (state.selections.video.includes('压缩') ? '原格式' : '—')
      if (error) {
        status.textContent = '导出失败'
        status.classList.add('error')
        status.title = error
      } else if (resultInputIds.has(input.id)) {
        status.textContent = '已导出'
        status.classList.add('success')
      } else if (formatState.cancelledInputIds.has(input.id)) {
        status.textContent = '已取消'
        status.classList.add('cancelled')
      } else if (Number.isFinite(progress)) {
        status.textContent = `转换中 ${Math.round(progress * 100)}%`
        status.classList.add('busy')
      } else {
        status.textContent = '等待处理'
      }
      nameNode.append(name)
      row.append(nameNode, detail, size, target, status, remove)
      fragment.append(row)
    })
    formatFileList.append(fragment)
    updateFormatControls()
  }

  function updateFormatControls() {
    const config = formatConfig()
    const engineReady = config.kind === 'image' ? formatState.sharpReady : formatState.ffmpegReady
    formatRunButton.disabled = formatState.busy || !formatState.inputs.length || !engineReady
    formatSaveButton.disabled = formatState.busy || !formatState.results.length
    document.querySelector('#format-pick-files').disabled = formatState.busy
    document.querySelector('#format-pick-folder').disabled = formatState.busy
    document.querySelector('#format-clear-inputs').disabled = formatState.busy
  }

  function renderFormatOptions() {
    const config = formatConfig()
    const isImage = config.kind === 'image'
    const qualityLabel = isImage ? '质量' : 'CRF（越低越清晰）'
    const qualityValue = isImage ? 82 : state.selections.video === '视频压缩' ? 28 : 23
    const qualityMin = isImage ? 10 : 18
    const qualityMax = isImage ? 100 : 35
    const target = config.targets
      ? `
      <label>输出格式
        <select id="format-target">
          ${config.targets.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
      </label>
    `
      : ''
    const audioOptions = ['视频转换', '视频压缩', '抽取音频', '音频转换'].includes(state.selections.video)
      ? `
      <label>音频码率 <b id="format-bitrate-value">192 kbps</b>
        <input id="format-audio-bitrate" type="range" min="64" max="320" step="32" value="192" />
      </label>
      <label>采样率
        <select id="format-sample-rate">
          <option value="44100">44.1 kHz</option>
          <option value="48000">48 kHz</option>
          <option value="32000">32 kHz</option>
        </select>
      </label>
    `
      : ''
    formatOptions.innerHTML = `
    ${target}
    <label>${qualityLabel} <b id="format-quality-value">${qualityValue}</b>
      <input id="format-quality" type="range" min="${qualityMin}" max="${qualityMax}" value="${qualityValue}" />
    </label>
    <label>最大宽度
      <select id="format-max-width">
        <option value="0">保持原尺寸</option>
        <option value="3840">3840 px</option>
        <option value="1920">1920 px</option>
        <option value="1280">1280 px</option>
        <option value="720">720 px</option>
      </select>
    </label>
    ${audioOptions}
  `
    const quality = formatOptions.querySelector('#format-quality')
    quality.addEventListener('input', () => {
      formatOptions.querySelector('#format-quality-value').textContent = quality.value
    })
    const bitrate = formatOptions.querySelector('#format-audio-bitrate')
    bitrate?.addEventListener('input', () => {
      formatOptions.querySelector('#format-bitrate-value').textContent = `${bitrate.value} kbps`
    })
    formatOptions.querySelector('#format-target')?.addEventListener('change', renderFormatFiles)
  }

  function setFormatAction(action, indicatorFromTop = null) {
    if (!formatActionConfigs[action]) return
    const previousKind = formatConfig().kind
    state.selections.video = action
    const config = formatConfig()
    document.querySelector('#format-crumb').textContent = action
    document.querySelector('#format-action-title').textContent = `${action}设置`
    document.querySelector('#format-action-copy').textContent = config.copy
    document.querySelector('#format-empty-title').textContent =
      `添加${config.kind === 'video' ? '视频' : config.kind === 'audio' ? '音频' : '图片'}文件`
    document.querySelector('#format-pick-files').textContent =
      `＋ 添加${config.kind === 'video' ? '视频' : config.kind === 'audio' ? '音频' : '图片'}`
    document.querySelector('#format-support-hint').textContent = config.kind === 'video'
      ? '支持 MP4 / MOV / MKV / AVI / WebM 等格式'
      : config.kind === 'audio'
        ? '支持 MP3 / AAC / WAV / FLAC / OGG 等格式'
        : '支持 JPG / PNG / WebP / AVIF / TIFF / GIF 等格式'
    formatRunButton.textContent = config.runLabel
    if (previousKind !== config.kind && formatState.inputs.length) clearFormatInputs()
    formatState.results = []
    formatState.progressByInput.clear()
    formatState.errorsByInput.clear()
    formatState.cancelledInputIds.clear()
    formatProgressFill.style.width = '0'
    formatStatusText.textContent = formatState.inputs.length ? `${formatState.inputs.length} 个文件 · 准备就绪` : '0 个文件 · 等待添加'
    renderFormatOptions()
    renderSubmenu('video', indicatorFromTop)
    renderFormatFiles()
    loadFormatRuntimeStatus()
  }

  function addFormatInputs(files, replace = false) {
    if (replace) {
      window.api.removeFormatInputs(formatState.inputs.map((input) => input.id)).catch(() => {})
      formatState.inputs = []
    }
    const knownIds = new Set(formatState.inputs.map((input) => input.id))
    const unique = files.filter((file) => !knownIds.has(file.id))
    const available = Math.max(0, 100 - formatState.inputs.length)
    const accepted = unique.slice(0, available)
    const rejected = unique.slice(available)
    if (rejected.length) {
      window.api.removeFormatInputs(rejected.map((file) => file.id)).catch(() => {})
    }
    formatState.inputs.push(...accepted)
    formatState.results = []
    formatState.progressByInput.clear()
    formatState.errorsByInput.clear()
    formatState.cancelledInputIds.clear()
    formatStatusText.textContent = `已添加 ${formatState.inputs.length} 个文件`
    formatProgressFill.style.width = '0'
    renderFormatFiles()
  }

  async function pickFormatFiles() {
    try {
      const result = await window.api.pickFormatFiles({ kind: formatConfig().kind })
      if (result.status !== 'selected') return
      addFormatInputs(result.files)
      if (result.errors.length) showToast(`${result.errors.length} 个文件未能加入`)
    } catch (error) {
      showToast(`添加文件失败：${error.message}`)
    }
  }

  async function pickFormatFolder() {
    try {
      const result = await window.api.pickFormatFolder({ kind: formatConfig().kind })
      if (result.status !== 'selected') return
      addFormatInputs(result.files, true)
      if (result.truncated) showToast('文件超过 100 个，已取前 100 个')
      else if (result.errors.length) showToast(`${result.errors.length} 个文件未能加入`)
    } catch (error) {
      showToast(`读取文件夹失败：${error.message}`)
    }
  }

  const formatDropZone = document.querySelector('#format-drop-zone')
  bindFileDropZone(formatDropZone, async (files) => {
    if (formatState.busy) return
    try {
      const result = await window.api.scanDroppedPaths({
        paths: droppedFilePaths(files),
        region: 'format',
        action: formatConfig().kind
      })
      addFormatInputs(result.files)
      if (result.skipped || result.errors.length || result.truncated) {
        const notes = []
        if (result.skipped) notes.push(`${result.skipped} 个跳过`)
        if (result.errors.length) notes.push(`${result.errors.length} 个失败`)
        if (result.truncated) notes.push('已达数量上限')
        if (notes.length) showToast(`扫描完成：${notes.join('，')}`)
      }
    } catch (error) {
      showToast(`拖入失败：${cleanIpcError(error?.message ?? error)}`)
    }
  })

  async function clearFormatInputs() {
    const ids = formatState.inputs.map((input) => input.id)
    formatState.inputs = []
    formatState.results = []
    formatState.progressByInput.clear()
    formatState.errorsByInput.clear()
    formatState.cancelledInputIds.clear()
    formatState.taskId = ''
    formatProgressFill.style.width = '0'
    formatStatusText.textContent = '0 个文件 · 等待添加'
    renderFormatFiles()
    if (ids.length) await window.api.removeFormatInputs(ids).catch(() => {})
  }

  function currentFormatOptions() {
    return {
      target: formatOptions.querySelector('#format-target')?.value || '',
      quality: Number(formatOptions.querySelector('#format-quality')?.value),
      maxWidth: Number(formatOptions.querySelector('#format-max-width')?.value),
      audioBitrate: Number(formatOptions.querySelector('#format-audio-bitrate')?.value || 192),
      sampleRate: Number(formatOptions.querySelector('#format-sample-rate')?.value || 44100)
    }
  }

  async function runFormatTask() {
    if (formatState.busy || !formatState.inputs.length) return
    formatState.busy = true
    formatState.results = []
    formatState.progressByInput.clear()
    formatState.errorsByInput.clear()
    formatState.cancelledInputIds.clear()
    formatState.taskId = crypto.randomUUID()
    formatRunButton.textContent = '处理中…'
    formatCancelButton.hidden = false
    formatStatusText.textContent = '正在准备任务…'
    updateFormatControls()
    try {
      const response = await window.api.runFormatTask({
        taskId: formatState.taskId,
        action: state.selections.video,
        inputIds: formatState.inputs.map((input) => input.id),
        options: currentFormatOptions()
      })
      if (response.status === 'cancelled') {
        // 主进程在取消时会把已经处理完的 results/errors 一并带回来——不接住的话，
        // 取消前已经成功转换的文件在列表里会跟"从没跑过"的文件长得一样，
        // 都停在"等待处理"，看不出哪些其实已经导出好了。
        formatState.results = response.results
        response.errors.forEach((error) => {
          formatState.errorsByInput.set(error.inputId, error.message)
        })
        const finishedIds = new Set([
          ...response.results.map((result) => result.inputId),
          ...response.errors.map((error) => error.inputId)
        ])
        formatState.inputs.forEach((input) => {
          if (!finishedIds.has(input.id)) formatState.cancelledInputIds.add(input.id)
        })
        formatStatusText.textContent = '任务已取消'
        showToast('格式转换任务已取消')
      } else {
        formatState.results = response.results
        response.errors.forEach((error) => {
          formatState.errorsByInput.set(error.inputId, error.message)
        })
        formatProgressFill.style.width = '100%'
        formatStatusText.textContent = response.errors.length
          ? `完成 ${response.results.length} 个，失败 ${response.errors.length} 个`
          : `已完成 ${response.results.length} 个文件`
        showToast('格式转换任务完成')
      }
    } catch (error) {
      formatStatusText.textContent = `处理失败：${error.message}`
      showToast('格式转换失败')
    } finally {
      formatState.busy = false
      formatState.taskId = ''
      formatRunButton.textContent = formatConfig().runLabel
      formatCancelButton.hidden = true
      renderFormatFiles()
    }
  }

  async function cancelFormatTask() {
    if (!formatState.taskId) return
    formatCancelButton.disabled = true
    formatStatusText.textContent = '正在取消任务…'
    try {
      await window.api.cancelFormatTask(formatState.taskId)
    } finally {
      formatCancelButton.disabled = false
    }
  }

  async function saveFormatResults() {
    if (!formatState.results.length || formatState.saving) return
    formatState.saving = true
    formatSaveButton.disabled = true
    try {
      const response = await window.api.saveFormatResults(formatState.results.map((result) => result.id))
      if (response.status === 'saved') {
        formatStatusText.textContent = `已保存 ${response.saved} 个结果`
        showToast('格式转换结果已保存')
      }
    } catch (error) {
      showToast(`保存失败：${error.message}`)
    } finally {
      formatState.saving = false
      formatSaveButton.disabled = formatState.results.length === 0
    }
  }

  async function loadFormatRuntimeStatus() {
    try {
      const status = await window.api.getFormatStatus()
      formatState.ffmpegReady = status.ffmpegReady
      formatState.sharpReady = Boolean(status.sharp?.sharp)
      const ready = formatConfig().kind === 'image' ? formatState.sharpReady : formatState.ffmpegReady
      formatRuntimeState.classList.toggle('ready', ready)
      formatRuntimeState.classList.toggle('error', !ready)
      const engineName = formatConfig().kind === 'image'
        ? `sharp ${status.sharp?.sharp || ''}`.trim()
        : (status.ffmpegVersion || 'FFmpeg')
      document.querySelector('#format-engine-status').textContent = ready
        ? `本地引擎正常 · ${engineName}`
        : '转换引擎暂不可用，请检查本地处理组件'
      formatState.engineDetail = ready
        ? `${engineName} 已就绪`
        : (formatConfig().kind === 'image' ? 'sharp 未能加载' : status.ffmpegMessage)
      formatEngineDetailButton.hidden = ready
      updateFormatControls()
    } catch (error) {
      formatRuntimeState.classList.add('error')
      document.querySelector('#format-engine-status').textContent = '转换引擎暂不可用，请检查本地处理组件'
      formatState.engineDetail = cleanIpcError(error?.message ?? error)
      formatEngineDetailButton.hidden = false
    }
  }

  document.querySelector('#format-pick-files').addEventListener('click', pickFormatFiles)
  document.querySelector('#format-pick-folder').addEventListener('click', pickFormatFolder)
  document.querySelector('#format-clear-inputs').addEventListener('click', clearFormatInputs)
  formatFileList.addEventListener('click', async (event) => {
    const button = event.target.closest('.format-remove')
    if (!button || formatState.busy) return
    const inputId = button.dataset.inputId
    formatState.inputs = formatState.inputs.filter((input) => input.id !== inputId)
    formatState.results = formatState.results.filter((result) => result.inputId !== inputId)
    formatState.progressByInput.delete(inputId)
    formatState.errorsByInput.delete(inputId)
    formatState.cancelledInputIds.delete(inputId)
    renderFormatFiles()
    await window.api.removeFormatInputs([inputId]).catch(() => {})
  })
  formatRunButton.addEventListener('click', runFormatTask)
  formatCancelButton.addEventListener('click', cancelFormatTask)
  formatSaveButton.addEventListener('click', saveFormatResults)
  formatEngineDetailButton.addEventListener('click', () => {
    showToast(formatState.engineDetail || '暂无更多引擎信息')
  })
  window.api.onFormatProgress((progress) => {
    if (progress.status === 'running' && progress.taskId === formatState.taskId) {
      const overall = (progress.completed + (progress.fileProgress || 0)) / Math.max(1, progress.total)
      if (progress.inputId) {
        formatState.progressByInput.set(progress.inputId, Math.min(1, progress.fileProgress || 0))
        renderFormatFiles()
      }
      formatProgressFill.style.width = `${Math.min(100, overall * 100)}%`
      formatStatusText.textContent = `正在处理 ${Math.min(progress.completed + 1, progress.total)} / ${progress.total}${progress.name ? ` · ${progress.name}` : ''}`
    } else if (progress.status === 'saving' && formatState.saving) {
      formatStatusText.textContent = `正在保存 ${progress.completed} / ${progress.total}`
    }
  })

  return {
    setFormatAction,
    isBusy: () => formatState.busy
  }
}
