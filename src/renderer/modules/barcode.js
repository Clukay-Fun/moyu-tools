import JsBarcode from 'jsbarcode'
import { parse as parseOpenType } from 'opentype.js'
import { isRetailType, renderRetailBarcode, computeRetailGeometry } from '../retailBarcode.js'
import { cleanIpcError, illustratorFailureHint, isComCancelled } from '../comErrors.js'
import {
  isGenericType, renderGenericBarcode, computeGenericGeometry, genericRasterSize, resolveGenericTypeName,
  CODE39_DEFAULTS, CODABAR_DEFAULTS, MSI_DEFAULTS
} from '../genericBarcode.js'
import {
  isGs1128Type, prepareGs1128, renderGs1128, computeGs1128Geometry, gs1128RasterSize
} from '../gs1128Barcode.js'
import {
  isItf14Type, renderItf14, computeItf14Geometry, itf14RasterSize,
  ITF14_PRESETS, ITF14_DEFAULT_PRESET
} from '../itf14Barcode.js'

/**
 * 条码页面：六种通用码（JsBarcode）+ 零售合规码 + GS1-128 + ITF-14，
 * 单个/批量生成、保存、复制、Illustrator/Photoshop 联动。
 * 从 main.js 原样搬出，DOM 结构、状态字段、渲染顺序与拆分前逐字一致。
 *
 * @param {object} deps
 * @param {object} deps.state 全局共享状态
 * @param {(message: string) => void} deps.showToast
 * @param {object} deps.barcodeTypes 条码类型配置表（跟顶部导航菜单共用同一份真值）
 * @param {object} deps.barcodeFonts 条码 HRI 字体配置表
 */
export function initBarcode({ state, showToast, barcodeTypes, barcodeFonts }) {
  // 零售合规码 HRI 固定字体（GS1 §5.2.5 禁止粗/斜/细/窄体，不随用户选择变化）
  const RETAIL_HRI_FONT_KEY = 'ocrb'
  let barcodeRenderedValue = ''
  let barcodeRenderedType = ''
  const parsedBarcodeFonts = new Map()

  const barcodeInput = document.querySelector('#barcode-value')
  const barcodeCompactSummary = document.querySelector('#barcode-compact-summary')
  const barcodeAdvancedSettings = document.querySelector('#barcode-advanced-settings')
  const barcodeSettingsTitle = document.querySelector('#barcode-settings-title')
  const barcodeSettingsCard = document.querySelector('#barcode-settings-card')
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
  // 上一次批量保存里失败的条目（按类型分开）；再次点同一个保存按钮时只重试
  // 这些，不用把已经成功落盘的文件重新导出一遍。批量重新生成/改动输入内容会
  // 让原有条目整体作废，这里也要一并清空，否则会拿旧的 svg 节点去重试。
  const barcodeBatchSaveFailures = { svg: null, png: null }
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

  function renderBarcodeCompactSummary(typeName) {
    const parts = [typeName]
    if (barcodeRenderedValue) parts.push(`${barcodeRenderedValue.length} 位`)

    try {
      if (isGs1128Type(typeName) && gs1128Prepared) {
        const geometry = computeGs1128Geometry(gs1128Prepared)
        const raster = gs1128RasterSize(gs1128Prepared)
        parts.push(`${geometry.widthMm.toFixed(2)} × ${geometry.heightMm.toFixed(2)} mm`, `${raster.dpi} DPI`)
      } else if (isItf14Type(typeName)) {
        const geometry = computeItf14Geometry(state.itf14Preset || ITF14_DEFAULT_PRESET, barcodeRenderedValue || null)
        const raster = itf14RasterSize(state.itf14Preset || ITF14_DEFAULT_PRESET, barcodeRenderedValue || null)
        parts.push(`${geometry.widthMm.toFixed(2)} × ${geometry.heightMm.toFixed(2)} mm`, `${raster.dpi} DPI`)
      } else if (isRetailType(typeName)) {
        const geometry = computeRetailGeometry(typeName)
        const raster = retailRasterSize(typeName)
        parts.push(`${geometry.widthMm.toFixed(2)} × ${geometry.heightMm.toFixed(2)} mm`, `${raster.dpi} DPI`)
      } else if (isGenericType(typeName) && barcodeRenderedValue) {
        const options = genericOptionsFor(typeName)
        const geometry = computeGenericGeometry(typeName, barcodeRenderedValue, options)
        const raster = genericRasterSize(typeName, barcodeRenderedValue, options)
        parts.push(`${geometry.widthMm.toFixed(2)} × ${geometry.heightMm.toFixed(2)} mm`, `${raster.dpi} DPI`)
      }
    } catch {
      // 紧凑摘要是辅助信息；详细规格与生成错误仍由原有路径负责。
    }

    barcodeCompactSummary.textContent = parts.join(' · ')
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
  let barcodeBatchRequestSeq = 0
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

  // 正在进行的保存/导出/COM 联动个数（计数而不是布尔，因为不同按钮各自独立
  // 禁用，两个操作理论上能重叠）。安装更新前置检查（updatePanel.js）靠这个
  // 判断"条码这边是不是正在写文件/联动外部程序"——之前完全没有这项检查，
  // 保存/导出到一半被强制退出重启会留下写了一半的文件。
  let barcodeOperationCount = 0

  async function generateBarcode(notifyError = true) {
    // 保留原始输入用于字符校验：trim 前的首尾空格也应算非法字符，不能被静默接受。
    const rawInput = barcodeInput.value
    const raw = rawInput.trim()
    const typeName = state.selections.bc
    barcodeCompactSummary.textContent = `${typeName} · 等待有效输入`
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
      renderBarcodeCompactSummary(typeName)
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
    barcodeOperationCount += 1

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
      barcodeOperationCount -= 1
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
    barcodeOperationCount += 1

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
      barcodeOperationCount -= 1
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
    barcodeOperationCount += 1

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
      barcodeOperationCount -= 1
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

    barcodeAdvancedSettings.hidden = !(code39 || msi || codabar)
    const hasBaseSettings = !fixedFont || itf14
    barcodeSettingsTitle.hidden = !hasBaseSettings
    barcodeSettingsCard.hidden = !hasBaseSettings
  }

  function selectBarcodeType(typeName, replaceValue = false) {
    const type = barcodeTypes[typeName]
    if (!type) return

    barcodeBatchRequestSeq += 1
    generateBarcodeBatchButton.disabled = false
    generateBarcodeBatchButton.textContent = '批量生成'
    state.selections.bc = typeName
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
    barcodeBatchSaveFailures.svg = null
    barcodeBatchSaveFailures.png = null
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
    barcodeBatchSaveFailures.svg = null
    barcodeBatchSaveFailures.png = null
    barcodeBatchList.replaceChildren()
    setBarcodeBatchExportEnabled(false)
    generateBarcodeBatchButton.disabled = true
    generateBarcodeBatchButton.textContent = '正在生成…'
    const requestId = ++barcodeBatchRequestSeq
    const batchType = state.selections.bc
    const batchItf14Preset = isItf14Type(batchType) ? state.itf14Preset : null
    const batchGenericOptions = genericOptionsFor(batchType)
    const fragment = document.createDocumentFragment()
    let validCount = 0

    for (const [index, value] of values.entries()) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      let item

      // 冻结生成时的 ITF-14 预设：生成后若切换预设，
      // 已有 SVG 与导出像素尺寸必须仍属同一模式。
      const itf14Preset = batchItf14Preset
      // Code 39 的窄宽比 / Mod 43 / Full ASCII 随条目冻结，
      // 生成后改设置不得影响已有条目的 SVG 与导出像素。
      const genericOptions = batchGenericOptions

      try {
        // GS1-128 每条独立做一次 AI 校验，校验结果随条目冻结，
        // 后续导出只用这份结果，不重新校验、不共用上一条的数据。
        const prepared = isGs1128Type(batchType) ? await prepareGs1128(value) : null
        if (requestId !== barcodeBatchRequestSeq) return
        renderBarcodeSvg(svg, value, batchType, itf14Preset, prepared, genericOptions)
        item = {
          value,
          type: batchType,
          itf14Preset,
          prepared,
          genericOptions,
          valid: true,
          svg
        }
        validCount += 1
      } catch (error) {
        if (requestId !== barcodeBatchRequestSeq) return
        item = {
          value,
          type: batchType,
          itf14Preset,
          prepared: null,
          genericOptions,
          valid: false,
          error: (isGs1128Type(batchType) || isGenericType(batchType)) && error instanceof Error
            ? error.message
            : friendlyBarcodeError(batchType)
        }
      }

      state.barcodeBatchItems.push(item)
      fragment.append(createBatchCard(item, index))

      if ((index + 1) % 20 === 0) {
        barcodeBatchList.append(fragment)
        await nextFrame()
        if (requestId !== barcodeBatchRequestSeq) return
      }
    }

    if (requestId !== barcodeBatchRequestSeq) return
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
    // 有上一轮失败记录时只重试那几个；否则是全新的一批。
    const validItems = barcodeBatchSaveFailures[type] || state.barcodeBatchItems.filter((item) => item.valid)
    if (!validItems.length) {
      barcodeBatchSummary.textContent = '没有可保存的有效条码。'
      return
    }

    const button = type === 'svg' ? saveBarcodeBatchSvgButton : saveBarcodeBatchPngButton
    const originalLabel = button.textContent
    setBarcodeBatchExportEnabled(false)
    generateBarcodeBatchButton.disabled = true
    button.textContent = '正在准备…'
    barcodeOperationCount += 1
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
          if (result.failed > 0) {
            // 记录失败项，索引对应的是这次实际发送的 files/validItems 顺序。
            barcodeBatchSaveFailures[type] = result.errors.map((error) => validItems[error.index]).filter(Boolean)
            barcodeBatchSummary.textContent =
              `已保存 ${result.saved} 个，失败 ${result.failed} 个（再次点击“保存 ${type.toUpperCase()}”可只重试失败项）。`
            showToast(`批量保存部分失败：${result.saved} 成功 / ${result.failed} 失败`)
          } else {
            barcodeBatchSaveFailures[type] = null
            barcodeBatchSummary.textContent = `已保存 ${result.saved} 个 ${type.toUpperCase()} 文件。`
            showToast(`批量条码已保存：${result.saved} 个文件`)
          }
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
      barcodeOperationCount -= 1
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
    barcodeBatchSaveFailures.svg = null
    barcodeBatchSaveFailures.png = null
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
      barcodeBatchSaveFailures.svg = null
      barcodeBatchSaveFailures.png = null
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
      barcodeBatchSaveFailures.svg = null
      barcodeBatchSaveFailures.png = null
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
      barcodeBatchSaveFailures.svg = null
      barcodeBatchSaveFailures.png = null
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
      barcodeBatchSaveFailures.svg = null
      barcodeBatchSaveFailures.png = null
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

  return {
    selectBarcodeType,
    setBarcodeMode,
    generateBarcode,
    isBusy: () => barcodeOperationCount > 0
  }
}
