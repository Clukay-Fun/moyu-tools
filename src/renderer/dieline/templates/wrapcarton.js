// 舌插式纸盒（全盖对口）：四面板粘口成筒，两端各四片摇盖，摇盖深 = 宽度，合拢后上下各自全覆盖。
// 结构与默认值来自 scope/plans/active/dieline-refs/tuck-wrap-215x65x780.png
// （215 | 65 | 220 | 65，高 780，端盖深 65，开槽 ≈4，粘口 ≈36，外圈长面比内圈多 5 mm 包差）。
import { makeTemplate, CARTON_MATERIALS, fmt } from './common.js'
import { buildSlottedPanels } from './slotted.js'

export const wrapCartonTemplate = makeTemplate({
  id: 'tuck-wrap-carton',
  version: '0.1.0-draft',
  name: '舌插式纸盒',
  category: '折叠纸盒',
  description: '四面板粘口成筒，上下各四片全深摇盖，细长件与立式包装',
  defaults: { length: 215, width: 65, height: 780, thickness: 2, bleed: 3, material: 'corrugated-e' },
  ranges: {
    length: [40, 1500],
    width: [20, 1000],
    height: [40, 2000],
    thickness: [0.3, 6],
    bleed: [0, 10]
  },
  materials: CARTON_MATERIALS,
  structureParams: [
    { key: 'glueFlap', label: '粘口宽', min: 10, max: 100, step: 0.5, auto: (p) => Math.min(45, Math.max(18, 0.17 * p.length)) },
    { key: 'flapDepth', label: '端盖深', min: 10, max: 1000, step: 0.5, auto: (p) => p.width },
    { key: 'slotWidth', label: '开槽宽', min: 1, max: 30, step: 0.5, auto: (p) => 2 * p.thickness },
    { key: 'wrapAllowance', label: '包差', min: 0, max: 40, step: 0.5, auto: (p) => 2.5 * p.thickness }
  ],
  extraValidate(params, structure) {
    const errors = []
    if (structure.glueFlap >= params.length) errors.push('粘口宽需小于长度')
    if (structure.slotWidth >= Math.min(params.length, params.width) / 2) errors.push('开槽宽过大')
    if (structure.flapDepth > params.width * 1.2) errors.push('端盖深超过宽度的 1.2 倍，合拢时会互相压叠')
    if (structure.wrapAllowance > params.length / 4) errors.push('包差不能超过长度的四分之一')
    return errors
  },
  sizes(params) {
    const { length, width, height, thickness: t } = params
    return {
      manufacturing: { length, width, height },
      inner: { length: length - 2 * t, width: width - 2 * t, height: height - 2 * t },
      outer: { length: length + t, width: width + t, height: height + 2 * t },
      calibrated: false,
      note: '内/外尺寸按单壁纸板估算，待打样校准'
    }
  },
  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const { glueFlap, flapDepth: D, slotWidth: s, wrapAllowance } = this.resolveStructure(params)
    const { panels, total } = buildSlottedPanels({ L, W, H, t, glueFlap, flapDepth: D, slotWidth: s, wrapAllowance })
    const half = s / 2
    const annotations = [
      { param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: H + D + 14, x2: L, y2: H + D + 14 },
      { param: 'width', label: `W ${fmt(W)} mm`, x1: L, y1: H + D + 14, x2: L + W, y2: H + D + 14 },
      { param: 'height', label: `H ${fmt(H)} mm`, x1: total + 14, y1: 0, x2: total + 14, y2: H },
      { param: 'glueFlap', label: `粘口 ${fmt(glueFlap)}`, x1: -glueFlap, y1: -D - 8, x2: 0, y2: -D - 8, secondary: true },
      { param: 'flapDepth', label: `端盖 ${fmt(D)}`, x1: total + 14, y1: -D, x2: total + 14, y2: 0, secondary: true },
      { param: 'slotWidth', label: `槽 ${fmt(s)}`, x1: L - half, y1: -D - 8, x2: L + half, y2: -D - 8, secondary: true },
      { param: 'wrapAllowance', label: `包差 ${fmt(wrapAllowance)}`, x1: L + W, y1: H + D + 14, x2: L + W + L + wrapAllowance, y2: H + D + 14, secondary: true }
    ]
    return { parts: [{ id: 'body', name: '盒体', count: 1, panels }], annotations }
  }
})
