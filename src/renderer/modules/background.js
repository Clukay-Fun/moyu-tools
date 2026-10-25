/**
 * 设置 › 外观 › 背景与毛玻璃。
 *
 * 只写几个 CSS 变量和 body[data-bg]，真正的配色在 CSS 里：
 *   body[data-bg]  classic（旧版光斑 + 白纱，默认）/ plain / gradient / solid / image
 *   --app-bg-start / --app-bg-end / --app-bg-angle  自定义颜色与渐变方向（深色主题下由 CSS 混进深色底）
 *   --app-bg-image / --bg-image-size / --bg-image-dim / --bg-image-blur  自定义背景图片层（只作用在 .bg-image）
 *   --glass-opacity / --glass-blur-px  工作区、导航条、内容框共用的毛玻璃参数，和图片模糊互不影响
 * 调整即生效，存在 localStorage；下次启动在首帧前恢复。切换样式时各样式的参数都保留。
 *
 * 背景图片由主进程重新编码后存到 userData/profile/background.webp，经 moyu-file://brand/ 读取；
 * 选了图片样式但图片不存在或读不出来时，界面按默认渐变显示（存档里的样式不改，修好图片即恢复）。
 *
 * @param {object} deps
 * @param {() => void} deps.onChange 背景变化后回调（同步 Windows 标题栏按钮底色）
 * @param {(message: string) => void} deps.notify 提示条
 * @param {(error: unknown) => string} deps.errorText IPC 错误转成人话
 */
const STORAGE_KEY = 'appearance-bg'
const HEX = /^#[0-9a-f]{6}$/i
const MODES = ['classic', 'plain', 'gradient', 'solid', 'image']
const IMAGE_FITS = { cover: 'cover', contain: 'contain', center: 'auto' }
// 只认主进程给的固定地址，不让存档里塞进任意 URL
const IMAGE_URL = /^moyu-file:\/\/brand\/background\.webp\?v=\d+$/
// 存档格式版本：V3 的存档没有这个字段，透明度和模糊的含义也不同
const VERSION = 4

// 自定义渐变的预设：左上偏紫、右下偏青
export const BACKGROUND_DEFAULTS = Object.freeze({
  mode: 'classic',
  c1: '#DCCAFF',
  c2: '#C8F0E8',
  angle: 135,
  alpha: 30,
  blur: 26,
  fit: 'cover',
  dim: 20,
  imageBlur: 0
})

const DARK_BASE = '#0b1018'
// 旧版白纱叠在底色上、窗口右上角（光斑照不到）的颜色
const CLASSIC_TITLE_BAR = { light: '#EEEFF3', dark: '#0C121B' }
// 与 CSS 里深色主题的 color-mix 比例一致：自定义颜色只混入 22%
const DARK_MIX = 0.22

function clamp(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function normalize(raw = {}) {
  return {
    mode: MODES.includes(raw.mode) ? raw.mode : BACKGROUND_DEFAULTS.mode,
    c1: HEX.test(raw.c1) ? raw.c1.toUpperCase() : BACKGROUND_DEFAULTS.c1,
    c2: HEX.test(raw.c2) ? raw.c2.toUpperCase() : BACKGROUND_DEFAULTS.c2,
    angle: Math.round(clamp(raw.angle, 0, 360, BACKGROUND_DEFAULTS.angle)),
    alpha: Math.round(clamp(raw.alpha, 20, 100, BACKGROUND_DEFAULTS.alpha)),
    blur: Math.round(clamp(raw.blur, 0, 30, BACKGROUND_DEFAULTS.blur)),
    fit: Object.hasOwn(IMAGE_FITS, raw.fit) ? raw.fit : BACKGROUND_DEFAULTS.fit,
    dim: Math.round(clamp(raw.dim, 0, 80, BACKGROUND_DEFAULTS.dim)),
    imageBlur: Math.round(clamp(raw.imageBlur, 0, 40, BACKGROUND_DEFAULTS.imageBlur)),
    // 不是偏好，是「上次见到的图片地址」：让首帧就能铺上图，启动后再向主进程核对
    imageUrl: IMAGE_URL.test(raw.imageUrl) ? raw.imageUrl : ''
  }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (raw.version === VERSION) return normalize(raw)
    // V3 存档：只保留用户明确选的自定义渐变 / 纯色和颜色，其余（含当时的「默认浅灰」）按首次使用处理
    if (raw.mode === 'gradient' || raw.mode === 'solid') {
      return normalize({ mode: raw.mode, c1: raw.c1, c2: raw.c2, angle: raw.angle })
    }
    return normalize()
  } catch {
    return normalize()
  }
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

function mix(a, b, weightOfA) {
  return a.map((channel, index) => channel * weightOfA + b[index] * (1 - weightOfA))
}

export function initBackgroundSettings({ onChange = () => {}, notify = () => {}, errorText = String } = {}) {
  let settings = load()
  // 当前图片地址是否读得出来；未核对前先乐观当作可用
  let imageBroken = false

  const root = document.documentElement
  const modeInputs = [...document.querySelectorAll('input[name="bg-mode"]')]
  const color1 = document.querySelector('#bg-color1')
  const color1Hex = document.querySelector('#bg-color1-hex')
  const color2 = document.querySelector('#bg-color2')
  const color2Hex = document.querySelector('#bg-color2-hex')
  const color2Field = document.querySelector('#bg-color2-field')
  const angleField = document.querySelector('#bg-angle-field')
  const angle = document.querySelector('#bg-angle')
  const angleValue = document.querySelector('#bg-angle-value')
  const alpha = document.querySelector('#bg-alpha')
  const alphaValue = document.querySelector('#bg-alpha-value')
  const blur = document.querySelector('#bg-blur')
  const blurValue = document.querySelector('#bg-blur-value')
  const colorFields = document.querySelector('#bg-colors')
  const imageFields = document.querySelector('#bg-image-fields')
  const imagePreview = document.querySelector('#bg-image-preview')
  const imageStatus = document.querySelector('#bg-image-status')
  const imageChoose = document.querySelector('#bg-image-choose')
  const imageClear = document.querySelector('#bg-image-clear')
  const fitInputs = [...document.querySelectorAll('input[name="bg-image-fit"]')]
  const dim = document.querySelector('#bg-image-dim')
  const dimValue = document.querySelector('#bg-image-dim-value')
  const imageBlur = document.querySelector('#bg-image-blur')
  const imageBlurValue = document.querySelector('#bg-image-blur-value')

  const imageUsable = () => Boolean(settings.imageUrl) && !imageBroken
  // 图片样式但没有可用图片：按默认渐变显示
  const effectiveMode = () => (settings.mode === 'image' && !imageUsable() ? BACKGROUND_DEFAULTS.mode : settings.mode)

  // 换了地址就重新核对一次能不能读出来；失败回退默认渐变
  let probing = ''
  function probeImage() {
    const url = settings.imageUrl
    if (!url || probing === url) return
    probing = url
    imageBroken = false
    const image = new Image()
    image.onload = () => { if (settings.imageUrl === url) { apply(); render() } }
    image.onerror = () => {
      if (settings.imageUrl !== url) return
      imageBroken = true
      apply()
      render()
    }
    image.src = url
  }

  function apply() {
    document.body.dataset.bg = effectiveMode()
    root.style.setProperty('--app-bg-image', imageUsable() ? `url("${settings.imageUrl}")` : 'none')
    root.style.setProperty('--bg-image-size', IMAGE_FITS[settings.fit])
    root.style.setProperty('--bg-image-dim', String(settings.dim / 100))
    root.style.setProperty('--bg-image-blur', `${settings.imageBlur}px`)
    root.style.setProperty('--app-bg-start', settings.c1)
    root.style.setProperty('--app-bg-end', settings.c2)
    root.style.setProperty('--app-bg-angle', `${settings.angle}deg`)
    root.style.setProperty('--glass-opacity', String(settings.alpha / 100))
    root.style.setProperty('--glass-blur-px', `${settings.blur}px`)
    onChange()
  }

  function render() {
    modeInputs.forEach((input) => { input.checked = input.value === settings.mode })
    color1.value = settings.c1.toLowerCase()
    color1Hex.value = settings.c1
    color2.value = settings.c2.toLowerCase()
    color2Hex.value = settings.c2
    angle.value = settings.angle
    angleValue.textContent = `${settings.angle}°`
    alpha.value = settings.alpha
    alphaValue.textContent = `${settings.alpha}%`
    blur.value = settings.blur
    blurValue.textContent = `${settings.blur}px`
    fitInputs.forEach((input) => { input.checked = input.value === settings.fit })
    dim.value = settings.dim
    dimValue.textContent = `${settings.dim}%`
    imageBlur.value = settings.imageBlur
    imageBlurValue.textContent = `${settings.imageBlur}px`
    const isImage = settings.mode === 'image'
    imageFields.hidden = !isImage
    imagePreview.style.backgroundImage = imageUsable() ? `url("${settings.imageUrl}")` : ''
    imagePreview.classList.toggle('has-image', imageUsable())
    imageChoose.textContent = settings.imageUrl ? '更换图片' : '上传图片'
    imageClear.disabled = !settings.imageUrl
    imageStatus.textContent = !settings.imageUrl
      ? '还没有图片：支持 PNG / JPG / WebP，最大 20 MB'
      : imageBroken
        ? '图片读取失败，已按默认渐变显示；可重新上传'
        : 'PNG / JPG / WebP，最大 20 MB；保存在应用数据目录'
    imageStatus.toggleAttribute('data-error', imageBroken)
    // 旧版和浅灰背景不用自定义颜色；纯色不需要第二个颜色和方向
    const custom = settings.mode === 'gradient' || settings.mode === 'solid'
    colorFields.toggleAttribute('data-disabled', !custom)
    for (const input of [color1, color1Hex, color2, color2Hex]) input.disabled = !custom
    color2Field.hidden = settings.mode === 'solid'
    angleField.hidden = settings.mode !== 'gradient'
  }

  function update(patch) {
    settings = normalize({ ...settings, ...patch })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, version: VERSION }))
    } catch {
      // 存不下也不影响当前窗口里的效果
    }
    apply()
    render()
  }

  modeInputs.forEach((input) => {
    input.addEventListener('change', () => input.checked && update({ mode: input.value }))
  })
  color1.addEventListener('input', () => update({ c1: color1.value }))
  color2.addEventListener('input', () => update({ c2: color2.value }))
  for (const [input, key] of [[color1Hex, 'c1'], [color2Hex, 'c2']]) {
    input.addEventListener('change', () => {
      const value = input.value.trim().replace(/^(?!#)/, '#')
      if (HEX.test(value)) update({ [key]: value })
      else render() // 输错了就退回当前值，不留半截颜色
    })
  }
  angle.addEventListener('input', () => update({ angle: angle.value }))
  alpha.addEventListener('input', () => update({ alpha: alpha.value }))
  blur.addEventListener('input', () => update({ blur: blur.value }))
  fitInputs.forEach((input) => {
    input.addEventListener('change', () => input.checked && update({ fit: input.value }))
  })
  dim.addEventListener('input', () => update({ dim: dim.value }))
  imageBlur.addEventListener('input', () => update({ imageBlur: imageBlur.value }))
  // 恢复默认只换回旧版渐变和默认参数；已上传的图片留着，随时能切回图片样式
  document.querySelector('#bg-reset')?.addEventListener('click', () => update({ ...BACKGROUND_DEFAULTS }))

  imageChoose.addEventListener('click', async () => {
    try {
      const result = await window.api.profile.chooseBackground()
      if (result?.status !== 'ok') return
      update({ imageUrl: result.url, mode: 'image' })
      probeImage()
      notify('背景图片已更新')
    } catch (error) {
      notify(`上传背景图片失败：${errorText(error?.message ?? error)}`)
    }
  })

  imageClear.addEventListener('click', async () => {
    try {
      await window.api.profile.clearBackground()
      // 图片没了就不再停在图片样式上
      update({ imageUrl: '', mode: settings.mode === 'image' ? BACKGROUND_DEFAULTS.mode : settings.mode })
      notify('背景图片已删除')
    } catch (error) {
      notify(`删除背景图片失败：${errorText(error?.message ?? error)}`)
    }
  })

  apply()
  render()
  probeImage()

  return {
    /**
     * Windows 系统窗口按钮只能取一个底色：取背景在窗口右上角的颜色。
     * 浅灰背景返回 null，由主进程用主题自带的外层色。
     */
    /** 启动后从主进程读到的背景图片状态：以磁盘上的文件为准 */
    setImage(info) {
      const url = info?.status === 'ok' ? info.url : ''
      if (url === settings.imageUrl) return
      update({ imageUrl: url })
      probeImage()
    },

    titleBarColor(theme) {
      const mode = effectiveMode()
      if (mode === 'plain' || mode === 'image') return null
      const dark = theme === 'dark'
      if (mode === 'classic') return dark ? CLASSIC_TITLE_BAR.dark : CLASSIC_TITLE_BAR.light
      const tone = (hex) => {
        const rgb = hexToRgb(hex)
        return dark ? mix(rgb, hexToRgb(DARK_BASE), DARK_MIX) : rgb
      }
      if (mode === 'solid') return rgbToHex(tone(settings.c1))
      // CSS 渐变线过中心，0deg 指向上方；右上角在渐变线上的位置 t ∈ [0, 1]
      const radians = (settings.angle * Math.PI) / 180
      const width = window.innerWidth
      const height = window.innerHeight
      const length = Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))
      const dot = (width / 2) * Math.sin(radians) + (height / 2) * Math.cos(radians)
      const t = Math.min(1, Math.max(0, 0.5 + dot / length))
      return rgbToHex(mix(tone(settings.c2), tone(settings.c1), t))
    }
  }
}
