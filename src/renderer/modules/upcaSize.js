// @ts-check

import { computeRetailGeometry } from '../retailBarcode.js'

const UPC_A = 'UPC-A'
const DEFAULT_ID = 'default'
const STORAGE_KEY = 'moyu.upca-size-presets.v1'
const STORAGE_VERSION = 1
const DEFAULT_GEOMETRY = computeRetailGeometry(UPC_A)
const DEFAULT_WIDTH_MM = DEFAULT_GEOMETRY.widthMm
const DEFAULT_HEIGHT_MM = DEFAULT_GEOMETRY.heightMm

/** @typedef {'proportional' | 'independent'} UpcaMode */
/** @typedef {{ mode: UpcaMode, widthMm: number, heightMm: number }} UpcaDimensions */
/** @typedef {UpcaDimensions & { id: string, name: string, version: number }} UpcaPreset */
/** @typedef {UpcaDimensions & { presetId: string, presetName: string }} UpcaConfig */
/** @typedef {{ valid: boolean, geometryChanged: boolean, becameValid: boolean, configurationChanged: boolean, config: UpcaConfig, error?: string }} UpcaChange */
/** @typedef {'width' | 'height'} UpcaField */

/** @param {string} selector @returns {HTMLElement} */
function need(selector) {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`缺少 UPC-A 尺寸控件：${selector}`)
  return /** @type {HTMLElement} */ (element)
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : null
}

/** @param {unknown} value @returns {UpcaPreset | null} */
function normalizePreset(value) {
  const record = asRecord(value)
  if (!record) return null
  const mode = record.mode === 'independent' ? 'independent' : record.mode === 'proportional' ? 'proportional' : null
  const widthMm = Number(record.widthMm)
  const heightMm = Number(record.heightMm)
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!mode || !id || !name || !Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) return null
  if (record.version !== STORAGE_VERSION) return null
  try {
    computeRetailGeometry(UPC_A, { widthMm, heightMm })
  } catch {
    return null
  }
  return { id, name, mode, widthMm, heightMm, version: STORAGE_VERSION }
}

/** @param {number} value */
function formatMm(value) {
  return Number(value).toFixed(2)
}

/** @param {number} a @param {number} b */
function sameNumber(a, b) {
  return Math.abs(a - b) < 1e-9
}

/** @param {{ widthMm: number, heightMm: number }} a @param {{ widthMm: number, heightMm: number }} b */
function sameDimensions(a, b) {
  return sameNumber(a.widthMm, b.widthMm) && sameNumber(a.heightMm, b.heightMm)
}

/** @param {unknown} error */
function explainError(error) {
  return error instanceof Error && error.message ? error.message : String(error || '未知错误')
}

/**
 * UPC-A 尺寸卡片、会话状态和自建预设。
 * @param {{
 *   onChange: (change: UpcaChange) => void,
 *   showToast: (message: string) => void,
 *   registerPopover: (menu: HTMLElement, trigger: HTMLElement | null, placement?: object) => void,
 *   openPopover: (menu: HTMLElement) => void,
 *   closePopover: (menu: HTMLElement) => void,
 *   isPopoverOpen: (menu: HTMLElement) => boolean
 * }} deps
 */
export function initUpcaSizeControls({
  onChange,
  showToast,
  registerPopover,
  openPopover,
  closePopover,
  isPopoverOpen
}) {
  const card = /** @type {HTMLDivElement} */ (need('#upca-size-card'))
  const widthInput = /** @type {HTMLInputElement} */ (need('#upca-width-mm'))
  const heightInput = /** @type {HTMLInputElement} */ (need('#upca-height-mm'))
  const widthError = need('#upca-width-error')
  const heightError = need('#upca-height-error')
  const warning = need('#upca-size-warning')
  const sizeStatus = need('#upca-size-status')
  const storageStatus = need('#upca-storage-status')
  const presetTrigger = /** @type {HTMLButtonElement} */ (need('#upca-preset-trigger'))
  const presetMenu = need('#upca-preset-menu')
  const presetItems = need('#upca-preset-items')
  const presetEmpty = need('#upca-preset-empty')
  const presetActionsTrigger = /** @type {HTMLButtonElement} */ (need('#upca-preset-actions-trigger'))
  const presetActionsMenu = need('#upca-preset-actions-menu')
  const resetButton = /** @type {HTMLButtonElement} */ (need('#upca-size-reset'))
  const saveAsButton = /** @type {HTMLButtonElement} */ (need('#upca-preset-save-as'))
  const updateButton = /** @type {HTMLButtonElement} */ (need('#upca-preset-update'))
  const presetDialog = /** @type {HTMLDialogElement} */ (need('#upca-preset-dialog'))
  const presetForm = /** @type {HTMLFormElement} */ (need('#upca-preset-form'))
  const presetDialogTitle = /** @type {HTMLHeadingElement} */ (need('#upca-preset-dialog-title'))
  const presetNameInput = /** @type {HTMLInputElement} */ (need('#upca-preset-name'))
  const presetNameError = need('#upca-preset-name-error')
  const cancelButton = /** @type {HTMLButtonElement} */ (need('#upca-preset-cancel'))
  const quickButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('#upca-size-presets [data-upca-scale]')])
  const modeButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('#upca-size-mode [data-upca-mode]')])

  if (!(widthInput instanceof HTMLInputElement) || !(heightInput instanceof HTMLInputElement) ||
      !(presetTrigger instanceof HTMLButtonElement) || !(presetActionsTrigger instanceof HTMLButtonElement) ||
      !(resetButton instanceof HTMLButtonElement) || !(saveAsButton instanceof HTMLButtonElement) ||
      !(updateButton instanceof HTMLButtonElement) || !(presetDialog instanceof HTMLDialogElement) ||
      !(presetForm instanceof HTMLFormElement) || !(presetNameInput instanceof HTMLInputElement) ||
      !(cancelButton instanceof HTMLButtonElement)) {
    throw new Error('UPC-A 尺寸控件结构无效')
  }

  /** @type {UpcaPreset[]} */
  let presets = []
  /** @type {string} */
  let selectedPresetId = DEFAULT_ID
  /** @type {UpcaDimensions} */
  let current = { mode: 'proportional', widthMm: DEFAULT_WIDTH_MM, heightMm: DEFAULT_HEIGHT_MM }
  /** @type {{ width: string, height: string }} */
  let draft = { width: formatMm(DEFAULT_WIDTH_MM), height: formatMm(DEFAULT_HEIGHT_MM) }
  let draftValid = true
  let visible = false
  let storageError = ''
  /** @type {{ mode: 'save' | 'rename', presetId?: string } | null} */
  let dialogIntent = null

  function selectedPreset() {
    return presets.find((preset) => preset.id === selectedPresetId) || null
  }

  function selectedName() {
    return selectedPreset()?.name || '默认尺寸'
  }

  function currentConfig() {
    return {
      ...current,
      presetId: selectedPresetId,
      presetName: selectedName()
    }
  }

  /** @returns {void} */
  function readPresets() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const data = asRecord(JSON.parse(raw))
      if (!data || data.version !== STORAGE_VERSION || !Array.isArray(data.presets)) {
        throw new Error('预设数据版本或格式不受支持')
      }
      const loaded = data.presets.map((preset) => normalizePreset(preset))
      if (loaded.some((preset) => !preset)) throw new Error('预设数据格式无效，未覆盖原数据')
      const validPresets = /** @type {UpcaPreset[]} */ (loaded)
      const ids = new Set(validPresets.map((preset) => preset.id))
      const names = new Set(validPresets.map((preset) => preset.name.toLocaleLowerCase()))
      if (ids.size !== validPresets.length || names.size !== validPresets.length || names.has('默认尺寸')) {
        throw new Error('预设名称或编号重复，未覆盖原数据')
      }
      presets = validPresets
    } catch (error) {
      storageError = `读取预设失败：${explainError(error)}`
    }
  }

  /** @param {UpcaPreset[]} nextPresets */
  function persistPresets(nextPresets) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, presets: nextPresets }))
      presets = nextPresets
      storageError = ''
      renderPresetItems()
      updateView()
      return true
    } catch (error) {
      storageError = `保存预设失败：${explainError(error)}`
      updateView()
      showToast(storageError)
      return false
    }
  }

  /** @param {HTMLInputElement} input @param {HTMLElement} target @param {string} message */
  function setFieldError(input, target, message) {
    input.setAttribute('aria-invalid', String(Boolean(message)))
    target.textContent = message
    target.hidden = !message
  }

  function setDraftFields() {
    widthInput.value = draft.width
    heightInput.value = draft.height
  }

  function isDirty() {
    const saved = selectedPreset()
    const baseline = saved || {
      mode: 'proportional',
      widthMm: DEFAULT_WIDTH_MM,
      heightMm: DEFAULT_HEIGHT_MM
    }
    return current.mode !== baseline.mode || !sameDimensions(current, baseline)
  }

  function isDefaultGeometry() {
    return sameNumber(current.widthMm, DEFAULT_WIDTH_MM) && sameNumber(current.heightMm, DEFAULT_HEIGHT_MM)
  }

  function needsScanWarning() {
    if (!draftValid) return false
    const widthScale = current.widthMm / DEFAULT_WIDTH_MM
    const heightScale = current.heightMm / DEFAULT_HEIGHT_MM
    const geometry = computeRetailGeometry(UPC_A, current)
    const shortenedBars = geometry.spec.barHeightMm < DEFAULT_GEOMETRY.spec.barHeightMm * widthScale - 1e-9
    return widthScale < 0.8 || widthScale > 2 || heightScale < 0.8 || heightScale > 2 || shortenedBars
  }

  function renderPresetItems() {
    const fragment = document.createDocumentFragment()
    for (const preset of presets) {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.dataset.upcaPresetId = preset.id
      item.setAttribute('aria-selected', String(preset.id === selectedPresetId))
      item.textContent = `${preset.name}${preset.id === selectedPresetId ? ' ✓' : ''}`
      item.title = preset.name
      fragment.append(item)
    }
    presetItems.replaceChildren(fragment)
    presetEmpty.hidden = presets.length > 0
    const defaultItem = presetMenu.querySelector('[data-upca-preset-id="default"]')
    defaultItem?.setAttribute('aria-selected', String(selectedPresetId === DEFAULT_ID))
    const rename = presetActionsMenu.querySelector('[data-upca-preset-action="rename"]')
    const remove = presetActionsMenu.querySelector('[data-upca-preset-action="delete"]')
    if (rename instanceof HTMLButtonElement) rename.disabled = selectedPresetId === DEFAULT_ID
    if (remove instanceof HTMLButtonElement) remove.disabled = selectedPresetId === DEFAULT_ID
  }

  function updateView() {
    card.hidden = !visible
    presetTrigger.textContent = selectedName()
    presetTrigger.title = selectedName()
    const statusText = isDirty()
      ? ''
      : selectedPresetId === DEFAULT_ID
        ? ''
        : '已保存预设'
    sizeStatus.textContent = statusText
    sizeStatus.hidden = !statusText
    storageStatus.textContent = storageError

    for (const button of quickButtons) {
      if (!(button instanceof HTMLButtonElement)) continue
      const scale = Number(button.dataset.upcaScale)
      const selected = draftValid && current.mode === 'proportional' &&
        sameNumber(current.widthMm, DEFAULT_WIDTH_MM * scale) &&
        sameNumber(current.heightMm, DEFAULT_HEIGHT_MM * scale)
      button.setAttribute('aria-pressed', String(selected))
      button.disabled = !draftValid
    }
    for (const button of modeButtons) {
      if (!(button instanceof HTMLButtonElement)) continue
      button.setAttribute('aria-pressed', String(button.dataset.upcaMode === current.mode))
      button.disabled = !draftValid
    }

    warning.hidden = !needsScanWarning()
    saveAsButton.disabled = !draftValid
    const currentPreset = selectedPreset()
    updateButton.disabled = !draftValid || !currentPreset || !isDirty()
    renderPresetItems()
  }

  /** @param {UpcaField} field @param {string} rawValue */
  function updateDraft(field, rawValue) {
    const previouslyValid = draftValid
    draft[field] = rawValue
    const widthRaw = field === 'width' ? rawValue : draft.width
    const heightRaw = field === 'height' ? rawValue : draft.height
    let widthMm = Number(widthRaw)
    let heightMm = Number(heightRaw)
    let widthMessage = ''
    let heightMessage = ''

    if (current.mode === 'proportional') {
      const value = Number(rawValue)
      if (!rawValue.trim() || !Number.isFinite(value) || value <= 0) {
        if (field === 'width') widthMessage = '宽度必须是大于 0 的有效数字。'
        else heightMessage = '总高度必须是大于 0 的有效数字。'
      } else if (field === 'width') {
        widthMm = value
        heightMm = value * DEFAULT_HEIGHT_MM / DEFAULT_WIDTH_MM
        draft.height = formatMm(heightMm)
        heightInput.value = draft.height
      } else {
        heightMm = value
        widthMm = value * DEFAULT_WIDTH_MM / DEFAULT_HEIGHT_MM
        draft.width = formatMm(widthMm)
        widthInput.value = draft.width
      }
    } else {
      if (!widthRaw.trim() || !Number.isFinite(widthMm) || widthMm <= 0) widthMessage = '宽度必须是大于 0 的有效数字。'
      if (!heightRaw.trim() || !Number.isFinite(heightMm) || heightMm <= 0) heightMessage = '总高度必须是大于 0 的有效数字。'
    }

    if (widthMessage || heightMessage) {
      setFieldError(widthInput, widthError, widthMessage)
      setFieldError(heightInput, heightError, heightMessage)
      draftValid = false
      updateView()
      onChange({ valid: false, geometryChanged: false, becameValid: false, configurationChanged: false, config: currentConfig() })
      return
    }

    try {
      computeRetailGeometry(UPC_A, { widthMm, heightMm })
    } catch (error) {
      heightMessage = explainError(error)
      setFieldError(widthInput, widthError, '')
      setFieldError(heightInput, heightError, heightMessage)
      draftValid = false
      updateView()
      onChange({ valid: false, geometryChanged: false, becameValid: false, configurationChanged: false, config: currentConfig(), error: heightMessage })
      return
    }

    setFieldError(widthInput, widthError, '')
    setFieldError(heightInput, heightError, '')
    const previous = { ...current }
    current = { mode: current.mode, widthMm, heightMm }
    draftValid = true
    const geometryChanged = !sameDimensions(previous, current)
    updateView()
    if (geometryChanged || !previouslyValid) {
      onChange({ valid: true, geometryChanged, becameValid: !previouslyValid, configurationChanged: false, config: currentConfig() })
    }
  }

  /** @param {UpcaDimensions} config @param {string} presetId */
  function applyConfiguration(config, presetId) {
    try {
      computeRetailGeometry(UPC_A, { widthMm: config.widthMm, heightMm: config.heightMm })
    } catch (error) {
      showToast(`无法应用此尺寸预设：${explainError(error)}。已保留当前尺寸。`)
      return false
    }

    const wasValid = draftValid
    const previous = { ...current }
    const previousPresetId = selectedPresetId
    current = { mode: config.mode, widthMm: config.widthMm, heightMm: config.heightMm }
    selectedPresetId = presetId
    draft = { width: formatMm(current.widthMm), height: formatMm(current.heightMm) }
    draftValid = true
    setFieldError(widthInput, widthError, '')
    setFieldError(heightInput, heightError, '')
    setDraftFields()
    updateView()
    const geometryChanged = !sameDimensions(previous, current)
    const configurationChanged = previous.mode !== current.mode || previousPresetId !== selectedPresetId
    if (geometryChanged || !wasValid || configurationChanged) {
      onChange({ valid: true, geometryChanged, becameValid: !wasValid, configurationChanged, config: currentConfig() })
    }
    return true
  }

  function applyDefault() {
    applyConfiguration({ mode: 'proportional', widthMm: DEFAULT_WIDTH_MM, heightMm: DEFAULT_HEIGHT_MM }, DEFAULT_ID)
  }

  /** @param {string} message */
  function renderNameError(message) {
    presetNameInput.setAttribute('aria-invalid', String(Boolean(message)))
    presetNameError.textContent = message
    presetNameError.hidden = !message
  }

  /** @param {{ mode: 'save' | 'rename', presetId?: string }} intent */
  function openNameDialog(intent) {
    dialogIntent = intent
    presetDialogTitle.textContent = intent.mode === 'rename' ? '重命名预设' : '另存为预设'
    const existing = intent.presetId ? presets.find((preset) => preset.id === intent.presetId) : null
    presetNameInput.value = existing?.name || ''
    renderNameError('')
    if (!presetDialog.open) presetDialog.showModal()
    requestAnimationFrame(() => {
      if (!presetDialog.open) return
      presetNameInput.focus()
      presetNameInput.select()
    })
  }

  function newPresetId() {
    return `upca-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  function saveNameDialog() {
    if (!dialogIntent) return false
    const name = presetNameInput.value.trim()
    if (!name) {
      renderNameError('名称不能为空，请输入一个预设名称。')
      presetNameInput.focus()
      return false
    }
    if (name.toLocaleLowerCase() === '默认尺寸') {
      renderNameError('“默认尺寸”是内置预设名称，请换一个名称。')
      presetNameInput.focus()
      presetNameInput.select()
      return false
    }
    const duplicate = presets.some((preset) =>
      preset.id !== dialogIntent?.presetId && preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (duplicate) {
      renderNameError('这个名称已存在，请换一个名称。')
      presetNameInput.focus()
      presetNameInput.select()
      return false
    }

    if (dialogIntent.mode === 'rename') {
      const presetId = dialogIntent.presetId
      if (!presetId) return false
      const existing = presets.find((preset) => preset.id === presetId)
      if (!existing) return false
      const next = presets.map((preset) => preset.id === presetId ? { ...preset, name } : preset)
      if (!persistPresets(next)) return false
      selectedPresetId = presetId
      updateView()
      showToast('预设名称已更新')
    } else {
      if (!draftValid) {
        renderNameError('请先修正尺寸输入后再保存。')
        return false
      }
      const preset = {
        id: newPresetId(),
        name,
        mode: current.mode,
        widthMm: current.widthMm,
        heightMm: current.heightMm,
        version: STORAGE_VERSION
      }
      if (!persistPresets([...presets, preset])) return false
      applyConfiguration(preset, preset.id)
      showToast('尺寸预设已保存')
    }
    presetDialog.close()
    dialogIntent = null
    return true
  }

  function updateSelectedPreset() {
    const existing = selectedPreset()
    if (!existing || !draftValid || !isDirty()) return
    const updated = {
      ...existing,
      mode: current.mode,
      widthMm: current.widthMm,
      heightMm: current.heightMm
    }
    if (persistPresets(presets.map((preset) => preset.id === existing.id ? updated : preset))) {
      showToast('预设已更新')
    }
  }

  function deleteSelectedPreset() {
    const existing = selectedPreset()
    if (!existing) return
    if (!window.confirm(`删除预设“${existing.name}”？此操作无法撤销。`)) return
    if (!persistPresets(presets.filter((preset) => preset.id !== existing.id))) return
    applyDefault()
    showToast('预设已删除，尺寸已恢复默认')
  }

  /** @param {boolean} nextVisible */
  function setVisible(nextVisible) {
    visible = nextVisible
    if (!visible) {
      if (isPopoverOpen(presetMenu)) closePopover(presetMenu)
      if (isPopoverOpen(presetActionsMenu)) closePopover(presetActionsMenu)
    }
    updateView()
  }

  /** @param {HTMLElement} menu @param {string} selectedSelector */
  function openMenu(menu, selectedSelector) {
    if (isPopoverOpen(menu)) {
      closePopover(menu)
      return
    }
    openPopover(menu)
    requestAnimationFrame(() => {
      const selected = menu.querySelector(`${selectedSelector}[aria-selected="true"]`)
      const first = menu.querySelector(`${selectedSelector}:not(:disabled)`)
      const target = selected instanceof HTMLButtonElement ? selected : first
      if (target instanceof HTMLButtonElement && !target.disabled) target.focus({ preventScroll: true })
    })
  }

  /** @param {HTMLElement} menu @param {string} selector @param {number} direction @param {HTMLButtonElement | null} currentElement */
  function moveMenuFocus(menu, selector, direction, currentElement) {
    const items = /** @type {HTMLButtonElement[]} */ ([...menu.querySelectorAll(selector)]
      .filter((item) => item instanceof HTMLButtonElement && !item.disabled))
    if (!items.length) return
    const currentIndex = currentElement ? items.indexOf(currentElement) : -1
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + items.length) % items.length
    items[nextIndex]?.focus({ preventScroll: true })
  }

  readPresets()
  renderPresetItems()
  updateView()
  registerPopover(presetMenu, presetTrigger, { align: 'left' })
  registerPopover(presetActionsMenu, presetActionsTrigger, { align: 'right' })

  presetTrigger.addEventListener('click', (event) => {
    event.stopPropagation()
    openMenu(presetMenu, '[role="option"]')
  })
  presetTrigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!isPopoverOpen(presetMenu)) openPopover(presetMenu)
    requestAnimationFrame(() => {
      const selected = presetMenu.querySelector('[role="option"][aria-selected="true"]')
      const first = presetMenu.querySelector('[role="option"]')
      const target = selected instanceof HTMLButtonElement ? selected : first
      if (target instanceof HTMLButtonElement) target.focus({ preventScroll: true })
    })
  })
  presetMenu.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const item = event.target.closest('button[data-upca-preset-id]')
    if (!(item instanceof HTMLButtonElement)) return
    const id = item.dataset.upcaPresetId
    if (id === DEFAULT_ID) applyDefault()
    else {
      const preset = presets.find((entry) => entry.id === id)
      if (preset) applyConfiguration(preset, preset.id)
    }
    closePopover(presetMenu)
    presetTrigger.focus({ preventScroll: true })
  })
  presetMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      closePopover(presetMenu)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveMenuFocus(presetMenu, '[role="option"]', event.key === 'ArrowDown' ? 1 : -1,
        event.target instanceof HTMLButtonElement ? event.target : null)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const items = [...presetMenu.querySelectorAll('[role="option"]')]
      const target = event.key === 'Home' ? items[0] : items.at(-1)
      if (target instanceof HTMLButtonElement) target.focus({ preventScroll: true })
    }
  })

  presetActionsTrigger.addEventListener('click', (event) => {
    event.stopPropagation()
    openMenu(presetActionsMenu, '[role="menuitem"]')
  })
  presetActionsTrigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!isPopoverOpen(presetActionsMenu)) openPopover(presetActionsMenu)
    requestAnimationFrame(() => {
      const first = presetActionsMenu.querySelector('[role="menuitem"]:not(:disabled)')
      if (first instanceof HTMLButtonElement) first.focus({ preventScroll: true })
    })
  })
  presetActionsMenu.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const item = event.target.closest('button[data-upca-preset-action]')
    if (!(item instanceof HTMLButtonElement) || item.disabled) return
    closePopover(presetActionsMenu)
    presetActionsTrigger.focus({ preventScroll: true })
    if (item.dataset.upcaPresetAction === 'rename') openNameDialog({ mode: 'rename', presetId: selectedPresetId })
    if (item.dataset.upcaPresetAction === 'delete') deleteSelectedPreset()
  })
  presetActionsMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      closePopover(presetActionsMenu)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveMenuFocus(presetActionsMenu, '[role="menuitem"]', event.key === 'ArrowDown' ? 1 : -1,
        event.target instanceof HTMLButtonElement ? event.target : null)
    }
  })

  resetButton.addEventListener('click', applyDefault)
  saveAsButton.addEventListener('click', () => {
    if (draftValid) openNameDialog({ mode: 'save' })
  })
  updateButton.addEventListener('click', updateSelectedPreset)
  cancelButton.addEventListener('click', () => presetDialog.close('cancel'))
  presetForm.addEventListener('submit', (event) => {
    event.preventDefault()
    saveNameDialog()
  })
  presetNameInput.addEventListener('input', () => renderNameError(''))
  presetDialog.addEventListener('close', () => { dialogIntent = null })

  widthInput.addEventListener('input', () => updateDraft('width', widthInput.value))
  heightInput.addEventListener('input', () => updateDraft('height', heightInput.value))
  widthInput.addEventListener('blur', () => {
    if (!draftValid) return
    draft.width = formatMm(current.widthMm)
    widthInput.value = draft.width
  })
  heightInput.addEventListener('blur', () => {
    if (!draftValid) return
    draft.height = formatMm(current.heightMm)
    heightInput.value = draft.height
  })

  card.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const stepButton = event.target.closest('button[data-upca-step]')
    if (!(stepButton instanceof HTMLButtonElement)) return
    const field = stepButton.dataset.upcaStep
    if (field !== 'width' && field !== 'height') return
    const direction = Number(stepButton.dataset.direction) || 1
    const input = field === 'width' ? widthInput : heightInput
    const currentValue = Number(input.value)
    const base = Number.isFinite(currentValue) && currentValue > 0
      ? currentValue
      : field === 'width' ? current.widthMm : current.heightMm
    input.value = (base + direction * 0.01).toFixed(2)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  for (const button of quickButtons) {
    if (!(button instanceof HTMLButtonElement)) continue
    button.addEventListener('click', () => {
      const scale = Number(button.dataset.upcaScale)
      if (!draftValid || !Number.isFinite(scale) || scale <= 0) return
      applyConfiguration({
        mode: 'proportional',
        widthMm: DEFAULT_WIDTH_MM * scale,
        heightMm: DEFAULT_HEIGHT_MM * scale
      }, selectedPresetId)
    })
  }

  for (const button of modeButtons) {
    if (!(button instanceof HTMLButtonElement)) continue
    button.addEventListener('click', () => {
      const mode = button.dataset.upcaMode
      if (!draftValid || (mode !== 'proportional' && mode !== 'independent')) return
      const heightMm = mode === 'proportional'
        ? current.widthMm * DEFAULT_HEIGHT_MM / DEFAULT_WIDTH_MM
        : current.heightMm
      applyConfiguration({ mode, widthMm: current.widthMm, heightMm }, selectedPresetId)
    })
  }

  /** @param {string} typeName */
  function setVisibleForType(typeName) {
    setVisible(typeName === UPC_A)
  }

  return {
    setVisibleForType,
    isValid: () => draftValid,
    getCurrent: currentConfig,
    getRenderOptions: () => isDefaultGeometry() ? null : { widthMm: current.widthMm, heightMm: current.heightMm },
    getStatusName: selectedName
  }
}
