import { cleanIpcError } from '../comErrors.js'

/**
 * Illustrator 批处理页面（导出 PDF / 最小化 PDF / 文字转曲）。
 * 从 main.js 原样搬出，只是把散落在顶层脚本里的这一段收进一个函数——
 * DOM 结构、事件绑定顺序、状态字段全部与拆分前逐字一致。
 *
 * @param {object} deps
 * @param {(message: string) => void} deps.showToast
 * @param {(element: Element, onDrop: (files: FileList) => void) => void} deps.bindFileDropZone
 * @param {(files: FileList) => string[]} deps.droppedFilePaths
 */
export function initIllustrator({ showToast, bindFileDropZone, droppedFilePaths }) {
  const illustratorState = {
    inputs: [],
    statuses: new Map(),
    busy: false,
    outputs: []
  }
  const illustratorFileBody = document.querySelector('#illustrator-file-body')
  const illustratorEmpty = document.querySelector('#illustrator-empty')
  const illustratorDropZone = document.querySelector('#illustrator-drop-zone')
  const illustratorAddFilesButton = document.querySelector('#illustrator-add-files')
  const illustratorAddFolderButton = document.querySelector('#illustrator-add-folder')
  const illustratorClearButton = document.querySelector('#illustrator-clear')
  const illustratorStopButton = document.querySelector('#illustrator-stop')
  const illustratorSameDirectory = document.querySelector('#illustrator-same-directory')
  const illustratorProgressFill = document.querySelector('#illustrator-progress-fill')
  const illustratorProgressText = document.querySelector('#illustrator-progress-text')
  const illustratorProgressSummary = document.querySelector('#illustrator-progress-summary')
  const illustratorLog = document.querySelector('#illustrator-log')
  const illustratorOpenOutputButton = document.querySelector('#illustrator-open-output')
  const illustratorRunButton = document.querySelector('#illustrator-run')
  const illustratorModeButtons = Array.from(document.querySelectorAll('.illustrator-mode-switch button'))
  const illustratorModeLabels = {
    'standard-pdf': '导出 PDF',
    'minimal-pdf': '最小化 PDF',
    outline: '文字转曲'
  }
  let illustratorSelectedAction = 'standard-pdf'

  function illustratorFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }

  function appendIllustratorLog(message) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const lines = `${illustratorLog.textContent}\n[${timestamp}] ${message}`.trim().split('\n').slice(-120)
    illustratorLog.textContent = lines.join('\n')
    illustratorLog.scrollTop = illustratorLog.scrollHeight
  }

  function renderIllustratorFiles() {
    illustratorFileBody.replaceChildren()
    illustratorEmpty.classList.toggle('hidden', illustratorState.inputs.length > 0)

    illustratorState.inputs.forEach((file) => {
      const row = document.createElement('div')
      const name = document.createElement('span')
      const size = document.createElement('span')
      const status = document.createElement('span')
      const remove = document.createElement('button')
      const currentStatus = illustratorState.statuses.get(file.id) || '待处理'
      const statusClass = currentStatus === '完成' ? 'success'
        : currentStatus === '处理中' ? 'busy'
        : currentStatus === '失败' ? 'error'
        : currentStatus === '已取消' ? 'cancelled'
        : ''

      row.className = 'pdf-file-row illustrator-file-row'
      name.className = 'cell-name'
      size.className = 'cell-meta'
      status.className = `cell-status illustrator-status ${statusClass}`
      name.textContent = file.name
      name.title = file.name
      size.textContent = illustratorFileSize(file.size)
      status.textContent = currentStatus
      remove.type = 'button'
      remove.className = 'pdf-remove-file illustrator-remove-file'
      remove.dataset.id = file.id
      remove.disabled = illustratorState.busy
      remove.setAttribute('aria-label', `移除 ${file.name}`)
      remove.textContent = '×'
      row.append(name, size, status, remove)
      illustratorFileBody.append(row)
    })

    const hasFiles = illustratorState.inputs.length > 0
    const completed = illustratorState.inputs.filter((file) => illustratorState.statuses.get(file.id) === '完成').length
    const failed = illustratorState.inputs.filter((file) => illustratorState.statuses.get(file.id) === '失败').length
    illustratorProgressSummary.textContent = hasFiles
      ? `${illustratorState.inputs.length} 个文件 · 已完成 ${completed} 个 · 失败 ${failed} 个`
      : '0 个文件 · 等待任务'
    illustratorAddFilesButton.disabled = illustratorState.busy
    illustratorAddFolderButton.disabled = illustratorState.busy
    illustratorClearButton.disabled = illustratorState.busy || !hasFiles
    illustratorSameDirectory.disabled = illustratorState.busy
    illustratorModeButtons.forEach((button) => {
      const selected = button.dataset.illustratorAction === illustratorSelectedAction
      button.classList.toggle('active', selected)
      button.setAttribute('aria-checked', String(selected))
      button.disabled = illustratorState.busy
    })
    illustratorRunButton.disabled = illustratorState.busy || !hasFiles
    illustratorRunButton.hidden = illustratorState.busy
    illustratorStopButton.hidden = !illustratorState.busy
    illustratorStopButton.disabled = !illustratorState.busy
  }

  async function addIllustratorInputs(picker) {
    if (illustratorState.busy) return
    try {
      const files = await picker()
      if (!files.length) return
      const known = new Set(illustratorState.inputs.map((file) => file.id))
      const added = files.filter((file) => {
        const key = file.id
        if (known.has(key)) return false
        known.add(key)
        return true
      })
      illustratorState.inputs.push(...added)
      added.forEach((file) => illustratorState.statuses.set(file.id, '待处理'))
      illustratorState.outputs = []
      illustratorOpenOutputButton.disabled = true
      renderIllustratorFiles()
      appendIllustratorLog(`已添加 ${added.length} 个文件，共 ${illustratorState.inputs.length} 个。`)
    } catch (error) {
      appendIllustratorLog(`添加失败：${error instanceof Error ? error.message : String(error)}`)
      showToast('无法添加 Illustrator 文件')
    }
  }

  async function runIllustratorAction(action) {
    if (illustratorState.busy || !illustratorState.inputs.length) return
    illustratorState.busy = true
    illustratorState.outputs = []
    illustratorOpenOutputButton.disabled = true
    illustratorState.inputs.forEach((file) => illustratorState.statuses.set(file.id, '待处理'))
    illustratorProgressFill.style.width = '0%'
    illustratorProgressText.textContent = '正在启动 Illustrator…'
    renderIllustratorFiles()
    const actionLabel = illustratorModeLabels[action]
    appendIllustratorLog(`开始${actionLabel}，共 ${illustratorState.inputs.length} 个文件。`)

    try {
      const result = await window.api.runIllustratorTask({
        action,
        inputIds: illustratorState.inputs.map((file) => file.id),
        sameDirectory: illustratorSameDirectory.checked
      })
      if (result.status === 'completed') {
        illustratorState.inputs.forEach((file) => illustratorState.statuses.set(file.id, '完成'))
        illustratorState.outputs = result.outputs
        illustratorProgressFill.style.width = '100%'
        illustratorProgressText.textContent = `已完成 ${result.outputs.length} / ${illustratorState.inputs.length}`
        illustratorOpenOutputButton.disabled = result.outputs.length === 0
        appendIllustratorLog(`${actionLabel}完成，已生成 ${result.outputs.length} 个文件。`)
        showToast(`${actionLabel}完成`)
      } else {
        // 已经完成的文件不倒退成"已取消"；还没轮到、或正卡在"处理中"的
        // （批处理其实是整批一次性发给 COM worker，一旦停止不会再继续处理
        // 剩下的文件）才需要一个终止态，否则文件列表会一直显示"待处理/
        // 处理中"，像是还会继续跑，实际上不会了。
        illustratorState.inputs.forEach((file) => {
          const current = illustratorState.statuses.get(file.id)
          if (current !== '完成') illustratorState.statuses.set(file.id, '已取消')
        })
        illustratorProgressText.textContent = '任务已取消'
        appendIllustratorLog('任务已取消；当前 COM 操作完成后停止。')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      illustratorState.inputs.forEach((file) => {
        if (illustratorState.statuses.get(file.id) === '处理中') {
          illustratorState.statuses.set(file.id, '失败')
        }
      })
      illustratorProgressText.textContent = '任务失败'
      appendIllustratorLog(`任务失败：${reason}`)
      showToast('Illustrator 任务失败')
    } finally {
      illustratorState.busy = false
      renderIllustratorFiles()
    }
  }

  illustratorAddFilesButton.addEventListener('click', () => addIllustratorInputs(window.api.pickIllustratorFiles))
  illustratorAddFolderButton.addEventListener('click', () => addIllustratorInputs(window.api.pickIllustratorFolder))
  document.querySelector('#illustrator-empty-add-files').addEventListener('click', () => illustratorAddFilesButton.click())
  document.querySelector('#illustrator-empty-add-folder').addEventListener('click', () => illustratorAddFolderButton.click())
  bindFileDropZone(illustratorDropZone, async (files) => {
    if (illustratorState.busy) return
    try {
      const result = await window.api.scanDroppedPaths({
        paths: droppedFilePaths(files),
        region: 'illustrator'
      })
      await addIllustratorInputs(async () => result.files)
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
  illustratorClearButton.addEventListener('click', async () => {
    if (illustratorState.busy) return
    const ids = illustratorState.inputs.map((file) => file.id)
    await window.api.removeIllustratorInputs(ids)
    illustratorState.inputs = []
    illustratorState.statuses.clear()
    illustratorState.outputs = []
    illustratorProgressFill.style.width = '0%'
    illustratorProgressText.textContent = '等待任务'
    illustratorOpenOutputButton.disabled = true
    illustratorLog.textContent = '等待添加 Illustrator 文件。'
    renderIllustratorFiles()
  })
  illustratorFileBody.addEventListener('click', async (event) => {
    const button = event.target.closest('.illustrator-remove-file')
    if (!button || illustratorState.busy) return
    await window.api.removeIllustratorInputs([button.dataset.id])
    illustratorState.inputs = illustratorState.inputs.filter((file) => file.id !== button.dataset.id)
    illustratorState.statuses.delete(button.dataset.id)
    renderIllustratorFiles()
  })
  illustratorModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (illustratorState.busy) return
      illustratorSelectedAction = button.dataset.illustratorAction
      renderIllustratorFiles()
    })
  })
  illustratorRunButton.addEventListener('click', () => runIllustratorAction(illustratorSelectedAction))
  illustratorStopButton.addEventListener('click', async () => {
    const result = await window.api.cancelIllustratorTask()
    if (result.status === 'cancelling') {
      illustratorStopButton.disabled = true
      illustratorProgressText.textContent = '正在停止…'
      appendIllustratorLog('已请求停止，将在当前文件处理结束后生效。')
    }
  })
  illustratorOpenOutputButton.addEventListener('click', async () => {
    if (illustratorState.outputs[0]) {
      await window.api.showComResult(illustratorState.outputs[0].id)
    }
  })
  window.api.onIllustratorProgress((progress) => {
    if (!illustratorState.busy) return
    const total = Math.max(1, Number(progress.total) || illustratorState.inputs.length || 1)
    const completed = Math.max(0, Math.min(total, Number(progress.completed) || 0))
    illustratorState.inputs.forEach((file, index) => {
      if (index < completed) illustratorState.statuses.set(file.id, '完成')
      else if (index === completed && completed < total) illustratorState.statuses.set(file.id, '处理中')
    })
    illustratorProgressFill.style.width = `${completed / total * 100}%`
    illustratorProgressText.textContent = progress.message || `处理中 ${completed} / ${total}`
    if (progress.message) appendIllustratorLog(progress.message)
    renderIllustratorFiles()
  })
  renderIllustratorFiles()

  return {
    isBusy: () => illustratorState.busy
  }
}
