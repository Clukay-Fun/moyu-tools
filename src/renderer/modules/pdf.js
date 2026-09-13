import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions, ImageKind, OPS } from 'pdfjs-dist'
import { createQpdfRunner } from 'qpdf-run'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import qpdfWorkerUrl from 'qpdf-run/worker?url'
import qpdfJsUrl from 'qpdf-run/qpdf.js?url'
import qpdfWasmUrl from 'qpdf-run/qpdf.wasm?url'
import { cleanIpcError, illustratorFailureHint, isComCancelled } from '../comErrors.js'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/**
 * PDF 工具页面：格式转换、合并/拆分/旋转、加密解密、页码/水印、页面重排、
 * 图片转 PDF、提取文字/图片、OCR。从 main.js 原样搬出，DOM 结构、状态字段、
 * 处理顺序与拆分前逐字一致；唯一的行为差异是这次順带把"逐页任务取消"接了进来
 * （集中升级计划·第 5 步，此前完全没有取消能力，属于新功能而非行为搬迁，
 * 已在原地实现并测试过，这里只是把已经验证好的代码一起搬过来）。
 *
 * @param {object} deps
 * @param {object} deps.state 全局共享状态
 * @param {(message: string) => void} deps.showToast
 * @param {(element: Element, onDrop: (files: FileList) => void) => void} deps.bindFileDropZone
 * @param {(files: FileList) => string[]} deps.droppedFilePaths
 * @returns {{ updatePdfState: (action: string) => void, terminateQpdfRunner: () => Promise<void> }}
 *   updatePdfState 供 main.js 的顶部子菜单/搜索分发调用；terminateQpdfRunner
 *   供 main.js 的 beforeunload 清理调用。
 */
export function initPdfTools({
  state,
  showToast,
  bindFileDropZone,
  droppedFilePaths,
  registerPopover,
  openPopover,
  closePopover,
  placePopover,
  isPopoverOpen
}) {
  let qpdfRunnerPromise = null
  let pdfWatermarkPreviewToken = 0
  // PDF 逐页处理任务的取消标记（集中升级计划·第 5 步）。
  // 逐页渲染/OCR/提取文字/提取图片/加水印这几条链路此前完全没有取消能力：
  // 用户点"开始"后只能等它跑完，页数一多（OCR 80 页上限也要跑好一会）体验很差。
  let pdfCancelRequested = false


  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('图片编码失败'))
      }, type, quality)
    })
  }

  const pdfActionConfig = {
    '转 PNG': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '转 JPEG': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '转 TXT': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '合并 PDF': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: true, minFiles: 2 },
    逐页拆分: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '旋转 PDF': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    提取指定页: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    添加水印: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: true, minFiles: 1 },
    添加页码: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    页重排: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    提取图片: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    'OCR 转 TXT': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '加密 PDF': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '解密 PDF': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
    '图片转 PDF': {
      inputLabel: '图片',
      kind: 'image',
      accept: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp',
      multiple: true,
      minFiles: 1
    },
    'Word 转 PDF': {
      inputLabel: 'Word',
      kind: 'office',
      officeKind: 'word',
      accept: '',
      multiple: false,
      minFiles: 1
    },
    'Excel 转 PDF': {
      inputLabel: 'Excel',
      kind: 'office',
      officeKind: 'excel',
      accept: '',
      multiple: false,
      minFiles: 1
    },
    'PPT 转 PDF': {
      inputLabel: 'PowerPoint',
      kind: 'office',
      officeKind: 'powerpoint',
      accept: '',
      multiple: false,
      minFiles: 1
    }
  }
  const pdfFileInput = document.querySelector('#pdf-file-input')
  const pdfAddFilesButton = document.querySelector('#pdf-add-files')
  const pdfClearFilesButton = document.querySelector('#pdf-clear-files')
  const pdfDropZone = document.querySelector('#pdf-drop-zone')
  const pdfWatermarkWorkbench = document.querySelector('#pdf-watermark-workbench')
  const pdfWatermarkFileList = document.querySelector('#pdf-watermark-file-list')
  const pdfWatermarkPreview = document.querySelector('#pdf-watermark-preview')
  const pdfWatermarkPreviewEmpty = document.querySelector('#pdf-watermark-preview-empty')
  const pdfWatermarkPreviewLabel = document.querySelector('#pdf-watermark-preview-label')
  const pdfFileBody = document.querySelector('#pdf-file-body')
  const pdfEmpty = document.querySelector('#pdf-empty')
  const pdfEmptyAddButton = document.querySelector('#pdf-empty-add')
  const pdfEmptyAddLabel = document.querySelector('#pdf-empty-add-label')
  const pdfOptions = document.querySelector('#pdf-options')
  const pdfJpegQualityMenu = document.querySelector('#pdf-jpeg-quality-menu')
  const pdfRunButton = document.querySelector('#run-pdf-action')
  const pdfWatermarkRunButton = document.querySelector('#run-pdf-watermark-action')
  const pdfChooseOutputButton = document.querySelector('#choose-pdf-output')
  const pdfOutputPath = document.querySelector('#pdf-output-path')
  const pdfResultText = document.querySelector('#pdf-result-text')
  const pdfResultDot = document.querySelector('#pdf-result-dot')
  const pdfOpenOutputButton = document.querySelector('#open-pdf-output')
  const pdfCancelButton = document.querySelector('#pdf-cancel-action')
  const pdfPageOrganizer = document.querySelector('#pdf-page-organizer')
  const pdfPageGrid = document.querySelector('#pdf-page-grid')
  const pdfPageSummary = document.querySelector('#pdf-page-summary')
  const pdfInsertPagesInput = document.querySelector('#pdf-insert-pages-input')
  let draggedPdfPageId = ''
  const pdfPageCounts = new WeakMap()
  let pdfDestinationRequest = 0

  function currentPdfConfig() {
    return pdfActionConfig[state.selections.pdf]
  }

  const pdfDirectoryActions = new Set([
    '转 PNG',
    '转 JPEG',
    '逐页拆分',
    '添加水印',
    '提取图片'
  ])

  function currentPdfDefaultOutputKind() {
    return {
      '转 JPEG': 'jpeg',
      '转 PNG': 'png',
      逐页拆分: 'split',
      添加水印: 'watermark',
      提取图片: 'images'
    }[state.selections.pdf] || null
  }

  function isPdfWatermarkAction(action = state.selections.pdf) {
    return action === '添加水印'
  }

  function currentPdfFiles() {
    return isPdfWatermarkAction() ? state.pdfWatermarkFiles : state.pdfFiles
  }

  function currentPdfOutputSpec() {
    const action = state.selections.pdf
    const source = currentPdfConfig().kind === 'office'
      ? state.pdfNativeInput
      : currentPdfFiles()[0]
    const base = source ? pdfOutputBaseName(source) : 'pdf-output'
    const type = action === '转 PNG' || action === '提取图片'
      ? 'png'
      : action === '转 JPEG'
        ? 'jpeg'
        : ['转 TXT', 'OCR 转 TXT'].includes(action)
          ? 'txt'
          : 'pdf'
    const suffix = {
      '合并 PDF': 'merged',
      '旋转 PDF': `${base}-rotated`,
      提取指定页: `${base}-pages`,
      添加水印: `${base}-watermarked`,
      添加页码: `${base}-numbered`,
      页重排: `${base}-reordered`,
      '图片转 PDF': 'images',
      '加密 PDF': `${base}-encrypted`,
      '解密 PDF': `${base}-decrypted`,
      'Word 转 PDF': base,
      'Excel 转 PDF': base,
      'PPT 转 PDF': base,
      '转 TXT': `${base}-text`,
      'OCR 转 TXT': `${base}-ocr`
    }[action] || base
    return {
      mode: pdfDirectoryActions.has(action) ? 'directory' : 'file',
      type,
      name: suffix
    }
  }

  function resetPdfDestination() {
    pdfDestinationRequest += 1
    const previous = state.pdfDestination
    state.pdfDestination = null
    if (previous?.id) void window.api.releasePdfOutput(previous.id)
    pdfOutputPath.textContent = currentPdfDefaultOutputKind()
      ? '添加文件后自动设置'
      : '尚未选择'
    pdfOutputPath.title = ''
    pdfChooseOutputButton.textContent = '更改'
  }

  function setPdfDestination(destination) {
    const previous = state.pdfDestination
    state.pdfDestination = destination
    if (previous?.id && previous.id !== destination.id) void window.api.releasePdfOutput(previous.id)
    pdfOutputPath.textContent = destination.path
    pdfOutputPath.title = destination.path
    pdfChooseOutputButton.textContent = '更改'
    updatePdfRunState()
  }

  async function setDefaultPdfDestination(file, preparedDestination = null) {
    const outputKind = currentPdfDefaultOutputKind()
    if (!file || !outputKind) return
    const request = ++pdfDestinationRequest
    try {
      const destination = preparedDestination || await window.api.createDefaultPdfOutput(file, outputKind)
      if (request !== pdfDestinationRequest || !destination) {
        if (destination?.id) void window.api.releasePdfOutput(destination.id)
        return
      }
      setPdfDestination(destination)
    } catch (error) {
      if (request !== pdfDestinationRequest) return
      pdfOutputPath.textContent = '自动设置失败，请手动选择'
      pdfOutputPath.title = cleanIpcError(error?.message ?? error)
      updatePdfRunState()
    }
  }

  function isAcceptedPdfToolFile(file, config = currentPdfConfig()) {
    if (config.kind === 'office') return false
    const name = file.name.toLowerCase()
    if (config.kind === 'pdf') {
      return file.type === 'application/pdf' || name.endsWith('.pdf')
    }
    return (
      ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      /\.(png|jpe?g|webp)$/i.test(name)
    )
  }

  function renderPdfOptions() {
    const action = state.selections.pdf
    if (isPopoverOpen(pdfJpegQualityMenu)) closePopover(pdfJpegQualityMenu)
    pdfOptions.replaceChildren()

    if (action === '旋转 PDF') {
      pdfOptions.innerHTML = `
        <label>旋转
          <select id="pdf-rotation">
            <option value="90">90°</option>
            <option value="180">180°</option>
            <option value="270">270°</option>
          </select>
        </label>
      `
    } else if (action === '逐页拆分') {
      pdfOptions.innerHTML = '<span class="pdf-option-status" id="pdf-split-estimate">每一页将生成一个独立 PDF 文件</span>'
    } else if (action === '提取指定页') {
      pdfOptions.innerHTML = `
        <label>页码
          <input id="pdf-page-range" type="text" value="1" placeholder="如 1-3,5">
        </label>
        <span class="pdf-option-status">示例 1-3,5：合并导出为一个 4 页 PDF</span>
      `
    } else if (action === '转 JPEG') {
      pdfOptions.innerHTML = `
        <label>质量
          <button class="pdf-select-trigger" id="pdf-jpeg-quality" type="button"
            data-value="${state.pdfJpegQuality}" aria-haspopup="listbox" aria-expanded="false">
            ${Math.round(Number(state.pdfJpegQuality) * 100)}%
          </button>
        </label>
      `
      bindPdfJpegQualityMenu()
    } else if (action === '添加页码') {
      pdfOptions.innerHTML = `
        <label>位置
          <select id="pdf-page-number-position">
            <option value="footer">页脚</option>
            <option value="header">页眉</option>
          </select>
        </label>
        <label>起始
          <input id="pdf-page-number-start" type="number" min="0" max="99999" value="1">
        </label>
      `
    } else if (action === '页重排') {
      pdfOptions.innerHTML = `
        <button class="gbtn compact" id="pdf-open-page-organizer" type="button">编辑页面顺序</button>
        <span class="pdf-option-status" id="pdf-page-option-status">上传 PDF 后载入页面</span>
      `
      pdfOptions.querySelector('#pdf-open-page-organizer').addEventListener('click', openPdfPageOrganizer)
    } else if (action === '加密 PDF') {
      pdfOptions.innerHTML = `
        <label>打开口令
          <input id="pdf-encrypt-password" type="password" maxlength="127" autocomplete="new-password">
        </label>
        <label>确认口令
          <input id="pdf-encrypt-password-confirm" type="password" maxlength="127" autocomplete="new-password">
        </label>
        <span class="pdf-option-status">AES-256 · R6</span>
      `
    } else if (action === '解密 PDF') {
      pdfOptions.innerHTML = `
        <label>PDF 口令
          <input id="pdf-decrypt-password" type="password" maxlength="127" autocomplete="current-password">
        </label>
        <span class="pdf-option-status">支持 user / owner password</span>
      `
    }
  }

  function bindPdfJpegQualityMenu() {
    const trigger = pdfOptions.querySelector('#pdf-jpeg-quality')
    if (!trigger) return
    registerPopover(pdfJpegQualityMenu, trigger)

    const openMenu = ({ focusOption = false } = {}) => {
      openPopover(pdfJpegQualityMenu)
      placePopover(pdfJpegQualityMenu, trigger, { matchWidth: true })
      if (focusOption) {
        const selected = pdfJpegQualityMenu.querySelector('[aria-selected="true"]')
        ;(selected || pdfJpegQualityMenu.querySelector('button'))?.focus()
      }
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      if (isPopoverOpen(pdfJpegQualityMenu)) closePopover(pdfJpegQualityMenu)
      else openMenu()
    })
    trigger.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      openMenu({ focusOption: true })
    })
  }

  pdfJpegQualityMenu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-value]')
    if (!option) return
    state.pdfJpegQuality = option.dataset.value
    pdfJpegQualityMenu.querySelectorAll('[role="option"]').forEach((item) => {
      item.setAttribute('aria-selected', String(item === option))
    })
    const trigger = pdfOptions.querySelector('#pdf-jpeg-quality')
    if (trigger) {
      trigger.dataset.value = state.pdfJpegQuality
      trigger.textContent = `${Math.round(Number(state.pdfJpegQuality) * 100)}%`
    }
    closePopover(pdfJpegQualityMenu)
    trigger?.focus({ preventScroll: true })
  })

  pdfJpegQualityMenu.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const options = [...pdfJpegQualityMenu.querySelectorAll('[role="option"]')]
    const current = options.indexOf(document.activeElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(options.length - 1, current + 1)
          : Math.max(0, current - 1)
    options[next]?.focus()
  })

  function pdfIdleSummary(files) {
    if (!files.length) return '0 个文件 · 等待添加'
    const totalSize = files.reduce((total, file) => total + (Number(file.size) || 0), 0)
    const pageCounts = files.map((file) => pdfPageCounts.get(file)).filter(Number.isInteger)
    const pages = pageCounts.length === files.length
      ? ` · ${pageCounts.reduce((total, count) => total + count, 0)} 页`
      : ''
    return `${files.length} 个文件${pages} · ${(totalSize / 1024 / 1024).toFixed(2)} MB`
  }

  function shouldShowPdfPageCount() {
    return currentPdfConfig().kind === 'pdf'
  }

  function loadPdfPageCount(file) {
    if (!shouldShowPdfPageCount() || pdfPageCounts.has(file)) return
    pdfPageCounts.set(file, 'loading')
    void readPdfDocument(file).then((document) => {
      pdfPageCounts.set(file, document.getPageCount())
    }).catch(() => {
      pdfPageCounts.set(file, 'unknown')
    }).finally(() => {
      if (currentPdfFiles().includes(file)) renderPdfFiles()
    })
  }

  function renderPdfFiles() {
    pdfFileBody.replaceChildren()
    const config = currentPdfConfig()
    const displayedFiles = config.kind === 'office'
      ? (state.pdfNativeInput ? [state.pdfNativeInput] : [])
      : currentPdfFiles()
    pdfEmpty.classList.toggle('hidden', displayedFiles.length > 0)

    displayedFiles.forEach((file, index) => {
      const row = document.createElement('div')
      const name = document.createElement('span')
      const nameText = document.createElement('span')
      const detail = document.createElement('small')
      const pages = document.createElement('span')
      const size = document.createElement('span')
      const progress = document.createElement('span')
      const remove = document.createElement('button')

      row.className = 'pdf-file-row'
      name.className = 'cell-name pdf-file-name'
      pages.className = 'cell-pages'
      size.className = 'cell-size'
      progress.className = 'cell-progress'
      nameText.textContent = file.name
      name.title = file.name
      name.append(nameText, detail)
      size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`
      if (config.kind === 'pdf') {
        loadPdfPageCount(file)
        const count = pdfPageCounts.get(file)
        pages.textContent = Number.isInteger(count) ? `${count} 页` : count === 'unknown' ? '无法读取' : '读取中…'
        detail.textContent = state.selections.pdf === '转 JPEG' && Number.isInteger(count)
          ? `预计生成 ${count} 张 JPEG`
          : ''
      } else {
        pages.textContent = '—'
        detail.textContent = config.inputLabel
      }
      const fileStatus = isPdfWatermarkAction()
        ? state.pdfWatermarkStatuses[index]
        : state.pdfFileStatuses[index]
      const fallbackStatus = state.selections.pdf === '转 JPEG' ? '待转换' : '待处理'
      progress.textContent = fileStatus?.error || fileStatus?.status || fallbackStatus
      if (state.selections.pdf === '转 JPEG' && progress.textContent === '待处理') progress.textContent = '待转换'
      progress.title = fileStatus?.error || ''
      progress.classList.toggle('success', ['已导出', '完成'].includes(fileStatus?.status))
      progress.classList.toggle('busy', ['处理中', '等待保存'].includes(fileStatus?.status))
      progress.classList.toggle('error', Boolean(fileStatus?.error) || fileStatus?.status === '导出失败')
      remove.type = 'button'
      remove.className = 'pdf-remove-file'
      remove.dataset.index = String(index)
      remove.setAttribute('aria-label', `移除 ${file.name}`)
      remove.textContent = '×'
      row.append(name, pages, size, progress, remove)
      pdfFileBody.append(row)
    })

    const hasError = (isPdfWatermarkAction() ? state.pdfWatermarkStatuses : state.pdfFileStatuses)
      .some((status) => status?.error)
    if (!state.pdfBusy && !state.pdfLastOutput && !state.pdfComResult && !hasError) {
      setPdfResult(pdfIdleSummary(displayedFiles))
    }
    updatePdfRunState()
    void updatePdfSplitEstimate()
  }

  async function updatePdfSplitEstimate() {
    const status = document.querySelector('#pdf-split-estimate')
    const file = state.selections.pdf === '逐页拆分' ? state.pdfFiles[0] : null
    if (!status || !file) return
    status.textContent = '正在计算预计文件数…'
    try {
      const source = await readPdfDocument(file)
      if (state.selections.pdf !== '逐页拆分' || state.pdfFiles[0] !== file) return
      status.textContent = `预计生成 ${source.getPageCount()} 个独立 PDF 文件`
    } catch {
      status.textContent = '无法读取页数，请检查 PDF 文件'
    }
  }

  function renderPdfWatermarkFileList() {
    pdfWatermarkFileList.replaceChildren()
    if (!state.pdfWatermarkFiles.length) {
      const empty = document.createElement('span')
      empty.className = 'pdf-option-status'
      empty.textContent = '尚未添加 PDF'
      pdfWatermarkFileList.append(empty)
      return
    }

    state.pdfWatermarkFiles.forEach((file, index) => {
      const row = document.createElement('div')
      const name = document.createElement('span')
      const status = document.createElement('small')
      const remove = document.createElement('button')
      row.className = 'pdf-watermark-file'
      row.classList.toggle('active', index === state.pdfWatermarkPreviewFileIndex)
      row.dataset.previewIndex = String(index)
      name.textContent = file.name
      name.title = file.name
      const fileStatus = state.pdfWatermarkStatuses[index]
      status.className = fileStatus?.error ? 'error' : ''
      status.textContent = fileStatus?.error || fileStatus?.status || '待处理'
      remove.type = 'button'
      remove.className = 'pdf-remove-file'
      remove.dataset.watermarkIndex = String(index)
      remove.setAttribute('aria-label', `移除 ${file.name}`)
      remove.textContent = '×'
      row.append(name, status, remove)
      pdfWatermarkFileList.append(row)
    })
  }

  async function loadPdfWatermarkPreviewSource() {
    const file = state.pdfWatermarkFiles[state.pdfWatermarkPreviewFileIndex]
    if (!file) return null
    const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    const pdfDocument = await loadingTask.promise
    try {
      const pageNumber = Math.max(1, Math.min(pdfDocument.numPages, state.pdfWatermarkPreviewPage))
      const page = await pdfDocument.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = Math.min(1.5, 720 / baseViewport.width, 880 / baseViewport.height)
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport
      }).promise
      page.cleanup()
      return {
        canvas,
        pageWidth: baseViewport.width,
        pageHeight: baseViewport.height,
        scale,
        pageNumber,
        pageCount: pdfDocument.numPages
      }
    } finally {
      await pdfDocument.destroy()
    }
  }

  async function drawPdfWatermarkPreview() {
    const token = ++pdfWatermarkPreviewToken
    const file = state.pdfWatermarkFiles[state.pdfWatermarkPreviewFileIndex]
    const pageStatus = document.querySelector('#pdf-watermark-page-status')
    const previousPage = document.querySelector('#pdf-watermark-previous-page')
    const nextPage = document.querySelector('#pdf-watermark-next-page')
    if (!file || !isPdfWatermarkAction()) {
      pdfWatermarkPreview.width = 0
      pdfWatermarkPreview.height = 0
      pdfWatermarkPreviewEmpty.hidden = false
      pdfWatermarkPreviewLabel.textContent = '添加 PDF 后显示第一页'
      pageStatus.textContent = '第 0 / 0 页'
      previousPage.disabled = true
      nextPage.disabled = true
      return
    }

    pdfWatermarkPreviewEmpty.hidden = false
    pdfWatermarkPreviewEmpty.textContent = '正在生成第一页预览…'
    try {
      const source = await loadPdfWatermarkPreviewSource()
      if (token !== pdfWatermarkPreviewToken || !source) return
      state.pdfWatermarkPreviewPage = source.pageNumber
      state.pdfWatermarkPreviewPageCount = source.pageCount
      pageStatus.textContent = `第 ${source.pageNumber} / ${source.pageCount} 页`
      previousPage.disabled = source.pageNumber <= 1
      nextPage.disabled = source.pageNumber >= source.pageCount
      const settings = getPdfWatermarkSettings()
      const kind = state.pdfWatermarkMode
      let converted
      if (kind === 'text') {
        if (!settings.text) throw new Error('请输入水印文字')
        converted = await textWatermarkToPng(settings.text, settings)
      } else {
        if (!state.pdfWatermarkImage) {
          pdfWatermarkPreview.width = source.canvas.width
          pdfWatermarkPreview.height = source.canvas.height
          pdfWatermarkPreview.getContext('2d').drawImage(source.canvas, 0, 0)
          pdfWatermarkPreviewEmpty.hidden = true
          pdfWatermarkPreviewLabel.textContent = `${file.name} · 第 ${source.pageNumber} 页 · 请选择水印图片`
          return
        }
        converted = await imageFileToPng(state.pdfWatermarkImage)
      }
      if (token !== pdfWatermarkPreviewToken) return

      const maxWidth = source.pageWidth * (kind === 'text' ? 0.28 : 0.22)
      const maxHeight = source.pageHeight * 0.11
      const markScale = Math.min(maxWidth / converted.width, maxHeight / converted.height, 1)
      const markWidth = converted.width * markScale
      const markHeight = converted.height * markScale
      const placements = pdfWatermarkPlacements(
        source.pageWidth,
        source.pageHeight,
        markWidth,
        markHeight,
        settings
      )
      const watermarkBlob = new Blob([converted.data], { type: 'image/png' })
      const watermarkBitmap = await createImageBitmap(watermarkBlob)
      if (token !== pdfWatermarkPreviewToken) {
        watermarkBitmap.close()
        return
      }
      pdfWatermarkPreview.width = source.canvas.width
      pdfWatermarkPreview.height = source.canvas.height
      const context = pdfWatermarkPreview.getContext('2d')
      context.drawImage(source.canvas, 0, 0)
      context.globalAlpha = settings.opacity
      placements.forEach((center) => {
        context.save()
        context.translate(center.x * source.scale, (source.pageHeight - center.y) * source.scale)
        context.rotate(-settings.rotation * Math.PI / 180)
        context.drawImage(
          watermarkBitmap,
          -markWidth * source.scale / 2,
          -markHeight * source.scale / 2,
          markWidth * source.scale,
          markHeight * source.scale
        )
        context.restore()
      })
      context.globalAlpha = 1
      watermarkBitmap.close()
      pdfWatermarkPreviewEmpty.hidden = true
      pdfWatermarkPreviewLabel.textContent = `${file.name} · 第 ${source.pageNumber} 页`
    } catch (error) {
      if (token !== pdfWatermarkPreviewToken) return
      pdfWatermarkPreviewEmpty.hidden = false
      pdfWatermarkPreviewEmpty.textContent =
        error instanceof Error ? error.message : '无法生成预览'
      pdfWatermarkPreviewLabel.textContent = file.name
    }
  }

  function renderPdfWatermarkState() {
    state.pdfWatermarkPreviewFileIndex = Math.max(
      0,
      Math.min(state.pdfWatermarkPreviewFileIndex, state.pdfWatermarkFiles.length - 1)
    )
    const imageMode = state.pdfWatermarkMode === 'image'
    document.querySelectorAll('[data-watermark-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.watermarkMode === state.pdfWatermarkMode)
    })
    document.querySelector('#pdf-watermark-text').closest('label').hidden = imageMode
    document.querySelector('#pdf-watermark-font').closest('label').hidden = imageMode
    document.querySelector('#pdf-watermark-font-size').closest('label').hidden = imageMode
    document.querySelector('#pdf-watermark-image-button').hidden = !imageMode
    document.querySelector('#pdf-watermark-image-name').hidden = !imageMode
    document.querySelector('#pdf-watermark-image-name').textContent =
      state.pdfWatermarkImage?.name || '尚未选择图片'
    const customRotation = document.querySelector('#pdf-watermark-rotation').value === 'custom'
    document.querySelector('#pdf-watermark-custom-rotation-wrap').hidden = !customRotation
    renderPdfWatermarkFileList()
    void drawPdfWatermarkPreview()
  }

  function updatePdfRunState() {
    const config = currentPdfConfig()
    const fileCount = config.kind === 'office'
      ? Number(Boolean(state.pdfNativeInput))
      : currentPdfFiles().length
    const enoughFiles = fileCount >= config.minFiles
    const hasWatermarkImage = state.pdfWatermarkMode !== 'image' || Boolean(state.pdfWatermarkImage)
    const hasDestination = Boolean(state.pdfDestination)
    pdfRunButton.disabled = state.pdfBusy || !enoughFiles || !hasWatermarkImage || !hasDestination
    pdfRunButton.textContent = state.pdfBusy ? '处理中…' : `开始${state.selections.pdf}`
    pdfWatermarkRunButton.disabled = pdfRunButton.disabled
    const watermarkModeLabel = state.pdfWatermarkMode === 'image' ? '图片水印' : '文字水印'
    pdfWatermarkRunButton.textContent = state.pdfBusy ? '处理中…' : `开始${watermarkModeLabel}`
    pdfClearFilesButton.disabled = state.pdfBusy || fileCount === 0
    pdfAddFilesButton.disabled = state.pdfBusy
    pdfChooseOutputButton.disabled = state.pdfBusy || !enoughFiles
    const organizerButton = document.querySelector('#pdf-open-page-organizer')
    if (organizerButton) organizerButton.disabled = state.pdfBusy || !enoughFiles
    const organizerStatus = document.querySelector('#pdf-page-option-status')
    if (organizerStatus) {
      organizerStatus.textContent = state.pdfPageItems.length
        ? `当前 ${state.pdfPageItems.length} 页`
        : '上传 PDF 后载入页面'
    }
  }

  function updatePdfState(action) {
    const config = pdfActionConfig[action]
    if (!config) return

    if (config.kind === 'office') {
      state.pdfFiles = []
      if (state.pdfNativeInput?.kind !== config.officeKind) {
        state.pdfNativeInput = null
      }
    } else {
      state.pdfNativeInput = null
      if (!isPdfWatermarkAction(action)) {
        state.pdfFiles = state.pdfFiles.filter((file) => isAcceptedPdfToolFile(file, config))
        if (!config.multiple && state.pdfFiles.length > 1) {
          state.pdfFiles = state.pdfFiles.slice(0, 1)
        }
      }
    }

    pdfFileInput.accept = config.accept
    pdfFileInput.multiple = config.multiple
    pdfDropZone.classList.toggle('native-picker', config.kind === 'office')
    pdfDropZone.hidden = isPdfWatermarkAction(action)
    pdfWatermarkWorkbench.hidden = !isPdfWatermarkAction(action)
    document.querySelector('#page-pdf').classList.toggle('watermark-mode', isPdfWatermarkAction(action))
    document.querySelector('#pdf-crumb').textContent = action
    document.querySelector('#pdf-empty-text').textContent = `拖入 ${config.inputLabel} 文件到这里`
    pdfEmptyAddLabel.textContent = `上传 ${config.inputLabel}`
    pdfAddFilesButton.textContent = `＋ 上传 ${config.inputLabel}`
    state.pdfLastOutput = null
    state.pdfComResult = null
    state.pdfWatermarkImage = null
    state.pdfWatermarkPreviewFileIndex = 0
    state.pdfWatermarkPreviewPage = 1
    state.pdfWatermarkPreviewPageCount = 0
    resetPdfDestination()
    resetPdfPageOrganizer()
    pdfOpenOutputButton.disabled = true
    pdfResultText.textContent = '0 个文件 · 等待添加'
    pdfResultDot.classList.remove('success', 'error', 'busy')
    renderPdfOptions()
    renderPdfFiles()
    renderPdfWatermarkState()
    const retainedFile = config.kind === 'office' ? null : currentPdfFiles()[0]
    if (retainedFile) void setDefaultPdfDestination(retainedFile)
  }

  // 主进程已按区域规则扫描并校验，这里只按安全路径取回字节、重建 File 对象。
  function mimeFromFileName(name) {
    const dot = name.lastIndexOf('.')
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.png') return 'image/png'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.webp') return 'image/webp'
    return ''
  }

  // 单个扫描条目（持有不透明 fileId）按 sender 取回字节、重建 File，逐条读取避免一次性持有全部字节。
  async function readScanFile(item) {
    const data = await window.api.readDroppedFile(item.id)
    return new File([data.bytes], data.name, { type: mimeFromFileName(data.name) })
  }

  // 文件若落在目标区边缘之外，Chromium 默认会直接导航到该文件，导致当前工作丢失。
  // 目标区自己的 drop 处理先执行；这里仅兜底阻止页面导航。
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    })
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('.placeholder-action')
    if (!button) return

    const name = button.textContent.trim()
    showToast(`“${name}”将在 ${button.dataset.milestone} 接入`)
  })

  function setPdfResult(message, status = '') {
    pdfResultText.textContent = message
    pdfResultDot.classList.remove('success', 'error', 'busy')
    if (status) pdfResultDot.classList.add(status)
  }

  function pdfOutputBaseName(file) {
    return file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_.-]+/gu, '-') || 'pdf-output'
  }

  function addPdfToolFiles(fileList, { preparedDestination = null, preserveDestination = false } = {}) {
    const config = currentPdfConfig()
    const accepted = Array.from(fileList || []).filter((file) => isAcceptedPdfToolFile(file, config))

    if (!accepted.length) {
      setPdfResult(`请选择有效的 ${config.inputLabel} 文件`, 'error')
      return
    }

    const oversized = accepted.find((file) => file.size > 150 * 1024 * 1024)
    if (oversized) {
      setPdfResult(`${oversized.name} 超过 150 MB 单文件上限`, 'error')
      return
    }

    const existingFiles = currentPdfFiles()
    const nextFiles = config.multiple
      ? [...existingFiles, ...accepted].slice(0, 100)
      : [accepted[0]]
    const totalBytes = nextFiles.reduce((total, file) => total + file.size, 0)

    if (totalBytes > 300 * 1024 * 1024) {
      setPdfResult('所选文件总大小超过 300 MB', 'error')
      return
    }

    if (isPdfWatermarkAction()) {
      state.pdfWatermarkFiles = nextFiles
      state.pdfWatermarkStatuses = nextFiles.map((_, index) =>
        state.pdfWatermarkStatuses[index] || { status: '待处理', error: '' }
      )
    } else {
      state.pdfFiles = nextFiles
      state.pdfFileStatuses = nextFiles.map((_, index) =>
        state.pdfFileStatuses[index] || { status: '待处理', error: '' }
      )
    }
    state.pdfLastOutput = null
    if (!preserveDestination) resetPdfDestination()
    resetPdfPageOrganizer()
    pdfOpenOutputButton.disabled = true
    renderPdfFiles()
    renderPdfWatermarkState()
    if (!preserveDestination) void setDefaultPdfDestination(nextFiles[0], preparedDestination)
  }

  async function readPdfDocument(file) {
    try {
      return await PDFDocument.load(new Uint8Array(await file.arrayBuffer()))
    } catch {
      throw new Error(`${file.name} 无法读取；加密或损坏的 PDF 暂不支持`)
    }
  }

  async function getQpdfRunner() {
    if (!qpdfRunnerPromise) {
      qpdfRunnerPromise = createQpdfRunner({
        workerUrl: qpdfWorkerUrl,
        qpdfJsUrl,
        wasmUrl: qpdfWasmUrl,
        timeoutMs: 90000
      }).catch((error) => {
        qpdfRunnerPromise = null
        throw error
      })
    }
    return qpdfRunnerPromise
  }

  function qpdfErrorMessage(error, operation) {
    const code = error?.code || 'QPDF_UNKNOWN'
    if (code === 'QPDF_INIT_FAILED') {
      return `${operation}失败：QPDF 加密组件未能载入（${code}）`
    }
    if (code === 'QPDF_TIMEOUT') {
      return `${operation}失败：QPDF 处理超时（${code}）`
    }
    if (code === 'QPDF_OUTPUT_MISSING') {
      return `${operation}失败：QPDF 未生成输出文件（${code}）`
    }
    if (code === 'QPDF_EXEC_FAILED') {
      const detail = Array.isArray(error?.stderr) ? error.stderr.at(-1) : ''
      const fallback = operation === '解密'
        ? '口令错误，或该加密 PDF 不受支持'
        : 'PDF 不受支持或内容已损坏'
      return `${operation}失败：${detail || fallback}（${code}）`
    }
    return `${operation}失败：${error instanceof Error ? error.message : String(error)}（${code}）`
  }

  function validatePdfPassword(password, label) {
    const byteLength = new TextEncoder().encode(password).byteLength
    if (byteLength < 4) throw new Error(`${label}至少需要 4 个 UTF-8 字节`)
    if (byteLength > 127) throw new Error(`${label}不能超过 127 个 UTF-8 字节`)
  }

  async function encryptPdfFile() {
    const password = document.querySelector('#pdf-encrypt-password')?.value || ''
    const confirmation = document.querySelector('#pdf-encrypt-password-confirm')?.value || ''
    validatePdfPassword(password, '打开口令')
    if (password !== confirmation) throw new Error('两次输入的打开口令不一致')

    let data
    try {
      const runner = await getQpdfRunner()
      const ownerPassword = `${crypto.randomUUID()}-${crypto.randomUUID()}`
      data = await runner.runOne({
        input: new Uint8Array(await state.pdfFiles[0].arrayBuffer()),
        inputName: 'input.pdf',
        outputName: 'encrypted.pdf',
        args: [
          '--encrypt',
          password,
          ownerPassword,
          '256',
          '--',
          'input.pdf',
          'encrypted.pdf'
        ]
      })
    } catch (error) {
      throw new Error(qpdfErrorMessage(error, '加密'))
    }
    const result = await saveSinglePdfToolOutput(
      'pdf',
      `${pdfOutputBaseName(state.pdfFiles[0])}-encrypted`,
      data
    )
    return result.status === 'saved' ? '已使用 AES-256 加密 PDF' : '已取消保存'
  }

  async function decryptPdfFile() {
    const password = document.querySelector('#pdf-decrypt-password')?.value || ''
    if (!password) throw new Error('请输入 PDF 口令')
    if (new TextEncoder().encode(password).byteLength > 127) {
      throw new Error('PDF 口令不能超过 127 个 UTF-8 字节')
    }

    let data
    try {
      const runner = await getQpdfRunner()
      data = await runner.runOne({
        input: new Uint8Array(await state.pdfFiles[0].arrayBuffer()),
        inputName: 'input.pdf',
        outputName: 'decrypted.pdf',
        args: [
          `--password=${password}`,
          '--decrypt',
          'input.pdf',
          'decrypted.pdf'
        ]
      })
    } catch (error) {
      throw new Error(qpdfErrorMessage(error, '解密'))
    }
    const result = await saveSinglePdfToolOutput(
      'pdf',
      `${pdfOutputBaseName(state.pdfFiles[0])}-decrypted`,
      data
    )
    return result.status === 'saved' ? 'PDF 口令已移除' : '已取消保存'
  }

  async function saveSinglePdfToolOutput(type, name, data) {
    const result = await window.api.savePdfFile({
      type,
      name,
      data,
      destinationId: state.pdfDestination?.id
    })
    if (result.status === 'saved') {
      state.pdfLastOutput = { path: result.path, directory: false }
      pdfOpenOutputButton.disabled = false
      resetPdfDestination()
    }
    return result
  }

  async function saveBatchPdfToolOutput(type, files) {
    const result = await window.api.savePdfFiles({
      type,
      files,
      destinationId: state.pdfDestination?.id
    })
    if (result.status === 'saved') {
      state.pdfLastOutput = { path: result.directory, directory: true }
      pdfOpenOutputButton.disabled = false
    }
    return result
  }

  async function mergePdfFiles() {
    const output = await PDFDocument.create()

    for (const [index, file] of state.pdfFiles.entries()) {
      setPdfResult(`正在合并 ${index + 1} / ${state.pdfFiles.length}`, 'busy')
      const source = await readPdfDocument(file)
      const pages = await output.copyPages(source, source.getPageIndices())
      pages.forEach((page) => output.addPage(page))
    }

    const data = await output.save()
    const result = await saveSinglePdfToolOutput('pdf', 'merged', data)
    return result.status === 'saved' ? `已合并 ${output.getPageCount()} 页 PDF` : '已取消保存'
  }

  async function splitPdfFile() {
    const source = await readPdfDocument(state.pdfFiles[0])
    const baseName = pdfOutputBaseName(state.pdfFiles[0])
    const files = []

    if (source.getPageCount() > 500) {
      throw new Error('拆分页数超过 500 页上限')
    }

    for (let index = 0; index < source.getPageCount(); index += 1) {
      setPdfResult(`正在拆分 ${index + 1} / ${source.getPageCount()}`, 'busy')
      const output = await PDFDocument.create()
      const [page] = await output.copyPages(source, [index])
      output.addPage(page)
      files.push({
        name: `${baseName}-page-${String(index + 1).padStart(3, '0')}`,
        data: await output.save()
      })
    }

    const result = await saveBatchPdfToolOutput('pdf', files)
    return result.status === 'saved' ? `已拆分并保存 ${files.length} 个 PDF` : '已取消保存'
  }

  async function rotatePdfFile() {
    const source = await readPdfDocument(state.pdfFiles[0])
    const rotation = Number(document.querySelector('#pdf-rotation')?.value || 90)
    source.getPages().forEach((page) => {
      page.setRotation(degrees((page.getRotation().angle + rotation) % 360))
    })
    const result = await saveSinglePdfToolOutput(
      'pdf',
      `${pdfOutputBaseName(state.pdfFiles[0])}-rotated`,
      await source.save()
    )
    return result.status === 'saved'
      ? `已将 ${source.getPageCount()} 页旋转 ${rotation}°`
      : '已取消保存'
  }

  function parsePdfPageRange(value, pageCount) {
    const pages = []

    value.split(',').map((part) => part.trim()).filter(Boolean).forEach((part) => {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/)

      if (range) {
        const start = Number(range[1])
        const end = Number(range[2])
        const step = start <= end ? 1 : -1
        for (let page = start; page !== end + step; page += step) pages.push(page)
      } else if (/^\d+$/.test(part)) {
        pages.push(Number(part))
      } else {
        throw new Error('页码格式无效，请使用如 1-3,5')
      }
    })

    const unique = [...new Set(pages)]
    if (!unique.length || unique.some((page) => page < 1 || page > pageCount)) {
      throw new Error(`页码必须在 1–${pageCount} 之间`)
    }
    return unique.map((page) => page - 1)
  }

  async function extractPdfPages() {
    const source = await readPdfDocument(state.pdfFiles[0])
    const pageIndices = parsePdfPageRange(
      document.querySelector('#pdf-page-range')?.value || '',
      source.getPageCount()
    )
    const output = await PDFDocument.create()
    const pages = await output.copyPages(source, pageIndices)
    pages.forEach((page) => output.addPage(page))
    const result = await saveSinglePdfToolOutput(
      'pdf',
      `${pdfOutputBaseName(state.pdfFiles[0])}-pages`,
      await output.save()
    )
    return result.status === 'saved' ? `已提取 ${pages.length} 页` : '已取消保存'
  }

  async function imageFileToPng(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })

    if (bitmap.width * bitmap.height > 80_000_000) {
      bitmap.close()
      throw new Error(`${file.name} 超过 8000 万像素`)
    }

    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close()
    const blob = await canvasToBlob(canvas, 'image/png')
    return {
      width: canvas.width,
      height: canvas.height,
      data: new Uint8Array(await blob.arrayBuffer())
    }
  }

  function getPdfWatermarkSettings() {
    const rotationSelect = document.querySelector('#pdf-watermark-rotation')
    const rotation = rotationSelect?.value === 'custom'
      ? Number(document.querySelector('#pdf-watermark-custom-rotation')?.value || 0)
      : Number(rotationSelect?.value || 0)
    return {
      text: document.querySelector('#pdf-watermark-text')?.value.trim() || '',
      font: document.querySelector('#pdf-watermark-font')?.value || 'Microsoft YaHei UI',
      fontSize: Number(document.querySelector('#pdf-watermark-font-size')?.value || 42),
      rotation: Math.max(-180, Math.min(180, rotation)),
      opacity: Math.max(0.05, Math.min(1, Number(document.querySelector('#pdf-watermark-opacity')?.value || 28) / 100)),
      density: Number(document.querySelector('#pdf-watermark-density')?.value || 6),
      vertical: document.querySelector('#pdf-watermark-vertical')?.value || 'center',
      horizontal: document.querySelector('#pdf-watermark-horizontal')?.value || 'center',
      offsetX: Number(document.querySelector('#pdf-watermark-offset-x')?.value || 0),
      offsetY: Number(document.querySelector('#pdf-watermark-offset-y')?.value || 0),
      pages: document.querySelector('#pdf-watermark-pages')?.value || 'all'
    }
  }

  function pdfWatermarkAppliesToPage(pageIndex, scope) {
    const pageNumber = pageIndex + 1
    return scope === 'all' || (scope === 'odd' && pageNumber % 2 === 1) ||
      (scope === 'even' && pageNumber % 2 === 0)
  }

  function pdfWatermarkPlacements(pageWidth, pageHeight, markWidth, markHeight, settings) {
    const count = Math.max(1, settings.density)
    const columns = count >= 8 ? 3 : count >= 3 ? 2 : 1
    const rows = Math.ceil(count / columns)
    const marginX = Math.max(markWidth / 2 + 12, pageWidth * 0.08)
    const marginY = Math.max(markHeight / 2 + 12, pageHeight * 0.08)
    const usableWidth = Math.max(0, pageWidth - marginX * 2)
    const usableHeight = Math.max(0, pageHeight - marginY * 2)
    const anchorX = settings.horizontal === 'left'
      ? marginX
      : settings.horizontal === 'right'
        ? pageWidth - marginX
        : pageWidth / 2
    const anchorY = settings.vertical === 'top'
      ? pageHeight - marginY
      : settings.vertical === 'bottom'
        ? marginY
        : pageHeight / 2
    const groupWidth = columns > 1 ? usableWidth : 0
    const groupHeight = rows > 1 ? usableHeight : 0
    const startX = columns > 1 ? pageWidth / 2 - groupWidth / 2 : anchorX
    const startY = rows > 1 ? pageHeight / 2 - groupHeight / 2 : anchorY
    const placements = []

    for (let index = 0; index < count; index += 1) {
      const column = index % columns
      const row = Math.floor(index / columns)
      const centerX = columns > 1
        ? startX + (groupWidth * column) / (columns - 1)
        : anchorX
      const centerY = rows > 1
        ? startY + (groupHeight * row) / (rows - 1)
        : anchorY
      placements.push({
        x: centerX + settings.offsetX,
        y: centerY + settings.offsetY
      })
    }
    return placements
  }

  async function textWatermarkToPng(text, settings = getPdfWatermarkSettings()) {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const fontSize = settings.fontSize
    context.font = `700 ${fontSize}px "${settings.font}", "PingFang SC", sans-serif`
    const metrics = context.measureText(text)
    canvas.width = Math.ceil(metrics.width + 40)
    canvas.height = Math.ceil(fontSize * 1.5)
    context.font = `700 ${fontSize}px "${settings.font}", "PingFang SC", sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = '#5266d7'
    context.fillText(text, canvas.width / 2, canvas.height / 2)
    const blob = await canvasToBlob(canvas, 'image/png')
    return {
      width: canvas.width,
      height: canvas.height,
      data: new Uint8Array(await blob.arrayBuffer())
    }
  }

  function pdfWatermarkDrawBox(center, width, height, rotation) {
    const radians = rotation * Math.PI / 180
    return {
      x: center.x - (width * Math.cos(radians) - height * Math.sin(radians)) / 2,
      y: center.y - (width * Math.sin(radians) + height * Math.cos(radians)) / 2
    }
  }

  async function addPdfWatermarks(kind) {
    const settings = getPdfWatermarkSettings()
    let converted

    if (kind === 'text') {
      if (!settings.text) throw new Error('请输入水印文字')
      converted = await textWatermarkToPng(settings.text, settings)
    } else {
      if (!state.pdfWatermarkImage) throw new Error('请先选择水印图片')
      converted = await imageFileToPng(state.pdfWatermarkImage)
    }

    const files = []
    let watermarkedPages = 0
    let cancelled = false

    for (const [fileIndex, file] of state.pdfWatermarkFiles.entries()) {
      if (pdfCancelRequested) {
        cancelled = true
        // 还没轮到的文件不会再处理，标成"已取消"而不是留在"待处理"，
        // 否则界面看着像还会继续跑。
        for (let rest = fileIndex; rest < state.pdfWatermarkFiles.length; rest += 1) {
          state.pdfWatermarkStatuses[rest] = { status: '已取消', error: '' }
        }
        renderPdfWatermarkFileList()
        break
      }
      setPdfResult(`正在添加水印 ${fileIndex + 1} / ${state.pdfWatermarkFiles.length}`, 'busy')
      state.pdfWatermarkStatuses[fileIndex] = { status: '处理中', error: '' }
      renderPdfWatermarkFileList()
      try {
        const source = await readPdfDocument(file)
        const watermark = await source.embedPng(converted.data)
        source.getPages().forEach((page, pageIndex) => {
          if (!pdfWatermarkAppliesToPage(pageIndex, settings.pages)) return
          const { width: pageWidth, height: pageHeight } = page.getSize()
          const maxWidth = pageWidth * (kind === 'text' ? 0.28 : 0.22)
          const maxHeight = pageHeight * 0.11
          const scale = Math.min(maxWidth / converted.width, maxHeight / converted.height, 1)
          const width = converted.width * scale
          const height = converted.height * scale
          const placements = pdfWatermarkPlacements(
            pageWidth,
            pageHeight,
            width,
            height,
            settings
          )
          placements.forEach((center) => {
            const box = pdfWatermarkDrawBox(center, width, height, settings.rotation)
            page.drawImage(watermark, {
              x: box.x,
              y: box.y,
              width,
              height,
              opacity: settings.opacity,
              rotate: degrees(settings.rotation)
            })
          })
          watermarkedPages += 1
        })
        files.push({
          name: `${pdfOutputBaseName(file)}-watermarked`,
          data: await source.save(),
          sourceIndex: fileIndex
        })
        state.pdfWatermarkStatuses[fileIndex] = { status: '等待保存', error: '' }
      } catch (error) {
        state.pdfWatermarkStatuses[fileIndex] = {
          status: '失败',
          error: error instanceof Error ? error.message : String(error)
        }
      }
      renderPdfWatermarkFileList()
    }

    if (!files.length) {
      if (cancelled) return '已取消，未处理任何文件'
      throw new Error('没有可保存的水印结果，请检查文件错误')
    }
    const result = await saveBatchPdfToolOutput(
      'pdf',
      files.map(({ name, data }) => ({ name, data }))
    )
    if (result.status === 'saved') {
      files.forEach(({ sourceIndex }) => {
        state.pdfWatermarkStatuses[sourceIndex] = { status: '完成', error: '' }
      })
      renderPdfWatermarkFileList()
    }
    if (result.status !== 'saved') return '已取消保存'
    const failedCount = state.pdfWatermarkStatuses.filter((item) => item?.error).length
    const summary = `${cancelled ? '已取消：已' : '已'}处理 ${files.length} 个 PDF，共 ${watermarkedPages} 页添加${kind === 'text' ? '文字' : '图片'}水印${failedCount ? `；${failedCount} 个失败` : ''}`
    return summary
  }

  async function addPdfPageNumbers() {
    const source = await readPdfDocument(state.pdfFiles[0])
    const font = await source.embedFont(StandardFonts.Helvetica)
    const position = document.querySelector('#pdf-page-number-position')?.value || 'footer'
    const start = Number(document.querySelector('#pdf-page-number-start')?.value || 1)

    if (!Number.isInteger(start) || start < 0 || start > 99999) {
      throw new Error('起始页码必须是 0–99999 的整数')
    }

    source.getPages().forEach((page, index) => {
      const label = `${start + index} / ${start + source.getPageCount() - 1}`
      const size = 10
      const labelWidth = font.widthOfTextAtSize(label, size)
      const { width, height } = page.getSize()
      page.drawText(label, {
        x: Math.max(16, (width - labelWidth) / 2),
        y: position === 'header' ? height - 20 : 12,
        size,
        font,
        color: rgb(0.32, 0.34, 0.42),
        opacity: 0.82
      })
    })

    const result = await saveSinglePdfToolOutput(
      'pdf',
      `${pdfOutputBaseName(state.pdfFiles[0])}-numbered`,
      await source.save()
    )
    return result.status === 'saved'
      ? `已在${position === 'header' ? '页眉' : '页脚'}添加 ${source.getPageCount()} 个页码`
      : '已取消保存'
  }

  function resetPdfPageOrganizer() {
    state.pdfPageItems = []
    state.pdfPageOrganizerSource = null
    state.pdfPageOrganizerSnapshot = []
    if (pdfPageGrid) pdfPageGrid.replaceChildren()
    if (pdfPageOrganizer) pdfPageOrganizer.hidden = true
  }

  function renderPdfPageOrganizer() {
    pdfPageGrid.replaceChildren()
    state.pdfPageItems.forEach((item, index) => {
      const card = document.createElement('article')
      const preview = document.createElement('img')
      const footer = document.createElement('footer')
      const label = document.createElement('span')
      const previous = document.createElement('button')
      const next = document.createElement('button')
      const remove = document.createElement('button')

      card.className = 'pdf-page-card'
      card.classList.toggle('selected', Boolean(item.selected))
      card.draggable = true
      card.dataset.pageId = item.id
      preview.src = item.thumbnail
      preview.alt = `${item.file.name} 第 ${item.pageIndex + 1} 页`
      label.textContent = `${index + 1} · ${item.file.name} / ${item.pageIndex + 1}`
      label.title = label.textContent

      previous.type = 'button'
      previous.dataset.pageCommand = 'previous'
      previous.disabled = index === 0
      previous.setAttribute('aria-label', '向前移动')
      previous.textContent = '←'
      next.type = 'button'
      next.dataset.pageCommand = 'next'
      next.disabled = index === state.pdfPageItems.length - 1
      next.setAttribute('aria-label', '向后移动')
      next.textContent = '→'
      remove.type = 'button'
      remove.className = 'delete'
      remove.dataset.pageCommand = 'delete'
      remove.setAttribute('aria-label', '删除页面')
      remove.textContent = '×'
      footer.append(label, previous, next, remove)
      card.append(preview, footer)
      pdfPageGrid.append(card)
    })

    pdfPageSummary.textContent = state.pdfPageItems.length
      ? `共 ${state.pdfPageItems.length} 页 · 已选择 ${state.pdfPageItems.filter((item) => item.selected).length} 页`
      : '页面已全部删除，可插入其他 PDF'
    updatePdfRunState()
  }

  async function createPdfPageItems(file) {
    const loadingTask = getDocument({
      data: new Uint8Array(await file.arrayBuffer())
    })
    const pdfDocument = await loadingTask.promise
    const items = []

    try {
      if (state.pdfPageItems.length + pdfDocument.numPages > 200) {
        throw new Error('页重排最多支持 200 页')
      }

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        pdfPageSummary.textContent = `正在载入 ${file.name} · ${pageNumber} / ${pdfDocument.numPages}`
        const page = await pdfDocument.getPage(pageNumber)
        const natural = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: Math.min(1, 132 / natural.width) })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(viewport.width))
        canvas.height = Math.max(1, Math.ceil(viewport.height))
        await page.render({
          canvas,
          canvasContext: canvas.getContext('2d'),
          viewport
        }).promise
        items.push({
          id: crypto.randomUUID(),
          file,
          pageIndex: pageNumber - 1,
          thumbnail: canvas.toDataURL('image/jpeg', 0.72)
        })
        page.cleanup()
      }
    } finally {
      await pdfDocument.destroy()
    }

    return items
  }

  async function ensurePdfPageOrganizerLoaded() {
    const source = state.pdfFiles[0]
    if (!source) throw new Error('请先上传 PDF')
    if (state.pdfPageOrganizerSource === source && state.pdfPageItems.length) return

    state.pdfPageItems = []
    state.pdfPageOrganizerSource = source
    pdfPageGrid.replaceChildren()
    pdfPageSummary.textContent = '正在读取页面…'
    state.pdfPageItems = await createPdfPageItems(source)
    renderPdfPageOrganizer()
  }

  async function openPdfPageOrganizer() {
    if (state.pdfBusy || !state.pdfFiles[0]) return
    pdfPageOrganizer.hidden = false
    try {
      await ensurePdfPageOrganizerLoaded()
      state.pdfPageOrganizerSnapshot = state.pdfPageItems.map((item) => ({ ...item, selected: false }))
      document.querySelector('#pdf-page-output-path').textContent =
        state.pdfDestination?.path || '尚未选择'
    } catch (error) {
      pdfPageOrganizer.hidden = true
      setPdfResult(`页面载入失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  async function insertPdfPages(fileList) {
    const files = Array.from(fileList || []).filter((file) =>
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    )
    if (!files.length) return

    try {
      for (const file of files) {
        if (file.size > 150 * 1024 * 1024) throw new Error(`${file.name} 超过 150 MB`)
        state.pdfPageItems.push(...await createPdfPageItems(file))
      }
      renderPdfPageOrganizer()
    } catch (error) {
      setPdfResult(`插入页面失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  function movePdfPage(itemIndex, offset) {
    const targetIndex = itemIndex + offset
    if (itemIndex < 0 || targetIndex < 0 || targetIndex >= state.pdfPageItems.length) return
    const [item] = state.pdfPageItems.splice(itemIndex, 1)
    state.pdfPageItems.splice(targetIndex, 0, item)
    renderPdfPageOrganizer()
  }

  async function saveReorderedPdf() {
    await ensurePdfPageOrganizerLoaded()
    if (!state.pdfPageItems.length) throw new Error('至少保留一个页面')

    const sourceDocuments = new Map()
    const output = await PDFDocument.create()
    for (const [index, item] of state.pdfPageItems.entries()) {
      setPdfResult(`正在重排 ${index + 1} / ${state.pdfPageItems.length}`, 'busy')
      let source = sourceDocuments.get(item.file)
      if (!source) {
        source = await readPdfDocument(item.file)
        sourceDocuments.set(item.file, source)
      }
      const [page] = await output.copyPages(source, [item.pageIndex])
      output.addPage(page)
    }

    const result = await saveSinglePdfToolOutput(
      'pdf',
      `${pdfOutputBaseName(state.pdfFiles[0])}-reordered`,
      await output.save()
    )
    return result.status === 'saved'
      ? `已按当前顺序保存 ${state.pdfPageItems.length} 页`
      : '已取消保存'
  }

  async function imagesToPdf() {
    const output = await PDFDocument.create()

    for (const [index, file] of state.pdfFiles.entries()) {
      setPdfResult(`正在处理图片 ${index + 1} / ${state.pdfFiles.length}`, 'busy')
      const converted = await imageFileToPng(file)
      const image = await output.embedPng(converted.data)
      const pageScale = Math.min(1, 14400 / converted.width, 14400 / converted.height)
      const width = converted.width * pageScale
      const height = converted.height * pageScale
      const page = output.addPage([width, height])
      page.drawImage(image, { x: 0, y: 0, width, height })
    }

    const result = await saveSinglePdfToolOutput('pdf', 'images', await output.save())
    return result.status === 'saved'
      ? `已将 ${state.pdfFiles.length} 张图片合成为 PDF`
      : '已取消保存'
  }

  async function renderPdfPages(type) {
    const file = state.pdfFiles[0]
    const loadingTask = getDocument({
      data: new Uint8Array(await file.arrayBuffer())
    })
    const pdfDocument = await loadingTask.promise
    const files = []
    let totalBytes = 0
    let cancelled = false

    try {
      if (pdfDocument.numPages > 200) {
        throw new Error('逐页导出最多支持 200 页')
      }

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (pdfCancelRequested) { cancelled = true; break }
        setPdfResult(`正在渲染 ${pageNumber} / ${pdfDocument.numPages}`, 'busy')
        const page = await pdfDocument.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 2 })
        const outputCanvas = window.document.createElement('canvas')
        outputCanvas.width = Math.ceil(viewport.width)
        outputCanvas.height = Math.ceil(viewport.height)
        const context = outputCanvas.getContext('2d')

        if (type === 'jpeg') {
          context.fillStyle = '#ffffff'
          context.fillRect(0, 0, outputCanvas.width, outputCanvas.height)
        }

        await page.render({
          canvas: outputCanvas,
          canvasContext: context,
          viewport
        }).promise
        const blob = await canvasToBlob(
          outputCanvas,
          type === 'jpeg' ? 'image/jpeg' : 'image/png',
          type === 'jpeg'
            ? Number(window.document.querySelector('#pdf-jpeg-quality')?.dataset.value || 0.85)
            : undefined
        )
        const data = new Uint8Array(await blob.arrayBuffer())
        totalBytes += data.byteLength

        if (totalBytes > 450 * 1024 * 1024) {
          throw new Error('生成结果超过 450 MB，请逐页拆分后重试')
        }

        files.push({
          name: `${pdfOutputBaseName(file)}-page-${String(pageNumber).padStart(3, '0')}`,
          data
        })
        page.cleanup()
      }
    } finally {
      await pdfDocument.destroy()
    }

    const label = type === 'jpeg' ? 'JPEG' : 'PNG'
    if (cancelled && !files.length) return '已取消，未导出任何页'
    const result = await saveBatchPdfToolOutput(type, files)
    if (result.status !== 'saved') return '已取消保存'
    return cancelled
      ? `已取消：已导出 ${files.length} / ${pdfDocument.numPages} 张 ${label} 图片`
      : `已导出 ${files.length} 张 ${label} 图片`
  }

  async function extractPdfText() {
    const file = state.pdfFiles[0]
    const loadingTask = getDocument({
      data: new Uint8Array(await file.arrayBuffer())
    })
    const pdfDocument = await loadingTask.promise
    const pages = []
    let cancelled = false

    try {
      if (pdfDocument.numPages > 500) throw new Error('文字提取最多支持 500 页')

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (pdfCancelRequested) { cancelled = true; break }
        setPdfResult(`正在提取文字 ${pageNumber} / ${pdfDocument.numPages}`, 'busy')
        const page = await pdfDocument.getPage(pageNumber)
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
          .join('')
          .trim()
        pages.push(`--- 第 ${pageNumber} 页 ---\n${text}`)
        page.cleanup()
      }
    } finally {
      await pdfDocument.destroy()
    }

    if (cancelled && !pages.length) return '已取消，未提取任何页'
    const text = pages.join('\n\n').trim()
    if (!text.replace(/--- 第 \d+ 页 ---/g, '').trim()) {
      throw new Error('未检测到内嵌文字；扫描件不含文本，本功能不做 OCR')
    }

    const result = await saveSinglePdfToolOutput(
      'txt',
      `${pdfOutputBaseName(file)}-text`,
      new TextEncoder().encode(text)
    )
    if (result.status !== 'saved') return '已取消保存'
    return cancelled
      ? `已取消：已提取 ${pages.length} / ${pdfDocument.numPages} 页内嵌文字`
      : `已提取 ${pages.length} 页内嵌文字`
  }

  function pdfImageDataToCanvas(imageData) {
    const canvas = document.createElement('canvas')
    const width = Number(imageData?.width)
    const height = Number(imageData?.height)
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('PDF 图片尺寸无效')
    }
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')

    if (imageData instanceof ImageData) {
      context.putImageData(imageData, 0, 0)
      return canvas
    }
    if (imageData.bitmap) {
      context.drawImage(imageData.bitmap, 0, 0)
      return canvas
    }

    const source = imageData.data
    if (!(source instanceof Uint8Array || source instanceof Uint8ClampedArray)) {
      throw new Error('PDF 图片像素格式不受支持')
    }
    const output = context.createImageData(width, height)

    if (imageData.kind === ImageKind.RGBA_32BPP) {
      output.data.set(source.subarray(0, output.data.length))
    } else if (imageData.kind === ImageKind.RGB_24BPP) {
      for (let sourceIndex = 0, outputIndex = 0; outputIndex < output.data.length; outputIndex += 4) {
        output.data[outputIndex] = source[sourceIndex++]
        output.data[outputIndex + 1] = source[sourceIndex++]
        output.data[outputIndex + 2] = source[sourceIndex++]
        output.data[outputIndex + 3] = 255
      }
    } else if (imageData.kind === ImageKind.GRAYSCALE_1BPP) {
      const rowBytes = Math.ceil(width / 8)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const bit = source[y * rowBytes + Math.floor(x / 8)] & (128 >> (x % 8))
          const value = bit ? 255 : 0
          const outputIndex = (y * width + x) * 4
          output.data[outputIndex] = value
          output.data[outputIndex + 1] = value
          output.data[outputIndex + 2] = value
          output.data[outputIndex + 3] = 255
        }
      }
    } else {
      throw new Error('PDF 图片颜色格式不受支持')
    }

    context.putImageData(output, 0, 0)
    return canvas
  }

  function getPdfPageObject(page, objectId) {
    return new Promise((resolve) => page.objs.get(objectId, resolve))
  }

  async function extractEmbeddedPdfImages() {
    const file = state.pdfFiles[0]
    const loadingTask = getDocument({
      data: new Uint8Array(await file.arrayBuffer())
    })
    const pdfDocument = await loadingTask.promise
    const files = []
    let totalBytes = 0
    let cancelled = false

    try {
      if (pdfDocument.numPages > 500) throw new Error('提取图片最多支持 500 页')

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (pdfCancelRequested) { cancelled = true; break }
        setPdfResult(`正在分析图片 ${pageNumber} / ${pdfDocument.numPages}`, 'busy')
        const page = await pdfDocument.getPage(pageNumber)
        const operatorList = await page.getOperatorList()
        const seenObjectIds = new Set()
        let pageImageNumber = 0

        for (let index = 0; index < operatorList.fnArray.length; index += 1) {
          const operation = operatorList.fnArray[index]
          const args = operatorList.argsArray[index]
          let imageData

          if (
            operation === OPS.paintImageXObject ||
            operation === OPS.paintImageXObjectRepeat
          ) {
            const objectId = args?.[0]
            if (!objectId || seenObjectIds.has(objectId)) continue
            seenObjectIds.add(objectId)
            imageData = await getPdfPageObject(page, objectId)
          } else if (operation === OPS.paintInlineImageXObject) {
            imageData = args?.[0]
          } else {
            continue
          }

          if (!imageData || files.length >= 500) continue
          try {
            const canvas = pdfImageDataToCanvas(imageData)
            if (canvas.width < 2 || canvas.height < 2) continue
            const blob = await canvasToBlob(canvas, 'image/png')
            const data = new Uint8Array(await blob.arrayBuffer())
            totalBytes += data.byteLength
            if (totalBytes > 450 * 1024 * 1024) {
              throw new Error('提取结果超过 450 MB，请逐页拆分后重试')
            }
            pageImageNumber += 1
            files.push({
              name: `${pdfOutputBaseName(file)}-page-${String(pageNumber).padStart(3, '0')}-image-${String(pageImageNumber).padStart(3, '0')}`,
              data
            })
          } catch (error) {
            if (error instanceof Error && error.message.includes('450 MB')) throw error
          }
        }
        page.cleanup()
      }
    } finally {
      await pdfDocument.destroy()
    }

    if (!files.length) {
      if (cancelled) return '已取消，未提取任何图片'
      throw new Error('未检测到可导出的内嵌位图')
    }
    const result = await saveBatchPdfToolOutput('png', files)
    if (result.status !== 'saved') return '已取消保存'
    return cancelled ? `已取消：已提取 ${files.length} 张内嵌图片` : `已提取 ${files.length} 张内嵌图片`
  }

  async function ocrPdfToText() {
    const file = state.pdfFiles[0]
    const loadingTask = getDocument({
      data: new Uint8Array(await file.arrayBuffer())
    })
    const pdfDocument = await loadingTask.promise
    const pages = []
    let cancelled = false

    try {
      if (pdfDocument.numPages > 80) throw new Error('OCR 最多支持 80 页，请拆分后重试')

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        if (pdfCancelRequested) { cancelled = true; break }
        setPdfResult(`正在 OCR 第 ${pageNumber} / ${pdfDocument.numPages} 页`, 'busy')
        const page = await pdfDocument.getPage(pageNumber)
        const natural = page.getViewport({ scale: 1 })
        const scale = Math.min(2.5, 1800 / natural.width)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({
          canvas,
          canvasContext: canvas.getContext('2d'),
          viewport
        }).promise
        const blob = await canvasToBlob(canvas, 'image/png')
        const result = await window.api.recognizeScreenshot(
          new Uint8Array(await blob.arrayBuffer())
        )
        pages.push(`--- 第 ${pageNumber} 页 ---\n${result.text.trim()}`)
        page.cleanup()
      }
    } finally {
      await pdfDocument.destroy()
    }

    if (cancelled && !pages.length) return '已取消，未识别任何页'
    const text = pages.join('\n\n').trim()
    if (!text.replace(/--- 第 \d+ 页 ---/g, '').trim()) {
      throw new Error('未识别到文字，请确认扫描页清晰可见')
    }
    const result = await saveSinglePdfToolOutput(
      'txt',
      `${pdfOutputBaseName(file)}-ocr`,
      new TextEncoder().encode(text)
    )
    if (result.status !== 'saved') return '已取消保存'
    return cancelled
      ? `已取消：已识别并导出 ${pages.length} / ${pdfDocument.numPages} 页文字`
      : `OCR 已识别并导出 ${pages.length} 页文字`
  }

  // 真正逐页跑的几个动作才值得给取消按钮——合并/拆分/旋转/加密解密这些是
  // 一次性内存操作，几毫秒就完事，给个取消按钮只会一闪而过，反而让人以为
  // 卡住了。
  const PDF_CANCELLABLE_ACTIONS = new Set([
    '转 PNG', '转 JPEG', '转 TXT', '提取图片', 'OCR 转 TXT', '添加水印'
  ])

  async function runPdfAction() {
    if (state.pdfBusy || pdfRunButton.disabled) return
    state.pdfBusy = true
    state.pdfLastOutput = null
    state.pdfComResult = null
    pdfOpenOutputButton.disabled = true
    pdfCancelRequested = false
    pdfCancelButton.hidden = !PDF_CANCELLABLE_ACTIONS.has(state.selections.pdf)
    updatePdfRunState()
    if (!isPdfWatermarkAction()) {
      state.pdfFileStatuses = currentPdfFiles().map(() => ({ status: '处理中', error: '' }))
      renderPdfFiles()
    }
    setPdfResult('正在准备文件…', 'busy')

    try {
      const action = state.selections.pdf
      let message

      if (['Word 转 PDF', 'Excel 转 PDF', 'PPT 转 PDF'].includes(action)) {
        if (!state.pdfNativeInput) throw new Error('请先选择 Office 文件')
        const result = await window.api.convertOfficeToPdf({
          inputId: state.pdfNativeInput.id,
          destinationId: state.pdfDestination?.id
        })
        state.pdfComResult = result.result
        resetPdfDestination()
        pdfOpenOutputButton.disabled = false
        message = `${currentPdfConfig().inputLabel} 已导出为 PDF`
      } else if (action === '转 PNG') message = await renderPdfPages('png')
      else if (action === '转 JPEG') message = await renderPdfPages('jpeg')
      else if (action === '转 TXT') message = await extractPdfText()
      else if (action === '合并 PDF') message = await mergePdfFiles()
      else if (action === '逐页拆分') message = await splitPdfFile()
      else if (action === '旋转 PDF') message = await rotatePdfFile()
      else if (action === '提取指定页') message = await extractPdfPages()
      else if (action === '添加水印') message = await addPdfWatermarks(state.pdfWatermarkMode)
      else if (action === '添加页码') message = await addPdfPageNumbers()
      else if (action === '页重排') message = await saveReorderedPdf()
      else if (action === '提取图片') message = await extractEmbeddedPdfImages()
      else if (action === 'OCR 转 TXT') message = await ocrPdfToText()
      else if (action === '加密 PDF') message = await encryptPdfFile()
      else if (action === '解密 PDF') message = await decryptPdfFile()
      else if (action === '图片转 PDF') message = await imagesToPdf()
      else throw new Error('该 PDF 功能尚未接入')

      const hasOutput = Boolean(state.pdfLastOutput || state.pdfComResult)
      if (!isPdfWatermarkAction()) {
        state.pdfFileStatuses = currentPdfFiles().map(() => ({
          status: hasOutput ? '已导出' : '待处理',
          error: ''
        }))
        renderPdfFiles()
      }
      setPdfResult(message, hasOutput ? 'success' : '')
      if (hasOutput) showToast(message)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!isPdfWatermarkAction()) {
        state.pdfFileStatuses = currentPdfFiles().map(() => ({
          status: '导出失败',
          error: reason
        }))
        renderPdfFiles()
      }
      setPdfResult(`处理失败：${reason}`, 'error')
      showToast('PDF 处理失败')
    } finally {
      state.pdfBusy = false
      pdfCancelButton.hidden = true
      pdfCancelButton.disabled = false
      updatePdfRunState()
    }
  }

  pdfAddFilesButton.addEventListener('click', async () => {
    const config = currentPdfConfig()
    if (config.kind !== 'office') {
      pdfFileInput.value = ''
      pdfFileInput.click()
      return
    }
    try {
      const input = await window.api.pickOfficeFile(config.officeKind)
      if (!input) return
      state.pdfNativeInput = input
      state.pdfFileStatuses = [{ status: '待处理', error: '' }]
      state.pdfComResult = null
      state.pdfLastOutput = null
      resetPdfDestination()
      pdfOpenOutputButton.disabled = true
      renderPdfFiles()
      setPdfResult(`${input.name} 已添加`)
    } catch (error) {
      setPdfResult(`无法选择文件：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  })
  pdfEmptyAddButton.addEventListener('click', () => pdfAddFilesButton.click())
  document.querySelector('.pdf-watermark-mode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-watermark-mode]')
    if (!button || state.pdfBusy || button.dataset.watermarkMode === state.pdfWatermarkMode) return
    state.pdfWatermarkMode = button.dataset.watermarkMode
    renderPdfWatermarkState()
    updatePdfRunState()
  })
  pdfChooseOutputButton.addEventListener('click', async () => {
    if (state.pdfBusy || pdfChooseOutputButton.disabled) return
    try {
      const result = await window.api.choosePdfOutput(currentPdfOutputSpec())
      if (result.status !== 'selected') return
      pdfDestinationRequest += 1
      setPdfDestination(result)
      setPdfResult('输出位置已选择')
    } catch (error) {
      setPdfResult(`无法选择输出位置：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  })
  pdfFileInput.addEventListener('change', () => addPdfToolFiles(pdfFileInput.files))
  pdfClearFilesButton.addEventListener('click', () => {
    if (isPdfWatermarkAction()) {
      state.pdfWatermarkFiles = []
      state.pdfWatermarkStatuses = []
    } else {
      state.pdfFiles = []
      state.pdfFileStatuses = []
    }
    state.pdfNativeInput = null
    state.pdfComResult = null
    state.pdfLastOutput = null
    state.pdfWatermarkImage = null
    resetPdfDestination()
    resetPdfPageOrganizer()
    pdfOpenOutputButton.disabled = true
    renderPdfFiles()
    renderPdfWatermarkState()
    setPdfResult('0 个文件 · 等待添加')
  })
  pdfFileBody.addEventListener('click', (event) => {
    const button = event.target.closest('.pdf-remove-file')
    if (!button || state.pdfBusy) return
    if (currentPdfConfig().kind === 'office') {
      state.pdfNativeInput = null
      state.pdfFileStatuses = []
    } else {
      const index = Number(button.dataset.index)
      currentPdfFiles().splice(index, 1)
      state.pdfFileStatuses.splice(index, 1)
    }
    resetPdfDestination()
    resetPdfPageOrganizer()
    renderPdfFiles()
    renderPdfWatermarkState()
    void setDefaultPdfDestination(currentPdfFiles()[0])
  })
  pdfWatermarkFileList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-watermark-index]')
    if (state.pdfBusy) return
    if (button) {
      state.pdfWatermarkFiles.splice(Number(button.dataset.watermarkIndex), 1)
      state.pdfWatermarkStatuses.splice(Number(button.dataset.watermarkIndex), 1)
      resetPdfDestination()
      state.pdfWatermarkPreviewPage = 1
      renderPdfFiles()
      renderPdfWatermarkState()
      void setDefaultPdfDestination(currentPdfFiles()[0])
      return
    }
    const row = event.target.closest('[data-preview-index]')
    if (!row) return
    state.pdfWatermarkPreviewFileIndex = Number(row.dataset.previewIndex)
    state.pdfWatermarkPreviewPage = 1
    renderPdfWatermarkState()
  })
  document.querySelector('#pdf-watermark-image-button').addEventListener('click', () => {
    const input = document.querySelector('#pdf-watermark-image-input')
    input.value = ''
    input.click()
  })
  document.querySelector('#pdf-watermark-image-input').addEventListener('change', (event) => {
    state.pdfWatermarkImage = event.target.files?.[0] || null
    renderPdfWatermarkState()
    updatePdfRunState()
  })
  document.querySelector('#pdf-watermark-rotation').addEventListener('change', renderPdfWatermarkState)
  document.querySelectorAll(
    '#pdf-watermark-text, #pdf-watermark-font, #pdf-watermark-font-size, ' +
    '#pdf-watermark-custom-rotation, #pdf-watermark-density, #pdf-watermark-vertical, ' +
    '#pdf-watermark-offset-y, #pdf-watermark-horizontal, #pdf-watermark-offset-x, ' +
    '#pdf-watermark-pages'
  ).forEach((control) => {
    control.addEventListener('input', () => {
      renderPdfWatermarkState()
    })
  })
  const pdfWatermarkOpacity = document.querySelector('#pdf-watermark-opacity')
  const pdfWatermarkOpacityNumber = document.querySelector('#pdf-watermark-opacity-number')
  const pdfWatermarkOpacityValue = document.querySelector('#pdf-watermark-opacity-value')
  function updatePdfWatermarkOpacity(source) {
    const value = Math.max(5, Math.min(100, Number(source.value) || 28))
    pdfWatermarkOpacity.value = String(value)
    pdfWatermarkOpacityNumber.value = String(value)
    pdfWatermarkOpacityValue.textContent = `${value}%`
    void drawPdfWatermarkPreview()
  }
  pdfWatermarkOpacity.addEventListener('input', () => updatePdfWatermarkOpacity(pdfWatermarkOpacity))
  pdfWatermarkOpacityNumber.addEventListener('input', () => updatePdfWatermarkOpacity(pdfWatermarkOpacityNumber))
  document.querySelector('#pdf-watermark-previous-page').addEventListener('click', () => {
    state.pdfWatermarkPreviewPage = Math.max(1, state.pdfWatermarkPreviewPage - 1)
    void drawPdfWatermarkPreview()
  })
  document.querySelector('#pdf-watermark-next-page').addEventListener('click', () => {
    state.pdfWatermarkPreviewPage = Math.min(
      state.pdfWatermarkPreviewPageCount,
      state.pdfWatermarkPreviewPage + 1
    )
    void drawPdfWatermarkPreview()
  })
  pdfDropZone.addEventListener('dragover', (event) => {
    event.preventDefault()
    pdfDropZone.classList.add('drag-over')
  })
  pdfDropZone.addEventListener('dragleave', () => pdfDropZone.classList.remove('drag-over'))
  pdfDropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    pdfDropZone.classList.remove('drag-over')
    void addPdfFilesFromDrop(event.dataTransfer.files)
  })

  async function addPdfFilesFromDrop(files) {
    const paths = droppedFilePaths(files)
    if (!paths.length) return
    const config = currentPdfConfig()
    const kind = config.kind
    const action = kind === 'office' ? config.officeKind : kind
    try {
      const result = await window.api.scanDroppedPaths({ paths, region: 'pdf', action })
      if (!result.files.length) {
        if (result.skipped || result.errors.length) {
          setPdfResult(`未找到匹配的 ${config.inputLabel} 文件`, 'error')
        }
        return
      }
      if (kind === 'office') {
        // Office 转 PDF 沿用单输入模型：取首个匹配文件注册为受 sender 约束的 Office 会话。
        const first = result.files[0]
        state.pdfNativeInput = first
        state.pdfFileStatuses = [{ status: '待处理', error: '' }]
        state.pdfComResult = null
        state.pdfLastOutput = null
        resetPdfDestination()
        pdfOpenOutputButton.disabled = true
        renderPdfFiles()
        setPdfResult(`${first.name} 已添加`)
      } else {
        const outputKind = currentPdfDefaultOutputKind()
        let preparedDestination = null
        if (outputKind && result.files[0]) {
          preparedDestination = await window.api.createDefaultPdfDropOutput(result.files[0].id, outputKind)
        }
        for (const [index, item] of result.files.entries()) {
          const file = await readScanFile(item)
          addPdfToolFiles([file], {
            preparedDestination: index === 0 ? preparedDestination : null,
            preserveDestination: index > 0
          })
        }
        if (result.skipped || result.errors.length) {
          showToast(`扫描完成：跳过 ${result.skipped || 0}、失败 ${result.errors.length || 0}`)
        }
      }
    } catch (error) {
      setPdfResult(`拖入失败：${cleanIpcError(error?.message ?? error)}`, 'error')
    }
  }
  pdfRunButton.addEventListener('click', runPdfAction)
  pdfWatermarkRunButton.addEventListener('click', () => pdfRunButton.click())
  pdfCancelButton.addEventListener('click', () => {
    pdfCancelRequested = true
    pdfCancelButton.disabled = true
    setPdfResult('正在停止…', 'busy')
  })
  pdfOpenOutputButton.addEventListener('click', async () => {
    if (!state.pdfLastOutput && !state.pdfComResult) return
    try {
      if (state.pdfComResult) {
        await window.api.showComResult(state.pdfComResult.id)
      } else {
        await window.api.showPdfOutput(state.pdfLastOutput)
      }
    } catch {
      setPdfResult('无法打开输出位置', 'error')
    }
  })

  function closePdfPageOrganizer({ restore = false } = {}) {
    if (restore) {
      state.pdfPageItems = state.pdfPageOrganizerSnapshot.map((item) => ({
        ...item,
        selected: false
      }))
      renderPdfPageOrganizer()
    }
    pdfPageOrganizer.hidden = true
    document.querySelector('#pdf-open-page-organizer')?.focus()
  }
  document.querySelector('#pdf-cancel-page-organizer').addEventListener('click', () => {
    closePdfPageOrganizer({ restore: true })
  })
  document.querySelector('#pdf-insert-pages').addEventListener('click', () => {
    pdfInsertPagesInput.value = ''
    pdfInsertPagesInput.click()
  })
  document.querySelector('#pdf-select-all-pages').addEventListener('click', () => {
    const shouldSelect = state.pdfPageItems.some((item) => !item.selected)
    state.pdfPageItems.forEach((item) => {
      item.selected = shouldSelect
    })
    renderPdfPageOrganizer()
  })
  document.querySelector('#pdf-delete-selected-pages').addEventListener('click', () => {
    const selectedCount = state.pdfPageItems.filter((item) => item.selected).length
    if (!selectedCount) {
      setPdfResult('请先选择要删除的页面', 'error')
      return
    }
    state.pdfPageItems = state.pdfPageItems.filter((item) => !item.selected)
    renderPdfPageOrganizer()
  })
  document.querySelector('#pdf-reset-pages').addEventListener('click', () => {
    state.pdfPageItems = state.pdfPageOrganizerSnapshot.map((item) => ({
      ...item,
      selected: false
    }))
    renderPdfPageOrganizer()
  })
  document.querySelector('#pdf-page-choose-output').addEventListener('click', async () => {
    try {
      const result = await window.api.choosePdfOutput(currentPdfOutputSpec())
      if (result.status !== 'selected') return
      state.pdfDestination = result
      pdfOutputPath.textContent = result.path
      pdfOutputPath.title = result.path
      document.querySelector('#pdf-page-output-path').textContent = result.path
      updatePdfRunState()
    } catch (error) {
      setPdfResult(`无法选择输出位置：${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  })
  document.querySelector('#pdf-save-page-organizer').addEventListener('click', async () => {
    if (state.pdfBusy) return
    if (!state.pdfDestination) {
      setPdfResult('请先选择保存位置', 'error')
      return
    }
    state.pdfBusy = true
    updatePdfRunState()
    setPdfResult('正在保存页面顺序…', 'busy')
    try {
      const message = await saveReorderedPdf()
      setPdfResult(message, state.pdfLastOutput ? 'success' : '')
      if (state.pdfLastOutput) {
        state.pdfPageOrganizerSnapshot = state.pdfPageItems.map((item) => ({
          ...item,
          selected: false
        }))
        closePdfPageOrganizer()
      }
    } catch (error) {
      setPdfResult(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      state.pdfBusy = false
      updatePdfRunState()
    }
  })
  pdfInsertPagesInput.addEventListener('change', () => insertPdfPages(pdfInsertPagesInput.files))
  pdfPageOrganizer.addEventListener('click', (event) => {
    if (event.target === pdfPageOrganizer) closePdfPageOrganizer({ restore: true })
  })
  pdfPageGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page-command]')
    const card = event.target.closest('.pdf-page-card')
    if (!card || state.pdfBusy) return
    if (!button) {
      const item = state.pdfPageItems.find((entry) => entry.id === card.dataset.pageId)
      if (item) {
        item.selected = !item.selected
        renderPdfPageOrganizer()
      }
      return
    }
    const index = state.pdfPageItems.findIndex((item) => item.id === card.dataset.pageId)
    if (button.dataset.pageCommand === 'previous') movePdfPage(index, -1)
    else if (button.dataset.pageCommand === 'next') movePdfPage(index, 1)
    else if (button.dataset.pageCommand === 'delete') {
      state.pdfPageItems.splice(index, 1)
      renderPdfPageOrganizer()
    }
  })
  pdfPageGrid.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.pdf-page-card')
    if (!card) return
    draggedPdfPageId = card.dataset.pageId
    card.classList.add('dragging')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', draggedPdfPageId)
  })
  pdfPageGrid.addEventListener('dragover', (event) => {
    const card = event.target.closest('.pdf-page-card')
    if (!card || card.dataset.pageId === draggedPdfPageId) return
    event.preventDefault()
    pdfPageGrid.querySelectorAll('.drag-target').forEach((item) => item.classList.remove('drag-target'))
    card.classList.add('drag-target')
    event.dataTransfer.dropEffect = 'move'
  })
  pdfPageGrid.addEventListener('drop', (event) => {
    const targetCard = event.target.closest('.pdf-page-card')
    event.preventDefault()
    if (!targetCard || !draggedPdfPageId) return
    const sourceIndex = state.pdfPageItems.findIndex((item) => item.id === draggedPdfPageId)
    let targetIndex = state.pdfPageItems.findIndex((item) => item.id === targetCard.dataset.pageId)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return
    const [item] = state.pdfPageItems.splice(sourceIndex, 1)
    if (sourceIndex < targetIndex) targetIndex -= 1
    const placeAfter = event.clientX > targetCard.getBoundingClientRect().left + targetCard.offsetWidth / 2
    state.pdfPageItems.splice(targetIndex + (placeAfter ? 1 : 0), 0, item)
    renderPdfPageOrganizer()
  })
  pdfPageGrid.addEventListener('dragend', () => {
    draggedPdfPageId = ''
    pdfPageGrid.querySelectorAll('.dragging, .drag-target').forEach((item) => {
      item.classList.remove('dragging', 'drag-target')
    })
  })
  window.api.onPdfSaveProgress((progress) => {
    if (state.pdfBusy) {
      setPdfResult(`正在保存 ${progress.completed} / ${progress.total}`, 'busy')
    }
  })


  return {
    updatePdfState,
    terminateQpdfRunner: () => qpdfRunnerPromise?.then((runner) => runner.destroy()).catch(() => {})
  }
}
