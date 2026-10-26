// @ts-check
// 视频转二维码（视频模块的二级工具）。
//
// 只把视频链接编码成二维码：编码在本页完成，不联网、不访问链接；
// 保存走条码已有的 barcode:save-file（主进程弹对话框、写文件）。
// 输入时实时预览；点「生成二维码」后才锁定导出内容，之后改了链接要「重新生成」。

import { cleanIpcError } from '../comErrors.js'
import {
  QR_DENSE_VERSION,
  QR_ECC_LEVELS,
  QR_MIN_CONTRAST,
  contrastRatio,
  describeVideoLink,
  encodeQr,
  normalizeHexColor,
  normalizeVideoLink,
  qrFileBaseName,
  qrPixelLayout,
  qrSvg
} from '../qrLink.js'

/** @typedef {import('../qrLink.js').QrEcc} QrEcc */
/** @typedef {import('../qrLink.js').QrMatrix} QrMatrix */
/** @typedef {'black' | 'accent' | 'custom'} ColorMode */

const STYLE_KEY = 'video-qr-style'
const ACCENT_FALLBACK = '#6978E6'
const PNG_SIZES = [512, 1024, 2048]
const PNG_DPI = 300
const SVG_SIZE_RANGE = /** @type {const} */ ([10, 500])
const PREVIEW_DELAY_MS = 150

/**
 * @template {Element} T
 * @param {string} selector
 * @returns {T}
 */
function $(selector) {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`缺少元素：${selector}`)
  return /** @type {T} */ (element)
}

function loadStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || '{}')
    return {
      colorMode: /** @type {ColorMode} */ (['black', 'accent', 'custom'].includes(saved.colorMode) ? saved.colorMode : 'black'),
      customColor: normalizeHexColor(saved.customColor) || '#000000',
      ecc: /** @type {QrEcc} */ (QR_ECC_LEVELS.includes(saved.ecc) ? saved.ecc : 'M'),
      pngSize: PNG_SIZES.includes(saved.pngSize) ? saved.pngSize : 1024,
      svgSizeMm: clampSvgSize(saved.svgSizeMm) ?? 50
    }
  } catch {
    return { colorMode: /** @type {ColorMode} */ ('black'), customColor: '#000000', ecc: /** @type {QrEcc} */ ('M'), pngSize: 1024, svgSizeMm: 50 }
  }
}

/** @param {unknown} value */
function clampSvgSize(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.min(SVG_SIZE_RANGE[1], Math.max(SVG_SIZE_RANGE[0], Math.round(number)))
}

/** 用户在设置里改过强调色就用它，否则用默认强调色；不读深色主题下提亮的那一档 */
function accentHex() {
  try {
    return normalizeHexColor(localStorage.getItem('accent')) || ACCENT_FALLBACK
  } catch {
    return ACCENT_FALLBACK
  }
}

/**
 * 从码点矩阵直接画 PNG：每个码点占整数像素，边缘不会因缩放发虚。
 * @param {QrMatrix} matrix
 * @param {string} color
 * @param {number} targetPx
 * @returns {Promise<Uint8Array>}
 */
function qrPngBytes(matrix, color, targetPx) {
  const { scale, pixels } = qrPixelLayout(matrix, targetPx)
  const canvas = document.createElement('canvas')
  canvas.width = pixels
  canvas.height = pixels
  const context = canvas.getContext('2d')
  if (!context) return Promise.reject(new Error('无法创建画布'))
  context.fillStyle = '#FFFFFF'
  context.fillRect(0, 0, pixels, pixels)
  context.fillStyle = color
  const { size, dark } = matrix
  const offset = (pixels - size * scale) / 2
  for (let row = 0; row < size; row += 1) {
    let col = 0
    while (col < size) {
      if (!dark[row * size + col]) {
        col += 1
        continue
      }
      const start = col
      while (col < size && dark[row * size + col]) col += 1
      context.fillRect(offset + start * scale, offset + row * scale, (col - start) * scale, scale)
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('PNG 编码失败'))
        return
      }
      resolve(new Uint8Array(await blob.arrayBuffer()))
    }, 'image/png')
  })
}

/**
 * @param {object} deps
 * @param {(message: string) => void} deps.showToast
 * @returns {{ show: () => void, hide: () => void }}
 */
export function initVideoQr({ showToast }) {
  const page = $('#page-video')
  const root = /** @type {HTMLElement} */ ($('#video-qr'))
  const urlInput = /** @type {HTMLInputElement} */ ($('#video-qr-url'))
  const message = $('#video-qr-message')
  const info = /** @type {HTMLElement} */ ($('#video-qr-info'))
  const infoEmpty = /** @type {HTMLElement} */ ($('#video-qr-info-empty'))
  const preview = /** @type {HTMLElement} */ ($('#video-qr-preview'))
  const previewEmpty = /** @type {HTMLElement} */ ($('#video-qr-empty'))
  const spec = $('#video-qr-spec')
  const colorModeGroup = $('#video-qr-color-mode')
  const colorInput = /** @type {HTMLInputElement} */ ($('#video-qr-color'))
  const eccSelect = /** @type {HTMLSelectElement} */ ($('#video-qr-ecc'))
  const pngSizeSelect = /** @type {HTMLSelectElement} */ ($('#video-qr-png-size'))
  const svgSizeInput = /** @type {HTMLInputElement} */ ($('#video-qr-svg-size'))
  const generateButton = /** @type {HTMLButtonElement} */ ($('#video-qr-generate'))
  const savePngButton = /** @type {HTMLButtonElement} */ ($('#video-qr-save-png'))
  const saveSvgButton = /** @type {HTMLButtonElement} */ ($('#video-qr-save-svg'))
  const copyLinkButton = /** @type {HTMLButtonElement} */ ($('#video-qr-copy-link'))

  const style = loadStyle()
  /** 输入框当前内容的规范化结果 */
  let current = /** @type {ReturnType<typeof normalizeVideoLink> | null} */ (null)
  /** 点过「生成」后锁定的链接；导出只认它 */
  let generatedUrl = ''
  let busyCount = 0
  let previewTimer = 0

  eccSelect.value = style.ecc
  pngSizeSelect.value = String(style.pngSize)
  svgSizeInput.value = String(style.svgSizeMm)
  colorInput.value = style.customColor
  syncColorMode()

  function saveStyle() {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(style))
    } catch {
      // 存不下只影响下次打开的默认值
    }
  }

  function qrColor() {
    if (style.colorMode === 'accent') return accentHex()
    if (style.colorMode === 'custom') return style.customColor
    return '#000000'
  }

  function syncColorMode() {
    colorModeGroup.querySelectorAll('[data-color-mode]').forEach((button) => {
      button.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (button).dataset.colorMode === style.colorMode))
    })
    colorInput.hidden = style.colorMode !== 'custom'
  }

  /**
   * @param {string} text
   * @param {'' | 'error' | 'warning'} [tone]
   */
  function setMessage(text, tone = '') {
    message.textContent = text
    message.className = `video-qr-message${tone ? ` ${tone}` : ''}`
  }

  function isGenerated() {
    return Boolean(generatedUrl) && current?.ok === true && current.url === generatedUrl
  }

  function setExportEnabled() {
    const ready = isGenerated() && busyCount === 0
    savePngButton.disabled = !ready
    saveSvgButton.disabled = !ready
    copyLinkButton.disabled = !ready
    generateButton.disabled = current?.ok !== true || busyCount > 0
    generateButton.textContent = generatedUrl ? '重新生成' : '生成二维码'
  }

  /** @param {string} href */
  function renderInfo(href) {
    const details = describeVideoLink(href)
    info.querySelectorAll('[data-info]').forEach((cell) => {
      const key = /** @type {keyof typeof details} */ (/** @type {HTMLElement} */ (cell).dataset.info)
      cell.textContent = details[key]
      cell.setAttribute('title', details[key])
    })
    info.hidden = false
    infoEmpty.hidden = true
  }

  function clearPreview() {
    preview.replaceChildren()
    preview.hidden = true
    previewEmpty.hidden = false
    spec.textContent = ''
    info.hidden = true
    infoEmpty.hidden = false
  }

  /** 校验 → 预览 → 提示。提示按严重程度只留一条。 */
  function refresh() {
    window.clearTimeout(previewTimer)
    const raw = urlInput.value
    current = raw.trim() ? normalizeVideoLink(raw) : null
    urlInput.setAttribute('aria-invalid', String(current?.ok === false))

    if (!current) {
      clearPreview()
      setMessage('粘贴视频的分享链接，或视频文件的直链。')
      setExportEnabled()
      return
    }
    if (!current.ok) {
      clearPreview()
      setMessage(current.error, 'error')
      setExportEnabled()
      return
    }

    renderInfo(current.url)
    const encoded = encodeQr(current.url, style.ecc)
    if (!encoded.ok) {
      preview.replaceChildren()
      preview.hidden = true
      previewEmpty.hidden = false
      spec.textContent = ''
      setMessage(encoded.error, 'error')
      setExportEnabled()
      return
    }

    const { matrix } = encoded
    const color = qrColor()
    preview.innerHTML = qrSvg(matrix, { color, sizeMm: style.svgSizeMm }).replace(/^<\?xml[^>]*>/, '')
    preview.hidden = false
    previewEmpty.hidden = true
    preview.classList.toggle('is-draft', !isGenerated())
    const moduleMm = style.svgSizeMm / (matrix.size + 8)
    spec.textContent = `版本 ${matrix.version} · ${matrix.size}×${matrix.size} 码点 · SVG 每码点 ${moduleMm.toFixed(2)} mm`

    const contrast = contrastRatio(color, '#FFFFFF')
    if (generatedUrl && !isGenerated()) {
      setMessage('链接已修改，点「重新生成」后再导出。', 'warning')
    } else if (contrast < QR_MIN_CONTRAST) {
      setMessage(`颜色太浅（和白底对比度 ${contrast.toFixed(1)}:1），手机可能扫不出，建议换深一点的颜色。`, 'warning')
    } else if (matrix.version > QR_DENSE_VERSION) {
      setMessage('链接较长，码点很密，印得小可能扫不出，建议换短链接。', 'warning')
    } else if (moduleMm < 0.33) {
      setMessage('SVG 尺寸偏小，每个码点不到 0.33 mm，印刷后可能扫不出。', 'warning')
    } else if (current.insecure) {
      setMessage('这是 http 链接，部分手机会提示不安全，有 https 版本建议换成 https。', 'warning')
    } else if (current.addedScheme) {
      setMessage('已自动补上 https://。')
    } else {
      setMessage(isGenerated() ? '二维码已生成，可以保存或复制链接。' : '预览中，点「生成二维码」确认后即可导出。')
    }
    setExportEnabled()
  }

  function schedulePreview() {
    window.clearTimeout(previewTimer)
    previewTimer = window.setTimeout(refresh, PREVIEW_DELAY_MS)
  }

  /** 导出用的码：只认已生成的链接 */
  function generatedMatrix() {
    if (!isGenerated()) throw new Error('链接已修改，请先重新生成')
    const encoded = encodeQr(generatedUrl, style.ecc)
    if (!encoded.ok) throw new Error(encoded.error)
    return encoded.matrix
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {string} pendingLabel
   * @param {() => Promise<void>} task
   */
  async function runAction(button, pendingLabel, task) {
    const label = button.innerHTML
    busyCount += 1
    button.textContent = pendingLabel
    setExportEnabled()
    try {
      await task()
    } finally {
      busyCount -= 1
      button.innerHTML = label
      setExportEnabled()
    }
  }

  /** @param {'png' | 'svg'} type */
  async function save(type) {
    const button = type === 'png' ? savePngButton : saveSvgButton
    await runAction(button, '正在保存…', async () => {
      try {
        const matrix = generatedMatrix()
        const color = qrColor()
        const data = type === 'svg'
          ? qrSvg(matrix, { color, sizeMm: style.svgSizeMm })
          : await qrPngBytes(matrix, color, style.pngSize)
        const result = await window.api.saveBarcodeFile({
          type,
          name: qrFileBaseName(generatedUrl),
          data,
          density: type === 'png' ? PNG_DPI : undefined,
          label: 'qr'
        })
        if (result?.status === 'saved') {
          setMessage(`${type.toUpperCase()} 已保存。`)
          showToast(`二维码 ${type.toUpperCase()} 已保存`)
        } else {
          setMessage('已取消保存。')
        }
      } catch (error) {
        const reason = cleanIpcError(error instanceof Error ? error.message : String(error))
        setMessage(`保存失败：${reason}`, 'error')
        showToast('二维码保存失败，请检查目标位置是否可写')
      }
    })
  }

  async function copyLink() {
    await runAction(copyLinkButton, '复制中…', async () => {
      try {
        await navigator.clipboard.writeText(generatedUrl)
        setMessage('视频链接已复制。')
        showToast('视频链接已复制')
      } catch (error) {
        const reason = cleanIpcError(error instanceof Error ? error.message : String(error))
        setMessage(`复制失败：${reason}`, 'error')
      }
    })
  }

  urlInput.addEventListener('input', schedulePreview)
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      refresh()
      if (!generateButton.disabled) generateButton.click()
    }
  })

  generateButton.addEventListener('click', () => {
    refresh()
    if (current?.ok !== true || !encodeQr(current.url, style.ecc).ok) return
    generatedUrl = current.url
    // 规范化后的链接回填到输入框，用户能看到码里到底存了什么
    if (urlInput.value !== generatedUrl) urlInput.value = generatedUrl
    refresh()
    showToast('二维码已生成')
  })

  colorModeGroup.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-color-mode]'))
    if (!button) return
    style.colorMode = /** @type {ColorMode} */ (button.dataset.colorMode)
    syncColorMode()
    saveStyle()
    refresh()
    if (style.colorMode === 'custom') colorInput.click()
  })

  colorInput.addEventListener('input', () => {
    style.customColor = normalizeHexColor(colorInput.value) || '#000000'
    saveStyle()
    refresh()
  })

  eccSelect.addEventListener('change', () => {
    style.ecc = /** @type {QrEcc} */ (QR_ECC_LEVELS.includes(/** @type {QrEcc} */ (eccSelect.value)) ? eccSelect.value : 'M')
    saveStyle()
    refresh()
  })

  pngSizeSelect.addEventListener('change', () => {
    const size = Number(pngSizeSelect.value)
    style.pngSize = PNG_SIZES.includes(size) ? size : 1024
    saveStyle()
  })

  svgSizeInput.addEventListener('change', () => {
    const size = clampSvgSize(svgSizeInput.value)
    style.svgSizeMm = size ?? style.svgSizeMm
    svgSizeInput.value = String(style.svgSizeMm)
    saveStyle()
    refresh()
  })

  savePngButton.addEventListener('click', () => void save('png'))
  saveSvgButton.addEventListener('click', () => void save('svg'))
  copyLinkButton.addEventListener('click', () => void copyLink())

  refresh()

  return {
    show() {
      page.classList.add('is-qr')
      root.hidden = false
      // 强调色可能在设置里改过
      refresh()
    },
    hide() {
      page.classList.remove('is-qr')
      root.hidden = true
    }
  }
}
