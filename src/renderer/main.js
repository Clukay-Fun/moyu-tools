import JsBarcode from 'jsbarcode'
import { fabric } from 'fabric'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions, ImageKind, OPS } from 'pdfjs-dist'
import { createQpdfRunner } from 'qpdf-run'
import { parse as parseOpenType } from 'opentype.js'
import { isRetailType, renderRetailBarcode, computeRetailGeometry } from './retailBarcode.js'
import { BoardController } from './board/index.js'
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
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import qpdfWorkerUrl from 'qpdf-run/worker?url'
import qpdfJsUrl from 'qpdf-run/qpdf.js?url'
import qpdfWasmUrl from 'qpdf-run/qpdf.wasm?url'

globalThis.fabric = fabric
const eraserBrushReady = import('fabric/src/mixins/eraser_brush.mixin.js')
  .then(() => fabric.EraserBrush)
GlobalWorkerOptions.workerSrc = pdfWorkerUrl
installTooltips()

const appLogoUrl = new URL('../../assets/app-icon.png', import.meta.url).href

document.querySelectorAll('[data-app-logo]').forEach((image) => {
  image.src = appLogoUrl
})

// 零售合规码 HRI 固定字体（GS1 §5.2.5 禁止粗/斜/细/窄体，不随用户选择变化）
const RETAIL_HRI_FONT_KEY = 'ocrb'

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
    icon: 'AUTO',
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
        ['文字水印', 'WM', '#6978e6'],
        ['图片水印', 'IMG', '#6978e6'],
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
      items: Object.entries(barcodeTypes).map(([name, type]) => [name, type.icon, type.color])
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
  ['文字水印', 'PDF', 'pdf', '文字水印', 'PDF 水印 文字'],
  ['图片水印', 'PDF', 'pdf', '图片水印', 'PDF 水印 图片'],
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
  pdfWatermarkImage: null,
  pdfWatermarkPreviewFileIndex: 0,
  pdfWatermarkPreviewPage: 1,
  pdfWatermarkPreviewPageCount: 0,
  pdfPageItems: [],
  pdfPageOrganizerSource: null,
  pdfPageOrganizerSnapshot: []
}

const submenu = document.querySelector('#submenu')
const searchInput = document.querySelector('#feature-search')
const searchResults = document.querySelector('#search-results')
const toast = document.querySelector('#toast')
let toastTimer
let barcodeRenderedValue = ''
let barcodeRenderedType = ''
let qpdfRunnerPromise = null
let pdfWatermarkPreviewToken = 0
const parsedBarcodeFonts = new Map()

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
  if (animate && changed) animateEntry(activePage, { duration: 180, distance: 7 })

  const deferredMilestone = module === 'pdf' ? deferredPdfActions.get(action) : null

  if (action && submenuData[module] && !deferredMilestone) {
    state.selections[module] = action
  }

  renderSubmenu(module)

  if (module === 'pdf') {
    updatePdfState(state.selections.pdf)
    if (deferredMilestone) showToast(`“${action}”将在 ${deferredMilestone} 接入`)
  } else if (module === 'bc') {
    document.querySelector('#bc-crumb').textContent = state.selections.bc
    if (action) selectBarcodeType(action, true)
  } else if (module === 'image') {
    // U1：image 即统一画布。搜索传来的 action 走工具路由，不再切旧编辑器模式。
    activateUnifiedCanvas()
    if (action) requestImageTool(action)
  } else if (module === 'video') {
    setFormatAction(state.selections.video)
  }

  // 离开画布时收起浮动工具栏，并取消待执行的跟随更新（S2）。
  // 不收的话，切回来会先看到它停在旧位置再跳走。
  if (module !== 'image') boardController?.hideFloatingToolbars()
}

const pdfActionConfig = {
  '转 PNG': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
  '转 JPEG': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
  '转 TXT': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
  '合并 PDF': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: true, minFiles: 2 },
  逐页拆分: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
  '旋转 PDF': { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
  提取指定页: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: false, minFiles: 1 },
  文字水印: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: true, minFiles: 1 },
  图片水印: { inputLabel: 'PDF', kind: 'pdf', accept: 'application/pdf,.pdf', multiple: true, minFiles: 1 },
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
const pdfWatermarkAddFilesButton = document.querySelector('#pdf-watermark-add-files')
const pdfWatermarkFileList = document.querySelector('#pdf-watermark-file-list')
const pdfWatermarkPreview = document.querySelector('#pdf-watermark-preview')
const pdfWatermarkPreviewEmpty = document.querySelector('#pdf-watermark-preview-empty')
const pdfWatermarkPreviewLabel = document.querySelector('#pdf-watermark-preview-label')
const pdfFileBody = document.querySelector('#pdf-file-body')
const pdfEmpty = document.querySelector('#pdf-empty')
const pdfOptions = document.querySelector('#pdf-options')
const pdfRunButton = document.querySelector('#run-pdf-action')
const pdfChooseOutputButton = document.querySelector('#choose-pdf-output')
const pdfOutputPath = document.querySelector('#pdf-output-path')
const pdfResultText = document.querySelector('#pdf-result-text')
const pdfResultDot = document.querySelector('#pdf-result-dot')
const pdfOpenOutputButton = document.querySelector('#open-pdf-output')
const pdfPageOrganizer = document.querySelector('#pdf-page-organizer')
const pdfPageGrid = document.querySelector('#pdf-page-grid')
const pdfPageSummary = document.querySelector('#pdf-page-summary')
const pdfInsertPagesInput = document.querySelector('#pdf-insert-pages-input')
let draggedPdfPageId = ''

function currentPdfConfig() {
  return pdfActionConfig[state.selections.pdf]
}

const pdfDirectoryActions = new Set([
  '转 PNG',
  '转 JPEG',
  '逐页拆分',
  '文字水印',
  '图片水印',
  '提取图片'
])

function isPdfWatermarkAction(action = state.selections.pdf) {
  return action === '文字水印' || action === '图片水印'
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
    文字水印: `${base}-watermarked`,
    图片水印: `${base}-watermarked`,
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
  state.pdfDestination = null
  pdfOutputPath.textContent = '尚未选择'
  pdfOutputPath.title = ''
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
        <select id="pdf-jpeg-quality">
          <option value="0.85">85%</option>
          <option value="0.7">70%</option>
          <option value="0.95">95%</option>
        </select>
      </label>
    `
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

function renderPdfFiles() {
  pdfFileBody.replaceChildren()
  const config = currentPdfConfig()
  const displayedFiles = config.kind === 'office'
    ? (state.pdfNativeInput ? [state.pdfNativeInput] : [])
    : currentPdfFiles()
  pdfEmpty.classList.toggle('hidden', displayedFiles.length > 0)

  displayedFiles.forEach((file, index) => {
    const row = document.createElement('div')
    const order = document.createElement('span')
    const name = document.createElement('span')
    const size = document.createElement('span')
    const progress = document.createElement('span')
    const remove = document.createElement('button')

    row.className = 'pdf-file-row'
    order.className = 'cell-index'
    name.className = 'cell-name'
    size.className = 'cell-size'
    progress.className = 'cell-progress'
    order.textContent = String(index + 1)
    name.textContent = file.name
    name.title = file.name
    size.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`
    const fileStatus = isPdfWatermarkAction()
      ? state.pdfWatermarkStatuses[index]
      : state.pdfFileStatuses[index]
    progress.textContent = fileStatus?.error || fileStatus?.status || '待处理'
    progress.title = fileStatus?.error || ''
    progress.classList.toggle('success', ['已导出', '完成'].includes(fileStatus?.status))
    progress.classList.toggle('busy', ['处理中', '等待保存'].includes(fileStatus?.status))
    progress.classList.toggle('error', Boolean(fileStatus?.error) || fileStatus?.status === '导出失败')
    remove.type = 'button'
    remove.className = 'pdf-remove-file'
    remove.dataset.index = String(index)
    remove.setAttribute('aria-label', `移除 ${file.name}`)
    remove.textContent = '×'
    row.append(order, name, size, progress, remove)
    pdfFileBody.append(row)
  })

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
    const kind = state.selections.pdf === '文字水印' ? 'text' : 'image'
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
  const imageMode = state.selections.pdf === '图片水印'
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
  const hasWatermarkImage = state.selections.pdf !== '图片水印' || Boolean(state.pdfWatermarkImage)
  const hasDestination = Boolean(state.pdfDestination)
  pdfRunButton.disabled = state.pdfBusy || !enoughFiles || !hasWatermarkImage || !hasDestination
  pdfRunButton.textContent = state.pdfBusy ? '处理中…' : `开始${state.selections.pdf}`
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
  document.querySelector('#pdf-crumb').textContent = action
  document.querySelector('#pdf-hint').textContent =
    config.minFiles > 1
      ? `至少上传 ${config.minFiles} 个 ${config.inputLabel} 文件`
      : `上传 ${config.inputLabel} 文件后执行“${action}”`
  document.querySelector('#pdf-empty-text').textContent = `上传 ${config.inputLabel} 文件`
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
  pdfResultText.textContent = '添加文件后即可处理'
  pdfResultDot.classList.remove('success', 'error', 'busy')
  renderPdfOptions()
  renderPdfFiles()
  renderPdfWatermarkState()
}

function chooseSubmenu(module, action, animate = false) {
  const changed = state.selections[module] !== action
  const previousTop = animate && changed
    ? submenu.querySelector('.submenu-item.on')?.offsetTop ?? null
    : null
  if (module === 'video') {
    setFormatAction(action, previousTop)
    if (animate && changed) animateEntry(document.querySelector('#page-video'), { duration: 160, distance: 5 })
    return
  }
  state.selections[module] = action
  renderSubmenu(module, previousTop)

  if (module === 'pdf') {
    updatePdfState(action)
  } else if (module === 'bc') {
    selectBarcodeType(action, true)
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

function addPdfToolFiles(fileList) {
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
  resetPdfDestination()
  resetPdfPageOrganizer()
  pdfOpenOutputButton.disabled = true
  renderPdfFiles()
  renderPdfWatermarkState()
  setPdfResult(`已添加 ${nextFiles.length} 个文件`)
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

  for (const [fileIndex, file] of state.pdfWatermarkFiles.entries()) {
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

  if (!files.length) throw new Error('没有可保存的水印结果，请检查文件错误')
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
  const failedCount = state.pdfWatermarkStatuses.filter((item) => item?.error).length
  return result.status === 'saved'
    ? `已处理 ${files.length} 个 PDF，共 ${watermarkedPages} 页添加${kind === 'text' ? '文字' : '图片'}水印${failedCount ? `；${failedCount} 个失败` : ''}`
    : '已取消保存'
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

  try {
    if (pdfDocument.numPages > 200) {
      throw new Error('逐页导出最多支持 200 页')
    }

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
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
          ? Number(window.document.querySelector('#pdf-jpeg-quality')?.value || 0.85)
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

  const result = await saveBatchPdfToolOutput(type, files)
  const label = type === 'jpeg' ? 'JPEG' : 'PNG'
  return result.status === 'saved' ? `已导出 ${files.length} 张 ${label} 图片` : '已取消保存'
}

async function extractPdfText() {
  const file = state.pdfFiles[0]
  const loadingTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer())
  })
  const pdfDocument = await loadingTask.promise
  const pages = []

  try {
    if (pdfDocument.numPages > 500) throw new Error('文字提取最多支持 500 页')

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
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

  const text = pages.join('\n\n').trim()
  if (!text.replace(/--- 第 \d+ 页 ---/g, '').trim()) {
    throw new Error('未检测到内嵌文字；扫描件不含文本，本功能不做 OCR')
  }

  const result = await saveSinglePdfToolOutput(
    'txt',
    `${pdfOutputBaseName(file)}-text`,
    new TextEncoder().encode(text)
  )
  return result.status === 'saved' ? `已提取 ${pages.length} 页内嵌文字` : '已取消保存'
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

  try {
    if (pdfDocument.numPages > 500) throw new Error('提取图片最多支持 500 页')

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
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

  if (!files.length) throw new Error('未检测到可导出的内嵌位图')
  const result = await saveBatchPdfToolOutput('png', files)
  return result.status === 'saved' ? `已提取 ${files.length} 张内嵌图片` : '已取消保存'
}

async function ocrPdfToText() {
  const file = state.pdfFiles[0]
  const loadingTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer())
  })
  const pdfDocument = await loadingTask.promise
  const pages = []

  try {
    if (pdfDocument.numPages > 80) throw new Error('OCR 最多支持 80 页，请拆分后重试')

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
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

  const text = pages.join('\n\n').trim()
  if (!text.replace(/--- 第 \d+ 页 ---/g, '').trim()) {
    throw new Error('未识别到文字，请确认扫描页清晰可见')
  }
  const result = await saveSinglePdfToolOutput(
    'txt',
    `${pdfOutputBaseName(file)}-ocr`,
    new TextEncoder().encode(text)
  )
  return result.status === 'saved' ? `OCR 已识别并导出 ${pages.length} 页文字` : '已取消保存'
}

async function runPdfAction() {
  if (state.pdfBusy || pdfRunButton.disabled) return
  state.pdfBusy = true
  state.pdfLastOutput = null
  state.pdfComResult = null
  pdfOpenOutputButton.disabled = true
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
    else if (action === '文字水印') message = await addPdfWatermarks('text')
    else if (action === '图片水印') message = await addPdfWatermarks('image')
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
pdfWatermarkAddFilesButton.addEventListener('click', () => {
  pdfFileInput.value = ''
  pdfFileInput.click()
})
pdfChooseOutputButton.addEventListener('click', async () => {
  if (state.pdfBusy || pdfChooseOutputButton.disabled) return
  try {
    const result = await window.api.choosePdfOutput(currentPdfOutputSpec())
    if (result.status !== 'selected') return
    state.pdfDestination = result
    pdfOutputPath.textContent = result.path
    pdfOutputPath.title = result.path
    updatePdfRunState()
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
  setPdfResult('添加文件后即可处理')
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
      for (const item of result.files) {
        const file = await readScanFile(item)
        addPdfToolFiles([file])
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
        const result = await window.api.recognizeScreenshot(bytes)
        const text = (result?.text || '').trim()
        if (!text) return '未识别到文字'
        await window.api.copyScreenshotText(text)
        return `已识别 ${text.length} 个字符并复制`
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

function registerPopover(menu, trigger = null) {
  if (!menu) return
  popovers.push({ menu, trigger })
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
  return true
}

/** 把浮层定位到触发钮下方；越界时钳制回窗口内。position: fixed，用视口坐标。 */
function placePopover(menu, trigger, { align = 'left', gap = 6 } = {}) {
  menu.hidden = false // 先显形才量得到尺寸
  const t = trigger.getBoundingClientRect()
  const m = menu.getBoundingClientRect()
  let left = align === 'right' ? t.right - m.width : t.left
  left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8))
  // 下方放不下就翻到上方
  let top = t.bottom + gap
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, t.top - m.height - gap)
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
}

function closeAllCmdMenus(except = null) {
  closePopovers(except)
}

function toggleCmdMenu(trigger, menu) {
  if (isPopoverOpen(menu)) closePopover(menu)
  else openPopover(menu)
}

// 登记两个命令栏菜单
registerPopover(projectMenu, cmdProject)
registerPopover(backgroundMenu, cmdBackground)

// ── 文本工具栏的字体 / 对齐菜单（S1：替换原生 select）──
const textFontTrigger = document.querySelector('#text-font-trigger')
const textFontMenu = document.querySelector('#text-font-menu')
const textAlignTrigger = document.querySelector('#text-align-trigger')
const textAlignMenu = document.querySelector('#text-align-menu')
registerPopover(textFontMenu, textFontTrigger)
registerPopover(textAlignMenu, textAlignTrigger)

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
  toggleCmdMenu(cmdBackground, backgroundMenu)
})
backgroundMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-bg]')
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

let screenshotResizeTimer

window.addEventListener('beforeunload', () => {
  qpdfRunnerPromise?.then((runner) => runner.destroy()).catch(() => {})
})

const illustratorState = {
  inputs: [],
  statuses: new Map(),
  busy: false,
  outputs: []
}
const illustratorFileBody = document.querySelector('#illustrator-file-body')
const illustratorEmpty = document.querySelector('#illustrator-empty')
const illustratorDropZone = document.querySelector('#illustrator-drop-zone')
const illustratorAddFilesButton = document.querySelector('#illustrator-add-files')
const illustratorAddFolderButton = document.querySelector('#illustrator-add-folder')
const illustratorClearButton = document.querySelector('#illustrator-clear')
const illustratorStopButton = document.querySelector('#illustrator-stop')
const illustratorSameDirectory = document.querySelector('#illustrator-same-directory')
const illustratorProgressFill = document.querySelector('#illustrator-progress-fill')
const illustratorProgressText = document.querySelector('#illustrator-progress-text')
const illustratorLog = document.querySelector('#illustrator-log')
const illustratorOpenOutputButton = document.querySelector('#illustrator-open-output')
const illustratorRunButtons = Array.from(document.querySelectorAll('.illustrator-run'))

function illustratorFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function appendIllustratorLog(message) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const lines = `${illustratorLog.textContent}\n[${timestamp}] ${message}`.trim().split('\n').slice(-120)
  illustratorLog.textContent = lines.join('\n')
  illustratorLog.scrollTop = illustratorLog.scrollHeight
}

function renderIllustratorFiles() {
  illustratorFileBody.replaceChildren()
  illustratorEmpty.classList.toggle('hidden', illustratorState.inputs.length > 0)

  illustratorState.inputs.forEach((file, index) => {
    const row = document.createElement('div')
    const order = document.createElement('span')
    const name = document.createElement('span')
    const size = document.createElement('span')
    const status = document.createElement('span')
    const remove = document.createElement('button')
    const currentStatus = illustratorState.statuses.get(file.id) || '等待'

    row.className = 'pdf-file-row illustrator-file-row'
    order.className = 'cell-index'
    name.className = 'cell-name'
    size.className = 'cell-meta'
    status.className = `cell-status illustrator-status ${currentStatus === '完成' ? 'success' : currentStatus === '处理中' ? 'busy' : currentStatus === '失败' ? 'error' : ''}`
    order.textContent = String(index + 1)
    name.textContent = file.name
    name.title = file.name
    size.textContent = illustratorFileSize(file.size)
    status.textContent = currentStatus
    remove.type = 'button'
    remove.className = 'pdf-remove-file illustrator-remove-file'
    remove.dataset.id = file.id
    remove.disabled = illustratorState.busy
    remove.setAttribute('aria-label', `移除 ${file.name}`)
    remove.textContent = '×'
    row.append(order, name, size, status, remove)
    illustratorFileBody.append(row)
  })

  const hasFiles = illustratorState.inputs.length > 0
  illustratorAddFilesButton.disabled = illustratorState.busy
  illustratorAddFolderButton.disabled = illustratorState.busy
  illustratorClearButton.disabled = illustratorState.busy || !hasFiles
  illustratorSameDirectory.disabled = illustratorState.busy
  illustratorRunButtons.forEach((button) => {
    button.disabled = illustratorState.busy || !hasFiles
  })
  illustratorStopButton.disabled = !illustratorState.busy
}

async function addIllustratorInputs(picker) {
  if (illustratorState.busy) return
  try {
    const files = await picker()
    if (!files.length) return
    const known = new Set(illustratorState.inputs.map((file) => `${file.name}\0${file.size}`))
    const skippedIds = []
    const added = files.filter((file) => {
      const key = `${file.name}\0${file.size}`
      if (known.has(key)) {
        skippedIds.push(file.id)
        return false
      }
      known.add(key)
      return true
    })
    if (skippedIds.length) await window.api.removeIllustratorInputs(skippedIds)
    illustratorState.inputs.push(...added)
    added.forEach((file) => illustratorState.statuses.set(file.id, '等待'))
    illustratorState.outputs = []
    illustratorOpenOutputButton.disabled = true
    renderIllustratorFiles()
    appendIllustratorLog(`已添加 ${added.length} 个文件，共 ${illustratorState.inputs.length} 个。`)
  } catch (error) {
    appendIllustratorLog(`添加失败：${error instanceof Error ? error.message : String(error)}`)
    showToast('无法添加 Illustrator 文件')
  }
}

async function runIllustratorAction(action, triggerButton) {
  if (illustratorState.busy || !illustratorState.inputs.length) return
  illustratorState.busy = true
  illustratorState.outputs = []
  illustratorOpenOutputButton.disabled = true
  illustratorState.inputs.forEach((file) => illustratorState.statuses.set(file.id, '等待'))
  illustratorProgressFill.style.width = '0%'
  illustratorProgressText.textContent = '正在启动 Illustrator…'
  renderIllustratorFiles()
  const originalLabel = triggerButton.textContent
  triggerButton.textContent = '处理中…'
  appendIllustratorLog(`开始${originalLabel}，共 ${illustratorState.inputs.length} 个文件。`)

  try {
    const result = await window.api.runIllustratorTask({
      action,
      inputIds: illustratorState.inputs.map((file) => file.id),
      sameDirectory: illustratorSameDirectory.checked
    })
    if (result.status === 'completed') {
      illustratorState.inputs.forEach((file) => illustratorState.statuses.set(file.id, '完成'))
      illustratorState.outputs = result.outputs
      illustratorProgressFill.style.width = '100%'
      illustratorProgressText.textContent = `已完成 ${result.outputs.length} / ${illustratorState.inputs.length}`
      illustratorOpenOutputButton.disabled = result.outputs.length === 0
      appendIllustratorLog(`${originalLabel}完成，已生成 ${result.outputs.length} 个文件。`)
      showToast(`${originalLabel}完成`)
    } else {
      illustratorProgressText.textContent = '任务已取消'
      appendIllustratorLog('任务已取消；当前 COM 操作完成后停止。')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    illustratorState.inputs.forEach((file) => {
      if (illustratorState.statuses.get(file.id) === '处理中') {
        illustratorState.statuses.set(file.id, '失败')
      }
    })
    illustratorProgressText.textContent = '任务失败'
    appendIllustratorLog(`任务失败：${reason}`)
    showToast('Illustrator 任务失败')
  } finally {
    illustratorState.busy = false
    triggerButton.textContent = originalLabel
    renderIllustratorFiles()
  }
}

illustratorAddFilesButton.addEventListener('click', () => addIllustratorInputs(window.api.pickIllustratorFiles))
illustratorAddFolderButton.addEventListener('click', () => addIllustratorInputs(window.api.pickIllustratorFolder))
bindFileDropZone(illustratorDropZone, async (files) => {
  if (illustratorState.busy) return
  try {
    const result = await window.api.scanDroppedPaths({
      paths: droppedFilePaths(files),
      region: 'illustrator'
    })
    await addIllustratorInputs(async () => result.files)
    if (result.skipped || result.errors.length || result.truncated) {
      const notes = []
      if (result.skipped) notes.push(`${result.skipped} 个跳过`)
      if (result.errors.length) notes.push(`${result.errors.length} 个失败`)
      if (result.truncated) notes.push('已达数量上限')
      if (notes.length) showToast(`扫描完成：${notes.join('，')}`)
    }
  } catch (error) {
    showToast(`拖入失败：${cleanIpcError(error?.message ?? error)}`)
  }
})
illustratorClearButton.addEventListener('click', async () => {
  if (illustratorState.busy) return
  const ids = illustratorState.inputs.map((file) => file.id)
  await window.api.removeIllustratorInputs(ids)
  illustratorState.inputs = []
  illustratorState.statuses.clear()
  illustratorState.outputs = []
  illustratorProgressFill.style.width = '0%'
  illustratorProgressText.textContent = '等待任务'
  illustratorOpenOutputButton.disabled = true
  illustratorLog.textContent = '等待添加 Illustrator 文件。'
  renderIllustratorFiles()
})
illustratorFileBody.addEventListener('click', async (event) => {
  const button = event.target.closest('.illustrator-remove-file')
  if (!button || illustratorState.busy) return
  await window.api.removeIllustratorInputs([button.dataset.id])
  illustratorState.inputs = illustratorState.inputs.filter((file) => file.id !== button.dataset.id)
  illustratorState.statuses.delete(button.dataset.id)
  renderIllustratorFiles()
})
illustratorRunButtons.forEach((button) => {
  button.addEventListener('click', () => runIllustratorAction(button.dataset.illustratorAction, button))
})
illustratorStopButton.addEventListener('click', async () => {
  const result = await window.api.cancelIllustratorTask()
  if (result.status === 'cancelling') {
    illustratorStopButton.disabled = true
    illustratorProgressText.textContent = '正在停止…'
    appendIllustratorLog('已请求停止，将在当前文件处理结束后生效。')
  }
})
illustratorOpenOutputButton.addEventListener('click', async () => {
  if (illustratorState.outputs[0]) {
    await window.api.showComResult(illustratorState.outputs[0].id)
  }
})
window.api.onIllustratorProgress((progress) => {
  if (!illustratorState.busy) return
  const total = Math.max(1, Number(progress.total) || illustratorState.inputs.length || 1)
  const completed = Math.max(0, Math.min(total, Number(progress.completed) || 0))
  illustratorState.inputs.forEach((file, index) => {
    if (index < completed) illustratorState.statuses.set(file.id, '完成')
    else if (index === completed && completed < total) illustratorState.statuses.set(file.id, '处理中')
  })
  illustratorProgressFill.style.width = `${completed / total * 100}%`
  illustratorProgressText.textContent = progress.message || `处理中 ${completed} / ${total}`
  if (progress.message) appendIllustratorLog(progress.message)
  renderIllustratorFiles()
})
renderIllustratorFiles()

const barcodeInput = document.querySelector('#barcode-value')
const barcodeSvg = document.querySelector('#barcode-svg')
const barcodeMessage = document.querySelector('#barcode-message')
const barcodeSpecReport = document.querySelector('#barcode-spec-report')
const saveBarcodeSvgButton = document.querySelector('#save-barcode-svg')
const saveBarcodePngButton = document.querySelector('#save-barcode-png')
const saveBarcodeEpsButton = document.querySelector('#save-barcode-eps')
const copyBarcodeVectorButton = document.querySelector('#copy-barcode-vector')
const openBarcodeIllustratorButton = document.querySelector('#open-barcode-illustrator')
const openBarcodePhotoshopButton = document.querySelector('#open-barcode-photoshop')
const copyBarcodeUngroupedButton = document.querySelector('#copy-barcode-ungrouped')
const barcodeSingleTab = document.querySelector('#barcode-single-tab')
const barcodeBatchTab = document.querySelector('#barcode-batch-tab')
const barcodeSinglePane = document.querySelector('#barcode-single-pane')
const barcodeBatchPane = document.querySelector('#barcode-batch-pane')
const barcodeBatchInput = document.querySelector('#barcode-batch-value')
const barcodeBatchList = document.querySelector('#barcode-batch-list')
const barcodeBatchSummary = document.querySelector('#barcode-batch-summary')
const generateBarcodeBatchButton = document.querySelector('#generate-barcode-batch')
const saveBarcodeBatchSvgButton = document.querySelector('#save-barcode-batch-svg')
const saveBarcodeBatchPngButton = document.querySelector('#save-barcode-batch-png')
const barcodeFontSelect = document.querySelector('#barcode-font')
const itf14PresetPicker = document.querySelector('#itf14-preset-picker')
const itf14PresetSelect = document.querySelector('#itf14-preset')
const code39OptionsBox = document.querySelector('#code39-options')
const code39RatioSelect = document.querySelector('#code39-ratio')
const code39Mod43Check = document.querySelector('#code39-mod43')
const code39FullAsciiCheck = document.querySelector('#code39-fullascii')

// 窄宽比选项由 CODE39_DEFAULTS.selectableRatios 生成，避免 HTML 与常量各存一份真值
for (const ratio of CODE39_DEFAULTS.selectableRatios) {
  const option = document.createElement('option')
  option.value = String(ratio)
  option.textContent = `${ratio} : 1${ratio === CODE39_DEFAULTS.wideRatio ? '（产品默认）' : ''}`
  code39RatioSelect.append(option)
}
code39RatioSelect.value = String(CODE39_DEFAULTS.wideRatio)

const codabarOptionsBox = document.querySelector('#codabar-options')
const codabarStartSelect = document.querySelector('#codabar-start')
const codabarStopSelect = document.querySelector('#codabar-stop')
const codabarShowSsCheck = document.querySelector('#codabar-showss')

// 起止符选项同样由常量生成，别名只出现在 UI 标注上
for (const select of [codabarStartSelect, codabarStopSelect]) {
  for (const { value, alias } of CODABAR_DEFAULTS.startStopChars) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = `${value}（${alias}）`
    select.append(option)
  }
}
codabarStartSelect.value = CODABAR_DEFAULTS.start
codabarStopSelect.value = CODABAR_DEFAULTS.stop

const msiOptionsBox = document.querySelector('#msi-options')
const msiChecksumSelect = document.querySelector('#msi-checksum')
for (const { value, label } of MSI_DEFAULTS.checksumModes) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  msiChecksumSelect.append(option)
}
msiChecksumSelect.value = MSI_DEFAULTS.checksumMode

barcodeFontSelect.value = state.barcodeFont

function saveBarcodeFont() {
  localStorage.setItem('barcode-style', JSON.stringify({
    font: state.barcodeFont
  }))
}

function setBarcodeExportEnabled(enabled) {
  saveBarcodeSvgButton.disabled = !enabled
  saveBarcodePngButton.disabled = !enabled
  saveBarcodeEpsButton.disabled = !enabled
  copyBarcodeVectorButton.disabled = !enabled
  openBarcodeIllustratorButton.disabled = !enabled
  openBarcodePhotoshopButton.disabled = !enabled
  copyBarcodeUngroupedButton.disabled = !enabled
}

function setBarcodeBatchExportEnabled(enabled) {
  saveBarcodeBatchSvgButton.disabled = !enabled
  saveBarcodeBatchPngButton.disabled = !enabled
}

function setBarcodeMessage(message, type = '') {
  barcodeMessage.textContent = message
  barcodeMessage.className = `barcode-message${type ? ` ${type}` : ''}`
  barcodeInput.classList.toggle('invalid', type === 'error')
}

function getBarcodeType() {
  return barcodeTypes[state.selections.bc] || barcodeTypes['EAN-13']
}

// Code 39 的三项设置必须能被批量条目冻结：生成后用户改设置，
// 已有条目的 SVG 与导出尺寸必须仍属同一状态。
const GENERIC_OPTION_SOURCES = {
  Code39: () => ({ ...state.code39 }),
  Codabar: () => ({ ...state.codabar }),
  MSI: () => ({ ...state.msi })
}

function genericOptionsFor(typeName, frozen = null) {
  const source = GENERIC_OPTION_SOURCES[typeName]
  if (!source) return null
  return frozen || source()
}

function renderBarcodeSvg(svgElement, value, typeName = state.selections.bc, itf14Preset = null, prepared = null, genericOptions = null) {
  const type = barcodeTypes[typeName]
  if (!type) throw new Error('不支持的条码类型')

  // GS1-128 走模块网格几何引擎；AI 校验是异步的，必须由调用方先 prepareGs1128()
  // 并把结果传进来——本函数保持同步，不在渲染期发起校验。
  if (isGs1128Type(typeName)) {
    if (!prepared) throw new Error('GS1-128 需要先完成 AI 语法校验')
    renderGs1128(svgElement, prepared)
    // HRI 同样固定常规 OCR-B
    outlineBarcodeText(svgElement, RETAIL_HRI_FONT_KEY)
    return
  }

  // ITF-14 走元素级几何引擎（窄/宽 2.5:1，非模块网格）
  if (isItf14Type(typeName)) {
    renderItf14(svgElement, value, itf14Preset || state.itf14Preset || ITF14_DEFAULT_PRESET)
    outlineBarcodeText(svgElement, RETAIL_HRI_FONT_KEY)
    return
  }

  // 零售合规码制走 GS1 几何引擎；其余六种维持 JsBarcode 通用渲染。
  if (isRetailType(typeName)) {
    renderRetailBarcode(svgElement, typeName, value)
    // 零售合规码固定常规 OCR-B：GS1 §5.2.5 禁止粗/斜/细/窄体，
    // 不受用户字体下拉框（OCRB I/III/IV）影响。
    outlineBarcodeText(svgElement, RETAIL_HRI_FONT_KEY)
    return
  }

  // S4 通用生成：走本项目产品默认几何，不再用 JsBarcode 的默认版式。
  // HRI 字体仍随用户选择（本档不受 GS1 字体限制约束）。
  if (isGenericType(typeName)) {
    renderGenericBarcode(svgElement, typeName, value, genericOptionsFor(typeName, genericOptions))
    outlineBarcodeText(svgElement)
    return
  }

  const selectedFont = barcodeFonts[state.barcodeFont] || barcodeFonts.ocrb
  const options = {
    font: `"${selectedFont.label}", "Moyu OCR-B", OCRB, monospace`,
    lineColor: '#171820',
    background: '#ffffff',
    displayValue: true
  }
  if (type.format !== 'auto') options.format = type.format

  svgElement.replaceChildren()
  JsBarcode(svgElement, value, options)
  svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  outlineBarcodeText(svgElement)
}

function friendlyBarcodeError(typeName) {
  const type = barcodeTypes[typeName]
  return `${typeName} 输入无效：${type?.hint || '请检查长度与字符'}。`
}

// 生产合规参数报告：SVG/EPS 为精确标称值，PNG 为整数像素量化后的实际值，
// 二者必须分别标注，不得混称（GS1 尺寸口径）。
function renderBarcodeSpecReport(typeName) {
  // GS1-128：模块网格 + Syntax Engine 校验，报告口径独立
  if (isGs1128Type(typeName)) {
    if (!gs1128Prepared) {
      barcodeSpecReport.hidden = true
      return
    }
    const geo = computeGs1128Geometry(gs1128Prepared)
    const raster = gs1128RasterSize(gs1128Prepared)
    const s = geo.spec
    const rows = [
      ['规范', s.source],
      ['AI 校验', `GS1 Barcode Syntax Engine（gs1encoder 1.4.1，内嵌固定 AI 表，不联网）`],
      ['数据串', `${geo.dataStr}（^ = FNC1）· ${geo.moduleCount} 模块`],
      ['X-dimension', `${geo.x.toFixed(3)} mm（允许 ${s.xMinMm}–${s.xMaxMm}）`],
      ['SVG / EPS', `${geo.widthMm.toFixed(2)} × ${geo.heightMm.toFixed(2)} mm · 符号宽 ${geo.symbolWidthMm.toFixed(2)} mm`],
      ['PNG', `${raster.actualWidthMm.toFixed(2)} mm · ${raster.pixelWidth} × ${raster.pixelHeight} px · ${raster.dpi} DPI · 模块 ${raster.modulePx}px · X=${raster.actualXMm.toFixed(4)} mm`],
      ['条高 / 静区', `${s.barHeightMm.toFixed(2)} mm（不含 HRI）· 左右各 ${geo.quietLeftMm.toFixed(2)} mm（10X）`],
      [
        '符号长度',
        `${geo.measuredLengthMm.toFixed(2)} mm / 上限 ${s.maxSymbolLengthMm} mm（含左右静区）`
      ],
      [
        '数据字符',
        `${geo.dataCharCount} / 上限 ${s.maxDataCharacters} 个（含 AI 与中间分隔 FNC1；不含起始符、开头 FNC1、校验符、停止符）`
      ],
      [
        'HRI',
        `常规 OCR-B · 内容由 Syntax Engine 生成 · 字形高 ${s.hri.capHeightMm.toFixed(2)} mm（${s.hri.capHeightSource}）`
      ],
      [
        'HRI 版式',
        `不拆分 element string（每个 AI 单元整体不换行）· 行距 ${s.hri.lineGapMm.toFixed(2)} mm · 距条码 ${s.hri.gapMm.toFixed(2)} mm —— 均为产品版式值，规范未固定`
      ]
    ]
    barcodeSpecReport.replaceChildren()
    for (const [term, detail] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      dd.textContent = detail
      barcodeSpecReport.append(dt, dd)
    }
    barcodeSpecReport.hidden = false
    return
  }

  // S4 通用生成：只报实际产出尺寸，明示为产品默认值。
  // 口径：**不出现肯定性生产合规声明**；免责句"不作生产合规承诺"本身含该词，属正常。
  if (isGenericType(typeName)) {
    if (!barcodeRenderedValue) {
      barcodeSpecReport.hidden = true
      return
    }
    const opts = genericOptionsFor(typeName)
    const geo = computeGenericGeometry(typeName, barcodeRenderedValue, opts)
    const raster = genericRasterSize(typeName, barcodeRenderedValue, opts)
    const d = geo.defaults
    const rows = [
      ['参数性质', d.notice],
      ['依据', d.basis],
      ...(geo.symbology.resolvesTo
        ? [['自动选择', `${typeName} → ${geo.symbology.resolvesTo}（导出文件名按实际码制命名）`]]
        : []),
      ['编码', `${geo.symbology.label} · ${geo.symbology.features.join(' · ')} · ${geo.moduleCount} 模块`],
      ['X-dimension', `${geo.x.toFixed(3)} mm（产品默认值）`],
      ['SVG / EPS', `${geo.widthMm.toFixed(2)} × ${geo.heightMm.toFixed(2)} mm · 符号宽 ${geo.symbolWidthMm.toFixed(2)} mm`],
      ['PNG', `${raster.actualWidthMm.toFixed(2)} mm · ${raster.pixelWidth} × ${raster.pixelHeight} px · ${raster.dpi} DPI · 模块 ${raster.modulePx}px · X=${raster.actualXMm.toFixed(4)} mm`],
      [
        '条高',
        `${geo.barHeightMm.toFixed(2)} mm = max(${d.barHeightMinMm} mm, ${(d.barHeightRatio * 100).toFixed(0)}% × 符号宽 ${geo.symbolWidthMm.toFixed(2)} mm)` +
          `　当前取${geo.barHeightDrivenBy === 'ratio' ? '比例值' : '最小值'}`
      ],
      ['静区', `左右各 ${geo.quietLeftMm.toFixed(2)} mm（${d.quietLeftX}X，产品默认值）`],
      ...(geo.model === 'element'
        ? [[
            '窄宽比',
            typeName === 'Code39'
              ? `${geo.wideRatio}:1（产品默认 ${CODE39_DEFAULTS.wideRatio}:1，本产品支持 ` +
                `${CODE39_DEFAULTS.ratioRange.min}–${CODE39_DEFAULTS.ratioRange.max}）`
              : `${geo.wideRatio}:1（${typeName} 产品默认值）`
          ]]
        : []),
      ...(typeName === 'MSI'
        ? [
            ['原始数据', geo.payload],
            ['校验模式', geo.resolved.modeLabel],
            [
              '追加字符',
              geo.addedChars.length
                ? `${geo.addedChars}（${geo.addedChars.length} 位）`
                : '无（未追加任何字符）'
            ],
            ['实际编码内容', `${geo.composed}（HRI 显示此内容）`]
          ]
        : []),
      ...(typeName === 'Codabar'
        ? [
            ['起止符', `${geo.resolved.start} … ${geo.resolved.stop}（实际编码内容 ${geo.composed}）`],
            ['HRI 内容', geo.resolved.showStartStop ? '正文 + 起止符（A–D，不用别名）' : '仅正文，隐藏起止符'],
            ['校验字符', '未附加校验字符（本版不提供 Mod 16）'],
            ['正文字符集', `0-9 - $ : . + /（A–D 属起止符，不可写入正文）`]
          ]
        : []),
      ...(typeName === 'ITF'
        ? [
            ['位数', `${barcodeRenderedValue.length} 位（必须为偶数；不补零、不追加校验位）`],
            ['承载条', '通用 ITF 固定不生成承载条/外框；需要承载框与固定 14 位请使用 ITF-14'],
            ['HRI 内容', '与用户输入逐字一致']
          ]
        : []),
      ...(typeName === 'Code39'
        ? [
            [
              'Mod 43',
              geo.resolved.mod43
                ? `已开启 · 校验字符「${geo.checkChar}」${geo.resolved.showCheckChar ? '已显示在 HRI 中' : '不显示在 HRI 中'}`
                : '已关闭（Code 39 校验字符为可选项）'
            ],
            [
              '字符集',
              geo.resolved.fullAscii
                ? `Full ASCII 扩展 · 原始 ${barcodeRenderedValue.length} 字符展开为 ${geo.encodedValue.length} 个 Code 39 字符 · 需扫描器开启对应解码模式`
                : '标准 Code 39（0-9 A-Z 空格 - . $ / + %）'
            ],
            ['HRI 内容', `显示用户数据${geo.resolved.mod43 && geo.resolved.showCheckChar ? ' + 校验字符' : ''}，不显示起止符 *`]
          ]
        : []),
      ['HRI', `字形高 ${d.hri.capHeightMm.toFixed(2)} mm · 距条码 ${d.hri.gapMm.toFixed(2)} mm · 字体随选择 —— 均为产品版式值`]
    ]
    barcodeSpecReport.replaceChildren()
    for (const [term, detail] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      dd.textContent = detail
      barcodeSpecReport.append(dt, dd)
    }
    barcodeSpecReport.hidden = false
    return
  }

  // ITF-14：元素级几何 + 双印刷预设，报告口径与零售码不同
  if (isItf14Type(typeName)) {
    const presetKey = state.itf14Preset || ITF14_DEFAULT_PRESET
    const geo = computeItf14Geometry(presetKey, barcodeRenderedValue || null)
    const raster = itf14RasterSize(presetKey, barcodeRenderedValue || null)
    const rows = [
      ['规范', 'GS1 GenSpecs 26.0.0 · §5.12.3.2 · Table 5-47（一般流通）'],
      ['印刷预设', geo.preset.label],
      ['X-dimension', `${geo.x.toFixed(3)} mm（允许 0.495–1.016）`],
      ['宽窄比', `${(geo.wideMm / geo.x).toFixed(2)}:1（目标 2.5，允许 2.25–3）`],
      ['SVG / EPS', `${geo.widthMm.toFixed(2)} × ${geo.heightMm.toFixed(2)} mm · 符号宽 ${geo.symbolWidthMm.toFixed(2)} mm`],
      ['PNG', `${raster.actualWidthMm.toFixed(2)} mm · ${raster.pixelWidth} × ${raster.pixelHeight} px · ${raster.dpi} DPI · 窄 ${raster.narrowPx}px / 宽 ${raster.widePx}px · X=${raster.actualXMm.toFixed(4)} mm`],
      ['条高 / 静区', `${geo.base.barHeightMm.toFixed(2)} mm（不含 HRI 与承载框）· 左右各 ${geo.quietLeftMm.toFixed(2)} mm`],
      [
        '承载框',
        geo.preset.bearer.mode === 'frame'
          ? `四边完整框 · ${geo.bearerMm.toFixed(2)} mm（PNG ${raster.bearerPx}px = ${raster.bearerActualMm.toFixed(3)} mm）· 左右框在静区外`
          : `仅上下承载条 · ${geo.bearerMm.toFixed(2)} mm（2X，PNG ${raster.bearerPx}px）`
      ],
      ['HRI', `常规 OCR-B · 字形高 ${geo.base.hri.capHeightMm.toFixed(2)} mm · 距承载条 ${geo.base.hri.gapToBearerMm.toFixed(2)} mm（PNG ${raster.hriGapPx}px = ${raster.hriGapActualMm.toFixed(3)} mm）· 水平居中为产品版式`]
    ]
    barcodeSpecReport.replaceChildren()
    for (const [term, detail] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      dd.textContent = detail
      barcodeSpecReport.append(dt, dd)
    }
    barcodeSpecReport.hidden = false
    return
  }

  if (!isRetailType(typeName)) {
    barcodeSpecReport.hidden = true
    barcodeSpecReport.replaceChildren()
    return
  }

  const geometry = computeRetailGeometry(typeName)
  const raster = retailRasterSize(typeName)
  // 版式未锁定的码制：**保留全部已锁定参数**，只把合规结论标为待定。
  // （早前的提前 return 会把条高/静区/尺寸一并藏掉，反而丢失有效信息。）
  const pending = geometry.spec.hri.placementPending === true

  const rows = [
    pending
      ? ['合规状态', '待定 · 符号外首位数字水平位置需 ISO/IEC 15420 确认（本版未采购该规范），当前为版式实现值，不标注生产合规']
      : ['规范', 'GS1 GenSpecs 26.0.0 · Table 5-44 · 零售 POS'],
    ...(pending ? [['已锁定依据', 'GS1 GenSpecs 26.0.0 · Table 5-44（条空、静区、条高、Table 5-10 补偿）']] : []),
    ['放大系数', '标准 100%'],
    ['SVG / EPS', `${geometry.widthMm.toFixed(2)} × ${geometry.heightMm.toFixed(2)} mm · X=${geometry.x.toFixed(3)} mm`],
    ['PNG', `${raster.actualWidthMm.toFixed(2)} mm · ${raster.pixelWidth} × ${raster.pixelHeight} px · ${raster.dpi} DPI · X=${raster.actualXMm.toFixed(4)} mm`],
    ['条高 / 静区', `${geometry.spec.barHeightMm.toFixed(2)} mm · 左右各 ${(geometry.spec.quietLeftX * geometry.x).toFixed(2)} mm`],
    ['HRI 字体', '常规 OCR-B（固定）']
  ]

  barcodeSpecReport.replaceChildren()
  for (const [term, detail] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = detail
    barcodeSpecReport.append(dt, dd)
  }
  barcodeSpecReport.hidden = false
}

// GS1-128 的 AI 校验走 WASM，是**异步**的。用户连续输入时，先发出的请求可能后返回，
// 若不设防会用旧数据覆盖新输入。这里用单调递增序号：只有序号仍等于当前值的
// 回调才允许写入 DOM 与状态，落后的请求一律丢弃。
let barcodeRequestSeq = 0
// 当前预览所依据的 GS1-128 校验结果，是参数报告与全部导出路径的唯一数据源。
let gs1128Prepared = null

// 零售 / 物流码的有效数据长度（不含校验位）。用户输入视为数据前缀，右侧补零到此长度。
const RETAIL_DATA_LENGTH = {
  'EAN-13': 12,
  'UPC-A': 11,
  'EAN-8': 7,
  'ITF-14': 13
}

// 当前预览是否达到可导出状态：补零预览阶段为 false，导出控件保持禁用。
let barcodeExportReady = false

async function generateBarcode(notifyError = true) {
  // 保留原始输入用于字符校验：trim 前的首尾空格也应算非法字符，不能被静默接受。
  const rawInput = barcodeInput.value
  const raw = rawInput.trim()
  const typeName = state.selections.bc
  // 任何一次生成（含切换类型、非 GS1-128 类型）都推进序号，
  // 以作废仍在飞行中的旧 GS1-128 校验请求。
  const token = ++barcodeRequestSeq

  barcodeSvg.replaceChildren()
  barcodeRenderedValue = ''
  barcodeRenderedType = ''
  barcodeExportReady = false
  gs1128Prepared = null
  setBarcodeExportEnabled(false)

  let value = raw
  let isRetailPreview = false
  let prepared = null

  // 零售 / 物流码：前缀补零实时预览。空输入或不足时右补零到数据长度，
  // 仅用于预览；达到数据长度或提供合法完整码（含校验位）才允许导出。
  if (isRetailType(typeName) || isItf14Type(typeName)) {
    // 零售 / 物流码仅支持数字：任何非数字字符直接报错，绝不静默删除，
    // 否则会出现“显示成功且启用导出”但 hasCurrentBarcode 又拒绝导出的状态矛盾。
    if (rawInput.length > 0 && /[^0-9]/.test(rawInput)) {
      if (token !== barcodeRequestSeq) return false
      barcodeSpecReport.hidden = true
      setBarcodeMessage(`${typeName} 仅支持数字，请移除字母、空格或符号。`, 'error')
      if (notifyError) showToast('条码含非法字符')
      return false
    }
    const dataLen = RETAIL_DATA_LENGTH[typeName]
    const cleaned = raw.replace(/\D/g, '')
    if (cleaned.length === 0) {
      value = '0'.repeat(dataLen)
      isRetailPreview = true
    } else if (cleaned.length < dataLen) {
      value = cleaned + '0'.repeat(dataLen - cleaned.length)
      isRetailPreview = true
    } else if (cleaned.length === dataLen || cleaned.length === dataLen + 1) {
      value = cleaned
    } else {
      if (token !== barcodeRequestSeq) return false
      barcodeSpecReport.hidden = true
      setBarcodeMessage(
        `${typeName} 位数超出：需 ${dataLen} 位数据，或 ${dataLen + 1} 位完整码（含校验位）。`,
        'error'
      )
      if (notifyError) showToast('条码位数超出限制')
      return false
    }
  } else if (isGs1128Type(typeName)) {
    setBarcodeMessage('正在校验 GS1 应用标识符…', '')
    try {
      prepared = await prepareGs1128(value)
    } catch (error) {
      if (token !== barcodeRequestSeq) return false // 已被更新的输入取代
      const message = error instanceof Error ? error.message : friendlyBarcodeError(typeName)
      barcodeSpecReport.hidden = true
      setBarcodeMessage(message, 'error')
      if (notifyError) showToast('GS1-128 数据无效')
      return false
    }
    if (token !== barcodeRequestSeq) return false
  }

  try {
    renderBarcodeSvg(barcodeSvg, value, typeName, null, prepared, genericOptionsFor(typeName))
    if (token !== barcodeRequestSeq) return false
    gs1128Prepared = prepared
    barcodeRenderedValue = value
    barcodeRenderedType = typeName
    renderBarcodeSpecReport(typeName)
    if (isRetailPreview) {
      // 补零结果只用于预览：保存 / 复制 / EPS / Adobe 联动等导出控件保持禁用。
      setBarcodeExportEnabled(false)
      setBarcodeMessage(
        `预览已用 0 补足，请完整输入 ${RETAIL_DATA_LENGTH[typeName]} 位数据后导出。`,
        'preview'
      )
    } else {
      barcodeExportReady = true
      setBarcodeExportEnabled(true)
      setBarcodeMessage(`${typeName} 已生成，可保存为 SVG 或 PNG。`, 'success')
    }
    return true
  } catch (error) {
    if (token !== barcodeRequestSeq) return false
    // GS1-128 的几何层错误（如超过 165.10mm）自带可执行信息，不应被通用提示盖掉
    // GS1-128 的上限错误、Code 39 的字符集/窄宽比错误、零售码校验位错误都自带可执行信息，
    // 不能被通用提示盖掉。
    const message =
      (isGs1128Type(typeName) ||
        isGenericType(typeName) ||
        isRetailType(typeName) ||
        isItf14Type(typeName)) &&
      error instanceof Error
        ? error.message
        : friendlyBarcodeError(typeName)
    barcodeSpecReport.hidden = true
    setBarcodeMessage(message, 'error')
    if (notifyError) showToast(message)
    return false
  }
}

function getBarcodeFont(preferredKey) {
  const requested = preferredKey || state.barcodeFont
  const fontKey = barcodeFonts[requested] ? requested : 'ocrb'
  if (parsedBarcodeFonts.has(fontKey)) return parsedBarcodeFonts.get(fontKey)
  const encoded = barcodeFonts[fontKey].data.split(',')[1]
  if (!encoded) throw new Error('OCR-B 字体资源无效')
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const font = parseOpenType(bytes.buffer)
  parsedBarcodeFonts.set(fontKey, font)
  return font
}

// 数字字形高度 / em 的比值（按字体实测，结果缓存）。
// opentype 的 fontSize 是 em size，不是字形高度：OCR-B 数字仅约 0.573em。
const digitHeightRatioCache = new WeakMap()

function digitHeightPerEm(font) {
  if (digitHeightRatioCache.has(font)) return digitHeightRatioCache.get(font)
  const box = font.getPath('0', 0, 0, 1, {}).getBoundingBox()
  const ratio = box.y2 - box.y1
  const safe = ratio > 0 ? ratio : 0.573242
  digitHeightRatioCache.set(font, safe)
  return safe
}

// 0–9 在 em=1 时的最大墨宽（按字体实测，结果缓存）。
// 首尾数字用**统一**缩放比，避免不同数据得到不同字号。
const maxDigitInkCache = new WeakMap()

function maxDigitInkPerEm(font) {
  if (maxDigitInkCache.has(font)) return maxDigitInkCache.get(font)
  let widest = 0
  for (const digit of '0123456789') {
    const box = font.getPath(digit, 0, 0, 1, { kerning: true }).getBoundingBox()
    widest = Math.max(widest, box.x2 - box.x1)
  }
  const safe = widest > 0 ? widest : 0.6
  maxDigitInkCache.set(font, safe)
  return safe
}

function outlineBarcodeText(svgElement, preferredFontKey) {
  const font = getBarcodeFont(preferredFontKey)
  svgElement.querySelectorAll('text').forEach((textNode) => {
    const value = textNode.textContent || ''
    // 零售码写的是目标**字形高度**，按字体 metrics 反算 em；其余仍按 font-size。
    const capHeight = Number.parseFloat(textNode.getAttribute('data-cap-height') || '')
    let fontSize = Number.isFinite(capHeight) && capHeight > 0
      ? capHeight / digitHeightPerEm(font)
      : Number.parseFloat(textNode.getAttribute('font-size') || textNode.style.fontSize || '20')
    const originX = Number.parseFloat(textNode.getAttribute('x') || '0')
    const originY = Number.parseFloat(textNode.getAttribute('y') || '0')
    const anchor = textNode.getAttribute('text-anchor') || textNode.style.textAnchor || 'start'

    // GS1 §5.2.5 的宽度与定位约束针对**印刷后可见墨迹边缘**，
    // 不是含 side bearing 的 advance width。因此一律以最终 outline 的 bbox 度量。
    const inkBox = (size) => font.getPath(value, 0, 0, size, { kerning: true }).getBoundingBox()

    // 首尾数字最大墨宽（UPC-A 为 4X）：超出则**整体等比缩放**，不做横向压缩。
    // 缩放比按 0–9 中**最宽**的数字统一计算，使首尾数字恒等高；
    // 窄数字只是自然更窄，不会因逐字缩放而出现高低不一。
    const maxInkWidth = Number.parseFloat(textNode.getAttribute('data-max-ink-width') || '')
    if (Number.isFinite(maxInkWidth) && maxInkWidth > 0) {
      const widestInk = maxDigitInkPerEm(font) * fontSize
      if (widestInk > maxInkWidth) fontSize *= maxInkWidth / widestInk
    }

    // 定位：零售码按可见边缘锚定（首位右边缘 / 末位左边缘），其余按 advance。
    const anchorEdge = textNode.getAttribute('data-anchor-edge')
    let x
    if (anchorEdge) {
      const box = inkBox(fontSize)
      x = anchorEdge === 'right'
        ? originX - box.x2
        : anchorEdge === 'left'
          ? originX - box.x1
          : originX - (box.x1 + box.x2) / 2
    } else {
      const advance = font.getAdvanceWidth(value, fontSize, { kerning: true })
      x = anchor === 'middle'
        ? originX - advance / 2
        : anchor === 'end'
          ? originX - advance
          : originX
    }

    const path = font.getPath(value, x, originY, fontSize, { kerning: true })
    const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    pathNode.setAttribute('d', path.toPathData(3))
    pathNode.setAttribute(
      'fill',
      textNode.getAttribute('fill') || textNode.style.fill || '#171820'
    )
    pathNode.setAttribute('data-ocrb-text', value)
    const transform = textNode.getAttribute('transform')
    if (transform) pathNode.setAttribute('transform', transform)
    textNode.replaceWith(pathNode)
  })
}

function serializeBarcodeSvg(svgElement = barcodeSvg) {
  const clone = svgElement.cloneNode(true)
  clone.removeAttribute('id')
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  outlineBarcodeText(clone)

  // 普通 SVG / EPS / 矢量剪贴板默认作为一个整体导入设计软件，
  // 用户可在 Illustrator 中手动取消编组；专用“未编组”路径会在 COM 侧递归解组。
  const artwork = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  artwork.setAttribute('id', 'barcode-artwork')
  artwork.setAttribute('data-moyu-barcode-group', 'true')
  while (clone.firstChild) artwork.append(clone.firstChild)
  clone.append(artwork)

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`
}

// 零售合规码的 PNG 栅格化 DPI（内定，不暴露参数）。
const RETAIL_PNG_DPI = 300

/**
 * 计算零售码 PNG 的目标像素尺寸。
 * 模块宽量化为整数像素以保证边缘锐利，再按同一比例等比缩放整幅，
 * 因此 PNG 的实际 X 与总宽会略大于标称值（须按量化后的实际值报告）。
 */
function retailRasterSize(typeName) {
  const { x, widthMm, heightMm, totalModules } = computeRetailGeometry(typeName)
  const modulePx = Math.max(1, Math.round((x / 25.4) * RETAIL_PNG_DPI))
  const pxPerMm = modulePx / x
  return {
    pixelWidth: totalModules * modulePx,
    pixelHeight: Math.round(heightMm * pxPerMm),
    modulePx,
    actualXMm: (modulePx * 25.4) / RETAIL_PNG_DPI,
    actualWidthMm: (totalModules * modulePx * 25.4) / RETAIL_PNG_DPI,
    nominalWidthMm: widthMm,
    dpi: RETAIL_PNG_DPI
  }
}

function barcodeRasterTargetFor(typeName, value = barcodeRenderedValue, itf14Preset = null, prepared = null, genericOptions = null) {
  if (isGenericType(typeName)) {
    return value ? genericRasterSize(typeName, value, genericOptionsFor(typeName, genericOptions)) : null
  }
  if (isGs1128Type(typeName)) {
    const source = prepared || gs1128Prepared
    return source ? gs1128RasterSize(source) : null
  }
  if (isItf14Type(typeName)) {
    return itf14RasterSize(itf14Preset || state.itf14Preset || ITF14_DEFAULT_PRESET, value || null)
  }
  return isRetailType(typeName) ? retailRasterSize(typeName) : null
}

function svgToPngBytes(svgText, target = null) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()

    image.addEventListener('load', () => {
      try {
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        // 有目标尺寸时按其等比栅格化（零售码 @300DPI）；否则用 SVG 固有尺寸。
        const width = Math.round(target?.pixelWidth || image.naturalWidth || image.width)
        const height = Math.round(target?.pixelHeight || image.naturalHeight || image.height)

        if (width <= 0 || height <= 0) {
          throw new Error('SVG 固有尺寸无效')
        }

        canvas.width = width
        canvas.height = height
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
        context.drawImage(image, 0, 0, width, height)
        URL.revokeObjectURL(objectUrl)

        canvas.toBlob(async (pngBlob) => {
          if (!pngBlob) {
            reject(new Error('PNG 编码失败'))
            return
          }

          resolve(new Uint8Array(await pngBlob.arrayBuffer()))
        }, 'image/png')
      } catch (error) {
        URL.revokeObjectURL(objectUrl)
        reject(error)
      }
    }, { once: true })

    image.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('SVG 预览无法转换为 PNG'))
    }, { once: true })

    image.src = objectUrl
  })
}

async function saveBarcode(type) {
  if (!hasCurrentBarcode()) {
    setBarcodeMessage('内容已改变，请先重新生成条码。', 'error')
    return
  }

  const button = type === 'svg' ? saveBarcodeSvgButton : saveBarcodePngButton
  const originalLabel = button.textContent
  button.disabled = true
  button.textContent = '正在保存…'

  try {
    const svgText = serializeBarcodeSvg()
    const data = type === 'svg'
      ? svgText
      : await svgToPngBytes(svgText, barcodeRasterTargetFor(state.selections.bc))
    const result = await window.api.saveBarcodeFile({
      type,
      name: `${state.selections.bc}-${barcodeRenderedValue}`,
      data,
      density: barcodeRasterTargetFor(state.selections.bc)?.dpi
    })

    if (result.status === 'saved') {
      setBarcodeMessage(`${type.toUpperCase()} 已保存。`, 'success')
      showToast(`${type.toUpperCase()} 条码已保存`)
    } else {
      setBarcodeMessage('已取消保存。')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    setBarcodeMessage(`保存失败：${reason}`, 'error')
    showToast('条码保存失败，请检查目标位置是否可写')
  } finally {
    button.textContent = originalLabel
    setBarcodeExportEnabled(true)
  }
}

async function copyBarcodeVector() {
  if (!hasCurrentBarcode()) {
    setBarcodeMessage('当前内容还不能生成有效条码。', 'error')
    return
  }

  copyBarcodeVectorButton.disabled = true
  copyBarcodeVectorButton.textContent = '复制中…'

  try {
    await window.api.copyBarcodeVector(serializeBarcodeSvg())
    setBarcodeMessage('条码矢量图已复制到剪贴板。', 'success')
    showToast('条码矢量图已复制')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    setBarcodeMessage(`复制失败：${reason}`, 'error')
    showToast('条码矢量图复制失败')
  } finally {
    copyBarcodeVectorButton.textContent = '复制矢量图'
    setBarcodeExportEnabled(hasCurrentBarcode())
  }
}

function hasCurrentBarcode() {
  return Boolean(
    barcodeExportReady &&
    barcodeRenderedValue &&
    barcodeInput.value.trim() === barcodeRenderedValue &&
    barcodeRenderedType === state.selections.bc
  )
}

/**
 * F-006：复制到 Illustrator（未编组）。
 *
 * 与 runBarcodeCom 分开写，原因有二：
 *   · 本按钮有 loading 文案与统计回显，状态机与通用联动不同；
 *   · 通用联动用 button.textContent 换文案，会破坏带子元素的按钮结构。
 *
 * UI 只暴露 copy 模式；inspect / roundtrip 仍保留在主进程供排障，不进 UI。
 */
async function copyBarcodeUngrouped() {
  const button = copyBarcodeUngroupedButton
  if (!hasCurrentBarcode()) {
    setBarcodeMessage('内容已改变，请先重新生成条码。', 'error')
    return
  }
  const originalLabel = button.textContent
  button.disabled = true
  button.textContent = '正在复制到 Illustrator…'
  setBarcodeExportEnabled(false)

  try {
    const result = await window.api.illustratorUngroupedCopy({
      data: serializeBarcodeSvg(),
      mode: 'copy'
    })
    const fields = result?.fields || {}
    const stats = [
      ['顶层对象', fields.beforeTopLevel],
      ['条形', fields.beforeBarLike],
      ['字形', fields.beforeDigitLike]
    ]
      .filter(([, value]) => value !== undefined)
      .map(([label, value]) => `${label} ${value}`)
      .join(' · ')

    if (result?.ungrouped === false) {
      // 复制成功但结构不符预期：如实说明，不谎报"已未编组"
      setBarcodeMessage(
        `已复制，但检测到仍有 ${fields.beforeGroups} 个编组，粘贴后可能需要手动解组。${stats ? `（${stats}）` : ''}`,
        'error'
      )
      showToast('已复制，但未完全解组')
      return
    }
    setBarcodeMessage(`已复制到 Illustrator 剪贴板，粘贴即为未编组路径。${stats ? `（${stats}）` : ''}`, 'success')
    showToast('已复制（未编组）')
  } catch (error) {
    const reason = cleanIpcError(error instanceof Error ? error.message : String(error))
    // 取消不是失败，不按错误呈现
    if (isComCancelled(reason)) {
      setBarcodeMessage('已取消复制。')
      return
    }
    setBarcodeMessage(`复制失败：${reason}`, 'error')
    showToast(illustratorFailureHint(reason))
  } finally {
    button.textContent = originalLabel
    setBarcodeExportEnabled(hasCurrentBarcode())
    button.disabled = !hasCurrentBarcode()
  }
}

async function runBarcodeCom(action, button) {
  if (!hasCurrentBarcode()) {
    setBarcodeMessage('内容已改变，请先重新生成条码。', 'error')
    return
  }
  const originalLabel = button.textContent
  setBarcodeExportEnabled(false)
  button.textContent = '处理中…'

  try {
    const svgText = serializeBarcodeSvg()
    let result
    if (action === 'eps') {
      result = await window.api.exportBarcodeEps({
        name: `${state.selections.bc}-${barcodeRenderedValue}`,
        data: svgText
      })
    } else if (action === 'illustrator') {
      result = await window.api.openBarcodeInIllustrator({ data: svgText })
    } else {
      const png = await svgToPngBytes(svgText, barcodeRasterTargetFor(state.selections.bc))
      result = await window.api.openBarcodeInPhotoshop({
        data: png,
        density: barcodeRasterTargetFor(state.selections.bc)?.dpi
      })
    }

    if (result.status === 'cancelled') {
      setBarcodeMessage('已取消操作。')
    } else {
      const label = action === 'eps' ? 'EPS 已保存' : action === 'illustrator' ? '已转入 Illustrator' : '已转入 Photoshop'
      setBarcodeMessage(`${label}。`, 'success')
      showToast(label)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    setBarcodeMessage(`联动失败：${reason}`, 'error')
    showToast('请确认 Adobe 软件已安装')
  } finally {
    button.textContent = originalLabel
    setBarcodeExportEnabled(hasCurrentBarcode())
  }
}

// 零售合规码固定常规 OCR-B，隐藏字体下拉框（避免用户选到禁止的粗/斜/细/窄体）。
function updateBarcodeFontPickerVisibility(typeName) {
  const picker = barcodeFontSelect.closest('.barcode-font-picker') || barcodeFontSelect
  // ITF-14 同样固定常规 OCR-B，不能显示一个实际不生效的控件
  const fixedFont = isRetailType(typeName) || isItf14Type(typeName) || isGs1128Type(typeName)
  picker.hidden = fixedFont
  barcodeFontSelect.disabled = fixedFont
  // 印刷预设仅 ITF-14 提供，且只有两个规范预设（不开放任意数值）
  const itf14 = isItf14Type(typeName)
  itf14PresetPicker.hidden = !itf14
  itf14PresetSelect.disabled = !itf14
  if (itf14) itf14PresetSelect.value = state.itf14Preset || ITF14_DEFAULT_PRESET

  // Code 39 三项设置仅对 Code 39 显示
  const code39 = typeName === 'Code39'
  code39OptionsBox.hidden = !code39
  code39RatioSelect.disabled = !code39
  code39Mod43Check.disabled = !code39
  code39FullAsciiCheck.disabled = !code39
  if (code39) {
    code39RatioSelect.value = String(state.code39.wideRatio)
    code39Mod43Check.checked = state.code39.mod43
    code39FullAsciiCheck.checked = state.code39.fullAscii
  }

  const msi = typeName === 'MSI'
  msiOptionsBox.hidden = !msi
  msiChecksumSelect.disabled = !msi
  if (msi) msiChecksumSelect.value = state.msi.checksumMode

  const codabar = typeName === 'Codabar'
  codabarOptionsBox.hidden = !codabar
  codabarStartSelect.disabled = !codabar
  codabarStopSelect.disabled = !codabar
  codabarShowSsCheck.disabled = !codabar
  if (codabar) {
    codabarStartSelect.value = state.codabar.start
    codabarStopSelect.value = state.codabar.stop
    codabarShowSsCheck.checked = state.codabar.showStartStop
  }
}

function selectBarcodeType(typeName, replaceValue = false) {
  const type = barcodeTypes[typeName]
  if (!type) return

  state.selections.bc = typeName
  document.querySelector('#bc-crumb').textContent = typeName
  barcodeInput.inputMode = type.inputMode
  barcodeInput.maxLength = type.maxLength
  barcodeInput.placeholder = type.hint
  updateBarcodeFontPickerVisibility(typeName)

  if (replaceValue) {
    // 零售 / 物流码默认空白，由补零预览实时驱动；其余维持示例值。
    barcodeInput.value =
      isRetailType(typeName) || isItf14Type(typeName) ? '' : type.example
  }

  barcodeRenderedValue = ''
  barcodeRenderedType = ''
  state.barcodeBatchItems = []
  barcodeBatchList.replaceChildren()
  barcodeBatchSummary.textContent = '条码类型已改变，请重新批量生成。'
  setBarcodeBatchExportEnabled(false)
  generateBarcode()
}

function setBarcodeMode(mode, animate = false) {
  const changed = state.barcodeMode !== mode
  state.barcodeMode = mode
  const isSingle = mode === 'single'
  barcodeSingleTab.classList.toggle('on', isSingle)
  barcodeBatchTab.classList.toggle('on', !isSingle)
  barcodeSingleTab.setAttribute('aria-selected', String(isSingle))
  barcodeBatchTab.setAttribute('aria-selected', String(!isSingle))
  barcodeSinglePane.classList.toggle('active', isSingle)
  barcodeBatchPane.classList.toggle('active', !isSingle)
  barcodeSingleTab.parentElement.dataset.mode = mode
  if (animate && changed) animateEntry(isSingle ? barcodeSinglePane : barcodeBatchPane, {
    duration: 140,
    distance: isSingle ? -4 : 4,
    horizontal: true
  })
}

function parseBatchValues(rawValue) {
  return rawValue
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return ''

      if (trimmed.startsWith('"')) {
        const quoted = trimmed.match(/^"((?:[^"]|"")*)"/)
        if (quoted) return quoted[1].replace(/""/g, '"').trim()
      }

      return trimmed.split(/[\t,;]/, 1)[0].trim()
    })
    .filter(Boolean)
}

function createBatchCard(item, index) {
  const card = document.createElement('article')
  const footer = document.createElement('footer')
  const value = document.createElement('span')
  const status = document.createElement('span')

  card.className = `batch-item${item.valid ? '' : ' error'}`
  value.textContent = item.value
  value.title = item.value
  status.textContent = item.valid ? `#${index + 1}` : '错误'

  if (item.valid) {
    card.append(item.svg.cloneNode(true))
  } else {
    const error = document.createElement('div')
    error.className = 'batch-error'
    error.textContent = item.error
    card.append(error)
  }

  footer.append(value, status)
  card.append(footer)
  return card
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

async function generateBarcodeBatch() {
  const values = parseBatchValues(barcodeBatchInput.value)

  if (values.length === 0) {
    barcodeBatchSummary.textContent = '请先输入至少一个编码。'
    return
  }

  if (values.length > 500) {
    barcodeBatchSummary.textContent = `共 ${values.length} 条，超过 500 条上限。`
    showToast('单次最多生成 500 个条码')
    return
  }

  state.barcodeBatchItems = []
  barcodeBatchList.replaceChildren()
  setBarcodeBatchExportEnabled(false)
  generateBarcodeBatchButton.disabled = true
  generateBarcodeBatchButton.textContent = '正在生成…'
  const fragment = document.createDocumentFragment()
  let validCount = 0

  for (const [index, value] of values.entries()) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    let item

    // 冻结生成时的 ITF-14 预设：生成后若切换预设，
    // 已有 SVG 与导出像素尺寸必须仍属同一模式。
    const itf14Preset = isItf14Type(state.selections.bc) ? state.itf14Preset : null
    // Code 39 的窄宽比 / Mod 43 / Full ASCII 随条目冻结，
    // 生成后改设置不得影响已有条目的 SVG 与导出像素。
    const genericOptions = genericOptionsFor(state.selections.bc)

    try {
      // GS1-128 每条独立做一次 AI 校验，校验结果随条目冻结，
      // 后续导出只用这份结果，不重新校验、不共用上一条的数据。
      const prepared = isGs1128Type(state.selections.bc) ? await prepareGs1128(value) : null
      renderBarcodeSvg(svg, value, state.selections.bc, itf14Preset, prepared, genericOptions)
      item = {
        value,
        type: state.selections.bc,
        itf14Preset,
        prepared,
        genericOptions,
        valid: true,
        svg
      }
      validCount += 1
    } catch (error) {
      item = {
        value,
        type: state.selections.bc,
        itf14Preset,
        prepared: null,
        genericOptions,
        valid: false,
        error: (isGs1128Type(state.selections.bc) || isGenericType(state.selections.bc)) && error instanceof Error
          ? error.message
          : friendlyBarcodeError(state.selections.bc)
      }
    }

    state.barcodeBatchItems.push(item)
    fragment.append(createBatchCard(item, index))

    if ((index + 1) % 20 === 0) {
      barcodeBatchList.append(fragment)
      await nextFrame()
    }
  }

  barcodeBatchList.append(fragment)
  const invalidCount = values.length - validCount
  barcodeBatchSummary.textContent = `已生成 ${validCount} 条${invalidCount ? `，${invalidCount} 条输入无效` : ''}。`
  setBarcodeBatchExportEnabled(validCount > 0)
  generateBarcodeBatchButton.disabled = false
  generateBarcodeBatchButton.textContent = '批量生成'
}

function safeBarcodeFileName(typeName, value, index) {
  const compactValue = value.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 54)
  // Auto 等选择策略按**实际码制**命名：用户必须能从文件名看出拿到的是什么码
  const actualType = isGenericType(typeName) ? resolveGenericTypeName(typeName) : typeName
  return `${String(index + 1).padStart(3, '0')}-${actualType}-${compactValue || 'barcode'}`
}

async function saveBarcodeBatch(type) {
  const validItems = state.barcodeBatchItems.filter((item) => item.valid)
  if (!validItems.length) {
    barcodeBatchSummary.textContent = '没有可保存的有效条码。'
    return
  }

  const button = type === 'svg' ? saveBarcodeBatchSvgButton : saveBarcodeBatchPngButton
  const originalLabel = button.textContent
  setBarcodeBatchExportEnabled(false)
  generateBarcodeBatchButton.disabled = true
  button.textContent = '正在准备…'
  const files = []

  try {
    for (const [index, item] of validItems.entries()) {
      const svgText = serializeBarcodeSvg(item.svg)
      files.push({
        name: safeBarcodeFileName(item.type, item.value, index),
        data: type === 'svg'
          ? svgText
          : await svgToPngBytes(svgText, barcodeRasterTargetFor(item.type, item.value, item.itf14Preset, item.prepared, item.genericOptions))
      })
      barcodeBatchSummary.textContent = `正在准备 ${index + 1} / ${validItems.length}…`
      if ((index + 1) % 10 === 0) await nextFrame()
    }

    const stopProgress = window.api.onBarcodeSaveProgress((progress) => {
      barcodeBatchSummary.textContent = `正在保存 ${progress.completed} / ${progress.total} · ${progress.name}`
    })

    try {
      const batchDensities = new Set(
        validItems.map((item) => barcodeRasterTargetFor(item.type, item.value, item.itf14Preset, item.prepared, item.genericOptions)?.dpi ?? 0)
      )
      const result = await window.api.saveBarcodeFiles({
        type,
        files,
        // 仅当整批同为一种零售码时写入 density；混合批次不标记，避免误标通用码。
        density: batchDensities.size === 1 ? [...batchDensities][0] || undefined : undefined
      })
      if (result.status === 'saved') {
        barcodeBatchSummary.textContent = `已保存 ${result.saved} 个 ${type.toUpperCase()} 文件。`
        showToast(`批量条码已保存：${result.saved} 个文件`)
      } else {
        barcodeBatchSummary.textContent = '已取消批量保存。'
      }
    } finally {
      stopProgress()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    barcodeBatchSummary.textContent = `批量保存失败：${reason}`
    showToast('批量条码保存失败')
  } finally {
    button.textContent = originalLabel
    generateBarcodeBatchButton.disabled = false
    setBarcodeBatchExportEnabled(validItems.length > 0)
  }
}

barcodeInput.addEventListener('input', () => {
  // GS1-128 时这是异步的；正确性由 generateBarcode 内部的递增序号守卫保证
  void generateBarcode(false)
})
saveBarcodeSvgButton.addEventListener('click', () => saveBarcode('svg'))
saveBarcodePngButton.addEventListener('click', () => saveBarcode('png'))
saveBarcodeEpsButton.addEventListener('click', () => runBarcodeCom('eps', saveBarcodeEpsButton))
copyBarcodeVectorButton.addEventListener('click', copyBarcodeVector)
openBarcodeIllustratorButton.addEventListener('click', () => runBarcodeCom('illustrator', openBarcodeIllustratorButton))
openBarcodePhotoshopButton.addEventListener('click', () => runBarcodeCom('photoshop', openBarcodePhotoshopButton))
copyBarcodeUngroupedButton.addEventListener('click', () => void copyBarcodeUngrouped())
barcodeSingleTab.addEventListener('click', (event) => setBarcodeMode('single', event.detail > 0))
barcodeBatchTab.addEventListener('click', (event) => setBarcodeMode('batch', event.detail > 0))
generateBarcodeBatchButton.addEventListener('click', generateBarcodeBatch)
saveBarcodeBatchSvgButton.addEventListener('click', () => saveBarcodeBatch('svg'))
saveBarcodeBatchPngButton.addEventListener('click', () => saveBarcodeBatch('png'))
barcodeBatchInput.addEventListener('input', () => {
  state.barcodeBatchItems = []
  barcodeBatchList.replaceChildren()
  barcodeBatchSummary.textContent = '内容已修改，请重新批量生成。'
  setBarcodeBatchExportEnabled(false)
})

function refreshBarcodeFont() {
  if (barcodeInput.value.trim()) generateBarcode()
  if (!state.barcodeBatchItems.length) return
  void generateBarcodeBatch()
}

function onCode39OptionChange() {
  state.code39 = {
    wideRatio: Number(code39RatioSelect.value),
    mod43: code39Mod43Check.checked,
    fullAscii: code39FullAsciiCheck.checked
  }
  // 批量条目已冻结旧设置，改动后必须重新生成，避免混状态
  if (state.barcodeBatchItems.length) {
    state.barcodeBatchItems = []
    barcodeBatchList.replaceChildren()
    setBarcodeBatchExportEnabled(false)
    barcodeBatchSummary.textContent = 'Code 39 设置已改变，请重新批量生成。'
  }
  void generateBarcode(false)
}
code39RatioSelect.addEventListener('change', onCode39OptionChange)

function onCodabarOptionChange() {
  state.codabar = {
    start: codabarStartSelect.value,
    stop: codabarStopSelect.value,
    showStartStop: codabarShowSsCheck.checked
  }
  if (state.barcodeBatchItems.length) {
    state.barcodeBatchItems = []
    barcodeBatchList.replaceChildren()
    setBarcodeBatchExportEnabled(false)
    barcodeBatchSummary.textContent = 'Codabar 设置已改变，请重新批量生成。'
  }
  void generateBarcode(false)
}
msiChecksumSelect.addEventListener('change', () => {
  state.msi = { checksumMode: msiChecksumSelect.value }
  if (state.barcodeBatchItems.length) {
    state.barcodeBatchItems = []
    barcodeBatchList.replaceChildren()
    setBarcodeBatchExportEnabled(false)
    barcodeBatchSummary.textContent = 'MSI 校验模式已改变，请重新批量生成。'
  }
  void generateBarcode(false)
})

codabarStartSelect.addEventListener('change', onCodabarOptionChange)
codabarStopSelect.addEventListener('change', onCodabarOptionChange)
codabarShowSsCheck.addEventListener('change', onCodabarOptionChange)
code39Mod43Check.addEventListener('change', onCode39OptionChange)
code39FullAsciiCheck.addEventListener('change', onCode39OptionChange)

itf14PresetSelect.addEventListener('change', () => {
  state.itf14Preset = ITF14_PRESETS[itf14PresetSelect.value] ? itf14PresetSelect.value : ITF14_DEFAULT_PRESET
  // 批量条目已冻结旧预设，切换后必须重新生成，避免 SVG 与导出尺寸混模式
  if (state.barcodeBatchItems.length) {
    state.barcodeBatchItems = []
    barcodeBatchList.replaceChildren()
    setBarcodeBatchExportEnabled(false)
    barcodeBatchSummary.textContent = '印刷预设已改变，请重新批量生成。'
  }
  generateBarcode(false)
})

barcodeFontSelect.addEventListener('change', () => {
  state.barcodeFont = barcodeFontSelect.value
  saveBarcodeFont()
  refreshBarcodeFont()
})

const formatActionConfigs = {
  视频转换: {
    kind: 'video',
    mark: 'VID',
    copy: '转换为 MP4、MKV 或 WebM。',
    runLabel: '开始视频转换',
    targets: [['mp4', 'MP4 · H.264'], ['mkv', 'MKV · H.264'], ['webm', 'WebM · VP9']]
  },
  视频压缩: {
    kind: 'video',
    mark: 'ZIP',
    copy: '使用 H.264 CRF 档位缩小视频体积。',
    runLabel: '开始压缩视频'
  },
  抽取音频: {
    kind: 'video',
    mark: 'MP3',
    copy: '从视频中导出 MP3、AAC、WAV 或 FLAC。',
    runLabel: '开始抽取音频',
    targets: [['mp3', 'MP3'], ['m4a', 'AAC / M4A'], ['wav', 'WAV'], ['flac', 'FLAC']]
  },
  音频转换: {
    kind: 'audio',
    mark: 'AUD',
    copy: '在常用音频格式之间批量转换。',
    runLabel: '开始音频转换',
    targets: [['mp3', 'MP3'], ['m4a', 'AAC / M4A'], ['wav', 'WAV'], ['flac', 'FLAC']]
  },
  图片转换: {
    kind: 'image',
    mark: 'IMG',
    copy: '由 sharp 批量输出常用图片格式。',
    runLabel: '开始图片转换',
    targets: [['webp', 'WebP'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['avif', 'AVIF'], ['tiff', 'TIFF'], ['gif', 'GIF']]
  },
  图片压缩: {
    kind: 'image',
    mark: 'MIN',
    copy: '保持原格式，按质量与最大宽度批量压缩。',
    runLabel: '开始图片压缩'
  }
}

const formatFileList = document.querySelector('#format-file-list')
const formatEmpty = document.querySelector('#format-empty')
const formatOptions = document.querySelector('#format-options')
const formatRunButton = document.querySelector('#format-run-task')
const formatCancelButton = document.querySelector('#format-cancel-task')
const formatSaveButton = document.querySelector('#format-save-results')
const formatProgressFill = document.querySelector('#format-progress-fill')
const formatStatusText = document.querySelector('#format-status-text')
const formatRuntimeState = document.querySelector('#format-runtime-state')
const formatState = {
  inputs: [],
  results: [],
  progressByInput: new Map(),
  errorsByInput: new Map(),
  busy: false,
  saving: false,
  taskId: '',
  ffmpegReady: false,
  sharpReady: false
}

function formatConfig() {
  return formatActionConfigs[state.selections.video] || formatActionConfigs.视频转换
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function renderFormatFiles() {
  formatFileList.replaceChildren()
  formatEmpty.hidden = formatState.inputs.length > 0
  const resultInputIds = new Set(formatState.results.map((result) => result.inputId))
  const fragment = document.createDocumentFragment()
  formatState.inputs.forEach((input, index) => {
    const row = document.createElement('article')
    const indexNode = document.createElement('span')
    const nameNode = document.createElement('span')
    const name = document.createElement('b')
    const detail = document.createElement('small')
    const size = document.createElement('span')
    const status = document.createElement('span')
    const remove = document.createElement('button')
    const error = formatState.errorsByInput.get(input.id)
    const progress = formatState.progressByInput.get(input.id)
    row.className = 'format-file-item'
    indexNode.className = 'format-index'
    nameNode.className = 'format-name'
    size.className = 'format-size'
    status.className = 'format-file-status'
    remove.className = 'format-remove'
    remove.type = 'button'
    remove.dataset.inputId = input.id
    remove.setAttribute('aria-label', `移除 ${input.name}`)
    remove.textContent = '×'
    remove.disabled = formatState.busy
    indexNode.textContent = String(index + 1)
    name.textContent = input.name
    const inputDetail = input.dimensions?.width
      ? `${input.dimensions.width} × ${input.dimensions.height}`
      : (input.name.split('.').at(-1) || input.kind).toUpperCase()
    detail.textContent = error || inputDetail
    detail.title = error || ''
    size.textContent = formatSize(input.size)
    if (error) {
      status.textContent = '导出失败'
      status.classList.add('error')
      status.title = error
    } else if (resultInputIds.has(input.id)) {
      status.textContent = '已导出'
      status.classList.add('success')
    } else if (Number.isFinite(progress)) {
      status.textContent = `转换中 ${Math.round(progress * 100)}%`
      status.classList.add('busy')
    } else {
      status.textContent = '等待处理'
    }
    nameNode.append(name, detail)
    row.append(indexNode, nameNode, size, status, remove)
    fragment.append(row)
  })
  formatFileList.append(fragment)
  updateFormatControls()
}

function updateFormatControls() {
  const config = formatConfig()
  const engineReady = config.kind === 'image' ? formatState.sharpReady : formatState.ffmpegReady
  formatRunButton.disabled = formatState.busy || !formatState.inputs.length || !engineReady
  formatSaveButton.disabled = formatState.busy || !formatState.results.length
  document.querySelector('#format-pick-files').disabled = formatState.busy
  document.querySelector('#format-pick-folder').disabled = formatState.busy
  document.querySelector('#format-clear-inputs').disabled = formatState.busy
}

function renderFormatOptions() {
  const config = formatConfig()
  const isImage = config.kind === 'image'
  const qualityLabel = isImage ? '质量' : 'CRF（越低越清晰）'
  const qualityValue = isImage ? 82 : state.selections.video === '视频压缩' ? 28 : 23
  const qualityMin = isImage ? 10 : 18
  const qualityMax = isImage ? 100 : 35
  const target = config.targets
    ? `
      <label>输出格式
        <select id="format-target">
          ${config.targets.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select>
      </label>
    `
    : ''
  const audioOptions = ['视频转换', '视频压缩', '抽取音频', '音频转换'].includes(state.selections.video)
    ? `
      <label>音频码率 <b id="format-bitrate-value">192 kbps</b>
        <input id="format-audio-bitrate" type="range" min="64" max="320" step="32" value="192" />
      </label>
      <label>采样率
        <select id="format-sample-rate">
          <option value="44100">44.1 kHz</option>
          <option value="48000">48 kHz</option>
          <option value="32000">32 kHz</option>
        </select>
      </label>
    `
    : ''
  formatOptions.innerHTML = `
    ${target}
    <label>${qualityLabel} <b id="format-quality-value">${qualityValue}</b>
      <input id="format-quality" type="range" min="${qualityMin}" max="${qualityMax}" value="${qualityValue}" />
    </label>
    <label>最大宽度
      <select id="format-max-width">
        <option value="0">保持原尺寸</option>
        <option value="3840">3840 px</option>
        <option value="1920">1920 px</option>
        <option value="1280">1280 px</option>
        <option value="720">720 px</option>
      </select>
    </label>
    ${audioOptions}
  `
  const quality = formatOptions.querySelector('#format-quality')
  quality.addEventListener('input', () => {
    formatOptions.querySelector('#format-quality-value').textContent = quality.value
  })
  const bitrate = formatOptions.querySelector('#format-audio-bitrate')
  bitrate?.addEventListener('input', () => {
    formatOptions.querySelector('#format-bitrate-value').textContent = `${bitrate.value} kbps`
  })
}

function setFormatAction(action, indicatorFromTop = null) {
  if (!formatActionConfigs[action]) return
  const previousKind = formatConfig().kind
  state.selections.video = action
  const config = formatConfig()
  document.querySelector('#format-crumb').textContent = action
  document.querySelector('#format-action-title').textContent = action
  document.querySelector('#format-action-mark').textContent = config.mark
  document.querySelector('#format-action-copy').textContent = config.copy
  document.querySelector('#format-empty-title').textContent =
    `添加${config.kind === 'video' ? '视频' : config.kind === 'audio' ? '音频' : '图片'}文件`
  document.querySelector('#format-pick-files').textContent =
    `＋ 添加${config.kind === 'video' ? '视频' : config.kind === 'audio' ? '音频' : '图片'}`
  formatRunButton.textContent = config.runLabel
  if (previousKind !== config.kind && formatState.inputs.length) clearFormatInputs()
  formatState.results = []
  formatState.progressByInput.clear()
  formatState.errorsByInput.clear()
  formatProgressFill.style.width = '0'
  formatStatusText.textContent = formatState.inputs.length ? '准备就绪' : '添加文件后可开始'
  renderFormatOptions()
  renderSubmenu('video', indicatorFromTop)
  renderFormatFiles()
  loadFormatRuntimeStatus()
}

function addFormatInputs(files, replace = false) {
  if (replace) {
    window.api.removeFormatInputs(formatState.inputs.map((input) => input.id)).catch(() => {})
    formatState.inputs = []
  }
  const knownIds = new Set(formatState.inputs.map((input) => input.id))
  const unique = files.filter((file) => !knownIds.has(file.id))
  const available = Math.max(0, 100 - formatState.inputs.length)
  const accepted = unique.slice(0, available)
  const rejected = unique.slice(available)
  if (rejected.length) {
    window.api.removeFormatInputs(rejected.map((file) => file.id)).catch(() => {})
  }
  formatState.inputs.push(...accepted)
  formatState.results = []
  formatState.progressByInput.clear()
  formatState.errorsByInput.clear()
  formatStatusText.textContent = `已添加 ${formatState.inputs.length} 个文件`
  formatProgressFill.style.width = '0'
  renderFormatFiles()
}

async function pickFormatFiles() {
  try {
    const result = await window.api.pickFormatFiles({ kind: formatConfig().kind })
    if (result.status !== 'selected') return
    addFormatInputs(result.files)
    if (result.errors.length) showToast(`${result.errors.length} 个文件未能加入`)
  } catch (error) {
    showToast(`添加文件失败：${error.message}`)
  }
}

async function pickFormatFolder() {
  try {
    const result = await window.api.pickFormatFolder({ kind: formatConfig().kind })
    if (result.status !== 'selected') return
    addFormatInputs(result.files, true)
    if (result.truncated) showToast('文件超过 100 个，已取前 100 个')
    else if (result.errors.length) showToast(`${result.errors.length} 个文件未能加入`)
  } catch (error) {
    showToast(`读取文件夹失败：${error.message}`)
  }
}

const formatDropZone = document.querySelector('#format-drop-zone')
bindFileDropZone(formatDropZone, async (files) => {
  if (formatState.busy) return
  try {
    const result = await window.api.scanDroppedPaths({
      paths: droppedFilePaths(files),
      region: 'format',
      action: formatConfig().kind
    })
    addFormatInputs(result.files)
    if (result.skipped || result.errors.length || result.truncated) {
      const notes = []
      if (result.skipped) notes.push(`${result.skipped} 个跳过`)
      if (result.errors.length) notes.push(`${result.errors.length} 个失败`)
      if (result.truncated) notes.push('已达数量上限')
      if (notes.length) showToast(`扫描完成：${notes.join('，')}`)
    }
  } catch (error) {
    showToast(`拖入失败：${cleanIpcError(error?.message ?? error)}`)
  }
})

async function clearFormatInputs() {
  const ids = formatState.inputs.map((input) => input.id)
  formatState.inputs = []
  formatState.results = []
  formatState.progressByInput.clear()
  formatState.errorsByInput.clear()
  formatState.taskId = ''
  formatProgressFill.style.width = '0'
  formatStatusText.textContent = '添加文件后可开始'
  renderFormatFiles()
  if (ids.length) await window.api.removeFormatInputs(ids).catch(() => {})
}

function currentFormatOptions() {
  return {
    target: formatOptions.querySelector('#format-target')?.value || '',
    quality: Number(formatOptions.querySelector('#format-quality')?.value),
    maxWidth: Number(formatOptions.querySelector('#format-max-width')?.value),
    audioBitrate: Number(formatOptions.querySelector('#format-audio-bitrate')?.value || 192),
    sampleRate: Number(formatOptions.querySelector('#format-sample-rate')?.value || 44100)
  }
}

async function runFormatTask() {
  if (formatState.busy || !formatState.inputs.length) return
  formatState.busy = true
  formatState.results = []
  formatState.progressByInput.clear()
  formatState.errorsByInput.clear()
  formatState.taskId = crypto.randomUUID()
  formatRunButton.textContent = '处理中…'
  formatCancelButton.hidden = false
  formatStatusText.textContent = '正在准备任务…'
  updateFormatControls()
  try {
    const response = await window.api.runFormatTask({
      taskId: formatState.taskId,
      action: state.selections.video,
      inputIds: formatState.inputs.map((input) => input.id),
      options: currentFormatOptions()
    })
    if (response.status === 'cancelled') {
      formatStatusText.textContent = '任务已取消'
      showToast('格式转换任务已取消')
    } else {
      formatState.results = response.results
      response.errors.forEach((error) => {
        formatState.errorsByInput.set(error.inputId, error.message)
      })
      formatProgressFill.style.width = '100%'
      formatStatusText.textContent = response.errors.length
        ? `完成 ${response.results.length} 个，失败 ${response.errors.length} 个`
        : `已完成 ${response.results.length} 个文件`
      showToast('格式转换任务完成')
    }
  } catch (error) {
    formatStatusText.textContent = `处理失败：${error.message}`
    showToast('格式转换失败')
  } finally {
    formatState.busy = false
    formatState.taskId = ''
    formatRunButton.textContent = formatConfig().runLabel
    formatCancelButton.hidden = true
    renderFormatFiles()
  }
}

async function cancelFormatTask() {
  if (!formatState.taskId) return
  formatCancelButton.disabled = true
  formatStatusText.textContent = '正在取消任务…'
  try {
    await window.api.cancelFormatTask(formatState.taskId)
  } finally {
    formatCancelButton.disabled = false
  }
}

async function saveFormatResults() {
  if (!formatState.results.length || formatState.saving) return
  formatState.saving = true
  formatSaveButton.disabled = true
  try {
    const response = await window.api.saveFormatResults(formatState.results.map((result) => result.id))
    if (response.status === 'saved') {
      formatStatusText.textContent = `已保存 ${response.saved} 个结果`
      showToast('格式转换结果已保存')
    }
  } catch (error) {
    showToast(`保存失败：${error.message}`)
  } finally {
    formatState.saving = false
    formatSaveButton.disabled = formatState.results.length === 0
  }
}

async function loadFormatRuntimeStatus() {
  try {
    const status = await window.api.getFormatStatus()
    formatState.ffmpegReady = status.ffmpegReady
    formatState.sharpReady = Boolean(status.sharp?.sharp)
    const ready = formatConfig().kind === 'image' ? formatState.sharpReady : formatState.ffmpegReady
    formatRuntimeState.classList.toggle('ready', ready)
    formatRuntimeState.classList.toggle('error', !ready)
    formatRuntimeState.lastChild.textContent = ready
      ? formatConfig().kind === 'image'
        ? `sharp ${status.sharp.sharp}`
        : `${status.ffmpegVersion || 'FFmpeg'} · 编码器就绪`
      : formatConfig().kind === 'image' ? 'sharp 未能加载' : status.ffmpegMessage
    document.querySelector('#format-engine-name').textContent =
      formatConfig().kind === 'image'
        ? `sharp ${status.sharp?.sharp || ''}`
        : (status.ffmpegVersion || 'FFmpeg')
    document.querySelector('#format-engine-status').textContent =
      ready ? '本地引擎可用' : '当前环境不可用'
    updateFormatControls()
  } catch (error) {
    formatRuntimeState.classList.add('error')
    formatRuntimeState.lastChild.textContent = `引擎检查失败：${error.message}`
  }
}

document.querySelector('#format-pick-files').addEventListener('click', pickFormatFiles)
document.querySelector('#format-pick-folder').addEventListener('click', pickFormatFolder)
document.querySelector('#format-clear-inputs').addEventListener('click', clearFormatInputs)
formatFileList.addEventListener('click', async (event) => {
  const button = event.target.closest('.format-remove')
  if (!button || formatState.busy) return
  const inputId = button.dataset.inputId
  formatState.inputs = formatState.inputs.filter((input) => input.id !== inputId)
  formatState.results = formatState.results.filter((result) => result.inputId !== inputId)
  formatState.progressByInput.delete(inputId)
  formatState.errorsByInput.delete(inputId)
  renderFormatFiles()
  await window.api.removeFormatInputs([inputId]).catch(() => {})
})
formatRunButton.addEventListener('click', runFormatTask)
formatCancelButton.addEventListener('click', cancelFormatTask)
formatSaveButton.addEventListener('click', saveFormatResults)
window.api.onFormatProgress((progress) => {
  if (progress.status === 'running' && progress.taskId === formatState.taskId) {
    const overall = (progress.completed + (progress.fileProgress || 0)) / Math.max(1, progress.total)
    if (progress.inputId) {
      formatState.progressByInput.set(progress.inputId, Math.min(1, progress.fileProgress || 0))
      renderFormatFiles()
    }
    formatProgressFill.style.width = `${Math.min(100, overall * 100)}%`
    formatStatusText.textContent = `正在处理 ${Math.min(progress.completed + 1, progress.total)} / ${progress.total}${progress.name ? ` · ${progress.name}` : ''}`
  } else if (progress.status === 'saving' && formatState.saving) {
    formatStatusText.textContent = `正在保存 ${progress.completed} / ${progress.total}`
  }
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

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片编码失败'))
    }, type, quality)
  })
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

  const angle = colorState.h * Math.PI / 180
  const distance = 48 + (colorState.s / 100) * 44
  colorMarker.style.left = `${100 + Math.cos(angle) * distance}px`
  colorMarker.style.top = `${100 + Math.sin(angle) * distance}px`
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
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    updateColorControls()
    return
  }

  colorState.r = Number.parseInt(value.slice(1, 3), 16)
  colorState.g = Number.parseInt(value.slice(3, 5), 16)
  colorState.b = Number.parseInt(value.slice(5, 7), 16)
  rgbToHsl(colorState.r, colorState.g, colorState.b)
  updateColorControls()
  applyAccent()
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
  settingsNavItems.forEach((item) => item.classList.toggle('active', item.dataset.settingsTarget === current.id))
}

settingsNavItems.forEach((item) => {
  item.addEventListener('click', (event) => {
    event.preventDefault()
    const section = document.getElementById(item.dataset.settingsTarget)
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
})

settingsLayout?.addEventListener('scroll', syncSettingsNavigation, { passive: true })

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

// ── 设置页：更新（GitHub Releases 自动更新）──
function initUpdatePanel() {
  const el = {
    current: document.querySelector('#update-current'),
    last: document.querySelector('#update-last'),
    autocheck: document.querySelector('#update-autocheck'),
    statusText: document.querySelector('#update-status-text'),
    notes: document.querySelector('#update-notes'),
    progress: document.querySelector('#update-progress'),
    bar: document.querySelector('#update-progress-bar'),
    progressText: document.querySelector('#update-progress-text'),
    primary: document.querySelector('#update-primary'),
    secondary: document.querySelector('#update-secondary')
  }
  if (!el.current) return

  const fmtTime = (ts) => {
    if (!ts) return '—'
    try { return new Date(ts).toLocaleString() } catch { return '—' }
  }

  function statusLabel(s) {
    switch (s.status) {
      case 'checking': return '正在检查更新…'
      case 'available': return `发现新版本 v${s.availableVersion}`
      case 'downloading': return '正在下载更新…'
      case 'downloaded': return `v${s.availableVersion} 已下载，可重启安装`
      case 'up-to-date': return '已是最新版本'
      case 'error': return `更新出错：${s.message || '未知错误'}`
      case 'portable': return '便携版不支持自动更新，请前往 GitHub 手动下载'
      default: return '尚未检查更新'
    }
  }

  function render(s) {
    el.current.textContent = s.currentVersion || '—'
    el.last.textContent = fmtTime(s.lastCheckedAt)
    el.autocheck.checked = !!s.autoCheck
    el.statusText.textContent = statusLabel(s)
    if (s.releaseNotes) {
      el.notes.textContent = s.releaseNotes
      el.notes.hidden = false
    } else {
      el.notes.hidden = true
      el.notes.textContent = ''
    }
    if (s.status === 'downloading' && s.progress) {
      const pct = Math.floor(s.progress.percent || 0)
      el.bar.value = pct
      el.progressText.textContent = `${pct}%`
      el.progress.hidden = false
    } else {
      el.progress.hidden = true
    }
    el.secondary.hidden = s.status !== 'downloaded'
    const p = el.primary
    p.disabled = false
    switch (s.status) {
      case 'available': p.textContent = '下载更新'; break
      case 'checking': p.textContent = '检查中…'; p.disabled = true; break
      case 'downloading': p.textContent = '下载中…'; p.disabled = true; break
      case 'downloaded': p.textContent = '立即重启更新'; break
      case 'portable': p.textContent = '前往 GitHub 下载'; break
      default: p.textContent = '检查更新'
    }
  }

  el.primary.addEventListener('click', async () => {
    const s = await window.api.update.getState()
    if (s.status === 'portable') { await window.api.update.openReleases(); return }
    if (s.status === 'downloaded') { await window.api.update.install(); return }
    if (s.status === 'available') { await window.api.update.download(); return }
    await window.api.update.check()
  })
  el.secondary.addEventListener('click', () => {
    el.secondary.hidden = true
    el.progress.hidden = true
    el.statusText.textContent = '已下载更新，稍后可在设置中重启安装'
  })
  el.autocheck.addEventListener('change', async () => {
    await window.api.update.setAutoCheck(el.autocheck.checked)
  })

  window.api.update.onState(render)
  window.api.update.getState().then(render).catch(() => {})
}
initUpdatePanel()

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

drawColorWheel()
rgbToHsl(colorState.r, colorState.g, colorState.b)
updateColorControls()
applyAccent()
setBarcodeMode('single')
generateBarcode()
setFormatAction('视频转换')
activateModule('home')
verifyPreloadBridge()

// 启动埋点：首帧绘制且交互就绪后回报主进程（F-018 验收用）。
if (!window.__moyuStartupReported) {
  window.__moyuStartupReported = true
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.api.reportStartupReady())
  )
}
