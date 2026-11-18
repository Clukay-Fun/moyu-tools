// GS1 零售条码几何引擎（生产合规）
//
// 规范来源：GS1 General Specifications 26.0.0
//   §5.12.3.1 / Table 5-44（一般零售 POS 消费品包装）
//   §5.2.3.1 标称尺寸 · §5.2.3.2 符号高度 · §5.2.3.3 X-dimension
//   §5.2.3.4 静区 · §5.2.5 HRI
//
// 设计要点：
//   1. JsBarcode 只作编码器（取 95 位模块串），不参与任何布局；
//   2. 唯一几何真值以毫米表达，SVG viewBox 即 mm 坐标系；
//   3. UPC-A 默认遵循 GS1；另提供按客户 AI 参考稿排版的命名预设。
//
// ⚠ 深层导入：jsbarcode 内部路径，非公开稳定 API，版本锁死 3.12.3。
//   文件末尾为 `exports.default = UPC`（CommonJS + __esModule），
//   直接默认导入在 Vite ESM interop 下会拿到命名空间对象，必须解包。
import UPCModule from 'jsbarcode/bin/barcodes/EAN_UPC/UPC.js'
import EAN13Module from 'jsbarcode/bin/barcodes/EAN_UPC/EAN13.js'
import EAN8Module from 'jsbarcode/bin/barcodes/EAN_UPC/EAN8.js'
import * as eanConstants from 'jsbarcode/bin/barcodes/EAN_UPC/constants.js'

const UPC = UPCModule.default || UPCModule
const EAN13 = EAN13Module.default || EAN13Module
const EAN8 = EAN8Module.default || EAN8Module
const UPC_A_CUSTOMER_SAMPLE = 'customer-sample'
const UPC_A_CUSTOMER_SHORT = 'customer-short'
const CUSTOMER_LAYOUTS = {
  [UPC_A_CUSTOMER_SAMPLE]: { width: 98.14 * 25.4 / 72, height: 25.908, x: 0.30825, left: 2.428, top: 0.747, bottom: 22.272, cap: 2.56, digitInset: 0.69, outerDrop: 0.26, leftGap: 3.28, rightGap: 3.25 },
  "customer-b": { width: 78.512 * 25.4 / 72, height: 20.7264, x: 0.243065, left: 2.159, top: 0.60325, bottom: 17.41276, cap: 2.02107, digitInset: 0.98683, outerDrop: 0.20732, leftGap: 3.278, rightGap: 3.25 },
  "customer-c": { width: 196.28 * 25.4 / 72, height: 51.816, x: 0.6126, left: 5.14844, top: 1.24813, bottom: 44.61792, cap: 5.09588, digitInset: 1.33209, outerDrop: 0.52278, leftGap: 3.28, rightGap: 3.25 },
  [UPC_A_CUSTOMER_SHORT]: { width: 88.556 * 25.4 / 72, height: 7.366, x: 0.280384, left: 2.0877, top: 0.4812, bottom: 4.0432, cap: 2.33, digitInset: 0.638, outerDrop: 0.239, leftGap: 3.28, rightGap: 3.25 }
}
// 首位数字决定 EAN-13 左侧 6 位用 L(Number Set A) 还是 G(Number Set B)，
// 直接影响 Table 5-10 的补偿方向，必须按位取用。
const EAN13_STRUCTURE = eanConstants.EAN13_STRUCTURE || eanConstants.default?.EAN13_STRUCTURE


// GS1 GenSpecs 26.0.0 §5.2.3.1 / Table 5-10：字符 1/2/7/8 的条空补偿。
// 数值为 **X/13**（不写死 0.025mm——那只是 X=0.330mm 时的近似值）。
//   Number Set A   ：1,2 → 条 -X/13、空 +X/13 ； 7,8 → 条 +X/13、空 -X/13
//   Number Set B/C ：符号相反
// 每字符含 2 条 2 空，补偿总和为 0，字符总宽恒为 7X。
// 只作用于编码字符，不动护栏、静区与 HRI。属规范内置补偿，非用户可调 BWR。
const TABLE_5_10_BAR_SIGN = {
  A: { 1: -1, 2: -1, 7: 1, 8: 1 },
  BC: { 1: 1, 2: 1, 7: -1, 8: -1 }
}


// 通用分段构造：起始护栏 + 左区字符 + 中间护栏 + 右区字符 + 结束护栏。
// numberSetOf(k) 返回该左区字符的 Number Set（'A' 或 'BC'）。
function buildSegments({ charCount, numberSetOf, extendFirstLastChar }) {
  return (text) => {
    // 进入条空编码的永远是 text 的后 charCount×2 位：
    // UPC-A 12/12、EAN-8 8/8 全部编码；EAN-13 首位不编码（由左侧奇偶模式承载）。
    const encoded = text.slice(text.length - charCount * 2)
    const leftDigits = encoded.slice(0, charCount)
    const rightDigits = encoded.slice(charCount)
    const leftStart = 3
    const rightStart = 3 + charCount * 7 + 5
    return [
      { start: 0, count: 3, kind: 'guard', extended: true },
      ...Array.from({ length: charCount }, (_, k) => ({
        start: leftStart + k * 7,
        count: 7,
        kind: 'char',
        digit: leftDigits[k],
        numberSet: numberSetOf(k, text),
        extended: Boolean(extendFirstLastChar) && k === 0
      })),
      { start: leftStart + charCount * 7, count: 5, kind: 'guard', extended: true },
      ...Array.from({ length: charCount }, (_, k) => ({
        start: rightStart + k * 7,
        count: 7,
        kind: 'char',
        digit: rightDigits[k],
        numberSet: 'BC',
        extended: Boolean(extendFirstLastChar) && k === charCount - 1
      })),
      { start: rightStart + charCount * 7, count: 3, kind: 'guard', extended: true }
    ]
  }
}

// Table 5-44：一般零售 POS。Factor 固定 100%，取标称 X。
const RETAIL_SPECS = {
  'UPC-A': {
    encoder: (value) => new UPC(value, { flat: true }),
    xDimensionMm: 0.33,
    dataModules: 95,
    quietLeftX: 9,
    quietRightX: 9,
    barHeightMm: 22.85,
    guardExtendX: 5,
    charCount: 6,
    // UPC-A：首尾符号字符的条同样下延（因其 HRI 数字在符号外）
    segments: buildSegments({ charCount: 6, numberSetOf: () => 'A', extendFirstLastChar: true }),
    // HRI：首位与末位在符号外，中间 5+5 在数据区下方
    hriLayout: (text) => ({
      outsideFirst: text[0],
      outsideLast: text[text.length - 1],
      left: [1, 2, 3, 4, 5].map((charIndex, i) => ({ digit: text[i + 1], charIndex })),
      right: [0, 1, 2, 3, 4].map((charIndex, i) => ({ digit: text[i + 6], charIndex }))
    }),
    hri: {
      gapX: 1,
      capHeightMm: 2.75,
      outsideMaxInkWidthX: 4,
      outsideEdgeGapX: 5
    }
  },

  'EAN-13': {
    encoder: (value) => new EAN13(value, { flat: true }),
    xDimensionMm: 0.33,
    dataModules: 95,
    quietLeftX: 11, // §5.2.3.4：EAN-13 左 11X / 右 7X（与 UPC-A 的 9X/9X 不同）
    quietRightX: 7,
    barHeightMm: 22.85,
    guardExtendX: 5,
    charCount: 6,
    // EAN-13 只有护栏下延；符号字符不下延（首尾字符下延是 UPC-A 专有）
    segments: buildSegments({
      charCount: 6,
      // 左侧 6 位按首位决定的奇偶模式取 L(Set A) / G(Set B)
      numberSetOf: (k, text) => (EAN13_STRUCTURE[Number(text[0])][k] === 'L' ? 'A' : 'BC'),
      extendFirstLastChar: false
    }),
    // HRI：仅首位在符号外，其余 6+6 在数据区下方（1 + 6 + 6）
    hriLayout: (text) => ({
      outsideFirst: text[0],
      outsideLast: null,
      left: Array.from({ length: 6 }, (_, i) => ({ digit: text[i + 1], charIndex: i })),
      right: Array.from({ length: 6 }, (_, i) => ({ digit: text[i + 7], charIndex: i }))
    }),
    hri: {
      gapX: 1,
      capHeightMm: 2.75,
      // ── EAN-13 符号外首位数字：水平位置**未锁定** ──────────────────
      // 已确认（GS1 26.0.0 §5.2.5 p337 / Figure 5-11 p326）：
      //   · 位于起始护栏左侧，与内部数字同一行；
      //   · **与内部数字同字号、同基线**；
      //   · **不适用** UPC-A 的「最大墨宽 4X、距护栏 5X」缩小规则。
      // 未确认：GS1 未见对 EAN-13 规定同类固定水平间距。
      // 因此**不设 outsideMaxInkWidthX / outsideEdgeGapX**（那是 UPC-A 专有值），
      // 下面是**版式实现值，不是规范值**；在锁定前 EAN-13 不标生产合规。
      outsideFirstProvisionalOffsetX: 5,
      // 符号外首位数字的水平位置由 ISO/IEC 15420 规定，GS1 GenSpecs 未涵盖。
      // 本版**明确决定不采购该规范**，故此项长期保持待定：
      // 其余参数（条空、静区、条高、Table 5-10 补偿）均已按 GS1 锁定，
      // 只有这一项不作生产合规声明。不得用商业软件反推的实测值解除。
      placementPending: true
    }
  },

  'EAN-8': {
    encoder: (value) => new EAN8(value, { flat: true }),
    xDimensionMm: 0.33,
    dataModules: 67, // 3 + 4×7 + 5 + 4×7 + 3
    quietLeftX: 7,
    quietRightX: 7,
    barHeightMm: 18.23, // = X × 55.24（EAN-8 自有比值，非 69.24）
    guardExtendX: 5,
    charCount: 4,
    segments: buildSegments({ charCount: 4, numberSetOf: () => 'A', extendFirstLastChar: false }),
    // HRI：无符号外数字，4 + 4 全部在数据区下方
    hriLayout: (text) => ({
      outsideFirst: null,
      outsideLast: null,
      left: Array.from({ length: 4 }, (_, i) => ({ digit: text[i], charIndex: i })),
      right: Array.from({ length: 4 }, (_, i) => ({ digit: text[i + 4], charIndex: i }))
    }),
    hri: {
      gapX: 1,
      capHeightMm: 2.75
      // EAN-8 无符号外数字，故不定义 outsideMaxInkWidthX / outsideEdgeGapX，
      // 避免日后被误调用。
    }
  }
}

export const RETAIL_TYPES = Object.keys(RETAIL_SPECS)

export function isRetailType(typeName) {
  return Object.hasOwn(RETAIL_SPECS, typeName)
}

/** 取纯条空结构（95 位模块串），不含任何布局信息。 */
export function encodeRetailModules(typeName, value) {
  const spec = RETAIL_SPECS[typeName]
  if (!spec) throw new Error(`${typeName} 不是零售合规码制`)

  const instance = spec.encoder(value)
  if (!instance.valid()) throw new Error('编码内容不符合该码制要求')

  const { data, text } = instance.encode()
  if (data.length !== spec.dataModules) {
    throw new Error(`模块数异常：得到 ${data.length}，应为 ${spec.dataModules}`)
  }

  return { modules: data, text }
}

/** 计算该码制的几何（毫米）；UPC-A 可选择 GS1 或客户参考稿预设。 */
/** @param {string} typeName @param {{widthMm?: number, heightMm?: number, profile?: string} | null} [options] */
export function computeRetailGeometry(typeName, options = null) {
  let spec = RETAIL_SPECS[typeName]
  if (!spec) throw new Error(`${typeName} 不是零售合规码制`)

  let customerLayout = null
  let customerScale = 1
  let widthMm = 0
  let symbolStartMm = spec.quietLeftX * spec.xDimensionMm
  let barTopMm = 0
  let heightMm = 0
  if (typeName === 'UPC-A') {
    customerLayout = Object.hasOwn(CUSTOMER_LAYOUTS, options?.profile ?? '') ? CUSTOMER_LAYOUTS[options.profile] : null
    const standardWidth = (spec.quietLeftX + spec.dataModules + spec.quietRightX) * spec.xDimensionMm
    const standardHeight = spec.barHeightMm + spec.hri.gapX * spec.xDimensionMm + spec.hri.capHeightMm
    const defaultWidth = customerLayout?.width ?? standardWidth
    const defaultHeight = customerLayout?.height ?? standardHeight
    const width = Number(options?.widthMm ?? defaultWidth)
    const height = Number(options?.heightMm ?? defaultHeight * width / defaultWidth)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('尺寸必须为大于零的有效数字')
    widthMm = width
    if (customerLayout) {
      // 客户版式按参考稿白底左上角测量。独立调整时保留上下留白和数字比例。
      const scale = width / customerLayout.width
      customerScale = scale
      const x = customerLayout.x * scale
      const capHeightMm = customerLayout.cap * scale
      const barHeightMm = height - (customerLayout.height - customerLayout.bottom + customerLayout.top) * scale
      if (barHeightMm <= 0) throw new Error('总高度不足以容纳客户版式的条形与数字')
      symbolStartMm = customerLayout.left * scale
      barTopMm = customerLayout.top * scale
      const quietLeftX = symbolStartMm / x
      const quietRightX = (width - symbolStartMm - spec.dataModules * x) / x
      spec = {
        ...spec,
        quietLeftX,
        quietRightX,
        xDimensionMm: x,
        barHeightMm,
        hri: { ...spec.hri, capHeightMm }
      }
      heightMm = height
    } else {
      const scale = width / standardWidth
      const x = spec.xDimensionMm * scale
      const capHeightMm = spec.hri.capHeightMm * scale
      const barHeightMm = height - spec.hri.gapX * x - capHeightMm
      if (barHeightMm <= 0 || barHeightMm + spec.guardExtendX * x > height) throw new Error('总高度不足以容纳条形、护栏和数字')
      symbolStartMm = spec.quietLeftX * x
      spec = { ...spec, xDimensionMm: x, barHeightMm, hri: { ...spec.hri, capHeightMm } }
      heightMm = height
    }
  }

  const x = spec.xDimensionMm
  const totalModules = spec.quietLeftX + spec.dataModules + spec.quietRightX
  const barBottomMm = spec.barHeightMm
  const guardBottomMm = barBottomMm + spec.guardExtendX * x
  const hriTopMm = barBottomMm + spec.hri.gapX * x
  const hriBaselineMm = customerLayout
    ? heightMm - customerLayout.digitInset * customerScale
    : hriTopMm + spec.hri.capHeightMm

  return {
    spec,
    x,
    totalModules,
    widthMm: typeName === 'UPC-A' ? widthMm : totalModules * x,
    heightMm: typeName === 'UPC-A' ? heightMm : hriBaselineMm,
    symbolStartMm,
    barTopMm,
    barBottomMm,
    guardBottomMm,
    hriBaselineMm,
    profile: customerLayout ? options.profile : 'gs1'
  }
}

/**
 * 逐段生成条矩形。字符段按 Table 5-10 补偿条空宽度；
 * 补偿只改元素边缘，字符总宽恒为 7X，故段边界始终对齐整数模块。
 * 坐标保留小数，不做逐段取整（栅格化时再由整体等比缩放处理）。
 */
export function buildBars(spec, modules, text, x, symbolStartMm, barBottomMm, guardBottomMm) {
  const bars = []

  for (const segment of spec.segments(text)) {
    let cursor = symbolStartMm + segment.start * x
    const sign =
      segment.kind === 'char' ? TABLE_5_10_BAR_SIGN[segment.numberSet]?.[segment.digit] ?? 0 : 0
    const barDelta = (sign * x) / 13
    const spaceDelta = -barDelta
    const slice = modules.slice(segment.start, segment.start + segment.count)

    let index = 0
    while (index < slice.length) {
      const bit = slice[index]
      let run = 1
      while (index + run < slice.length && slice[index + run] === bit) run += 1

      const isBar = bit === '1'
      const width = run * x + (isBar ? barDelta : spaceDelta)
      if (isBar) {
        bars.push({
          x: cursor,
          width,
          height: segment.extended ? guardBottomMm : barBottomMm
        })
      }
      cursor += width
      index += run
    }
  }

  return bars
}

/**
 * 按标准几何填充 SVG 元素。
 * 文本以 <text> 写入（含 font-size，单位与 viewBox 一致即 mm），
 * 由调用方的 outlineBarcodeText() 统一转为路径。
 */
/** @param {SVGSVGElement} svgElement @param {string} typeName @param {string} value @param {{widthMm?: number, heightMm?: number, profile?: string, showBackground?: boolean} | null} [options] */
export function renderRetailBarcode(svgElement, typeName, value, options = null) {
  const { modules, text } = encodeRetailModules(typeName, value)
  const geometry = computeRetailGeometry(typeName, options)
  const { spec, x, widthMm, heightMm, symbolStartMm, barTopMm, barBottomMm, guardBottomMm, hriBaselineMm } =
    geometry
  const customerLayout = CUSTOMER_LAYOUTS[geometry.profile]

  const svgNs = 'http://www.w3.org/2000/svg'
  svgElement.replaceChildren()
  svgElement.setAttribute('xmlns', svgNs)
  svgElement.setAttribute('width', `${widthMm}mm`)
  svgElement.setAttribute('height', `${heightMm}mm`)
  svgElement.setAttribute('viewBox', `0 0 ${widthMm} ${heightMm}`)

  if (typeName !== 'UPC-A' || options?.showBackground !== false) {
    const background = document.createElementNS(svgNs, 'rect')
    background.setAttribute('x', '0')
    background.setAttribute('y', '0')
    background.setAttribute('width', String(widthMm))
    background.setAttribute('height', String(heightMm))
    background.setAttribute('fill', '#ffffff')
    svgElement.append(background)
  }

  // 条：逐段生成（含 Table 5-10 补偿）
  for (const bar of buildBars(spec, modules, text, x, symbolStartMm, barBottomMm, guardBottomMm)) {
    const rect = document.createElementNS(svgNs, 'rect')
    rect.setAttribute('x', String(bar.x))
    rect.setAttribute('y', String(barTopMm))
    rect.setAttribute('width', String(bar.width))
    rect.setAttribute('height', String(bar.height))
    rect.setAttribute('fill', '#000000')
    svgElement.append(rect)
  }

  // HRI
  const layout = spec.hriLayout(text)
  const addDigit = (content, xMm, edge) => {
    if (content == null) return
    const node = document.createElementNS(svgNs, 'text')
    node.setAttribute('x', String(xMm))
    node.setAttribute('y', String(customerLayout
      ? hriBaselineMm + (edge ? customerLayout.outerDrop * x / customerLayout.x : 0)
      : hriBaselineMm))
    node.setAttribute('text-anchor', 'middle')
    // 写入目标**字形高度**而非 em size（opentype 的 fontSize 是 em），
    // 由 outlineBarcodeText() 按字体 metrics 反算。
    node.setAttribute('data-cap-height', String(spec.hri.capHeightMm * (customerLayout && edge ? 0.78 : 1)))
    node.setAttribute('fill', '#000000')
    node.setAttribute('data-anchor-edge', edge || 'center')
    // 仅 UPC-A 定义了「符号外数字最大墨宽 4X、超出等比缩小」。
    // EAN-13 明确**不适用**该规则（同字号同基线），故不写 data-max-ink-width。
    if (edge && spec.hri.outsideMaxInkWidthX) {
      node.setAttribute('data-max-ink-width', String(spec.hri.outsideMaxInkWidthX * x))
    }
    node.textContent = content
    svgElement.append(node)
  }

  // 数据区起始模块：左区 3，右区 3 + charCount*7 + 5
  const leftStart = 3
  const rightStart = 3 + spec.charCount * 7 + 5
  const charCenterMm = (charIndex, dataStartModule) =>
    symbolStartMm + (dataStartModule + charIndex * 7 + 3.5) * x

  // 符号外首位。UPC-A 用规范值 outsideEdgeGapX；
  // EAN-13 水平位置未锁定，用 provisional 值（**非规范值**，见 spec 注释）。
  const outsideFirstOffsetX = customerLayout
    ? customerLayout.leftGap
    : (spec.hri.outsideEdgeGapX ?? spec.hri.outsideFirstProvisionalOffsetX ?? 0)
  addDigit(layout.outsideFirst, symbolStartMm - outsideFirstOffsetX * x, 'right')

  for (const item of layout.left) addDigit(item.digit, charCenterMm(item.charIndex, leftStart))
  for (const item of layout.right) addDigit(item.digit, charCenterMm(item.charIndex, rightStart))

  // 符号外末位：左边缘位于右护栏右侧 outsideEdgeGapX
  addDigit(
    layout.outsideLast,
    symbolStartMm + spec.dataModules * x + (customerLayout ? customerLayout.rightGap : (spec.hri.outsideEdgeGapX ?? 0)) * x,
    'left'
  )

  return geometry
}
