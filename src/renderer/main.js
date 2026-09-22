import JsBarcode from 'jsbarcode'
import { fabric } from 'fabric'
import { parse as parseOpenType } from 'opentype.js'
import { isRetailType, renderRetailBarcode, computeRetailGeometry } from './retailBarcode.js'
import { BoardController } from './board/index.js'
import { initIllustrator } from './modules/illustrator.js'
import { initBarcode } from './modules/barcode.js'
import { initPdfTools } from './modules/pdf.js'
import { initFormatFactory } from './modules/formatFactory.js'
import { initUpdatePanel } from './modules/updatePanel.js'
import { initDieline } from './modules/dieline.js'
import { ImageEditorModal } from './board/editor/modal.js'
import { RecoveryScheduler } from './board/recovery.js'
import { cleanIpcError, illustratorFailureHint, isComCancelled } from './comErrors.js'
import { installTooltips } from './tooltip.js'
import {
  isGenericType, renderGenericBarcode, computeGenericGeometry, genericRasterSize, resolveGenericTypeName,
  GENERIC_DEFAULTS, CODE39_DEFAULTS, CODABAR_DEFAULTS, MSI_DEFAULTS
} from './genericBarcode.js'
import {
  isGs1128Type, prepareGs1128, renderGs1128, computeGs1128Geometry, gs1128RasterSize
} from './gs1128Barcode.js'
import {
  isItf14Type, renderItf14, computeItf14Geometry, itf14RasterSize,
  ITF14_PRESETS, ITF14_DEFAULT_PRESET
} from './itf14Barcode.js'
// GS1-128 语法引擎（懒加载 WASM）。Spike 阶段仅确保打包链路成立，尚未接入 UI。
import ocrbFontData from '../../assets/fonts/OCR-B.ttf?inline'
import ocrbIFontData from '../../assets/fonts/OCRBI.ttf?inline'
import ocrbIIIFontData from '../../assets/fonts/OCRBIII.ttf?inline'
import ocrbIVFontData from '../../assets/fonts/OCRBIV.ttf?inline'

globalThis.fabric = fabric
const eraserBrushReady = import('fabric/src/mixins/eraser_brush.mixin.js')
  .then(() => fabric.EraserBrush)
installTooltips()

const appLogoUrl = new URL('../../assets/app-icon.png', import.meta.url).href

document.querySelectorAll('[data-app-logo]').forEach((image) => {
  image.src = appLogoUrl
})

const barcodeTypes = {
  'EAN-13': {
    format: 'EAN13',
    icon: '13',
    color: '#e88c32',
    example: '590123412345',
    inputMode: 'numeric',
    maxLength: 13,
    hint: '需要 12 位数字，或带正确校验位的 13 位数字'
  },
  'UPC-A': {
    format: 'UPC',
    icon: 'U',
    color: '#e75551',
    example: '038861781561',
    inputMode: 'numeric',
    maxLength: 12,
    hint: '需要 11 位数字，或带正确校验位的 12 位数字'
  },
  'ITF-14': {
    format: 'ITF14',
    icon: 'I14',
    color: '#5b8def',
    example: '00012345600012',
    inputMode: 'numeric',
    maxLength: 14,
    hint: '需要 13 位数字，或带正确校验位的 14 位数字'
  },
  'GS1-128': {
    format: 'GS1128',
    icon: 'G1',
    color: '#7a6ff0',
    example: '(01)09521234543213(10)ABC123(17)280101',
    inputMode: 'text',
    maxLength: 256,
    hint: '输入 GS1 AI 数据串，如 (01)09521234543213(10)ABC123'
  },
  'EAN-8': {
    format: 'EAN8',
    icon: '8',
    color: '#80cbb2',
    example: '9638507',
    inputMode: 'numeric',
    maxLength: 8,
    hint: '需要 7 位数字，或带正确校验位的 8 位数字'
  },
  Code128: {
    format: 'CODE128',
    icon: '128',
    color: '#88a2e8',
    example: 'MOYU-TOOLS-128',
    inputMode: 'text',
    maxLength: 80,
    hint: '支持 ASCII 字母、数字与常用符号'
  },
  Code39: {
    format: 'CODE39',
    icon: '39',
    color: '#8678d9',
    example: 'MOYU-39',
    inputMode: 'text',
    maxLength: 48,
    hint: '支持大写字母、数字、空格及 -.$/+%'
  },
  ITF: {
    format: 'ITF',
    icon: 'ITF',
    color: '#59a6ae',
    example: '12345670',
    inputMode: 'numeric',
    maxLength: 48,
    hint: '需要偶数位纯数字'
  },
  MSI: {
    format: 'MSI',
    icon: 'MSI',
    color: '#9b7fc6',
    example: '1234567',
    inputMode: 'numeric',
    maxLength: 48,
    hint: '仅支持数字'
  },
  Codabar: {
    format: 'codabar',
    icon: 'CB',
    color: '#bd7c65',
    example: '123456',
    inputMode: 'text',
    maxLength: 48,
    hint: '正文支持数字、-$:/.+；起止符请在右侧选项中设置'
  },
  Auto: {
    format: 'auto',
    icon: 'A',
    color: '#737789',
    example: 'AUTO-123456',
    inputMode: 'text',
    maxLength: 80,
    hint: '自动编码为 Code 128（自动切换 Code Set A/B/C）'
  }
}

const barcodeFonts = {
  ocrb: { label: 'OCRB', data: ocrbFontData },
  'ocrb-i': { label: 'OCRB I', data: ocrbIFontData },
  'ocrb-iii': { label: 'OCRB III', data: ocrbIIIFontData },
  'ocrb-iv': { label: 'OCRB IV', data: ocrbIVFontData }
}

const submenuData = {
  pdf: [
    {
      heading: '转换',
      items: [
        ['转 PNG', 'PNG', '#3c9a5e'],
        ['转 JPEG', 'JPG', '#3c9a5e'],
        ['转 TXT', 'TXT', '#707387'],
        ['转 DOCX', 'DOC', '#2b6cb0', 'M7x'],
        ['转 XLSX', 'XLS', '#217346', 'M7x'],
        ['转 PPTX', 'PPT', '#d24726', 'M7x']
      ]
    },
    {
      heading: '编辑',
      items: [
        ['合并 PDF', '合', '#e0554e'],
        ['逐页拆分', '拆', '#e0554e'],
        ['旋转 PDF', '旋', '#e0554e'],
        ['提取指定页', '页', '#e0554e'],
        ['添加水印', 'WM', '#6978e6'],
        ['添加页码', '#', '#6978e6'],
        ['页重排', '⇅', '#6978e6'],
        ['提取图片', 'PIC', '#3c9a5e'],
        ['OCR 转 TXT', 'OCR', '#3c9a5e']
      ]
    },
    {
      heading: '转成 PDF',
      items: [
        ['图片转 PDF', 'IMG', '#3c9a5e'],
        ['Word 转 PDF', 'W', '#2b6cb0'],
        ['Excel 转 PDF', 'X', '#217346'],
        ['PPT 转 PDF', 'P', '#d24726']
      ]
    },
    {
      heading: '安全',
      items: [
        ['加密 PDF', '锁', '#6978e6'],
        ['解密 PDF', '开', '#6978e6']
      ]
    }
  ],
  bc: [
    {
      heading: '条码类型',
      items: Object.entries(barcodeTypes)
        .filter(([name]) => name !== 'Auto')
        .map(([name, type]) => [name, type.icon, type.color])
    },
    {
      heading: '自动识别',
      items: [['Auto', barcodeTypes.Auto.icon, barcodeTypes.Auto.color]]
    }
  ],
  video: [
    {
      heading: '视频',
      items: [
        ['视频转换', 'VID', '#6978e6'],
        ['视频压缩', 'ZIP', '#e88c32'],
        ['抽取音频', 'MP3', '#59a6ae']
      ]
    },
    {
      heading: '音频',
      items: [
        ['音频转换', 'AUD', '#8678d9']
      ]
    },
    {
      heading: '图片',
      items: [
        ['图片转换', 'IMG', '#3c9a5e'],
        ['图片压缩', 'MIN', '#d35f79']
      ]
    }
  ]
}

const defaultSelections = {
  pdf: '转 PNG',
  bc: 'EAN-13',
  video: '视频转换'
}

const deferredPdfActions = new Map([
  ['转 DOCX', 'M7x'],
  ['转 XLSX', 'M7x'],
  ['转 PPTX', 'M7x']
])

const moduleLabels = {
  pdf: 'PDF',
  ai: 'Illustrator',
  bc: '条码',
  image: '图片',
  video: '格式工厂',
  more: '设置'
}

const searchFeatures = [
  ['转 PNG', 'PDF', 'pdf', '转 PNG', 'PDF 图片 PNG 导出'],
  ['转 JPEG', 'PDF', 'pdf', '转 JPEG', 'PDF 图片 JPG JPEG 导出'],
  ['转 TXT', 'PDF', 'pdf', '转 TXT', 'PDF 文字 文本 提取'],
  ['转 DOCX', 'PDF', 'pdf', '转 DOCX', 'PDF Word 内容提取'],
  ['转 XLSX', 'PDF', 'pdf', '转 XLSX', 'PDF Excel 表格提取'],
  ['转 PPTX', 'PDF', 'pdf', '转 PPTX', 'PDF PowerPoint 幻灯片'],
  ['合并 PDF', 'PDF', 'pdf', '合并 PDF', '合并 文件'],
  ['逐页拆分', 'PDF', 'pdf', '逐页拆分', '拆分 PDF 每页 独立文件'],
  ['旋转 PDF', 'PDF', 'pdf', '旋转 PDF', '旋转 页面'],
  ['提取指定页', 'PDF', 'pdf', '提取指定页', 'PDF 页面 提取 页码范围'],
  ['添加水印', 'PDF', 'pdf', '添加水印', 'PDF 水印 文字 图片'],
  ['添加页码', 'PDF', 'pdf', '添加页码', 'PDF 页眉 页脚'],
  ['页重排', 'PDF', 'pdf', '页重排', 'PDF 拖拽 调序 删除 插入'],
  ['提取图片', 'PDF', 'pdf', '提取图片', 'PDF 内嵌 图片 导出'],
  ['OCR 转 TXT', 'PDF', 'pdf', 'OCR 转 TXT', 'PDF 扫描件 文字识别'],
  ['加密 PDF', 'PDF', 'pdf', '加密 PDF', 'PDF AES 口令 密码'],
  ['解密 PDF', 'PDF', 'pdf', '解密 PDF', 'PDF 移除 口令 密码'],
  ['图片转 PDF', 'PDF', 'pdf', '图片转 PDF', '图片 PDF'],
  ['Word 转 PDF', 'PDF', 'pdf', 'Word 转 PDF', 'Office DOCX'],
  ['Excel 转 PDF', 'PDF', 'pdf', 'Excel 转 PDF', 'Office XLSX'],
  ['PPT 转 PDF', 'PDF', 'pdf', 'PPT 转 PDF', 'Office PPTX'],
  ['导出 PDF', 'Illustrator', 'ai', '', 'AI 批量 导出'],
  ['最小化 PDF', 'Illustrator', 'ai', '', 'AI PDF 最小化'],
  ['文字转曲', 'Illustrator', 'ai', '', 'AI 文字 转曲'],
  ['EAN-13 条码', '条码', 'bc', 'EAN-13', '商品码 一维码'],
  ['UPC-A 条码', '条码', 'bc', 'UPC-A', '商品码 一维码'],
  ['ITF-14 条码', '条码', 'bc', 'ITF-14', '外箱 物流 一维码'],
  ['GS1-128 条码', '条码', 'bc', 'GS1-128', 'EAN128 UCC128 物流 应用标识符 AI 一维码'],
  ['EAN-8 条码', '条码', 'bc', 'EAN-8', '商品码 一维码'],
  ['Code128 条码', '条码', 'bc', 'Code128', '物流 一维码'],
  ['Code39 条码', '条码', 'bc', 'Code39', '工业 一维码'],
  ['ITF 条码', '条码', 'bc', 'ITF', '外箱 一维码'],
  ['MSI 条码', '条码', 'bc', 'MSI', '库存 一维码'],
  ['Codabar 条码', '条码', 'bc', 'Codabar', '库德巴码 一维码'],
  ['自动格式条码', '条码', 'bc', 'Auto', 'Auto CODE128 一维码'],
  ['区域截图', '图片', 'image', 'capture', '截图 截屏 抓屏 屏幕 标注'],
  ['图片裁切', '图片', 'image', 'crop', '裁剪 编辑'],
  ['调色与马赛克', '图片', 'image', 'adjust', '亮度 对比度 饱和度 像素化'],
  ['统一画布', '图片', 'image', '', '画布 拼图 多图 文本框 moyuboard 项目 区域'],
  ['截图复制', '图片', 'image', '', '剪贴板 复制 PNG 截图'],
  ['图片导出', '图片', 'image', 'export', 'PNG JPG WebP TIFF'],
  ['视频转换', '格式工厂', 'video', '视频转换', 'FFmpeg MP4 MKV WebM'],
  ['视频压缩', '格式工厂', 'video', '视频压缩', 'FFmpeg CRF 体积'],
  ['抽取音频', '格式工厂', 'video', '抽取音频', '视频 MP3 WAV'],
  ['音频转换', '格式工厂', 'video', '音频转换', 'MP3 AAC WAV FLAC'],
  ['图片转换', '格式工厂', 'video', '图片转换', 'sharp JPG PNG WebP AVIF TIFF GIF'],
  ['图片压缩', '格式工厂', 'video', '图片压缩', 'sharp 批量 质量'],
  ['主题与强调色', '设置', 'more', '', '外观 深色 浅色 颜色'],
  ['关于摸鱼工具箱', '设置', 'more', '', '版本 作者']
].map(([name, group, module, action, keywords]) => {
  // 守卫：搜索项引用了不存在的模块时，渲染期 moduleLabels[module] 会是 undefined，
  // .slice() 抛错后既不显示结果也不显示"无匹配"——症状极具迷惑性。
  // 这里在启动时就炸出来，避免又一次靠人肉排查。
  if (!moduleLabels[module]) {
    throw new Error(`搜索项「${name}」引用了不存在的模块：${module}`)
  }
  return {
    name,
    group,
    module,
    action,
    searchable: `${name} ${group} ${keywords}`.toLowerCase()
  }
})

const savedBarcodeStyle = (() => {
  try {
    return JSON.parse(localStorage.getItem('barcode-style') || '{}')
  } catch {
    return {}
  }
})()

const state = {
  module: 'home',
  selections: { ...defaultSelections
  },
  activeSearchIndex: -1,
  searchMatches: [],
  pdfJpegQuality: '0.85',
  barcodeMode: 'single',
  barcodeFont: barcodeFonts[savedBarcodeStyle.font] ? savedBarcodeStyle.font : 'ocrb',
  itf14Preset: ITF14_DEFAULT_PRESET,
  code39: {
    wideRatio: CODE39_DEFAULTS.wideRatio,
    mod43: CODE39_DEFAULTS.mod43,
    fullAscii: CODE39_DEFAULTS.fullAscii
  },
  codabar: {
    start: CODABAR_DEFAULTS.start,
    stop: CODABAR_DEFAULTS.stop,
    showStartStop: CODABAR_DEFAULTS.showStartStop
  },
  msi: { checksumMode: MSI_DEFAULTS.checksumMode },
  barcodeBatchItems: [],
  pdfFiles: [],
  pdfFileStatuses: [],
  pdfBusy: false,
  pdfLastOutput: null,
  pdfComResult: null,
  pdfDestination: null,
  pdfNativeInput: null,
  pdfWatermarkFiles: [],
  pdfWatermarkStatuses: [],
  pdfWatermarkMode: 'text',
  pdfWatermarkImage: null,
  pdfWatermarkPreviewFileIndex: 0,
  pdfWatermarkPreviewPage: 1,
  pdfWatermarkPreviewPageCount: 0,
  pdfPageItems: [],
  pdfPageOrganizerSource: null,
  pdfPageOrganizerSnapshot: []
}

// showToast / bindFileDropZone / droppedFilePaths / renderSubmenu 是本文件后面
// 才出现的函数声明（会被提升），这里提前引用是安全的——只要不在模块顶层
// 立即调用它们（这里没有，initFormatFactory 内部只是注册事件监听）。
const formatFactoryModule = initFormatFactory({ state, renderSubmenu, showToast, bindFileDropZone, droppedFilePaths })

const submenu = document.querySelector('#submenu')
const searchInput = document.querySelector('#feature-search')
const searchResults = document.querySelector('#search-results')
const toast = document.querySelector('#toast')
let toastTimer

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') document.body.classList.add('keyboard-focus')
}, true)

document.addEventListener('pointerdown', () => {
  document.body.classList.remove('keyboard-focus')
}, true)

function renderSubmenu(module, indicatorFromTop = null) {
  const groups = submenuData[module]

  if (!groups) {
    submenu.classList.remove('show')
    submenu.replaceChildren()
    return
  }

  const fragment = document.createDocumentFragment()
  const indicator = document.createElement('div')
  indicator.className = 'submenu-indicator'
  indicator.setAttribute('aria-hidden', 'true')
  fragment.append(indicator)

  groups.forEach((group) => {
    const heading = document.createElement('div')
    heading.className = 'submenu-heading'
    heading.textContent = group.heading
    fragment.append(heading)

    group.items.forEach(([name, icon, color, milestone]) => {
      const button = document.createElement('button')
      const iconNode = document.createElement('i')

      button.type = 'button'
      button.className = `submenu-item${state.selections[module] === name ? ' on' : ''}${milestone ? ' placeholder-action' : ''}`
      button.dataset.module = module
      button.dataset.action = name
      if (milestone) {
        button.dataset.milestone = milestone
        button.setAttribute('aria-disabled', 'true')
      }
      iconNode.textContent = icon
      iconNode.style.background = color
      button.append(iconNode, document.createTextNode(name))
      fragment.append(button)
    })
  })

  submenu.replaceChildren(fragment)
  submenu.classList.add('show')

  const activeItem = submenu.querySelector('.submenu-item.on')
  if (!activeItem) {
    indicator.hidden = true
    return
  }

  const targetTop = activeItem.offsetTop
  if (indicatorFromTop == null) {
    indicator.style.transform = `translate3d(0, ${targetTop}px, 0)`
    requestAnimationFrame(() => indicator.classList.add('ready'))
    return
  }

  // 菜单项会随功能分组重建，选中底板必须先落在旧位置，再移动到新位置。
  // 强制读取一次布局是为了提交初始 transform；只发生在用户点击切换时。
  indicator.style.transform = `translate3d(0, ${indicatorFromTop}px, 0)`
  indicator.getBoundingClientRect()
  indicator.classList.add('ready')
  requestAnimationFrame(() => {
    indicator.style.transform = `translate3d(0, ${targetTop}px, 0)`
  })
}

const entryAnimations = new WeakMap()

function animateEntry(element, { duration = 160, distance = 6, horizontal = false } = {}) {
  if (!element) return
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  entryAnimations.get(element)?.cancel()
  const transform = horizontal ? `translateX(${distance}px)` : `translateY(${distance}px)`
  const animation = element.animate(
    reduced
      ? [{ opacity: 0.65 }, { opacity: 1 }]
      : [{ opacity: 0.25, transform }, { opacity: 1, transform: 'translate(0, 0)' }],
    { duration: reduced ? 100 : duration, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
  )
  entryAnimations.set(element, animation)
  const release = () => {
    if (entryAnimations.get(element) === animation) entryAnimations.delete(element)
  }
  animation.addEventListener('finish', release, { once: true })
  animation.addEventListener('cancel', release, { once: true })
}

function activateModule(module, action = '', animate = false) {
  const changed = state.module !== module
  if (module !== 'dieline') dielineModule?.deactivate()
  state.module = module

  document.querySelectorAll('.nav-ic').forEach((button) => {
    const isActive = button.dataset.module === module
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-current', isActive ? 'page' : 'false')
  })

  let activePage = null
  document.querySelectorAll('.page').forEach((page) => {
    if (page.id === `page-${module}`) activePage = page
    page.classList.toggle('active', page.id === `page-${module}`)
  })
  if (module === 'more' && changed && activePage) {
    // 设置内容有自己的滚动容器。重新进入设置页时必须复位外层 page，
    // 否则之前由锚点导航带出的 scrollTop 会把“设置”标题卷出视口。
    activePage.scrollTop = 0
    activePage.querySelector('.settings-layout')?.scrollTo({ top: 0, behavior: 'instant' })
  }
  if (animate && changed) animateEntry(activePage, { duration: 180, distance: 7 })

  const deferredMilestone = module === 'pdf' ? deferredPdfActions.get(action) : null

  if (action && submenuData[module] && !deferredMilestone) {
    state.selections[module] = action
  }

  renderSubmenu(module)

  if (module === 'pdf') {
    pdfModule.updatePdfState(state.selections.pdf)
    if (deferredMilestone) showToast(`“${action}”将在 ${deferredMilestone} 接入`)
  } else if (module === 'bc') {
    document.querySelector('#bc-crumb').textContent = state.selections.bc
    if (action) barcodeModule.selectBarcodeType(action, true)
  } else if (module === 'image') {
    // U1：image 即统一画布。搜索传来的 action 走工具路由，不再切旧编辑器模式。
    activateUnifiedCanvas()
    if (action) requestImageTool(action)
  } else if (module === 'video') {
    formatFactoryModule.setFormatAction(state.selections.video)
  } else if (module === 'dieline') {
    dielineModule?.activate()
  }

  // 离开画布时收起浮动工具栏，并取消待执行的跟随更新（S2）。
  // 不收的话，切回来会先看到它停在旧位置再跳走。
  if (module !== 'image') boardController?.hideFloatingToolbars()
}

function chooseSubmenu(module, action, animate = false) {
  const changed = state.selections[module] !== action
  const previousTop = animate && changed
    ? submenu.querySelector('.submenu-item.on')?.offsetTop ?? null
    : null
  if (module === 'video') {
    formatFactoryModule.setFormatAction(action, previousTop)
    if (animate && changed) animateEntry(document.querySelector('#page-video'), { duration: 160, distance: 5 })
    return
  }
  state.selections[module] = action
  renderSubmenu(module, previousTop)

  if (module === 'pdf') {
    pdfModule.updatePdfState(action)
  } else if (module === 'bc') {
    barcodeModule.selectBarcodeType(action, true)
  }
  if (animate && changed) animateEntry(document.querySelector(`#page-${module}`), { duration: 160, distance: 5 })
}

document.querySelector('.rail').addEventListener('click', (event) => {
  const button = event.target.closest('.nav-ic')
  if (button) activateModule(button.dataset.module, '', event.detail > 0)
})

submenu.addEventListener('click', (event) => {
  const button = event.target.closest('.submenu-item')
  if (button && !button.dataset.milestone) {
    chooseSubmenu(button.dataset.module, button.dataset.action, event.detail > 0)
  }
})

function showToast(message) {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.add('show')
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600)
}

function bindFileDropZone(element, onDrop) {
  element.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    element.classList.add('drag-over')
  })
  element.addEventListener('dragleave', (event) => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('drag-over')
  })
  element.addEventListener('drop', (event) => {
    event.preventDefault()
    element.classList.remove('drag-over')
    if (event.dataTransfer?.files.length) void onDrop(event.dataTransfer.files)
  })
}

function droppedFilePaths(files) {
  return Array.from(files || [], (file) => window.api.getPathForFile(file)).filter(Boolean)
}

// ── 汇总画布（F-009）────────────────────────────────────────
// U1：截图与图片合并为单一「图片」模块，统一画布挂在 #page-image。
// 旧的 screen 双面板已退役，其 DOM 保留但不可达（U6 删除）。
const canvasSurface = document.querySelector('#canvas-surface')
const boardFileInput = document.querySelector('#board-file-input')

let boardController = null

/** 取当前截图编辑器的画面字节；无截图时返回 null。 */

/** 进入图片模块时挂载统一画布。页面刚显示时尺寸才可测，故延后一帧 fit。 */
function ensureBoardController() {
  if (boardController) return boardController
  boardController = new BoardController({
    fabric,
    onStatus: (info) => {
      if (info?.error) showToast(info.error)
      if (info?.saved) showToast(`已保存：${info.saved.split(/[\\/]/).pop()}`)
      if (info?.opened) showToast(`已打开：${info.opened.split(/[\\/]/).pop()}`)
      if (info?.warn) showToast(info.warn)
      if (info?.message) showToast(info.message)
      if (info?.imported !== undefined) consumePendingImageTool(info.imported > 0)
    }
  })
  // 双击图片与对象工具栏的 编辑/裁切 都走这里（U4）
  boardController.onEditImage = (image, tool) => openImageEditor(image, tool)
  // 画布快捷键的第二道守卫：模态编辑器开着时一律不响应（F-10）
  boardController.isModalOpen = () => Boolean(imageEditorModal?.isOpen)

  // 对象侧栏的 IPC 类命令。S3 之后这里只剩「复制」——
  // OCR 与钉住已并入全屏编辑器的动作组，同一能力不再有两个入口。
  boardController.onNodeCommand = async (action, ids) => {
    if (ids.length !== 1) {
      showToast('请先单选一张图片')
      return
    }
    const image = boardController.getNodeImage(ids[0])
    if (!image?.bytes) {
      showToast('该对象不是图片或数据不可用')
      return
    }
    try {
      if (action === 'copy') {
        // 复制的是当前编辑后的源像素
        const result = await window.api.copyScreenshot(image.bytes)
        showToast(result?.status === 'copied' ? '已复制到剪贴板' : '复制失败')
        return
      }
      showToast(`暂不支持的操作：${action}`)
    } catch (error) {
      showToast(cleanIpcError(error?.message ?? error) || '操作失败')
    }
  }

  // 新建 / 打开 / 退出前的统一确认：保存 / 不保存 / 取消（规格 7.2）
  boardController.onConfirmDiscard = (actionLabel) => {
    const save = window.confirm(
      `当前画布有未保存的改动。\n\n确定 = 先保存再${actionLabel}\n取消 = 不保存`)
    if (save) return 'save'
    return window.confirm(`不保存直接${actionLabel}？未保存的改动会丢失。`) ? 'discard' : 'cancel'
  }

  // 退出握手：主进程弹三选项，选「保存并退出」时由这里真正执行保存，
  // 结果回传给主进程决定是否退出（规格 7.2）
  window.api.onBoardSaveRequest(async (id) => {
    let ok = false
    try {
      ok = await boardController.save(false)
    } catch {
      ok = false
    }
    window.api.reportBoardSaveResult(id, ok)
  })

  // 崩溃恢复：3 秒 debounce / 30 秒 max-wait（规格 7.3）
  boardController.attachRecovery(new RecoveryScheduler({
    write: async () => {
      const bytes = boardController.packForRecovery()
      await window.api.writeRecovery({ data: bytes, projectPath: boardController.filePath })
    },
    // 快照失败不能打断用户操作，只提示一次
    onError: (error) => showToast(`恢复快照写入失败：${error.message}`)
  }))

  boardController.mount({
    pane: canvasSurface,
    stage: document.querySelector('#board-stage'),
    // S5 · 文本框横向工具栏
    textToolbar: document.querySelector('#text-toolbar'),
    textFill: document.querySelector('#text-fill'),
    textScale: document.querySelector('#text-scale'),
    textFontTrigger: document.querySelector('#text-font-trigger'),
    textFontMenu: document.querySelector('#text-font-menu'),
    textAlignTrigger: document.querySelector('#text-align-trigger'),
    textAlignMenu: document.querySelector('#text-align-menu'),
    empty: document.querySelector('#board-empty'),
    statusDot: document.querySelector('#board-status-dot'),
    statusText: document.querySelector('#board-status-text'),
    addCapture: document.querySelector('#board-add-capture'),
    addFile: document.querySelector('#board-add-file'),
    addText: document.querySelector('#board-add-text'),
    addTextBox: document.querySelector('#board-add-textbox'),
    connect: document.querySelector('#board-connect'),
    edgeStyle: document.querySelector('#board-edge-style'),
    edgeShape: document.querySelector('#board-edge-shape'),
    edgeArrow: document.querySelector('#board-edge-arrow'),
    edgeWidth: document.querySelector('#board-edge-width'),
    edgeColor: document.querySelector('#board-edge-color'),
    edgeDelete: document.querySelector('#board-edge-delete'),
    undo: document.querySelector('#board-undo'),
    redo: document.querySelector('#board-redo'),
    zoomIn: document.querySelector('#board-zoom-in'),
    zoomOut: document.querySelector('#board-zoom-out'),
    zoomFit: document.querySelector('#board-zoom-fit'),
    zoomReset: document.querySelector('#board-zoom-reset'),
    zoomLabel: document.querySelector('#board-zoom-label'),
    open: document.querySelector('#board-open'),
    save: document.querySelector('#board-save'),
    saveAs: document.querySelector('#board-save-as'),
    overlay: document.querySelector('#board-overlay'),
    rulerX: document.querySelector('#ruler-x'),
    rulerY: document.querySelector('#ruler-y'),
    objectToolbar: document.querySelector('#object-toolbar'),
    exportRange: document.querySelector('#board-export-range'),
    exportPng: document.querySelector('#board-export-png'),
    exportJpg: document.querySelector('#board-export-jpg'),
    fileInput: document.querySelector('#board-file-input'),
    deleteButton: document.querySelector('#board-delete'),
    front: document.querySelector('#board-front'),
    forward: document.querySelector('#board-forward'),
    backward: document.querySelector('#board-backward'),
    back: document.querySelector('#board-back')
  })
  // 只读检视接口：仅暴露读取方法，无法修改画布状态
  window.__moyuBoard = boardController.inspector()

  return boardController
}

/**
 * 启动时检查上次是否异常退出。
 *
 * 只在用户第一次进入画布时问一次：放弃后立即删除快照，
 * 不能每次切页面都再弹一遍（规格 7.3）。
 */
let recoveryPrompted = false

async function checkRecoverySnapshot(controller) {
  if (recoveryPrompted) return
  recoveryPrompted = true
  let found
  try {
    found = await window.api.readRecovery()
  } catch (error) {
    showToast(`读取恢复快照失败：${error.message}`)
    return
  }
  if (found?.status === 'corrupt') {
    // 明确报错但**不覆盖正式工程**，也不静默吞掉
    showToast(`上次的恢复快照不可用：${found.reason}`)
    await window.api.clearRecovery().catch(() => {})
    return
  }
  if (found?.status !== 'found') return

  const when = new Date(found.savedAt).toLocaleString('zh-CN')
  const name = found.projectPath ? found.projectPath.split(/[\\/]/).pop() : '未命名画布'
  if (!window.confirm(`检测到上次异常退出时的画布（${name}，${when}）。\n\n恢复它吗？取消将丢弃。`)) {
    await window.api.clearRecovery().catch(() => {})
    showToast('已丢弃上次的恢复快照')
    return
  }
  try {
    await controller.loadRecovered(found.data, found.projectPath)
    showToast('已恢复上次异常退出前的画布，仍需另行保存')
  } catch (error) {
    // 恢复失败也不能动用户的正式工程
    showToast(`恢复失败：${error.message}`)
  }
}

function activateUnifiedCanvas() {
  const controller = ensureBoardController()
  canvasSurface.classList.add('active-surface')
  requestAnimationFrame(() => controller.fit())
  checkRecoverySnapshot(controller)
  return controller
}

// ══ U1 · 统一画布命令栏与工具路由 ══════════════════════════

/**
 * 搜索直达图片工具时的一次性目标。
 * 只在「无图 → 触发导入 → 导入成功」这条路径上短暂存在；
 * 取消或失败必须清空，否则下次导入会被上一次的意图劫持。
 */
let pendingImageTool = null

const IMAGE_TOOLS = new Set(['crop', 'adjust'])

/** 全屏图片编辑器（U4）。懒创建：没打开过就不建实例。 */
let imageEditorModal = null

function ensureImageEditor() {
  if (imageEditorModal) return imageEditorModal
  imageEditorModal = new ImageEditorModal({
    fabric,
    onStatus: (message) => showToast(message),
    confirmDiscard: () => window.confirm('放弃本次编辑？未完成的修改会丢失。'),
    onCancel: () => {
      // 取消什么都不做：场景、资源、主历史逐字段不变（规格 5.2）
    },
    // ⚠ 不在这里 catch：失败必须传回模态，让它保持打开、保住操作栈。
    //   吞掉异常会让模态以为提交成功并关闭，用户的编辑就没了。
    /**
     * 编辑器的动作执行器（S4）：OCR 与钉住。
     *
     * ⚠ 作用于**当前编辑结果**，不是最初的原图——传进来的 bytes 就是
     * 渲染管线的当前缓冲。
     *
     * 钉住已从这里移除（S4）：编辑器里钉的是一份还没提交的预览，
     * 语义含糊。独立的截图钉住功能不受影响，仍在。
     */
    onAction: async (action, { bytes }) => {
      if (action === 'ocr') {
        showToast('正在识别文字…')
        ocrToastActive = true
        try {
          const result = await window.api.recognizeScreenshot(bytes)
          const text = (result?.text || '').trim()
          if (!text) return '未识别到文字'
          await window.api.copyScreenshotText(text)
          return `已识别 ${text.length} 个字符并复制`
        } finally {
          ocrToastActive = false
        }
      }
      return `暂不支持的操作：${action}`
    },
    onCommit: async ({ blob, size, context }) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (context?.nodeId) {
        await boardController.replaceNodeImage(context.nodeId, {
          bytes, mime: 'image/png', size
        })
      } else {
        await boardController.addImage(bytes, 'image/png')
      }
    }
  })
  return imageEditorModal
}

/**
 * 打开全屏图片编辑器。
 *
 * 两个入口共用：画布双击/工具按钮传 image（含 nodeId），
 * 截图入口传 { bytes, mime } 且不带 nodeId。
 */
/** 把字节解码成 <img>。解码完成后 objectURL 立刻回收。 */
async function decodeImageBytes(bytes, mime = 'image/png') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  try {
    return await new Promise((resolve, reject) => {
      const probe = new Image()
      probe.addEventListener('load', () => resolve(probe))
      probe.addEventListener('error', () => reject(new Error('图片无法解码')))
      probe.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 编辑器只有一个实例，同一时刻只能开一张图。
 * 这个令牌挡住「解码还没回来又发起了第二次打开」——否则两次解码
 * 先后完成时会各自调 open()，第二次覆盖掉第一次的 fabric 实例。
 */
let imageEditorOpening = false

async function openImageEditor(image, tool) {
  if (!image?.bytes) {
    showToast('图片数据不可用')
    return false
  }
  const editor = ensureImageEditor()
  if (imageEditorOpening || editor.isOpen) {
    showToast('图片编辑器已打开')
    return false
  }
  imageEditorOpening = true
  try {
    const bitmap = await decodeImageBytes(image.bytes, image.mime)
    return editor.open({
      image: bitmap,
      assetId: image.assetId || 'capture',
      originNodeId: image.nodeId || null,
      origin: image.nodeId ? 'canvas' : 'capture',
      canRestore: Boolean(image.canRestore),
      // 锁定的图片以**只读**方式进来：可以提取文字、钉住，不能改像素（S4）
      readOnly: Boolean(image.readOnly),
      context: { nodeId: image.nodeId || null },
      // 「恢复原图」按需取原图字节：不预先解码，没点就不付这个代价
      loadOriginal: image.canRestore && image.nodeId
        ? async () => {
            const original = boardController.getNodeOriginalImage(image.nodeId)
            if (!original?.bytes) throw new Error('原图数据已不可用')
            return {
              assetId: original.assetId,
              image: await decodeImageBytes(original.bytes, original.mime)
            }
          }
        : null,
      tool
    })
  } catch (error) {
    showToast(`打开编辑器失败：${error.message}`)
    return false
  } finally {
    imageEditorOpening = false
  }
}

/** 当前可编辑的单选图片；不满足条件时返回原因。 */
function singleEditableImage() {
  const controller = boardController
  if (!controller) return { ok: false, reason: 'no-canvas' }
  const scene = controller.getSceneSnapshot()
  const ids = controller.inspector().getSelection()
  if (ids.length !== 1) {
    return { ok: false, reason: scene.nodes.some((n) => n.type === 'image') ? 'not-single' : 'no-image' }
  }
  const node = scene.nodes.find((n) => n.id === ids[0])
  if (!node || node.type !== 'image') return { ok: false, reason: 'not-image' }
  if (node.locked) return { ok: false, reason: 'locked' }
  return { ok: true, node }
}

/**
 * 搜索直达图片工具的统一入口。
 *
 * · 已单选未锁定图片 → 直接打开编辑器并预选工具
 * · 画布无可编辑图片 → 触发导入，用 pendingImageTool 记住意图
 * · 选中的是锁定图片 → 提示解锁，不绕过锁定
 */
function requestImageTool(tool) {
  if (tool === 'capture') {
    startUnifiedCapture()
    return
  }
  if (!IMAGE_TOOLS.has(tool)) return

  const pick = singleEditableImage()
  if (pick.ok) {
    openImageEditor(boardController.getNodeImage(pick.node.id), tool)
    return
  }
  if (pick.reason === 'locked') {
    showToast('该图片已锁定，请先解锁再编辑')
    return
  }
  if (pick.reason === 'not-single') {
    showToast('请先单选一张图片再使用该工具')
    return
  }
  // 画布上没有可编辑图片：先导入，导入成功后再打开
  pendingImageTool = tool
  boardFileInput.click()
}

/** 导入结束后消费 pending；无论成功失败都必须清空。 */
function consumePendingImageTool(imported) {
  const tool = pendingImageTool
  pendingImageTool = null
  if (!tool) return
  if (!imported) return // 用户取消或导入失败：不打开空编辑器，不污染历史
  const pick = singleEditableImage()
  if (pick.ok) openImageEditor(boardController.getNodeImage(pick.node.id), tool)
}

/** 区域截图是否在进行中。旧截图页删除后，这是唯一的忙碌标记。 */
let regionCaptureBusy = false

/**
 * 发起区域截图。
 * @returns {Promise<boolean>} 覆盖层是否真的起来了。
 *
 * 返回值很重要：调用方要靠它决定截图结果归谁。忙碌中直接返回 false，
 * 启动异常也返回 false——两种情况都不会有 captured/cancelled 回调，
 * 若此时留下"结果归画布"的标记，下一次截图结果就会被劫持。
 */
async function beginRegionScreenshot() {
  if (regionCaptureBusy) return false
  regionCaptureBusy = true
  try {
    await window.api.startScreenshot()
    return true
  } catch (error) {
    regionCaptureBusy = false
    showToast(`截图失败：${error instanceof Error ? error.message : error}`)
    return false
  }
}

// 截图结果：直接成为画布上的普通图片对象，不自动打开编辑器（规格 6）
window.api.onScreenshotCaptured((result) => {
  regionCaptureBusy = false
  if (!captureTargetsCanvas) return
  captureTargetsCanvas = false
  ;(async () => {
    const controller = ensureBoardController()
    controller.beginAddTransaction()
    try {
      await controller.addImage(new Uint8Array(result.data), 'image/png')
      showToast('截图已加入画布')
    } catch (error) {
      showToast(`截图加入画布失败：${error.message}`)
    } finally {
      controller.endAddTransaction()
    }
  })()
})

window.api.onScreenshotCancelled(() => {
  regionCaptureBusy = false
  captureTargetsCanvas = false
})

// ── 全局截图快捷键（规格 6）────────────────────────────────
// 主进程注册 Ctrl+Shift+A，触发后走与命令栏按钮**同一个入口**，
// 不复制第二套截图逻辑。
window.api.onCaptureShortcut(() => {
  startUnifiedCapture()
})

window.api.onShortcutStatus((status) => {
  // 注册成功不打扰用户；失败必须说清楚是被占用，且应用照常可用
  if (!status?.ok) showToast(status?.message || '全局截图快捷键注册失败')
})

// 告诉主进程渲染端已就绪，补发启动期间可能错过的注册结果
window.api.reportShortcutReady()

/**
 * 截图结果是否应进统一编辑器。
 * 只在「从画布发起截图」这条路径上为真；取消时必须清掉，
 * 否则下次从旧截图页发起会被劫持。
 */
let captureTargetsCanvas = false

/** 区域截图统一入口。命令栏按钮与全局快捷键都走这里。 */
async function startUnifiedCapture() {
  activateUnifiedCanvas()
  // ⚠ 只有确认覆盖层起来了才置标记。启动失败或忙碌时置了却等不到回调，
  //   标记会一直挂着，把下一次别处发起的截图结果劫持到画布上。
  const started = await beginRegionScreenshot()
  captureTargetsCanvas = started
  return started
}

// ── 命令栏：委托到既有实现，不复制第二套逻辑 ──
const cmdCapture = document.querySelector('#cmd-capture')
const cmdImport = document.querySelector('#cmd-import')
const cmdText = document.querySelector('#cmd-text')
const cmdProject = document.querySelector('#cmd-project')
const projectMenu = document.querySelector('#project-menu')
const cmdBackground = document.querySelector('#cmd-background')
const backgroundMenu = document.querySelector('#background-menu')
const boardBgColor = document.querySelector('#board-bg-color')
const cmdView = document.querySelector('#cmd-view')
const viewMenu = document.querySelector('#view-menu')
const boardStage = document.querySelector('#board-stage')
const boardEmptyImport = document.querySelector('#board-empty-import')

/** 同一时刻只允许一个下拉打开。 */
/**
 * ══ 浮层管理器（S1）══
 *
 * 所有"同层浮层"登记在这里，解决三件事：
 *   · 开新的要关掉同层的旧的——两个下拉同时开着，用户不知道该点哪个；
 *   · Esc **只关最上层**，不能一次全关掉，也不能越过模态去关下面的；
 *   · 点浮层内部不穿透到画布——不加的话点击会冒到 document，
 *     被"点空白取消选择"的兜底清掉选中，浮层跟着消失。
 *
 * 登记表按**打开顺序**维护，最后打开的就是最上层。
 */
const popovers = []
/** @type {Array<{menu: HTMLElement, trigger: HTMLElement|null}>} */
const openPopovers = []
const overlayLayer = document.querySelector('#overlay-layer')

function registerPopover(menu, trigger = null, placement = {}) {
  if (!menu) return
  const existing = popovers.find((entry) => entry.menu === menu)
  if (existing) {
    existing.trigger = trigger
    existing.placement = placement
    return
  }
  overlayLayer?.append(menu)
  popovers.push({ menu, trigger, placement })
  // 点内部不穿透；mousedown 也要拦，否则会把焦点从画布抢走
  menu.addEventListener('mousedown', (event) => {
    if (!event.target.closest('input, select, textarea')) event.preventDefault()
  })
  menu.addEventListener('click', (event) => event.stopPropagation())
}

function isPopoverOpen(menu) { return openPopovers.some((p) => p.menu === menu) }

function openPopover(menu) {
  const entry = popovers.find((p) => p.menu === menu)
  if (!entry) return
  closePopovers(menu) // 同层互斥
  menu.hidden = false
  entry.trigger?.setAttribute('aria-expanded', 'true')
  if (!isPopoverOpen(menu)) openPopovers.push(entry)
  if (entry.trigger) placePopover(menu, entry.trigger, entry.placement)
}

function closePopover(menu) {
  const at = openPopovers.findIndex((p) => p.menu === menu)
  if (at === -1) return
  const [entry] = openPopovers.splice(at, 1)
  entry.menu.hidden = true
  entry.trigger?.setAttribute('aria-expanded', 'false')
}

/** 关闭全部（可留一个）。点画布空白、切模块等场景用。 */
function closePopovers(except = null) {
  for (const entry of [...openPopovers]) {
    if (entry.menu === except) continue
    closePopover(entry.menu)
  }
}

/** 关掉最上层的一个，返回是否关掉了。Esc 用。 */
function closeTopPopover() {
  const top = openPopovers[openPopovers.length - 1]
  if (!top) return false
  closePopover(top.menu)
  top.trigger?.focus({ preventScroll: true })
  // 焦点被送回触发按钮，但这不是选区变化——文本工具栏的显隐只在
  // 选区变化时重算，不补这一下的话，字体/对齐菜单关闭后工具栏会
  // 一直卡在隐藏，直到用户重新点一次画布对象。
  boardController?.resyncToolbarVisibility()
  return true
}

/** 把浮层定位到触发钮下方；越界时钳制回窗口内。position: fixed，用视口坐标。 */
function placePopover(menu, trigger, { align = 'left', gap = 6, matchWidth = false } = {}) {
  menu.hidden = false // 先显形才量得到尺寸
  const t = trigger.getBoundingClientRect()
  if (matchWidth) {
    const triggerWidth = `${Math.round(t.width)}px`
    menu.style.width = triggerWidth
    menu.style.minWidth = triggerWidth
    menu.style.maxWidth = triggerWidth
  }
  const m = menu.getBoundingClientRect()
  let left = align === 'right' ? t.right - m.width : t.left
  left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8))
  // 下方放不下就翻到上方
  let top = t.bottom + gap
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, t.top - m.height - gap)
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
}

function repositionOpenPopovers() {
  for (const entry of openPopovers) {
    if (!entry.trigger?.isConnected || entry.trigger.hidden) {
      closePopover(entry.menu)
      continue
    }
    placePopover(entry.menu, entry.trigger, entry.placement)
  }
}

function closeAllCmdMenus(except = null) {
  closePopovers(except)
}

function toggleCmdMenu(trigger, menu) {
  if (isPopoverOpen(menu)) closePopover(menu)
  else openPopover(menu)
}

// 登记画布命令栏菜单
registerPopover(projectMenu, cmdProject)
registerPopover(backgroundMenu, cmdBackground, { align: 'right' })
registerPopover(viewMenu, cmdView, { align: 'right' })

// ── 文本工具栏的字体 / 对齐菜单（S1：替换原生 select）──
const textFontTrigger = document.querySelector('#text-font-trigger')
const textFontMenu = document.querySelector('#text-font-menu')
const textAlignTrigger = document.querySelector('#text-align-trigger')
const textAlignMenu = document.querySelector('#text-align-menu')
registerPopover(textFontMenu, textFontTrigger)
registerPopover(textAlignMenu, textAlignTrigger)

function placePdfQualityMenu() {
  if (!isPopoverOpen(pdfJpegQualityMenu)) return
  const trigger = pdfOptions.querySelector('#pdf-jpeg-quality')
  if (!trigger) {
    closePopover(pdfJpegQualityMenu)
    return
  }
  placePopover(pdfJpegQualityMenu, trigger, { matchWidth: true })
}

window.addEventListener('resize', repositionOpenPopovers)
window.addEventListener('scroll', repositionOpenPopovers, true)

const ALIGN_LABEL = { left: '左对齐', center: '居中', right: '右对齐' }

function bindTextPopover(trigger, menu, onPick) {
  trigger?.addEventListener('mousedown', (event) => event.preventDefault())
  trigger?.addEventListener('click', (event) => {
    event.stopPropagation()
    if (isPopoverOpen(menu)) { closePopover(menu); return }
    openPopover(menu)
    placePopover(menu, trigger)
  })
  menu?.addEventListener('click', (event) => {
    const item = event.target.closest('button')
    if (!item) return
    closePopover(menu)
    onPick(item)
  })
}
bindTextPopover(textFontTrigger, textFontMenu, (item) => {
  boardController?.applyTextStyleFromToolbar({ fontFamily: item.dataset.font })
})
bindTextPopover(textAlignTrigger, textAlignMenu, (item) => {
  boardController?.applyTextStyleFromToolbar({ textAlign: item.dataset.align })
})

// ── 全应用 Select 适配层 ──────────────────────────────────
// 原生 select 的弹层由系统窗口绘制，无法解决圆角容器裁切、主题和宽度不一致。
// 保留原 select 作为唯一数据源，只替换它的可视触发器与菜单：业务代码继续读写
// select.value 并监听 change，不需要维护第二份状态。
const enhancedSelects = new Map()
let appSelectSequence = 0

function selectAccessibleName(select) {
  const explicit = select.getAttribute('aria-label')
  if (explicit) return explicit
  const label = select.closest('label')
  if (!label) return '选择选项'
  return [...label.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join(' ') || '选择选项'
}

function syncEnhancedSelect(select) {
  const entry = enhancedSelects.get(select)
  if (!entry) return
  const option = select.selectedOptions[0]
  const label = option?.textContent?.trim() || '请选择'
  const invalid = select.getAttribute('aria-invalid') || 'false'
  if (entry.trigger.textContent !== label) entry.trigger.textContent = label
  if (entry.trigger.title !== label) entry.trigger.title = label
  if (entry.trigger.disabled !== select.disabled) entry.trigger.disabled = select.disabled
  if (entry.trigger.hidden !== select.hidden) entry.trigger.hidden = select.hidden
  if (entry.trigger.getAttribute('aria-invalid') !== invalid) entry.trigger.setAttribute('aria-invalid', invalid)
  if ((select.disabled || select.hidden) && isPopoverOpen(entry.menu)) closePopover(entry.menu)
}

function renderEnhancedSelectMenu(select) {
  const entry = enhancedSelects.get(select)
  if (!entry) return
  entry.menu.replaceChildren(...[...select.options].map((option) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.role = 'option'
    item.dataset.value = option.value
    item.textContent = option.textContent
    item.title = option.textContent
    item.disabled = option.disabled
    item.setAttribute('aria-selected', String(option.selected))
    return item
  }))
}

function focusEnhancedSelectOption(menu, direction = 0) {
  const items = [...menu.querySelectorAll('button:not(:disabled)')]
  if (!items.length) return
  const selected = menu.querySelector('button[aria-selected="true"]:not(:disabled)')
  let index = items.indexOf(document.activeElement)
  if (index === -1) index = Math.max(0, items.indexOf(selected))
  const target = direction === 0
    ? (selected || items[0])
    : items[(index + direction + items.length) % items.length]
  target.focus({ preventScroll: true })
}

function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.multiple || enhancedSelects.has(select)) return

  const menuId = `app-select-menu-${++appSelectSequence}`
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'app-select-trigger'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-controls', menuId)
  trigger.setAttribute('aria-label', selectAccessibleName(select))

  const menu = document.createElement('div')
  menu.id = menuId
  menu.className = 'app-menu app-select-menu'
  menu.role = 'listbox'
  menu.setAttribute('aria-label', selectAccessibleName(select))
  menu.hidden = true

  select.classList.add('app-select-native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')
  select.insertAdjacentElement('afterend', trigger)
  enhancedSelects.set(select, { trigger, menu })
  registerPopover(menu, trigger, { matchWidth: true })
  syncEnhancedSelect(select)

  const label = select.closest('label')
  label?.addEventListener('click', (event) => {
    if (event.target !== label) return
    event.preventDefault()
    trigger.click()
  })

  trigger.addEventListener('click', (event) => {
    event.stopPropagation()
    syncEnhancedSelect(select)
    renderEnhancedSelectMenu(select)
    if (isPopoverOpen(menu)) closePopover(menu)
    else openPopover(menu)
  })
  trigger.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (!isPopoverOpen(menu)) {
      renderEnhancedSelectMenu(select)
      openPopover(menu)
    }
    requestAnimationFrame(() => {
      if (event.key === 'Home') menu.querySelector('button:not(:disabled)')?.focus()
      else if (event.key === 'End') [...menu.querySelectorAll('button:not(:disabled)')].at(-1)?.focus()
      else focusEnhancedSelectOption(menu, event.key === 'ArrowDown' ? 1 : -1)
    })
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      closePopover(menu)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') menu.querySelector('button:not(:disabled)')?.focus()
    else if (event.key === 'End') [...menu.querySelectorAll('button:not(:disabled)')].at(-1)?.focus()
    else focusEnhancedSelectOption(menu, event.key === 'ArrowDown' ? 1 : -1)
  })
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('button[data-value]')
    if (!item || item.disabled) return
    select.value = item.dataset.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    syncEnhancedSelect(select)
    closePopover(menu)
    trigger.focus({ preventScroll: true })
  })
  select.addEventListener('change', () => syncEnhancedSelect(select))
  select.addEventListener('input', () => syncEnhancedSelect(select))
}

function syncAllEnhancedSelects() {
  for (const [select, entry] of enhancedSelects) {
    if (!select.isConnected) {
      closePopover(entry.menu)
      entry.menu.remove()
      entry.trigger.remove()
      enhancedSelects.delete(select)
      continue
    }
    syncEnhancedSelect(select)
  }
}

function installAppSelects(root = document) {
  if (root instanceof HTMLSelectElement) enhanceSelect(root)
  root.querySelectorAll?.('select').forEach(enhanceSelect)
}

const appSelectObserver = new MutationObserver((records) => {
  let childListChanged = false
  for (const record of records) {
    if (record.type === 'childList') {
      childListChanged = true
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) installAppSelects(node)
      })
    } else if (record.target instanceof HTMLSelectElement) {
      syncEnhancedSelect(record.target)
    }
  }
  if (childListChanged) syncAllEnhancedSelects()
})

appSelectObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled', 'hidden', 'aria-invalid']
})
document.addEventListener('click', () => queueMicrotask(syncAllEnhancedSelects))

// ══ F-16 · 全局截图快捷键设置 ══════════════════════════════
//
// 用**录制**而不是让用户手打加速键字符串：手打必然会写出
// "ctrl+shift+a"、"Ctrl + Shift + A" 这类 Electron 不认的形式，
// 然后得到一个语焉不详的失败。录制则天然只产出合法组合。
const shortcutButton = document.querySelector('#shortcut-capture')
const shortcutReset = document.querySelector('#shortcut-reset')
const shortcutEnabled = document.querySelector('#shortcut-enabled')
const shortcutStatus = document.querySelector('#shortcut-status')

let shortcutRecording = false
let shortcutCurrent = null

function setShortcutStatus(text, kind = '') {
  if (!shortcutStatus) return
  shortcutStatus.textContent = text
  shortcutStatus.className = `shortcut-status${kind ? ' ' + kind : ''}`
  shortcutStatus.hidden = kind !== 'error'
}

function paintShortcut(accelerator, disabled) {
  shortcutCurrent = accelerator
  if (shortcutButton) {
    shortcutButton.textContent = accelerator || '未设置'
    shortcutButton.disabled = Boolean(disabled)
  }
  if (shortcutEnabled) shortcutEnabled.checked = !disabled
}

/** 把 KeyboardEvent 翻成 Electron 的 accelerator。 */
function toAccelerator(event) {
  const mods = []
  if (event.ctrlKey) mods.push('Control')
  if (event.metaKey) mods.push('Command')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  const key = event.key
  // 只按了修饰键：还没构成组合，继续等
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null
  if (!mods.length) return null // 全局快捷键必须带修饰键，否则会吃掉普通按键
  let name = key.length === 1 ? key.toUpperCase() : key
  if (name === ' ') name = 'Space'
  if (name.startsWith('Arrow')) name = name.slice(5)
  return [...mods, name].join('+')
}

async function loadShortcut() {
  if (!shortcutButton) return
  try {
    const info = await window.api.getCaptureShortcut()
    paintShortcut(info.accelerator, info.disabled)
    setShortcutStatus(info.disabled
      ? '已关闭。可继续用界面上的截图按钮。'
      : `当前生效：${info.accelerator}`)
  } catch (error) {
    setShortcutStatus(`读取设置失败：${cleanIpcError(error?.message ?? error)}`, 'error')
  }
}

async function applyShortcut(accelerator) {
  try {
    const result = await window.api.setCaptureShortcut({ accelerator })
    paintShortcut(result.accelerator, result.disabled)
    if (result.ok) {
      setShortcutStatus(result.disabled ? '已关闭全局快捷键。' : `已生效：${result.accelerator}`, 'ok')
    } else {
      // 失败时主进程已回滚到原设置，这里如实说明发生了什么
      setShortcutStatus(result.message || '设置失败，已保留原有快捷键。', 'error')
    }
  } catch (error) {
    setShortcutStatus(`设置失败：${cleanIpcError(error?.message ?? error)}`, 'error')
  }
}

shortcutButton?.addEventListener('click', () => {
  shortcutRecording = true
  shortcutButton.classList.add('recording')
  shortcutButton.textContent = '按下新的组合…'
  setShortcutStatus('按下组合键，或按 Esc 取消。')
})

// 捕获阶段：录制时要抢在应用其他快捷键之前拿到按键
document.addEventListener('keydown', (event) => {
  if (!shortcutRecording) return
  event.preventDefault()
  event.stopPropagation()
  const finish = () => {
    shortcutRecording = false
    shortcutButton.classList.remove('recording')
  }
  if (event.key === 'Escape') {
    finish()
    paintShortcut(shortcutCurrent, !shortcutEnabled?.checked)
    setShortcutStatus('已取消，未做修改。')
    return
  }
  const accelerator = toAccelerator(event)
  if (!accelerator) return // 只按了修饰键，继续等
  finish()
  void applyShortcut(accelerator)
}, true)

shortcutReset?.addEventListener('click', async () => {
  try {
    const result = await window.api.resetCaptureShortcut()
    paintShortcut(result.accelerator, false)
    setShortcutStatus(result.ok ? `已恢复默认：${result.accelerator}` : (result.message || '恢复失败'),
      result.ok ? 'ok' : 'error')
    if (shortcutEnabled) shortcutEnabled.checked = true
  } catch (error) {
    setShortcutStatus(`恢复失败：${cleanIpcError(error?.message ?? error)}`, 'error')
  }
})

shortcutEnabled?.addEventListener('change', () => {
  // 关闭传 null；重新启用则恢复上一次的组合，没有就用默认
  void applyShortcut(shortcutEnabled.checked ? (shortcutCurrent || 'Control+Shift+A') : null)
})

// 窗口恢复后重新激活画布（F-15）。挂在这里而不是控制器内部：
// 控制器是懒创建的，没打开过画布时不该因为窗口恢复就把它建出来。
window.api.onWindowRevive?.(() => boardController?.reviveAfterRestore())

void loadShortcut()

cmdCapture.addEventListener('click', () => startUnifiedCapture())
cmdImport.addEventListener('click', () => {
  activateUnifiedCanvas()
  boardFileInput.click()
})
boardEmptyImport?.addEventListener('click', () => cmdImport.click())
cmdText.addEventListener('click', () => {
  activateUnifiedCanvas()
  ensureBoardController().addText('textbox')
})

cmdProject.addEventListener('click', (event) => {
  event.stopPropagation()
  toggleCmdMenu(cmdProject, projectMenu)
})
projectMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-project]')
  if (!button) return
  closeAllCmdMenus()
  const controller = ensureBoardController()
  // ⚠ 这里的每个分支都必须对应控制器上**真实存在**的方法。
  //   曾经有过 export-png 调用早已改名的 exportPng()、export-jpg 与 new
  //   直接掉进 default 的情况——底部隐藏按钮接的是对的，所以 harness 全绿，
  //   而用户真正在用的顶部菜单完全不工作。
  switch (button.dataset.project) {
    case 'new': void controller.newBoard(); break
    case 'open': void controller.open(); break
    case 'save': void controller.save(false); break
    case 'save-as': void controller.save(true); break
    case 'export-png': void controller.exportImage({ range: 'content', format: 'png' }); break
    case 'export-jpg': void controller.exportImage({ range: 'content', format: 'jpg' }); break
    default: showToast(`暂不支持的操作：${button.textContent.trim()}`)
  }
})

cmdBackground.addEventListener('click', (event) => {
  event.stopPropagation()
  syncBackgroundMenu()
  toggleCmdMenu(cmdBackground, backgroundMenu)
})
backgroundMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-bg], [data-bg-color]')
  if (!button) return
  const controller = ensureBoardController()
  const key = button.dataset.bg
  // 网格两个开关是切换项，点完不关菜单，方便连着点。
  // ⚠ 必须 stopPropagation：document 上有「点任何地方都关菜单」的兜底监听，
  //   光是不调用 closeAllCmdMenus() 拦不住冒泡。
  if (key === 'grid' || key === 'snap') {
    event.stopPropagation()
    const next = button.getAttribute('aria-checked') !== 'true'
    button.setAttribute('aria-checked', String(next))
    if (key === 'grid') controller.setShowGrid(next)
    else controller.setSnapGrid(next)
    return
  }
  if (button.dataset.bgColor) {
    controller.setBackground({ type: 'color', color: button.dataset.bgColor })
    syncBackgroundMenu()
    showToast(`背景已设为 ${button.getAttribute('aria-label') || button.dataset.bgColor}`)
    return
  }
  closeAllCmdMenus()
  if (key === 'transparent') {
    controller.setBackground({ type: 'transparent' })
    syncBackgroundMenu()
    showToast('背景已设为透明')
    return
  }
  if (key === 'custom') {
    // 原生取色器：change 时才落定，避免拖动过程刷满历史
    boardBgColor.value = controller.background?.color || '#ffffff'
    boardBgColor.click()
    return
  }
  showToast(`暂不支持的背景选项：${button.textContent.trim()}`)
})

cmdView.addEventListener('click', (event) => {
  event.stopPropagation()
  syncViewMenu()
  toggleCmdMenu(cmdView, viewMenu)
})

viewMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]')
  if (!button) return
  const controller = ensureBoardController()
  const action = button.dataset.view
  if (action === 'rulers') {
    event.stopPropagation()
    boardStage.classList.toggle('show-rulers')
    syncViewMenu()
    return
  }
  closeAllCmdMenus()
  if (action === 'fit') {
    controller.fitToContent()
    return
  }
  if (action === 'new') {
    void controller.newBoard()
  }
})

boardBgColor.addEventListener('change', () => {
  const controller = ensureBoardController()
  controller.setBackground({ type: 'color', color: boardBgColor.value })
  syncBackgroundMenu()
  showToast(`背景已设为 ${boardBgColor.value}`)
})

/** 把菜单里的勾选态与场景真值对齐，避免显示与实际不符。 */
function syncBackgroundMenu() {
  const controller = boardController
  if (!controller) return
  const bg = controller.background
  backgroundMenu.querySelector('[data-bg="transparent"]')
    ?.setAttribute('aria-checked', String(bg.type === 'transparent'))
  backgroundMenu.querySelector('[data-bg="grid"]')
    ?.setAttribute('aria-checked', String(controller.showGrid))
  backgroundMenu.querySelector('[data-bg="snap"]')
    ?.setAttribute('aria-checked', String(controller.snapGrid))
  for (const swatch of backgroundMenu.querySelectorAll('[data-bg-color]')) {
    swatch.setAttribute('aria-checked', String(
      bg.type === 'color' && bg.color?.toLowerCase() === swatch.dataset.bgColor.toLowerCase()
    ))
  }
}

function syncViewMenu() {
  viewMenu.querySelector('[data-view="rulers"]')
    ?.setAttribute('aria-checked', String(boardStage.classList.contains('show-rulers')))
}

// 取消文件选择时 change 不会触发，必须靠 cancel 清掉 pending，
// 否则下次导入会被上一次的意图劫持。
boardFileInput.addEventListener('cancel', () => consumePendingImageTool(false))

document.addEventListener('click', () => closePopovers())
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  // ⚠ 只关**最上层**一个，不是全关。连着按两次 Esc 才关两层，
  //   这样用户的每一次 Esc 都有确定的、可预期的效果。
  //   模态编辑器开着时轮不到这里——它在捕获阶段就把 Esc 拿走了。
  if (closeTopPopover()) {
    event.preventDefault()
    event.stopPropagation()
  }
})


/**
 * 发起区域截图。
 * @returns {Promise<boolean>} 覆盖层是否真的起来了。
 *
 * 返回值很重要：调用方要靠它决定截图结果归谁。忙碌中直接返回 false，
 * 启动异常也返回 false——两种情况都不会有 captured/cancelled 回调，
 * 若此时留下"结果归画布"的标记，下一次从旧截图页发起的结果就会被劫持。
 */

const ocrProgressLabels = {
  'loading tesseract core': '载入 OCR 核心',
  'initializing tesseract': '初始化 OCR 核心',
  'loading language traineddata': '载入中英文模型',
  'initializing api': '初始化识别引擎',
  'recognizing text': '正在识别文字'
}

// OCR 首次运行要下载/初始化 Tesseract 核心和语言包，图片编辑器里点一次 OCR
// 之前只会看到一句不会变的"正在识别文字…"，直到几秒后结果或错误跳出来——
// 主进程一直在发这几个阶段的进度事件，只是没人订阅。用同一个 toast 承载，
// 不需要新增界面元素。
let ocrToastActive = false
window.api.onScreenshotOcrProgress((progress) => {
  if (!ocrToastActive) return
  const label = ocrProgressLabels[progress.status]
  if (!label) return
  const percent = Number.isFinite(progress.progress) ? `${Math.round(progress.progress * 100)}%` : ''
  showToast(percent ? `${label} ${percent}` : label)
})

let screenshotResizeTimer

const illustratorModule = initIllustrator({ showToast, bindFileDropZone, droppedFilePaths })
const barcodeModule = initBarcode({ state, showToast, barcodeTypes, barcodeFonts })
const pdfModule = initPdfTools({
  state,
  showToast,
  bindFileDropZone,
  droppedFilePaths,
  registerPopover,
  openPopover,
  closePopover,
  placePopover,
  isPopoverOpen
})

const dielineModule = initDieline({ showToast })

window.addEventListener('beforeunload', () => {
  pdfModule.terminateQpdfRunner()
})

const imageEditor = document.querySelector('#image-editor')

function enlivenImageObjects(objects) {
  return new Promise((resolve) => {
    fabric.util.enlivenObjects(objects || [], resolve)
  })
}

function clampColor(value) {
  return Math.max(0, Math.min(255, value))
}

let updatingImageResize = false

let imageResizeTimer

const submenuIconMap = new Map()
for (const [module, groups] of Object.entries(submenuData)) {
  for (const group of groups) {
    for (const [name, icon, color] of group.items) {
      submenuIconMap.set(`${module}:${name}`, { icon, color })
    }
  }
}

const moduleSearchIcons = {
  ai: { icon: 'Ai', color: '#31a766' },
  image: { icon: 'IMG', color: '#6978e6' },
  more: { icon: 'SET', color: '#737789' }
}

const searchModuleOrder = Object.keys(moduleLabels)

function searchFeatureIcon(feature) {
  return submenuIconMap.get(`${feature.module}:${feature.action}`)
    || submenuIconMap.get(`${feature.module}:${feature.name}`)
    || moduleSearchIcons[feature.module]
    || { icon: moduleLabels[feature.module].slice(0, 3), color: '#6978e6' }
}

function renderSearchResults(query) {
  const normalized = query.trim().toLowerCase()
  const score = (feature) => {
    const name = feature.name.toLowerCase()
    const group = feature.group.toLowerCase()
    if (!normalized || name.startsWith(normalized)) return 0
    if (name.includes(normalized)) return 1
    if (group.includes(normalized)) return 2
    return 3
  }
  const matches = normalized
    ? searchFeatures.filter((feature) => feature.searchable.includes(normalized))
    : [...searchFeatures]
  state.searchMatches = searchModuleOrder.flatMap((module) => matches
    .filter((feature) => feature.module === module)
    .sort((left, right) => score(left) - score(right)))
  state.activeSearchIndex = -1

  if (!state.searchMatches.length) {
    const empty = document.createElement('div')
    empty.className = 'search-empty'
    empty.textContent = '没有匹配的功能'
    searchResults.replaceChildren(empty)
  } else {
    const fragment = document.createDocumentFragment()
    let previousModule = ''

    state.searchMatches.forEach((feature, index) => {
      if (feature.module !== previousModule) {
        const heading = document.createElement('div')
        heading.className = 'search-group'
        heading.textContent = feature.group
        fragment.append(heading)
        previousModule = feature.module
      }

      const button = document.createElement('button')
      const icon = document.createElement('i')
      const name = document.createElement('span')

      button.type = 'button'
      button.className = `search-result${index === state.activeSearchIndex ? ' keyboard-active' : ''}`
      button.dataset.index = String(index)
      button.setAttribute('role', 'option')
      const iconInfo = searchFeatureIcon(feature)
      icon.textContent = iconInfo.icon
      icon.style.background = iconInfo.color
      name.textContent = feature.name
      button.append(icon, name)
      fragment.append(button)
    })

    searchResults.replaceChildren(fragment)
  }

  searchResults.classList.add('open')
  searchInput.setAttribute('aria-expanded', 'true')
}

function closeSearch() {
  searchResults.classList.remove('open')
  searchInput.setAttribute('aria-expanded', 'false')
}

function runSearchResult(index) {
  const feature = state.searchMatches[index]
  if (!feature) return

  activateModule(feature.module, feature.action)
  searchInput.value = ''
  closeSearch()
}

function refreshActiveSearchResult() {
  searchResults.querySelectorAll('.search-result').forEach((button, index) => {
    button.classList.toggle('keyboard-active', index === state.activeSearchIndex)
  })
}

searchInput.addEventListener('focus', () => renderSearchResults(searchInput.value))
searchInput.addEventListener('input', () => renderSearchResults(searchInput.value))
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    state.activeSearchIndex = Math.min(state.activeSearchIndex + 1, state.searchMatches.length - 1)
    refreshActiveSearchResult()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    state.activeSearchIndex = state.activeSearchIndex < 0
      ? state.searchMatches.length - 1
      : Math.max(state.activeSearchIndex - 1, 0)
    refreshActiveSearchResult()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    runSearchResult(state.activeSearchIndex < 0 ? 0 : state.activeSearchIndex)
  } else if (event.key === 'Escape') {
    closeSearch()
    searchInput.blur()
  }
})

searchResults.addEventListener('click', (event) => {
  const button = event.target.closest('.search-result')
  if (button) runSearchResult(Number(button.dataset.index))
})

searchResults.addEventListener('pointermove', () => {
  if (state.activeSearchIndex < 0) return
  state.activeSearchIndex = -1
  refreshActiveSearchResult()
})

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.search-wrap')) closeSearch()
})

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  }
})

const timerStartedAt = Date.now()
const mochiTime = document.querySelector('#mochi-time')

function updateMochiTimer() {
  const elapsedSeconds = Math.floor((Date.now() - timerStartedAt) / 1000)
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')
  const seconds = String(elapsedSeconds % 60).padStart(2, '0')
  mochiTime.textContent = `${minutes}:${seconds}`
}

updateMochiTimer()
window.setInterval(updateMochiTimer, 1000)

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(theme) {
  const resolved = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme
  document.body.dataset.theme = resolved
  document.body.dataset.themePreference = theme
  localStorage.setItem('theme', theme)
}

document.querySelectorAll('input[name="theme"]').forEach((input) => {
  input.addEventListener('change', () => applyTheme(input.value))
})

systemTheme.addEventListener('change', () => {
  if (document.body.dataset.themePreference === 'system') applyTheme('system')
})

const savedTheme = localStorage.getItem('theme') || 'system'
const savedThemeInput = document.querySelector(`input[name="theme"][value="${savedTheme}"]`)
if (savedThemeInput) savedThemeInput.checked = true
applyTheme(savedTheme)

const colorState = { h: 0, s: 0, l: 0, r: 105, g: 120, b: 230 }
const colorWheel = document.querySelector('#color-wheel')
const colorMarker = document.querySelector('#wheel-marker')
const colorContext = colorWheel.getContext('2d')

function drawColorWheel() {
  const outerRadius = 90
  const innerRadius = 50

  for (let angle = 0; angle < 360; angle += 1) {
    const start = (angle - 1) * Math.PI / 180
    const end = (angle + 1) * Math.PI / 180

    for (let radius = innerRadius; radius <= outerRadius; radius += 2) {
      const saturation = (radius - innerRadius) / (outerRadius - innerRadius)
      colorContext.fillStyle = `hsl(${angle} ${Math.round(saturation * 100)}% 55%)`
      colorContext.beginPath()
      colorContext.arc(100, 100, radius, start, end)
      colorContext.lineTo(100, 100)
      colorContext.fill()
    }
  }
}

function rgbToHsl(red, green, blue) {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2

  if (max === min) {
    colorState.h = 0
    colorState.s = 0
  } else {
    const delta = max - min
    colorState.s = Math.round((lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)) * 100)
    colorState.h = Math.round((
      max === r
        ? (g - b) / delta + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4
    ) * 60)
  }

  colorState.l = Math.round(lightness * 100)
}

function hslToRgb(hue, saturation, lightness) {
  const s = saturation / 100
  const l = lightness / 100
  const amplitude = s * Math.min(l, 1 - l)
  const channel = (offset) => {
    const k = (offset + hue / 30) % 12
    return l - amplitude * Math.max(Math.min(k - 3, 9 - k, 1), -1)
  }

  colorState.r = Math.round(channel(0) * 255)
  colorState.g = Math.round(channel(8) * 255)
  colorState.b = Math.round(channel(4) * 255)
}

function colorHex() {
  return `#${[colorState.r, colorState.g, colorState.b]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

function applyAccent() {
  const rootStyle = document.documentElement.style
  rootStyle.setProperty('--accent-r', colorState.r)
  rootStyle.setProperty('--accent-g', colorState.g)
  rootStyle.setProperty('--accent-b', colorState.b)
  localStorage.setItem('accent', colorHex())
}

function updateColorControls() {
  ;['r', 'g', 'b'].forEach((channel) => {
    document.querySelector(`#color-${channel}`).value = colorState[channel]
    document.querySelector(`#color-${channel}-value`).textContent = colorState[channel]
  })
  document.querySelector('#color-hex').value = colorHex()
  document.querySelector('#color-swatch').style.background = colorHex()
  document.querySelectorAll('[data-accent]').forEach((button) => {
    button.classList.toggle('active', button.dataset.accent.toUpperCase() === colorHex())
  })

  const angle = colorState.h * Math.PI / 180
  const distance = 48 + (colorState.s / 100) * 44
  colorMarker.style.left = `${100 + Math.cos(angle) * distance}px`
  colorMarker.style.top = `${100 + Math.sin(angle) * distance}px`
}

function setAccentFromHex(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return false
  colorState.r = Number.parseInt(value.slice(1, 3), 16)
  colorState.g = Number.parseInt(value.slice(3, 5), 16)
  colorState.b = Number.parseInt(value.slice(5, 7), 16)
  rgbToHsl(colorState.r, colorState.g, colorState.b)
  updateColorControls()
  applyAccent()
  return true
}

function setAccentFromRgbInputs() {
  colorState.r = Number(document.querySelector('#color-r').value)
  colorState.g = Number(document.querySelector('#color-g').value)
  colorState.b = Number(document.querySelector('#color-b').value)
  rgbToHsl(colorState.r, colorState.g, colorState.b)
  updateColorControls()
  applyAccent()
}

document.querySelectorAll('.slider-row input').forEach((input) => {
  input.addEventListener('input', setAccentFromRgbInputs)
})

document.querySelector('#color-hex').addEventListener('change', (event) => {
  const value = event.target.value.trim()
  if (!setAccentFromHex(value)) {
    updateColorControls()
  }
})

document.querySelectorAll('[data-accent]').forEach((button) => {
  button.addEventListener('click', () => setAccentFromHex(button.dataset.accent))
})

document.querySelector('#toggle-custom-accent').addEventListener('click', (event) => {
  const panel = document.querySelector('#custom-accent-panel')
  panel.hidden = !panel.hidden
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden))
  event.currentTarget.textContent = panel.hidden ? '自定义…' : '收起'
})

document.querySelector('#reset-accent').addEventListener('click', () => {
  Object.assign(colorState, { r: 105, g: 120, b: 230 })
  rgbToHsl(colorState.r, colorState.g, colorState.b)
  updateColorControls()
  applyAccent()
})

const settingsLayout = document.querySelector('.settings-layout')
const settingsNavItems = [...document.querySelectorAll('[data-settings-target]')]
const settingsSections = [...document.querySelectorAll('[data-settings-section]')]

function syncSettingsNavigation() {
  if (!settingsLayout || !settingsSections.length) return
  const top = settingsLayout.getBoundingClientRect().top + 18
  const current = settingsSections.reduce((closest, section) => {
    const distance = Math.abs(section.getBoundingClientRect().top - top)
    return distance < closest.distance ? { id: section.id, distance } : closest
  }, { id: settingsSections[0].id, distance: Infinity })
  settingsNavItems.forEach((item) => {
    const active = item.dataset.settingsTarget === current.id
    item.classList.toggle('active', active)
    item.setAttribute('aria-current', active ? 'page' : 'false')
  })
}

settingsNavItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault()
    const section = document.getElementById(item.dataset.settingsTarget)
    if (!settingsLayout || !section) return
    const offset = section.getBoundingClientRect().top - settingsLayout.getBoundingClientRect().top
    settingsLayout.scrollTo({
      top: settingsLayout.scrollTop + offset,
      behavior: 'smooth'
    })
  })
})

settingsLayout?.addEventListener('scroll', syncSettingsNavigation, { passive: true })
syncSettingsNavigation()

window.api.getAppInfo().then((info) => {
  document.querySelector('#app-version').textContent = info.version
}).catch(() => {
  document.querySelector('#app-version').textContent = '版本信息不可用'
})

document.querySelector('#open-github')?.addEventListener('click', async () => {
  try {
    await window.api.openExternal('https://github.com/Clukay-Fun/moyu-tools')
  } catch (error) {
    showToast(`无法打开 GitHub：${cleanIpcError(error?.message ?? error)}`)
  }
})

initUpdatePanel({
  state,
  showToast,
  isIllustratorBusy: () => illustratorModule.isBusy(),
  isFormatFactoryBusy: () => formatFactoryModule.isBusy(),
  isBarcodeBusy: () => barcodeModule.isBusy(),
  isRegionCaptureBusy: () => regionCaptureBusy,
  getBoardController: () => boardController
})

let colorDragging = false

function pickWheelColor(event) {
  const rect = colorWheel.getBoundingClientRect()
  const x = event.clientX - rect.left - 100
  const y = event.clientY - rect.top - 100
  const distance = Math.hypot(x, y)

  if (distance < 48 || distance > 92) return

  colorState.h = Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360)
  colorState.s = Math.round(Math.min(1, Math.max(0, (distance - 48) / 44)) * 100)
  colorState.l = 55
  hslToRgb(colorState.h, colorState.s, colorState.l)
  updateColorControls()
  applyAccent()
}

colorWheel.addEventListener('pointerdown', (event) => {
  colorDragging = true
  colorWheel.setPointerCapture(event.pointerId)
  pickWheelColor(event)
})
colorWheel.addEventListener('pointermove', (event) => {
  if (colorDragging) pickWheelColor(event)
})
colorWheel.addEventListener('pointerup', () => {
  colorDragging = false
})

async function verifyPreloadBridge() {
  try {
    document.body.dataset.ipc = await window.api.ping()
  } catch {
    document.body.dataset.ipc = 'error'
  }
}

const savedAccent = localStorage.getItem('accent')
if (/^#[0-9a-f]{6}$/i.test(savedAccent || '')) {
  colorState.r = Number.parseInt(savedAccent.slice(1, 3), 16)
  colorState.g = Number.parseInt(savedAccent.slice(3, 5), 16)
  colorState.b = Number.parseInt(savedAccent.slice(5, 7), 16)
}

document.querySelector('.search kbd').textContent = /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'

installAppSelects()
drawColorWheel()
rgbToHsl(colorState.r, colorState.g, colorState.b)
updateColorControls()
applyAccent()
barcodeModule.setBarcodeMode('single')
barcodeModule.generateBarcode()
formatFactoryModule.setFormatAction('视频转换')
activateModule('home')
verifyPreloadBridge()

// 启动埋点：首帧绘制且交互就绪后回报主进程（F-018 验收用）。
if (!window.__moyuStartupReported) {
  window.__moyuStartupReported = true
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.api.reportStartupReady())
  )
}
