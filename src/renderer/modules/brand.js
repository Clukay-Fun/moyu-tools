/**
 * 设置 › 通用 › 应用品牌。
 *
 * 文字（应用名称、顶部标语、欢迎页标语）存在 localStorage，启动时同步恢复；
 * Logo 图片由主进程落盘到 userData/profile/logo.png，经 moyu-file://brand/ 读取，和个人头像各管各的。
 *   应用名称  窗口标题、「关于」里的名称；留空时用默认名
 *   顶部标语  顶栏计时器左边；留空则隐藏，计时器位置不变
 *   欢迎页标语 首页中间的大字；留空时整个标题元素从页面上拿掉，不留占位
 *
 * @param {object} deps
 * @param {string} deps.defaultLogoUrl 内置 Logo（自定义 Logo 读不到时回退）
 * @param {(message: string) => void} deps.notify 提示条
 * @param {(error: unknown) => string} deps.errorText IPC 错误转成人话
 */
const STORAGE_KEY = 'app-brand'
const LIMITS = { name: 24, topSlogan: 40, homeSlogan: 30 }

export const BRAND_DEFAULTS = Object.freeze({
  name: '摸鱼工具箱',
  topSlogan: '干活快一点，摸鱼久一点',
  homeSlogan: '干活快一点，摸鱼久一点',
  homeSloganFontSize: null
})

// 没存过的字段用默认值；存过空字符串的标语就是用户要的「不显示」
function normalize(raw = {}) {
  const text = (key) => (typeof raw[key] === 'string' ? raw[key].trim().slice(0, LIMITS[key]) : BRAND_DEFAULTS[key])
  const hasCustomHomeSloganFontSize = raw.homeSloganFontSize !== undefined && raw.homeSloganFontSize !== null && raw.homeSloganFontSize !== ''
  const savedFontSize = hasCustomHomeSloganFontSize
    ? Number(raw.homeSloganFontSize)
    : raw.homeSloganLarge === true ? 84 : null
  return {
    name: text('name') || BRAND_DEFAULTS.name,
    topSlogan: text('topSlogan'),
    homeSlogan: text('homeSlogan'),
    homeSloganFontSize: Number.isFinite(savedFontSize)
      ? Math.min(120, Math.max(36, Math.round(savedFontSize)))
      : null
  }
}

function load() {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'))
  } catch {
    return normalize()
  }
}

export function initBrandSettings({ defaultLogoUrl, notify = () => {}, errorText = String } = {}) {
  let settings = load()
  let version = ''
  let logoUrl = ''

  const nameInput = document.querySelector('#brand-name')
  const topInput = document.querySelector('#brand-top-slogan')
  const homeInput = document.querySelector('#brand-home-slogan')
  const homeSloganFontSizeInput = document.querySelector('#brand-home-slogan-size')
  const topSlogan = document.querySelector('.topbar .slogan')
  const homePage = document.querySelector('#page-home')
  const homeSlogan = document.querySelector('#home-slogan')

  function applyLogo() {
    document.querySelectorAll('[data-app-logo]').forEach((image) => {
      image.src = logoUrl || defaultLogoUrl
    })
    document.querySelector('#brand-clear-logo')?.toggleAttribute('disabled', !logoUrl)
  }

  function apply() {
    document.title = version ? `${settings.name} v${version}` : settings.name
    if (homePage) {
      if (settings.homeSloganFontSize === null) homePage.style.removeProperty('--home-slogan-custom-size')
      else homePage.style.setProperty('--home-slogan-custom-size', `${settings.homeSloganFontSize}px`)
    }
    document.querySelectorAll('[data-app-name]').forEach((node) => { node.textContent = settings.name })
    for (const node of [topSlogan, ...document.querySelectorAll('[data-app-tagline]')]) {
      if (!node) continue
      node.textContent = settings.topSlogan
      node.hidden = !settings.topSlogan
    }
    if (homePage && homeSlogan) {
      if (settings.homeSlogan) {
        homeSlogan.textContent = settings.homeSlogan
        homeSlogan.dataset.text = settings.homeSlogan
        if (!homeSlogan.isConnected) homePage.prepend(homeSlogan)
        homePage.removeAttribute('aria-label')
        homePage.setAttribute('aria-labelledby', 'home-slogan')
      } else {
        homeSlogan.remove()
        homePage.removeAttribute('aria-labelledby')
        homePage.setAttribute('aria-label', settings.name)
      }
    }
  }

  function render() {
    if (nameInput && document.activeElement !== nameInput) nameInput.value = settings.name
    if (topInput && document.activeElement !== topInput) topInput.value = settings.topSlogan
    if (homeInput && document.activeElement !== homeInput) homeInput.value = settings.homeSlogan
    if (homeSloganFontSizeInput) homeSloganFontSizeInput.value = settings.homeSloganFontSize ?? ''
  }

  function update(patch) {
    settings = normalize({ ...settings, ...patch })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // 存不下也不影响当前窗口里的效果
    }
    apply()
  }

  // 边输边生效；失焦时把裁掉的空格、超长部分写回输入框
  for (const [input, key] of [[nameInput, 'name'], [topInput, 'topSlogan'], [homeInput, 'homeSlogan']]) {
    if (!input) continue
    input.maxLength = LIMITS[key]
    input.placeholder = key === 'name' ? BRAND_DEFAULTS.name : '留空则不显示'
    input.addEventListener('input', () => update({ [key]: input.value }))
    input.addEventListener('change', render)
    input.addEventListener('blur', render)
  }

  function commitHomeSloganFontSize(rawValue) {
    if (rawValue === '') {
      update({ homeSloganFontSize: null })
    } else {
      const size = Number(rawValue)
      if (!Number.isFinite(size)) {
        render()
        return
      }
      update({ homeSloganFontSize: Math.min(120, Math.max(36, Math.round(size))) })
    }
    render()
  }

  function stepHomeSloganFontSize(delta) {
    const adaptiveSize = homeSlogan?.isConnected
      ? Number.parseFloat(getComputedStyle(homeSlogan).fontSize)
      : Math.min(76, Math.max(46, window.innerWidth * 0.046))
    const currentSize = settings.homeSloganFontSize ?? adaptiveSize
    const nextSize = Math.min(120, Math.max(36, Math.round(currentSize + delta)))
    update({ homeSloganFontSize: nextSize })
    render()
  }

  homeSloganFontSizeInput?.addEventListener('change', () => {
    commitHomeSloganFontSize(homeSloganFontSizeInput.value)
  })
  document.querySelector('#brand-home-slogan-size-dec')?.addEventListener('click', () => stepHomeSloganFontSize(-1))
  document.querySelector('#brand-home-slogan-size-inc')?.addEventListener('click', () => stepHomeSloganFontSize(1))

  document.querySelector('#brand-reset-text')?.addEventListener('click', () => {
    update({ ...BRAND_DEFAULTS, homeSloganFontSize: settings.homeSloganFontSize })
    render()
    notify('应用名称和标语已恢复默认')
  })

  // 自定义 Logo 被外部删掉或损坏时退回内置 Logo
  document.querySelectorAll('[data-app-logo]').forEach((image) => {
    image.addEventListener('error', () => {
      if (!logoUrl || image.src === defaultLogoUrl) return
      logoUrl = ''
      applyLogo()
    })
  })

  document.querySelector('#brand-choose-logo')?.addEventListener('click', async () => {
    try {
      const result = await window.api.profile.chooseLogo()
      if (result?.status !== 'ok') return
      logoUrl = result.url
      applyLogo()
      notify('应用 Logo 已更新')
    } catch (error) {
      notify(`更换 Logo 失败：${errorText(error?.message ?? error)}`)
    }
  })

  document.querySelector('#brand-clear-logo')?.addEventListener('click', async () => {
    try {
      await window.api.profile.clearLogo()
      logoUrl = ''
      applyLogo()
      notify('已恢复默认 Logo')
    } catch (error) {
      notify(`恢复默认 Logo 失败：${errorText(error?.message ?? error)}`)
    }
  })

  apply()
  render()
  applyLogo()

  return {
    /** 启动后从主进程读到的 Logo 状态 */
    setLogo(info) {
      logoUrl = info?.status === 'ok' ? info.url : ''
      applyLogo()
    },
    /** 窗口标题带版本号：名称改了也跟着变 */
    setVersion(value) {
      version = value
      apply()
    }
  }
}
