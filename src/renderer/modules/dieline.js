import { buildModel, PDF_PAGE_LIMIT_MM } from '../dieline/model.js'
import { DIELINE_TEMPLATES, getTemplate } from '../dieline/templates/index.js'
import { renderModel2d, PAPER_COLORS } from '../dieline/render2d.js'
import { illustratorFailureHint, cleanIpcError } from '../comErrors.js'

const MM_PER_INCH = 25.4
const DIMENSION_KEYS = ['length', 'width', 'height']
const SVG_NS = 'http://www.w3.org/2000/svg'

function formatMm(value, unit) {
  if (!Number.isFinite(value)) return ''
  if (unit === 'in') return Number((value / MM_PER_INCH).toFixed(3)).toString()
  return Number(value.toFixed(2)).toString()
}

function formatSize(size) {
  return `${formatMm(size.length)} × ${formatMm(size.width)} × ${formatMm(size.height)} mm`
}

function presetThumbnail(template) {
  const result = buildModel(template, template.defaults)
  const svg = document.createElementNS(SVG_NS, 'svg')
  if (!result.ok) return svg
  const part = result.model.parts[0]
  const { minX, minY, maxX, maxY } = part.paperBounds
  const pad = Math.max(maxX - minX, maxY - minY) * 0.05
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`)
  svg.setAttribute('aria-hidden', 'true')
  const group = document.createElementNS(SVG_NS, 'g')
  group.setAttribute('fill', '#f1ead9')
  group.setAttribute('stroke', '#2036c9')
  group.setAttribute('stroke-width', String(Math.max(maxX - minX, maxY - minY) / 110))
  group.setAttribute('stroke-linejoin', 'round')
  for (const path of part.layers.paper) {
    const element = document.createElementNS(SVG_NS, 'path')
    element.setAttribute('d', path)
    group.append(element)
  }
  svg.append(group)
  return svg
}

export function initDieline({ showToast }) {
  const page = document.querySelector('#page-dieline')
  if (!page) return null

  const query = (selector) => page.querySelector(selector)
  const presetList = query('#dieline-preset-list')
  const presetSearch = query('#dieline-preset-search')
  const stage = query('#dieline-stage')
  const svg = query('#dieline-svg')
  const sizesList = query('#dieline-sizes')
  const empty = query('#dieline-empty')
  const threeStage = query('#dieline-3d-stage')
  const stageError = query('#dieline-stage-error')
  const stageErrorText = query('#dieline-stage-error-text')
  const foldRange = query('#dieline-fold-range')
  const foldControl = query('#dieline-fold-control')
  const foldValue = query('#dieline-fold-value')
  const assemblyControl = query('#dieline-assembly-control')
  const assemblyRange = query('#dieline-assembly-range')
  const assemblyHint = query('#dieline-assembly-hint')
  const materialSelect = query('#dieline-material')
  const exportButton = query('#dieline-export-pdf')
  const exportAiButton = query('#dieline-export-ai')
  const isWindows = navigator.userAgent.includes('Windows')
  const exportStatus = query('#dieline-export-status')
  const structureContainer = query('#dieline-structure-params')
  const paramInputs = Object.fromEntries([...page.querySelectorAll('input[data-param]')].map((input) => [input.dataset.param, input]))
  const structureInputs = {}

  let template = DIELINE_TEMPLATES[0]
  let params = { ...template.defaults }
  let unit = 'mm'
  let sizeType = 'manufacturing'
  let focusParam = null
  let currentModel = null
  let foldPreview = null
  let foldGeneration = 0
  let foldTimer = 0
  let isActive = false
  let exporting = false
  let view = { centerX: 0, centerY: 0, baseWidth: 1, baseHeight: 1, zoom: 1, fitted: false }
  let drag = null

  // ---------- 预设 ----------
  function renderPresets(filter = '') {
    presetList.replaceChildren()
    const keyword = filter.trim().toLowerCase()
    for (const entry of DIELINE_TEMPLATES) {
      if (keyword && ![entry.name, entry.category, entry.description].join(' ').toLowerCase().includes(keyword)) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `dieline-preset${entry.id === template.id ? ' selected' : ''}`
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(entry.id === template.id))
      button.dataset.template = entry.id
      const text = document.createElement('div')
      const title = document.createElement('b')
      title.textContent = entry.name
      const detail = document.createElement('span')
      detail.textContent = entry.category
      text.append(title, detail)
      button.append(presetThumbnail(entry), text)
      button.addEventListener('click', () => selectTemplate(entry.id))
      presetList.append(button)
    }
  }

  function selectTemplate(id) {
    const next = getTemplate(id)
    if (!next || next === template) return
    template = next
    params = { ...template.defaults }
    fillForm()
    renderPresets(presetSearch.value)
    renderProject({ refit: true })
  }

  // ---------- 表单 ----------
  // 用户输入的是所选口径的尺寸，内部存制造尺寸。模板只提供正向换算（制造 → 内/外），
  // 反向用逐维割线法：换算在每一维上是仿射的（k·x + b），两点即可解出，非仿射时再迭代几轮收敛。
  function convert(dimensions) {
    const probe = template.normalizeParams({ ...params, ...dimensions })
    return template.sizes(probe)[sizeType]
  }

  function toManufacturing(typed) {
    if (sizeType === 'manufacturing') return typed
    let guess = { ...typed }
    try {
      for (let round = 0; round < 4; round += 1) {
        const base = convert(guess)
        let delta = 0
        const next = { ...guess }
        for (const key of DIMENSION_KEYS) {
          const error = typed[key] - base[key]
          if (Math.abs(error) < 1e-9) continue
          const step = Math.max(Math.abs(guess[key]) * 0.01, 0.5)
          const probed = convert({ ...next, [key]: guess[key] + step })[key]
          const slope = (probed - base[key]) / step
          next[key] = Math.abs(slope) > 1e-6 ? guess[key] + error / slope : guess[key] + error
          delta = Math.max(delta, Math.abs(next[key] - guess[key]))
        }
        guess = next
        if (delta < 1e-9) break
      }
    } catch { return typed }
    return guess
  }

  function displayDimensions() {
    if (sizeType === 'manufacturing') return { length: params.length, width: params.width, height: params.height }
    try { return template.sizes(template.normalizeParams(params))[sizeType] } catch { return params }
  }

  function syncDimensionInputs() {
    const shown = displayDimensions()
    for (const key of DIMENSION_KEYS) {
      if (document.activeElement !== paramInputs[key]) paramInputs[key].value = formatMm(shown[key], unit)
    }
  }

  function fillForm() {
    for (const key of DIMENSION_KEYS) paramInputs[key].value = formatMm(params[key], unit)
    paramInputs.thickness.value = formatMm(params.thickness)
    paramInputs.bleed.value = formatMm(params.bleed)
    const [minT, maxT] = template.ranges.thickness
    paramInputs.thickness.min = String(minT)
    paramInputs.thickness.max = String(maxT)
    paramInputs.thickness.title = `${minT}–${maxT} mm`
    materialSelect.replaceChildren()
    for (const material of template.materials) {
      const option = document.createElement('option')
      option.value = material.id
      option.textContent = material.label
      materialSelect.append(option)
    }
    materialSelect.value = params.material
    page.querySelectorAll('[data-unit-label]').forEach((label) => { label.textContent = unit })
    renderStructureInputs()
  }

  function renderStructureInputs() {
    for (const key of Object.keys(structureInputs)) delete structureInputs[key]
    structureContainer.replaceChildren()
    const schema = template.structureParams || []
    structureContainer.hidden = !schema.length
    for (const entry of schema) {
      const label = document.createElement('label')
      label.textContent = entry.label
      const wrap = document.createElement('span')
      wrap.className = 'dieline-input'
      const input = document.createElement('input')
      input.type = 'number'
      input.step = String(entry.step || 0.5)
      input.min = String(entry.min)
      input.max = String(entry.max)
      input.dataset.param = entry.key
      input.value = formatMm(Number.isFinite(params[entry.key]) ? params[entry.key] : entry.auto(params))
      const unitLabel = document.createElement('em')
      unitLabel.textContent = 'mm'
      wrap.append(input, unitLabel)
      label.append(wrap)
      structureContainer.append(label)
      structureInputs[entry.key] = input
      bindParamInput(entry.key, input, () => {
        const raw = input.value.trim()
        return raw === '' ? null : Number(raw)
      })
    }
    updateStructurePlaceholders()
  }

  // 结构参数改长宽高后会重算：只有用户没手动改过的才跟随
  function updateStructurePlaceholders() {
    if (!template.resolveStructure) return
    let resolved = null
    try { resolved = template.resolveStructure(params) } catch { return }
    for (const [key, input] of Object.entries(structureInputs)) {
      if (Number.isFinite(params[key]) || document.activeElement === input) continue
      input.value = formatMm(resolved[key])
    }
  }

  function readDimension(key) {
    const raw = paramInputs[key].value.trim()
    if (!raw) return NaN
    const value = Number(raw)
    if (!Number.isFinite(value)) return NaN
    return unit === 'in' && DIMENSION_KEYS.includes(key) ? value * MM_PER_INCH : value
  }

  function setUnit(next) {
    if (next === unit) return
    unit = next
    page.querySelectorAll('[data-dieline-unit]').forEach((button) => {
      const selected = button.dataset.dielineUnit === unit
      button.classList.toggle('selected', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
    for (const key of DIMENSION_KEYS) paramInputs[key].value = formatMm(params[key], unit)
    page.querySelectorAll('[data-unit-label]').forEach((label) => { label.textContent = unit })
  }

  function stepThickness(direction) {
    const [minT, maxT] = template.ranges.thickness
    const current = Number.isFinite(params.thickness) ? params.thickness : template.defaults.thickness
    params.thickness = Math.min(maxT, Math.max(minT, Number((current + direction * 0.1).toFixed(2))))
    paramInputs.thickness.value = formatMm(params.thickness)
    renderProject()
  }

  // ---------- 2D ----------
  function renderSvg() {
    if (!currentModel) return
    renderModel2d(svg, currentModel, {
      view,
      paper: PAPER_COLORS[params.material] || PAPER_COLORS['corrugated-e'],
      focusParam,
      showAnnotations: query('#dieline-show-annotations').checked
    })
    svg.querySelectorAll('.dieline-annotation text').forEach((text) => {
      text.addEventListener('click', () => {
        const key = text.parentElement.dataset.param
        const target = paramInputs[key] || structureInputs[key]
        target?.focus()
        target?.select()
      })
    })
    const zoomInput = query('#dieline-zoom-label')
    if (document.activeElement !== zoomInput) zoomInput.value = String(Math.round(view.zoom * 100))
  }

  function fitCanvas({ preserveZoom = false } = {}) {
    if (!currentModel || !stage.clientWidth || !stage.clientHeight) return
    const { minX, minY, maxX, maxY } = currentModel.bounds
    const padding = Math.max(maxX - minX, maxY - minY) * 0.12
    view.centerX = (minX + maxX) / 2
    view.centerY = (minY + maxY) / 2
    view.baseWidth = maxX - minX + padding * 2
    view.baseHeight = maxY - minY + padding * 2
    const stageRatio = stage.clientWidth / stage.clientHeight
    if (view.baseWidth / view.baseHeight > stageRatio) view.baseHeight = view.baseWidth / stageRatio
    else view.baseWidth = view.baseHeight * stageRatio
    if (!preserveZoom) view.zoom = 1
    view.fitted = true
    renderSvg()
  }

  function renderSizes(model) {
    sizesList.replaceChildren()
    for (const [label, size] of [['制造尺寸', model.sizes.manufacturing], ['内尺寸', model.sizes.inner], ['外尺寸', model.sizes.outer]]) {
      const term = document.createElement('dt')
      term.textContent = label
      const detail = document.createElement('dd')
      detail.textContent = formatSize(size)
      sizesList.append(term, detail)
    }
  }

  // ---------- 主渲染 ----------
  function renderProject({ refit = false } = {}) {
    const result = buildModel(template, params)
    const errorLabels = { length: '长', width: '宽', height: '高', thickness: '厚度', bleed: '出血' }
    for (const entry of template.structureParams || []) errorLabels[entry.key] = entry.label
    for (const [key, input] of Object.entries({ ...paramInputs, ...structureInputs })) {
      input.classList.toggle('invalid', !result.ok && result.errors.some((error) => error.startsWith(errorLabels[key] || '\u0000')))
    }
    updateStructurePlaceholders()
    if (!result.ok) {
      currentModel = null
      disposePreview()
      empty.textContent = result.errors.join(' · ')
      empty.hidden = false
      exportButton.disabled = true
      exportAiButton.disabled = true
      return
    }
    const previous = currentModel
    currentModel = result.model
    empty.hidden = true
    exportButton.disabled = exporting
    exportAiButton.disabled = exporting || !isWindows
    renderSizes(currentModel)
    syncDimensionInputs()
    if (!exporting) {
      const oversize = currentModel.parts.find((part) => part.bounds.maxX - part.bounds.minX + 30 > PDF_PAGE_LIMIT_MM || part.bounds.maxY - part.bounds.minY + 41 > PDF_PAGE_LIMIT_MM)
      exportStatus.classList.toggle('error', Boolean(oversize))
      exportStatus.textContent = oversize
        ? `${oversize.name}展开超过 PDF 单页上限 ${PDF_PAGE_LIMIT_MM} mm，导出会失败`
        : `1:1 矢量刀模 · ${currentModel.parts.length > 1 ? `${currentModel.parts.length} 页，每部件一页` : '页面按展开尺寸生成'}`
    }
    const boundsChanged = !previous || ['minX', 'minY', 'maxX', 'maxY'].some((key) => previous.bounds[key] !== currentModel.bounds[key])
    assemblyControl.hidden = currentModel.parts.length < 2
    syncAssemblyAvailability()
    if ((refit || boundsChanged) && stage.clientWidth > 0) fitCanvas({ preserveZoom: Boolean(previous && view.fitted && !refit) })
    else renderSvg()
    schedulePreview()
  }

  // ---------- 3D ----------
  function disposePreview() {
    foldGeneration += 1
    clearTimeout(foldTimer)
    foldPreview?.dispose()
    foldPreview = null
    threeStage.replaceChildren()
  }

  function schedulePreview() {
    clearTimeout(foldTimer)
    foldTimer = setTimeout(() => { void updatePreview() }, 140)
  }

  async function updatePreview() {
    if (!isActive || !currentModel) return
    const generation = ++foldGeneration
    const model = currentModel
    try {
      foldPreview?.dispose()
      foldPreview = null
      const { createFoldPreview } = await import('../dieline/foldPreview.js')
      if (generation !== foldGeneration || !isActive) return
      const preview = await createFoldPreview(threeStage, model)
      if (generation !== foldGeneration || !isActive) {
        preview.dispose()
        return
      }
      foldPreview = preview
      foldPreview.setFold(Number(foldRange.value) / 100)
      foldPreview.setAssembly(Number(assemblyRange.value) / 100)
      stageError.hidden = true
    } catch (error) {
      if (generation !== foldGeneration) return
      stageErrorText.textContent = `3D 预览不可用：${error.message || '未知错误'}`
      stageError.hidden = false
    }
  }

  // ---------- 导出 ----------
  async function exportPdf() {
    if (!currentModel || exporting) return
    const snapshot = currentModel
    const includeAnnotations = query('#dieline-export-annotations').checked
    let destination = null
    exporting = true
    exportButton.disabled = true
    exportStatus.classList.remove('error')
    exportStatus.textContent = '正在生成 PDF…'
    try {
      const { length, width, height } = snapshot.params
      destination = await window.api.choosePdfOutput({ type: 'pdf', name: `${snapshot.templateId}-${length}x${width}x${height}` })
      if (destination.status !== 'selected') {
        exportStatus.textContent = '已取消导出'
        return
      }
      const { buildDielinePdf } = await import('../dieline/exportPdf.js')
      const bytes = await buildDielinePdf(snapshot, { includeAnnotations })
      await window.api.savePdfFile({ type: 'pdf', name: 'dieline.pdf', data: bytes, destinationId: destination.id })
      exportStatus.textContent = `已保存 · ${snapshot.parts.length} 页 · 打印请按 100%`
      showToast('刀模 PDF 已保存')
    } catch (error) {
      exportStatus.classList.add('error')
      exportStatus.textContent = `导出失败：${error.message || error}`
    } finally {
      exporting = false
      exportButton.disabled = !currentModel
      exportAiButton.disabled = !currentModel || !isWindows
      if (destination?.id) void window.api.releasePdfOutput(destination.id)
    }
  }

  // 与条码相同：渲染层出 SVG → 主进程 → Illustrator 打开，不自动保存文件。
  async function exportAi() {
    if (!currentModel || exporting) return
    if (!isWindows) {
      exportStatus.classList.add('error')
      exportStatus.textContent = '发送到 Illustrator 仅 Windows + Illustrator 可用'
      return
    }
    const snapshot = currentModel
    const includeAnnotations = query('#dieline-export-annotations').checked
    exporting = true
    exportButton.disabled = true
    exportAiButton.disabled = true
    exportStatus.classList.remove('error')
    exportStatus.textContent = '正在发送到 Illustrator…'
    try {
      const { buildDielineSvg } = await import('../dieline/exportSvg.js')
      const result = await window.api.sendDielineToIllustrator({
        data: buildDielineSvg(snapshot, { includeAnnotations })
      })
      if (result?.status !== 'opened') throw new Error('Illustrator 未确认打开刀模')
      exportStatus.textContent = '已发送到 Illustrator · 请在 Illustrator 中另存文件'
      showToast('刀模已发送到 Illustrator')
    } catch (error) {
      exportStatus.classList.add('error')
      exportStatus.textContent = `发送失败：${cleanIpcError(error?.message || error)}`
      showToast(illustratorFailureHint(error?.message || error))
    } finally {
      exporting = false
      exportButton.disabled = !currentModel
      exportAiButton.disabled = !currentModel || !isWindows
    }
  }

  // ---------- 事件 ----------
  function bindParamInput(key, input, read) {
    input.addEventListener('input', () => {
      params[key] = read()
      renderProject()
    })
    input.addEventListener('focus', () => {
      focusParam = key
      input.classList.add('focus-param')
      renderSvg()
    })
    input.addEventListener('blur', () => {
      focusParam = null
      input.classList.remove('focus-param')
      renderSvg()
    })
  }
  for (const [key, input] of Object.entries(paramInputs)) {
    bindParamInput(key, input, () => {
      const value = readDimension(key)
      if (!DIMENSION_KEYS.includes(key) || sizeType === 'manufacturing') return value
      if (!Number.isFinite(value)) return value
      const typed = { ...displayDimensions(), [key]: value }
      return toManufacturing(typed)[key]
    })
  }
  page.querySelectorAll('[data-dieline-size-type]').forEach((button) => {
    button.addEventListener('click', () => {
      sizeType = button.dataset.dielineSizeType
      page.querySelectorAll('[data-dieline-size-type]').forEach((item) => {
        const selected = item === button
        item.classList.toggle('selected', selected)
        item.setAttribute('aria-pressed', String(selected))
      })
      syncDimensionInputs()
    })
  })
  materialSelect.addEventListener('change', () => {
    params.material = materialSelect.value
    const material = template.materials.find((entry) => entry.id === params.material)
    if (material && (params.thickness < material.thickness[0] || params.thickness > material.thickness[1])) {
      params.thickness = material.thickness[0]
      paramInputs.thickness.value = formatMm(params.thickness)
    }
    renderProject()
  })
  query('#dieline-thickness-dec').addEventListener('click', () => stepThickness(-1))
  query('#dieline-thickness-inc').addEventListener('click', () => stepThickness(1))
  page.querySelectorAll('[data-dieline-unit]').forEach((button) => button.addEventListener('click', () => setUnit(button.dataset.dielineUnit)))
  query('#dieline-show-annotations').addEventListener('change', renderSvg)
  presetSearch.addEventListener('input', () => renderPresets(presetSearch.value))
  query('#dieline-zoom-in').addEventListener('click', () => { view.zoom = Math.min(8, view.zoom * 1.2); renderSvg() })
  query('#dieline-zoom-out').addEventListener('click', () => { view.zoom = Math.max(0.15, view.zoom / 1.2); renderSvg() })
  query('#dieline-fit').addEventListener('click', () => fitCanvas())
  query('#dieline-zoom-label').addEventListener('input', () => {
    const value = Number(query('#dieline-zoom-label').value)
    if (!Number.isFinite(value) || value <= 0) return
    view.zoom = Math.max(0.15, Math.min(8, value / 100))
    renderSvg()
  })
  stage.addEventListener('wheel', (event) => {
    if (!currentModel) return
    event.preventDefault()
    view.zoom = Math.max(0.15, Math.min(8, view.zoom * (event.deltaY < 0 ? 1.12 : 0.89)))
    renderSvg()
  }, { passive: false })
  stage.addEventListener('pointerdown', (event) => {
    if (!currentModel || event.target.closest('button, text')) return
    drag = { x: event.clientX, y: event.clientY, centerX: view.centerX, centerY: view.centerY }
    stage.setPointerCapture(event.pointerId)
  })
  stage.addEventListener('pointermove', (event) => {
    if (!drag || !currentModel) return
    const rect = stage.getBoundingClientRect()
    view.centerX = drag.centerX - (event.clientX - drag.x) * (view.baseWidth / view.zoom) / Math.max(rect.width, 1)
    view.centerY = drag.centerY - (event.clientY - drag.y) * (view.baseHeight / view.zoom) / Math.max(rect.height, 1)
    renderSvg()
  })
  stage.addEventListener('pointerup', () => { drag = null })
  stage.addEventListener('pointercancel', () => { drag = null })
  // 装配只在完全合拢后可用；重新展开时把装配复位
  function syncAssemblyAvailability() {
    const noFolds = currentModel && currentModel.foldSteps === 0
    foldControl.hidden = Boolean(noFolds)
    const folded = noFolds || Number(foldRange.value) >= 100
    assemblyRange.disabled = !folded
    query('#dieline-assembly-apart').disabled = !folded
    query('#dieline-assembly-done').disabled = !folded
    assemblyControl.classList.toggle('disabled', !folded)
    if (!folded && Number(assemblyRange.value) > 0) {
      assemblyRange.value = '0'
      foldPreview?.setAssembly(0)
    }
    updateAssemblyLabel(folded)
  }
  function updateAssemblyLabel(folded = Number(foldRange.value) >= 100 || (currentModel && currentModel.foldSteps === 0)) {
    const value = Number(assemblyRange.value)
    assemblyHint.textContent = folded ? `${value}%` : '先合拢'
    query('#dieline-assembly-apart').classList.toggle('active', folded && value <= 0)
    query('#dieline-assembly-done').classList.toggle('active', folded && value >= 100)
  }
  function applyFoldValue() {
    const value = Number(foldRange.value) / 100
    foldValue.textContent = `${Math.round(value * 100)}%`
    query('#dieline-fold-open').classList.toggle('active', value <= 0)
    query('#dieline-fold-close').classList.toggle('active', value >= 1)
    foldPreview?.setFold(value)
    syncAssemblyAvailability()
  }
  foldRange.addEventListener('input', applyFoldValue)
  query('#dieline-fold-open').addEventListener('click', () => { foldRange.value = '0'; applyFoldValue() })
  query('#dieline-fold-close').addEventListener('click', () => { foldRange.value = '100'; applyFoldValue() })
  applyFoldValue()
  function applyAssemblyValue() {
    foldPreview?.setAssembly(Number(assemblyRange.value) / 100)
    updateAssemblyLabel()
  }
  assemblyRange.addEventListener('input', applyAssemblyValue)
  query('#dieline-assembly-apart').addEventListener('click', () => { assemblyRange.value = '0'; applyAssemblyValue() })
  query('#dieline-assembly-done').addEventListener('click', () => { assemblyRange.value = '100'; applyAssemblyValue() })
  query('#dieline-3d-reset').addEventListener('click', () => foldPreview?.resetView())
  query('#dieline-3d-retry').addEventListener('click', () => { stageError.hidden = true; void updatePreview() })
  exportButton.addEventListener('click', exportPdf)
  exportAiButton.addEventListener('click', exportAi)
  if (!isWindows) exportAiButton.title = '发送到 Illustrator 需 Windows + Adobe Illustrator'

  fillForm()
  renderPresets()
  renderProject({ refit: true })

  return {
    renderProject,
    activate() {
      isActive = true
      requestAnimationFrame(() => {
        fitCanvas({ preserveZoom: true })
        void updatePreview()
      })
    },
    deactivate() {
      isActive = false
      disposePreview()
    }
  }
}
