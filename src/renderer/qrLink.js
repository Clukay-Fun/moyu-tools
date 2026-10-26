// @ts-check
// 视频转二维码的纯逻辑：链接规范化、链接信息、编码、SVG。
//
// 不碰 DOM，可在 Node 侧直接测。二维码里只放链接本身（视频在用户自己选的地方），
// 这里也不会去访问这个链接。

import qrcode from 'qrcode-generator'

/** @typedef {'L' | 'M' | 'Q' | 'H'} QrEcc */
/** @typedef {{ size: number, dark: Uint8Array, version: number }} QrMatrix */

export const QR_ECC_LEVELS = /** @type {const} */ (['L', 'M', 'Q', 'H'])
/** 四周留白（码点），ISO/IEC 18004 要求至少 4 */
export const QR_QUIET_ZONE = 4
/** 版本超过这个值码点就比较密，小尺寸印刷容易扫不出 */
export const QR_DENSE_VERSION = 10
/** 和白底的对比度低于这个值时提示（扫码靠明暗差，不按 WCAG 的 4.5） */
export const QR_MIN_CONTRAST = 3

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'wmv', 'm3u8', 'ts'])

// 按主机名后缀认出常见平台，只用来显示，不影响编码内容
/** @type {Array<[string[], string]>} */
const KNOWN_SITES = [
  [['bilibili.com', 'b23.tv'], '哔哩哔哩'],
  [['douyin.com', 'iesdouyin.com'], '抖音'],
  [['kuaishou.com', 'gifshow.com'], '快手'],
  [['ixigua.com'], '西瓜视频'],
  [['v.qq.com'], '腾讯视频'],
  [['channels.weixin.qq.com'], '微信视频号'],
  [['mp.weixin.qq.com'], '微信公众号'],
  [['youku.com'], '优酷'],
  [['iqiyi.com'], '爱奇艺'],
  [['xiaohongshu.com', 'xhslink.com'], '小红书'],
  [['weibo.com', 'weibo.cn'], '微博'],
  [['pan.baidu.com'], '百度网盘'],
  [['aliyundrive.com', 'alipan.com'], '阿里云盘'],
  [['pan.quark.cn'], '夸克网盘'],
  [['123pan.com', '123pan.cn'], '123 云盘'],
  [['youtube.com', 'youtu.be'], 'YouTube'],
  [['vimeo.com'], 'Vimeo']
]

/**
 * 用户输入 → 二维码里要放的链接。
 * 只放行 http / https；`new URL().href` 会把中文路径转成百分号编码、中文域名转成 punycode，
 * 编进码里的就只有 ASCII，各家扫码软件读出来一致。
 * @param {unknown} raw
 * @returns {{ ok: true, url: string, addedScheme: boolean, insecure: boolean } | { ok: false, error: string }}
 */
export function normalizeVideoLink(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: '请输入视频链接' }
  if (/\s/.test(text)) return { ok: false, error: '链接里不能有空格或换行' }

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text)
  // 「pan.baidu.com:8080/x」这类不带协议的会被当成协议，按「主机名:端口」再认一次
  const looksLikeHostPort = /^[^/:]+\.[^/:]+:\d+(?:[/?#]|$)/.test(text)
  const addedScheme = !hasScheme || looksLikeHostPort
  /** @type {URL} */
  let url
  try {
    url = new URL(addedScheme ? `https://${text.replace(/^\/\//, '')}` : text)
  } catch {
    return { ok: false, error: '链接格式不正确' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只支持 http / https 链接' }
  }
  if (!url.hostname || (addedScheme && !url.hostname.includes('.'))) {
    return { ok: false, error: '链接里缺少网址（例如 pan.baidu.com）' }
  }
  if (url.username || url.password) {
    return { ok: false, error: '链接里不能带账号或密码' }
  }
  return { ok: true, url: url.href, addedScheme, insecure: url.protocol === 'http:' }
}

/**
 * 只用链接本身能看出的信息，不联网。
 * @param {string} href 已规范化的链接
 */
export function describeVideoLink(href) {
  const url = new URL(href)
  const host = url.hostname.toLowerCase()
  const known = KNOWN_SITES.find(([suffixes]) => suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
  const extension = url.pathname.split('/').pop()?.split('.').slice(1).pop()?.toLowerCase() || ''
  return {
    site: known ? `${known[1]} · ${host}` : host,
    protocol: url.protocol === 'https:' ? 'HTTPS（加密）' : 'HTTP（未加密）',
    kind: VIDEO_EXTENSIONS.has(extension) ? `视频文件（${extension.toUpperCase()}）` : '网页（打开后播放）',
    length: `${href.length} 个字符`
  }
}

/**
 * 编码成码点矩阵；版本自动选择。
 * @param {string} text 只含 ASCII（normalizeVideoLink 的结果）
 * @param {QrEcc} ecc
 * @returns {{ ok: true, matrix: QrMatrix } | { ok: false, error: string }}
 */
export function encodeQr(text, ecc) {
  if (!QR_ECC_LEVELS.includes(ecc)) return { ok: false, error: `不支持的容错等级：${ecc}` }
  // 库的默认字节转换会截掉 0xFF 以上的字符，非 ASCII 必须在这之前拦下
  if (/[^\x20-\x7e]/.test(text)) return { ok: false, error: '链接里有未编码的字符' }
  const code = qrcode(0, ecc)
  try {
    code.addData(text, 'Byte')
    code.make()
  } catch {
    return { ok: false, error: '链接太长，当前容错等级装不下，请换短链接或调低容错等级' }
  }
  const size = code.getModuleCount()
  const dark = new Uint8Array(size * size)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (code.isDark(row, col)) dark[row * size + col] = 1
    }
  }
  return { ok: true, matrix: { size, dark, version: (size - 17) / 4 } }
}

/**
 * 深色码点按行合并成横向矩形，拼成一条 path：文件小，Illustrator 里也只是一个对象。
 * 坐标以码点为单位，已含留白偏移。
 * @param {QrMatrix} matrix
 */
export function qrPathData(matrix, margin = QR_QUIET_ZONE) {
  const { size, dark } = matrix
  const parts = []
  for (let row = 0; row < size; row += 1) {
    let col = 0
    while (col < size) {
      if (!dark[row * size + col]) {
        col += 1
        continue
      }
      const start = col
      while (col < size && dark[row * size + col]) col += 1
      parts.push(`M${start + margin} ${row + margin}h${col - start}v1h${start - col}z`)
    }
  }
  return parts.join('')
}

/**
 * @param {QrMatrix} matrix
 * @param {{ color: string, sizeMm: number }} options
 */
export function qrSvg(matrix, { color, sizeMm }) {
  const extent = matrix.size + QR_QUIET_ZONE * 2
  const size = `${Number(sizeMm.toFixed(2))}mm`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges">`,
    `<rect width="${extent}" height="${extent}" fill="#FFFFFF"/>`,
    `<path fill="${normalizeHexColor(color) || '#000000'}" d="${qrPathData(matrix)}"/>`,
    '</svg>'
  ].join('')
}

/**
 * PNG 边长：每个码点占整数像素，最接近 targetPx 且不小于码点总数。
 * @param {QrMatrix} matrix
 * @param {number} targetPx
 */
export function qrPixelLayout(matrix, targetPx) {
  const extent = matrix.size + QR_QUIET_ZONE * 2
  const scale = Math.max(1, Math.round(targetPx / extent))
  return { scale, extent, pixels: extent * scale }
}

/**
 * @param {unknown} value
 * @returns {string} 大写 #RRGGBB；不合法返回空串
 */
export function normalizeHexColor(value) {
  const text = String(value ?? '').trim()
  const short = /^#?([\da-f])([\da-f])([\da-f])$/i.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
  const full = /^#?([\da-f]{6})$/i.exec(text)
  return full ? `#${full[1]}`.toUpperCase() : ''
}

/** @param {string} hex */
function relativeLuminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [value >> 16, (value >> 8) & 0xff, value & 0xff].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * @param {string} foreground
 * @param {string} background
 */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(normalizeHexColor(foreground) || '#000000')
  const b = relativeLuminance(normalizeHexColor(background) || '#FFFFFF')
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * 默认文件名：视频二维码-<主机名>
 * @param {string} href
 */
export function qrFileBaseName(href) {
  return `视频二维码-${new URL(href).hostname}`
}
