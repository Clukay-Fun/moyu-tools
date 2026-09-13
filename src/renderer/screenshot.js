import { installTooltips } from './tooltip.js'

installTooltips()

// OCR 首次运行要下载/初始化 Tesseract 核心和语言包，加上识别本身，几秒钟内
// 只看得到一句静止的"正在提取文字…"——主进程其实一直在发这几个阶段的进度
// （screenshot:ocr-progress），只是之前没有任何界面订阅它。
const OCR_PROGRESS_LABELS = {
  'loading tesseract core': '载入 OCR 核心',
  'initializing tesseract': '初始化 OCR 核心',
  'loading language traineddata': '载入中英文模型',
  'initializing api': '初始化识别引擎',
  'recognizing text': '正在识别文字'
}

const canvas = document.querySelector('#capture-canvas')
const context = canvas.getContext('2d')
const magnifier = document.querySelector('#capture-magnifier')
const magnifierContext = magnifier.getContext('2d')
const sizeLabel = document.querySelector('#selection-size')
const toolbar = document.querySelector('#capture-toolbar')
const popover = document.querySelector('#capture-popover')
const textEditor = document.querySelector('#capture-text-editor')
const tip = document.querySelector('#capture-tip')
const undoButton = document.querySelector('#undo-capture')
const redoButton = document.querySelector('#redo-capture')
const colorButton = document.querySelector('#annotation-color')
const widthButton = document.querySelector('#annotation-width')
let sessionId = new URLSearchParams(window.location.search).get('session')

const HANDLE_RADIUS = 10
const HANDLE_SIZE = 8
const COLORS = ['#ff4f57', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#111827']
const WIDTHS = [2, 4, 7]

let image
let selection = null
let interaction = null
let tool = null
let draft = null
let annotations = []
let redoStack = []
let annotationColor = COLORS[0]
let annotationWidth = WIDTHS[0]
let busy = false

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function pointFromEvent(event) {
  return {
    x: clamp(event.clientX, 0, canvas.width),
    y: clamp(event.clientY, 0, canvas.height)
  }
}

function normalizedRect(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

function selectionContains(point) {
  return selection &&
    point.x >= selection.x && point.x <= selection.x + selection.width &&
    point.y >= selection.y && point.y <= selection.y + selection.height
}

function handlePoints(rect = selection) {
  if (!rect) return []
  const left = rect.x
  const centerX = rect.x + rect.width / 2
  const right = rect.x + rect.width
  const top = rect.y
  const centerY = rect.y + rect.height / 2
  const bottom = rect.y + rect.height
  return [
    ['nw', left, top], ['n', centerX, top], ['ne', right, top],
    ['e', right, centerY], ['se', right, bottom], ['s', centerX, bottom],
    ['sw', left, bottom], ['w', left, centerY]
  ]
}

function hitHandle(point) {
  for (const [name, x, y] of handlePoints()) {
    if (Math.abs(point.x - x) <= HANDLE_RADIUS && Math.abs(point.y - y) <= HANDLE_RADIUS) return name
  }
  return null
}

function resizeSelection(initial, handle, point, origin) {
  let left = initial.x
  let top = initial.y
  let right = initial.x + initial.width
  let bottom = initial.y + initial.height
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  if (handle.includes('w')) left += dx
  if (handle.includes('e')) right += dx
  if (handle.includes('n')) top += dy
  if (handle.includes('s')) bottom += dy
  return normalizedRect(
    { x: clamp(left, 0, canvas.width), y: clamp(top, 0, canvas.height) },
    { x: clamp(right, 0, canvas.width), y: clamp(bottom, 0, canvas.height) }
  )
}

function moveSelection(initial, point, origin) {
  return {
    ...initial,
    x: clamp(initial.x + point.x - origin.x, 0, canvas.width - initial.width),
    y: clamp(initial.y + point.y - origin.y, 0, canvas.height - initial.height)
  }
}

function drawArrow(target, item) {
  const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1)
  const head = Math.max(12, item.width * 4)
  target.beginPath()
  target.moveTo(item.x1, item.y1)
  target.lineTo(item.x2, item.y2)
  target.stroke()
  target.beginPath()
  target.moveTo(item.x2, item.y2)
  target.lineTo(item.x2 - head * Math.cos(angle - Math.PI / 6), item.y2 - head * Math.sin(angle - Math.PI / 6))
  target.moveTo(item.x2, item.y2)
  target.lineTo(item.x2 - head * Math.cos(angle + Math.PI / 6), item.y2 - head * Math.sin(angle + Math.PI / 6))
  target.stroke()
}

function drawMosaic(target, item) {
  const rect = normalizedRect({ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 })
  if (rect.width < 2 || rect.height < 2) return
  const block = Math.max(8, item.width * 3)
  const scaleX = image.width / canvas.width
  const scaleY = image.height / canvas.height
  const source = document.createElement('canvas')
  source.width = Math.max(1, Math.ceil(rect.width / block))
  source.height = Math.max(1, Math.ceil(rect.height / block))
  source.getContext('2d').drawImage(
    image,
    rect.x * scaleX, rect.y * scaleY, rect.width * scaleX, rect.height * scaleY,
    0, 0, source.width, source.height
  )
  target.save()
  target.imageSmoothingEnabled = false
  target.drawImage(source, rect.x, rect.y, rect.width, rect.height)
  target.restore()
}

function drawAnnotation(target, item) {
  target.save()
  target.strokeStyle = item.color
  target.fillStyle = item.color
  target.lineWidth = item.width
  target.lineCap = 'round'
  target.lineJoin = 'round'
  if (item.tool === 'rectangle') {
    const rect = normalizedRect({ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 })
    target.strokeRect(rect.x, rect.y, rect.width, rect.height)
  } else if (item.tool === 'ellipse') {
    target.beginPath()
    target.ellipse((item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2,
      Math.abs(item.x2 - item.x1) / 2, Math.abs(item.y2 - item.y1) / 2, 0, 0, Math.PI * 2)
    target.stroke()
  } else if (item.tool === 'arrow') {
    drawArrow(target, item)
  } else if (item.tool === 'brush') {
    target.beginPath()
    item.points.forEach((point, index) => index === 0 ? target.moveTo(point.x, point.y) : target.lineTo(point.x, point.y))
    target.stroke()
  } else if (item.tool === 'text') {
    target.font = `600 ${Math.max(18, item.width * 6)}px "Segoe UI", "Microsoft YaHei UI", sans-serif`
    String(item.text).split('\n').forEach((line, index) => target.fillText(line, item.x1, item.y1 + index * 27))
  } else if (item.tool === 'mosaic') {
    drawMosaic(target, item)
  }
  target.restore()
}

function drawSelectionFrame() {
  context.save()
  context.strokeStyle = '#2f9bff'
  context.lineWidth = 2
  context.setLineDash([])
  context.strokeRect(selection.x, selection.y, selection.width, selection.height)
  context.fillStyle = '#fff'
  for (const [, x, y] of handlePoints()) {
    context.fillRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    context.strokeRect(x - HANDLE_SIZE / 2, y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
  }
  context.restore()
}

function render() {
  if (!image) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  context.fillStyle = 'rgba(15, 18, 25, 0.5)'
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (!selection || selection.width < 1 || selection.height < 1) return
  context.save()
  context.beginPath()
  context.rect(selection.x, selection.y, selection.width, selection.height)
  context.clip()
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  annotations.forEach((item) => drawAnnotation(context, item))
  if (draft) drawAnnotation(context, draft)
  context.restore()
  drawSelectionFrame()
}

function positionControls() {
  if (!selection) return
  const toolbarWidth = toolbar.offsetWidth || 530
  const toolbarHeight = toolbar.offsetHeight || 44
  const below = selection.y + selection.height + 10
  const top = below + toolbarHeight <= window.innerHeight - 8
    ? below
    : Math.max(8, selection.y - toolbarHeight - 10)
  toolbar.style.left = `${clamp(selection.x + selection.width - toolbarWidth, 8, window.innerWidth - toolbarWidth - 8)}px`
  toolbar.style.top = `${top}px`
  sizeLabel.style.left = `${clamp(selection.x + selection.width / 2 - 50, 8, window.innerWidth - 108)}px`
  sizeLabel.style.top = `${Math.max(8, selection.y - 29)}px`
  const scaleX = image ? image.width / canvas.width : 1
  const scaleY = image ? image.height / canvas.height : 1
  sizeLabel.textContent = `${Math.round(selection.width * scaleX)} × ${Math.round(selection.height * scaleY)}`
}

function syncHistory() {
  undoButton.disabled = annotations.length === 0
  redoButton.disabled = redoStack.length === 0
}

function pushAnnotation(item) {
  annotations.push(item)
  redoStack = []
  syncHistory()
  render()
}

function undo() {
  const item = annotations.pop()
  if (!item) return
  redoStack.push(item)
  syncHistory()
  render()
}

function redo() {
  const item = redoStack.pop()
  if (!item) return
  annotations.push(item)
  syncHistory()
  render()
}

function finalCanvas() {
  if (!selection) throw new Error('请先选择截图区域')
  const scaleX = image.width / canvas.width
  const scaleY = image.height / canvas.height
  const output = document.createElement('canvas')
  output.width = Math.max(1, Math.round(selection.width * scaleX))
  output.height = Math.max(1, Math.round(selection.height * scaleY))
  const outputContext = output.getContext('2d')
  outputContext.scale(scaleX, scaleY)
  outputContext.translate(-selection.x, -selection.y)
  outputContext.drawImage(image, 0, 0, canvas.width, canvas.height)
  annotations.forEach((item) => drawAnnotation(outputContext, item))
  return output
}

function canvasPngBytes(output) {
  return new Promise((resolve, reject) => {
    output.toBlob(async (blob) => {
      if (!blob) return reject(new Error('截图编码失败'))
      resolve(new Uint8Array(await blob.arrayBuffer()))
    }, 'image/png')
  })
}

async function withBusy(message, action) {
  if (busy) return
  busy = true
  toolbar.querySelectorAll('button').forEach((button) => { button.disabled = true })
  tip.textContent = message
  try {
    await action()
  } catch (error) {
    tip.textContent = error?.message || '截图操作失败，请重试'
  } finally {
    busy = false
    toolbar.querySelectorAll('button').forEach((button) => { button.disabled = false })
    syncHistory()
  }
}

function cancelSelection() {
  window.api.cancelScreenshot(sessionId)
}

function setTool(nextTool) {
  tool = tool === nextTool ? null : nextTool
  toolbar.querySelectorAll('[data-tool]').forEach((option) => option.classList.toggle('on', option.dataset.tool === tool))
  tip.textContent = tool ? '在选区内拖动进行标注' : '拖动选区可移动，拖动控制点可缩放'
}

function closePopover() {
  popover.hidden = true
  popover.replaceChildren()
}

function showPopover(anchor, type) {
  closePopover()
  const values = type === 'color' ? COLORS : WIDTHS
  values.forEach((value) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.value = String(value)
    button.classList.toggle('on', value === (type === 'color' ? annotationColor : annotationWidth))
    button.setAttribute('aria-label', type === 'color' ? `颜色 ${value}` : `粗细 ${value}`)
    const preview = document.createElement('span')
    if (type === 'color') {
      preview.className = 'color-dot'
      preview.style.setProperty('--dot-color', value)
    } else {
      preview.className = 'width-line'
      preview.style.setProperty('--line-width', `${value}px`)
    }
    button.append(preview)
    button.addEventListener('click', () => {
      if (type === 'color') {
        annotationColor = value
        colorButton.querySelector('.annotation-swatch').style.background = value
      } else {
        annotationWidth = value
        widthButton.querySelector('.annotation-width-preview').style.height = `${value}px`
      }
      closePopover()
    })
    popover.append(button)
  })
  popover.hidden = false
  const rect = anchor.getBoundingClientRect()
  const width = popover.offsetWidth
  popover.style.left = `${clamp(rect.left, 8, window.innerWidth - width - 8)}px`
  popover.style.top = `${Math.max(8, rect.top - popover.offsetHeight - 8)}px`
}

function openTextEditor(point) {
  textEditor.value = ''
  textEditor.style.left = `${clamp(point.x, selection.x, selection.x + selection.width - 180)}px`
  textEditor.style.top = `${clamp(point.y - 12, selection.y, selection.y + selection.height - 44)}px`
  textEditor.hidden = false
  textEditor.dataset.x = String(point.x)
  textEditor.dataset.y = String(point.y)
  // pointerdown 的浏览器默认聚焦发生在事件处理器之后；同步 focus 会被它抢回，
  // 随即触发 blur，把刚出现的空编辑器立刻关掉。
  requestAnimationFrame(() => {
    if (!textEditor.hidden) textEditor.focus()
  })
}

function commitTextEditor() {
  if (textEditor.hidden) return
  const text = textEditor.value.trim()
  if (text) {
    pushAnnotation({
      tool: 'text', text,
      x1: Number(textEditor.dataset.x), y1: Number(textEditor.dataset.y),
      color: annotationColor, width: annotationWidth
    })
  }
  textEditor.hidden = true
  textEditor.value = ''
}

function cancelTextEditor() {
  textEditor.hidden = true
  textEditor.value = ''
}

function renderMagnifier(point) {
  if (!image || interaction?.kind !== 'select') {
    magnifier.hidden = true
    return
  }
  const sampleSize = 16
  const sampleScale = 7
  const scaleX = image.width / canvas.width
  const scaleY = image.height / canvas.height
  magnifierContext.clearRect(0, 0, magnifier.width, magnifier.height)
  magnifierContext.imageSmoothingEnabled = false
  magnifierContext.drawImage(
    image,
    (point.x - sampleSize / 2) * scaleX, (point.y - sampleSize / 2) * scaleY,
    sampleSize * scaleX, sampleSize * scaleY,
    8, 8, sampleSize * sampleScale, sampleSize * sampleScale
  )
  magnifierContext.strokeStyle = '#2f9bff'
  magnifierContext.lineWidth = 1
  magnifierContext.strokeRect(8 + sampleSize * sampleScale / 2 - 3.5, 8 + sampleSize * sampleScale / 2 - 3.5, 7, 7)
  magnifierContext.fillStyle = '#fff'
  magnifierContext.font = '12px Consolas, monospace'
  magnifierContext.fillText(`${Math.round(point.x * scaleX)}, ${Math.round(point.y * scaleY)}`, 10, 140)
  magnifier.style.left = `${point.x + 148 < window.innerWidth ? point.x + 18 : point.x - 146}px`
  magnifier.style.top = `${point.y + 170 < window.innerHeight ? point.y + 18 : point.y - 170}px`
  magnifier.hidden = false
}

canvas.addEventListener('pointerdown', (event) => {
  if (busy || event.button !== 0 || !textEditor.hidden) return
  event.preventDefault()
  closePopover()
  const point = pointFromEvent(event)
  const handle = selection && annotations.length === 0 && !tool ? hitHandle(point) : null
  if (handle) {
    interaction = { kind: 'resize', handle, origin: point, initial: { ...selection } }
  } else if (selection && selectionContains(point) && tool) {
    if (tool === 'text') {
      openTextEditor(point)
      return
    }
    draft = tool === 'brush'
      ? { tool, points: [point], color: annotationColor, width: annotationWidth }
      : { tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color: annotationColor, width: annotationWidth }
    interaction = { kind: 'draw' }
  } else if (selection && selectionContains(point) && annotations.length === 0) {
    interaction = { kind: 'move', origin: point, initial: { ...selection } }
  } else {
    annotations = []
    redoStack = []
    tool = null
    syncHistory()
    selection = { x: point.x, y: point.y, width: 0, height: 0 }
    interaction = { kind: 'select', origin: point }
    toolbar.hidden = true
    sizeLabel.hidden = false
  }
  canvas.setPointerCapture(event.pointerId)
  renderMagnifier(point)
  render()
})

canvas.addEventListener('pointermove', (event) => {
  const point = pointFromEvent(event)
  if (!interaction) return
  if (interaction.kind === 'select') {
    selection = normalizedRect(interaction.origin, point)
  } else if (interaction.kind === 'move') {
    selection = moveSelection(interaction.initial, point, interaction.origin)
  } else if (interaction.kind === 'resize') {
    selection = resizeSelection(interaction.initial, interaction.handle, point, interaction.origin)
  } else if (interaction.kind === 'draw' && draft?.tool === 'brush') {
    draft.points.push(point)
  } else if (interaction.kind === 'draw' && draft) {
    draft.x2 = point.x
    draft.y2 = point.y
  }
  positionControls()
  renderMagnifier(point)
  render()
})

canvas.addEventListener('pointerup', (event) => {
  if (!interaction) return
  canvas.releasePointerCapture(event.pointerId)
  if (interaction.kind === 'select') {
    const valid = selection.width >= 5 && selection.height >= 5
    toolbar.hidden = !valid
    sizeLabel.hidden = !valid
    tip.textContent = valid ? '拖动选区可移动，选择工具后在选区内标注' : '拖动选择截图区域 · Esc 取消'
    if (!valid) selection = null
  } else if (interaction.kind === 'draw' && draft) {
    pushAnnotation(draft)
    draft = null
  }
  interaction = null
  magnifier.hidden = true
  positionControls()
  render()
})

toolbar.addEventListener('pointerdown', (event) => event.stopPropagation())
toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tool]')
  if (button) setTool(button.dataset.tool)
})

undoButton.addEventListener('click', undo)
redoButton.addEventListener('click', redo)
colorButton.addEventListener('click', () => showPopover(colorButton, 'color'))
widthButton.addEventListener('click', () => showPopover(widthButton, 'width'))

document.querySelector('#confirm-capture').addEventListener('click', () => withBusy('正在生成截图…', async () => {
  const data = await canvasPngBytes(finalCanvas())
  await window.api.completeScreenshot({ sessionId, data })
}))
document.querySelector('#cancel-capture').addEventListener('click', cancelSelection)
document.querySelector('#save-capture').addEventListener('click', () => withBusy('正在保存截图…', async () => {
  const data = await canvasPngBytes(finalCanvas())
  const result = await window.api.saveScreenshot({ name: `screenshot-${Date.now()}`, data })
  tip.textContent = result.status === 'saved' ? '截图已保存' : '已取消保存'
}))
document.querySelector('#copy-capture').addEventListener('click', () => withBusy('正在复制截图…', async () => {
  const data = await canvasPngBytes(finalCanvas())
  await window.api.copyScreenshot(data)
  tip.textContent = '截图已复制到剪贴板'
}))
document.querySelector('#pin-capture').addEventListener('click', () => withBusy('正在钉住截图…', async () => {
  const data = await canvasPngBytes(finalCanvas())
  await window.api.pinScreenshot(data)
  tip.textContent = '截图已钉住'
}))
window.api.onScreenshotOcrProgress((progress) => {
  if (!busy) return
  const label = OCR_PROGRESS_LABELS[progress.status]
  if (!label) return
  const percent = Number.isFinite(progress.progress) ? `${Math.round(progress.progress * 100)}%` : ''
  tip.textContent = percent ? `${label} ${percent}` : label
})

document.querySelector('#ocr-capture').addEventListener('click', () => withBusy('正在提取文字…', async () => {
  const data = await canvasPngBytes(finalCanvas())
  const result = await window.api.recognizeScreenshot(data)
  if (!result.text?.trim()) throw new Error('未识别到文字')
  await window.api.copyScreenshotText(result.text)
  tip.textContent = '文字已提取并复制到剪贴板'
}))

textEditor.addEventListener('pointerdown', (event) => event.stopPropagation())
textEditor.addEventListener('blur', commitTextEditor)
textEditor.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelTextEditor()
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    commitTextEditor()
  }
})

window.addEventListener('pointerdown', (event) => {
  if (!popover.hidden && !popover.contains(event.target) && !event.target.closest('#annotation-color, #annotation-width')) closePopover()
})
window.addEventListener('keydown', (event) => {
  if (!textEditor.hidden) return
  if (event.key === 'Escape') {
    if (!popover.hidden) closePopover()
    else cancelSelection()
  } else if (event.key === 'Enter' && selection) {
    document.querySelector('#confirm-capture').click()
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? redo() : undo()
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
  }
})

window.addEventListener('resize', () => {
  const oldWidth = canvas.width || window.innerWidth
  const oldHeight = canvas.height || window.innerHeight
  const scaleX = window.innerWidth / oldWidth
  const scaleY = window.innerHeight / oldHeight
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  if (selection) {
    selection = {
      x: selection.x * scaleX,
      y: selection.y * scaleY,
      width: selection.width * scaleX,
      height: selection.height * scaleY
    }
    annotations = annotations.map((item) => {
      const next = { ...item }
      if (next.points) next.points = next.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))
      for (const key of ['x1', 'x2']) if (Number.isFinite(next[key])) next[key] *= scaleX
      for (const key of ['y1', 'y2']) if (Number.isFinite(next[key])) next[key] *= scaleY
      return next
    })
  }
  positionControls()
  render()
})

async function initialize(nextSessionId) {
  sessionId = nextSessionId
  image = null
  selection = null
  interaction = null
  tool = null
  draft = null
  annotations = []
  redoStack = []
  busy = false
  toolbar.hidden = true
  sizeLabel.hidden = true
  magnifier.hidden = true
  closePopover()
  cancelTextEditor()
  tip.textContent = '拖动选择截图区域 · Esc 取消'
  syncHistory()
  const session = await window.api.getScreenshotSession(sessionId)
  image = await createImageBitmap(new Blob([session.data], { type: 'image/png' }))
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  render()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await window.api.reportScreenshotReady(sessionId)
}

function startSession(nextSessionId) {
  initialize(nextSessionId).catch((error) => {
    tip.textContent = error?.message || '截图初始化失败'
    setTimeout(cancelSelection, 1200)
  })
}

window.api.onScreenshotSession(startSession)
if (sessionId) startSession(sessionId)
