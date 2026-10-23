/**
 * 设置 › 外观 › 背景与毛玻璃。
 *
 * 只写几个 CSS 变量和 body[data-bg]，真正的配色在 CSS 里：
 *   --bg-c1 / --bg-c2 / --bg-angle  背景颜色与渐变方向（深色主题下由 CSS 混进深色底）
 *   --glass-alpha / --glass-blur-px  工作区、导航条、内容框共用的毛玻璃参数
 * 调整即生效，存在 localStorage；下次启动在首帧前恢复。
 *
 * @param {object} deps
 * @param {() => void} deps.onChange 背景变化后回调（同步 Windows 标题栏按钮底色）
 */
const STORAGE_KEY = 'appearance-bg'
const HEX = /^#[0-9a-f]{6}$/i

// 渐变模式的预设就是旧版紫蓝渐变：左上偏紫、右下偏青
export const BACKGROUND_DEFAULTS = Object.freeze({
  mode: 'default',
  c1: '#DCCAFF',
  c2: '#C8F0E8',
  angle: 135,
  alpha: 82,
  blur: 14
})

const DARK_BASE = '#0b1018'
// 与 CSS 里深色主题的 color-mix 比例一致：自定义颜色只混入 22%
const DARK_MIX = 0.22

function clamp(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function normalize(raw = {}) {
  return {
    mode: ['default', 'gradient', 'solid'].includes(raw.mode) ? raw.mode : BACKGROUND_DEFAULTS.mode,
    c1: HEX.test(raw.c1) ? raw.c1.toUpperCase() : BACKGROUND_DEFAULTS.c1,
    c2: HEX.test(raw.c2) ? raw.c2.toUpperCase() : BACKGROUND_DEFAULTS.c2,
    angle: Math.round(clamp(raw.angle, 0, 360, BACKGROUND_DEFAULTS.angle)),
    alpha: Math.round(clamp(raw.alpha, 50, 100, BACKGROUND_DEFAULTS.alpha)),
    blur: Math.round(clamp(raw.blur, 0, 30, BACKGROUND_DEFAULTS.blur))
  }
}

function load() {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
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

export function initBackgroundSettings({ onChange = () => {} } = {}) {
  let settings = load()

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

  function apply() {
    document.body.dataset.bg = settings.mode
    root.style.setProperty('--bg-c1', settings.c1)
    root.style.setProperty('--bg-c2', settings.c2)
    root.style.setProperty('--bg-angle', `${settings.angle}deg`)
    root.style.setProperty('--glass-alpha', String(settings.alpha / 100))
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
    // 默认背景不用自定义颜色；纯色不需要第二个颜色和方向
    const custom = settings.mode !== 'default'
    colorFields.toggleAttribute('data-disabled', !custom)
    for (const input of [color1, color1Hex, color2, color2Hex]) input.disabled = !custom
    color2Field.hidden = settings.mode === 'solid'
    angleField.hidden = settings.mode !== 'gradient'
  }

  function update(patch) {
    settings = normalize({ ...settings, ...patch })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
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
  document.querySelector('#bg-reset')?.addEventListener('click', () => update({ ...BACKGROUND_DEFAULTS }))

  apply()
  render()

  return {
    /**
     * Windows 系统窗口按钮只能取一个底色：取背景在窗口右上角的颜色。
     * 默认背景返回 null，由主进程用主题自带的外层色。
     */
    titleBarColor(theme) {
      if (settings.mode === 'default') return null
      const dark = theme === 'dark'
      const tone = (hex) => {
        const rgb = hexToRgb(hex)
        return dark ? mix(rgb, hexToRgb(DARK_BASE), DARK_MIX) : rgb
      }
      if (settings.mode === 'solid') return rgbToHex(tone(settings.c1))
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
