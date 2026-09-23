// 托盘 + 围套：双层侧墙锁底托盘（0421 类）+ 四面粘口套筒（0501 类），套筒沿托盘宽向套入。
// 无参考刀模；托盘复用 tray.js，套筒内尺寸 = 托盘外尺寸 + 2×间隙。
import { buildTrayPanels } from './tray.js'
import { validateParams, fitTo } from './common.js'

function buildSleevePanels({ faceL, faceH, depth, t, glueFlap }) {
  const widths = [faceL, faceH, faceL, faceH]
  const ids = ['sleeveBottom', 'sleeveSide1', 'sleeveTop', 'sleeveSide2']
  const names = ['套筒底面', '套筒侧面 1', '套筒顶面', '套筒侧面 2']
  const starts = [0]
  widths.forEach((width, index) => starts.push(starts[index] + width))
  const panels = []
  widths.forEach((width, index) => {
    const x0 = starts[index]
    const x1 = starts[index + 1]
    const last = index === widths.length - 1
    panels.push({
      id: ids[index], name: names[index], holes: [],
      parent: index === 0 ? null : ids[index - 1],
      hinge: index === 0 ? null : { a: [x0, 0], b: [x0, depth] },
      order: 1, angle: index === 0 ? 0 : 90,
      contour: [
        { x: x0, y: 0, edge: 'cut' },
        { x: x1, y: 0, edge: last ? 'cut' : 'none' },
        { x: x1, y: depth, edge: 'cut' },
        { x: x0, y: depth, edge: index === 0 ? 'none' : 'crease' }
      ]
    })
  })
  const taper = Math.min(4 * t + 4, depth * 0.1)
  panels.push({
    id: 'sleeveGlue', name: '套筒粘口', holes: [], parent: ids[0], order: 1, angle: 90,
    hinge: { a: [0, 0], b: [0, depth] },
    contour: [
      { x: 0, y: 0, edge: 'cut' },
      { x: -glueFlap, y: taper, edge: 'cut' },
      { x: -glueFlap, y: depth - taper, edge: 'cut' },
      { x: 0, y: depth, edge: 'crease' }
    ]
  })
  return { panels, total: starts[4] }
}

export const traySleeveTemplate = Object.freeze({
  id: 'tray-sleeve',
  version: '0.1.0-draft',
  name: '托盘 + 围套',
  category: '托盘纸盒',
  description: '锁底托盘配套筒，较大板件与拆装家具部件',
  defaults: { length: 600, width: 400, height: 60, thickness: 3, bleed: 3, material: 'corrugated-b' },
  ranges: {
    length: [40, 2000],
    width: [40, 2000],
    height: [15, 600],
    thickness: [0.5, 8],
    bleed: [0, 10]
  },
  materials: [
    { id: 'corrugated-e', label: '瓦楞纸 E（三层）', thickness: [1.1, 2] },
    { id: 'corrugated-b', label: '瓦楞纸 B（三层）', thickness: [2.5, 3.2] },
    { id: 'corrugated-c', label: '瓦楞纸 C（三层）', thickness: [3.5, 4.2] },
    { id: 'cardboard', label: '白卡纸', thickness: [0.5, 1] }
  ],
  sizeConversion: { status: 'estimated' },
  structureParams: [
    { key: 'gap', label: '配合间隙', min: 0, max: 5, step: 0.1, auto: (p) => Math.min(2, Math.max(0.5, p.thickness / 2)) },
    { key: 'sleeveDepth', label: '围套宽', min: 20, max: 2000, step: 0.5, auto: (p) => p.width + 4 * p.thickness },
    { key: 'glueFlap', label: '围套粘口', min: 15, max: 120, step: 0.5, auto: (p) => fitTo(Math.min(50, Math.max(20, 0.08 * p.length)), 0.4 * p.length) },
    { key: 'endFlapW', label: '端翼宽', min: 10, max: 600, step: 0.5, auto: (p) => Math.min(0.4 * p.width, 0.45 * p.length) },
    { key: 'tabLength', label: '锁舌长', min: 5, max: 300, step: 0.5, auto: (p) => 0.2 * p.width }
  ],

  normalizeParams(raw) {
    const number = (value, fallback) => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : fallback)
    return {
      length: number(raw.length, NaN),
      width: number(raw.width, NaN),
      height: number(raw.height, NaN),
      thickness: number(raw.thickness, this.defaults.thickness),
      bleed: number(raw.bleed, this.defaults.bleed),
      material: this.materials.some((entry) => entry.id === raw.material) ? raw.material : this.defaults.material,
      ...Object.fromEntries(this.structureParams.map((entry) => [entry.key, number(raw[entry.key], null)]))
    }
  },

  resolveStructure(params) {
    return Object.fromEntries(this.structureParams.map((entry) => {
      const manual = params[entry.key]
      return [entry.key, Number.isFinite(manual) ? manual : entry.auto(params)]
    }))
  },

  sleeveSize(params) {
    const { gap } = this.resolveStructure(params)
    const t = params.thickness
    // 托盘外尺寸：长向双壁 +4t，高向底板 + 前后墙 ≈ H + 2t
    return { faceL: params.length + 4 * t + 2 * gap, faceH: params.height + 2 * t + 2 * gap }
  },

  validate(params) {
    return validateParams(this, params, (checked, structure) => {
      const errors = []
      const t = params.thickness
      if (params.height * 2 + t * 6 > params.length) errors.push('高度过大：长度需大于 2 倍高度加壁厚')
      if (structure.tabLength * 2 + 4 * t >= params.width) errors.push('锁舌长过大，两个锁舌会重叠')
      if (structure.endFlapW * 2 > params.length) errors.push('端翼宽超过长度的一半')
      if (structure.glueFlap >= params.length) errors.push('围套粘口需小于长度')
      return errors
    })
  },

  sizes(params) {
    const { length, width, height, thickness: t } = params
    const { sleeveDepth } = this.resolveStructure(params)
    const sleeve = this.sleeveSize(params)
    return {
      manufacturing: { length, width, height },
      inner: { length: length - 4 * t, width: width - 4 * t, height: height - t },
      outer: { length: sleeve.faceL + 2 * t, width: Math.max(sleeveDepth, width + 4 * t), height: sleeve.faceH + 2 * t },
      calibrated: false,
      note: '内尺寸按托盘双壁扣除、外尺寸按围套外壁估算，待打样校准'
    }
  },

  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const { gap, sleeveDepth, glueFlap, endFlapW, tabLength } = this.resolveStructure(params)
    const sleeve = this.sleeveSize(params)
    const tray = buildTrayPanels({ L, W, H, t, endFlapW, tabLength })
    const tube = buildSleevePanels({ faceL: sleeve.faceL, faceH: sleeve.faceH, depth: sleeveDepth, t, glueFlap })
    const fmt = (value) => Number(value.toFixed(1)).toString()
    const m = tray.metrics

    const annotations = [
      { part: 'tray', param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: W + m.wallH + 14, x2: L, y2: W + m.wallH + 14 },
      { part: 'tray', param: 'width', label: `W ${fmt(W)} mm`, x1: m.outerRight + 14, y1: 0, x2: m.outerRight + 14, y2: W },
      { part: 'tray', param: 'height', label: `H ${fmt(H)} mm`, x1: L / 2, y1: -m.wallH, x2: L / 2, y2: 0, inline: true },
      { part: 'tray', param: 'endFlapW', label: `端翼 ${fmt(endFlapW)}`, x1: -endFlapW, y1: -m.wallH - 8, x2: 0, y2: -m.wallH - 8, secondary: true },
      { part: 'tray', param: 'tabLength', label: `锁舌 ${fmt(tabLength)}`, x1: m.outerLeft - 8, y1: m.tabs[0] - tabLength / 2, x2: m.outerLeft - 8, y2: m.tabs[0] + tabLength / 2, secondary: true },
      { part: 'sleeve', param: 'gap', label: `围套面 ${fmt(sleeve.faceL)} mm`, pdfLabel: `SLEEVE FACE ${fmt(sleeve.faceL)} mm`, x1: 0, y1: sleeveDepth + 14, x2: sleeve.faceL, y2: sleeveDepth + 14 },
      { part: 'sleeve', param: 'gap', label: `围套高 ${fmt(sleeve.faceH)} mm`, pdfLabel: `SLEEVE H ${fmt(sleeve.faceH)} mm`, x1: sleeve.faceL, y1: sleeveDepth + 14, x2: sleeve.faceL + sleeve.faceH, y2: sleeveDepth + 14 },
      { part: 'sleeve', param: 'sleeveDepth', label: `围套宽 ${fmt(sleeveDepth)} mm`, pdfLabel: `SLEEVE W ${fmt(sleeveDepth)} mm`, x1: tube.total + 14, y1: 0, x2: tube.total + 14, y2: sleeveDepth },
      { part: 'sleeve', param: 'glueFlap', label: `粘口 ${fmt(glueFlap)}`, x1: -glueFlap, y1: -8, x2: 0, y2: -8, secondary: true }
    ]
    return {
      parts: [
        { id: 'tray', name: '托盘', count: 1, panels: tray.panels, anchor: [L / 2, W / 2] },
        {
          id: 'sleeve', name: '围套', count: 1, panels: tube.panels, anchor: [sleeve.faceL / 2, sleeveDepth / 2],
          // 套筒底面中心对准托盘底板中心，沿宽向从托盘前方滑入
          assemble: { over: 'tray', mode: 'slide', lift: -(t + gap), slideFrom: [0, W + sleeveDepth] }
        }
      ],
      annotations
    }
  }
})
