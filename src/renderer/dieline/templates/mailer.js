// 翻盖飞机盒（对标 pacdora 150010 类结构）。
// 结构比例来自 scope/plans/active/m0-dieline-mailer.md 的样本（400×202×62，t=1.5）像素反推，误差 ±2 mm；
// 三种尺寸换算只有单个厚度样本，标记为「待校准」。
import { buildTrayPanels, mirrorPanel, rect } from './tray.js'

const SAMPLE_THICKNESS = 1.5
const SAMPLE_OFFSETS = Object.freeze({
  inner: Object.freeze({ length: -15, width: -2, height: -2 }),
  outer: Object.freeze({ length: 1, width: 2.5, height: 1 })
})

export const mailerTemplate = Object.freeze({
  id: 'mailer-tuck',
  version: '0.2.0-draft',
  name: '翻盖飞机盒',
  category: '折叠纸盒',
  description: '盖插舌 + 双层侧墙锁底，家具五金、配件与小型家居产品',
  defaults: { length: 400, width: 202, height: 62, thickness: 1.5, bleed: 3, material: 'corrugated-e' },
  ranges: {
    length: [30, 1500],
    width: [30, 1200],
    height: [15, 400],
    thickness: [0.2, 5],
    bleed: [0, 10]
  },
  materials: [
    { id: 'corrugated-e', label: '瓦楞纸 E（三层）', thickness: [1.1, 2] },
    { id: 'corrugated-b', label: '瓦楞纸 B（三层）', thickness: [2.5, 3.2] },
    { id: 'cardboard', label: '白卡纸', thickness: [0.2, 1] }
  ],
  sizeConversion: { status: 'single-sample', sampleThickness: SAMPLE_THICKNESS },
  // 模板专属结构参数：留空 = 按长宽高自动推算
  structureParams: [
    { key: 'tuckExt', label: '插舌耳宽', min: 5, max: 200, step: 0.5, auto: (p) => Math.min(0.8 * p.height, 0.2 * p.length) },
    { key: 'endFlapW', label: '端翼宽', min: 10, max: 600, step: 0.5, auto: (p) => 0.4 * p.width },
    { key: 'tabLength', label: '锁舌长', min: 5, max: 300, step: 0.5, auto: (p) => 0.2 * p.width },
    { key: 'earNotch', label: '盖耳让位', min: 0, max: 300, step: 0.5, auto: (p) => 0.15 * p.width }
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

  /** 结构参数实际取值（手动值优先，否则自动推算）。 */
  resolveStructure(params) {
    return Object.fromEntries(this.structureParams.map((entry) => {
      const manual = params[entry.key]
      return [entry.key, Number.isFinite(manual) ? manual : entry.auto(params)]
    }))
  },

  validate(params) {
    const errors = []
    const labels = { length: '长', width: '宽', height: '高', thickness: '厚度', bleed: '出血' }
    for (const [key, [min, max]] of Object.entries(this.ranges)) {
      const value = params[key]
      if (!Number.isFinite(value) || value < min || value > max) errors.push(`${labels[key]}需在 ${min}–${max} mm`)
    }
    if (errors.length) return errors
    for (const entry of this.structureParams) {
      const value = params[entry.key]
      if (value !== null && (!Number.isFinite(value) || value < entry.min || value > entry.max)) errors.push(`${entry.label}需在 ${entry.min}–${entry.max} mm`)
    }
    if (errors.length) return errors
    const structure = this.resolveStructure(params)
    if (params.height * 2 + params.thickness * 6 > params.length) errors.push('长度需大于 2 倍高度加壁厚，否则侧墙无法折叠')
    if (structure.tabLength * 2 + 4 * params.thickness >= params.width) errors.push('锁舌长过大，两个锁舌会重叠')
    if (structure.endFlapW * 2 > params.length) errors.push('端翼宽超过长度的一半')
    if (structure.earNotch >= params.width) errors.push('盖耳让位不能超过宽度')
    return errors
  },

  sizes(params) {
    const { length, width, height } = params
    const apply = (offsets) => ({ length: length + offsets.length, width: width + offsets.width, height: height + offsets.height })
    return {
      manufacturing: { length, width, height },
      inner: apply(SAMPLE_OFFSETS.inner),
      outer: apply(SAMPLE_OFFSETS.outer),
      calibrated: false,
      note: `内/外尺寸按 t=${SAMPLE_THICKNESS} mm 样本偏移估算，待校准`
    }
  },

  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const { tuckExt, endFlapW, tabLength, earNotch } = this.resolveStructure(params)
    const tray = buildTrayPanels({ L, W, H, t, endFlapW, tabLength, backWallTop: 'none' })
    const { wallH, sideW, strip, innerW, tabDepth, innerX, tabs } = tray.metrics
    const lidD = W + 2 * t
    const tuckH = H
    const tuckR = Math.min(0.45 * tuckH, 0.8 * tuckExt)
    const earW = Math.max(H - 2 * t, 4 * t)
    const lidTop = -(wallH + lidD)

    const panels = tray.panels
    const push = (panel) => panels.push({ holes: [], angle: 90, ...panel })

    // 盖板（挂在后墙上）
    push({
      id: 'lid', name: '盖板', parent: 'backWall', order: 6,
      hinge: { a: [0, -wallH], b: [L, -wallH] },
      contour: [
        { x: 0, y: lidTop, edge: 'none' }, { x: L, y: lidTop, edge: 'cut' }, { x: L, y: lidTop + earNotch, edge: 'none' },
        { x: L, y: -wallH, edge: 'crease' }, { x: 0, y: -wallH, edge: 'none' }, { x: 0, y: lidTop + earNotch, edge: 'cut' }
      ]
    })
    // 盖板耳：上沿斜切、下角圆角、下沿斜回折线
    const earLeft = {
      id: 'lidEarLeft', name: '盖板左耳', parent: 'lid', order: 5,
      hinge: { a: [0, lidTop + earNotch], b: [0, -wallH] },
      contour: [
        { x: 0, y: lidTop + earNotch, edge: 'cut' },
        { x: -earW, y: lidTop, r: 0.1 * earW, edge: 'cut' },
        { x: -earW, y: -wallH - 0.2 * earW, r: 0.15 * earW, edge: 'cut' },
        { x: 0, y: -wallH, edge: 'crease' }
      ]
    }
    push(earLeft)
    push(mirrorPanel(earLeft, L / 2))

    // 盖插舌 + 两侧插舌耳
    push({
      id: 'tuck', name: '盖插舌', parent: 'lid', order: 8,
      hinge: { a: [0, lidTop], b: [L, lidTop] },
      contour: rect(0, lidTop - tuckH, L, lidTop, { edges: { top: 'cut', right: 'none', bottom: 'crease', left: 'none' } })
    })
    const tuckEarLeft = {
      id: 'tuckEarLeft', name: '插舌左耳', parent: 'tuck', order: 7,
      hinge: { a: [0, lidTop - tuckH], b: [0, lidTop] },
      contour: [
        { x: 0, y: lidTop - tuckH, edge: 'cut' },
        { x: -tuckExt, y: lidTop - tuckH, r: tuckR, edge: 'cut' },
        { x: -tuckExt, y: lidTop, r: tuckR, edge: 'cut' },
        { x: 0, y: lidTop, edge: 'crease' }
      ]
    }
    push(tuckEarLeft)
    push(mirrorPanel(tuckEarLeft, L / 2))

    const fmt = (value) => Number(value.toFixed(1)).toString()
    const outerX = Math.max(L + endFlapW, L + sideW + strip + innerW + tabDepth) + 14
    const annotations = [
      { param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: W + wallH + 14, x2: L, y2: W + wallH + 14 },
      { param: 'width', label: `W ${fmt(W)} mm`, x1: outerX, y1: 0, x2: outerX, y2: W },
      { param: 'height', label: `H ${fmt(H)} mm`, x1: L * 0.5, y1: -wallH, x2: L * 0.5, y2: 0, inline: true },
      { param: 'tuckExt', label: `插舌耳 ${fmt(tuckExt)}`, x1: -tuckExt, y1: lidTop - tuckH - 8, x2: 0, y2: lidTop - tuckH - 8, secondary: true },
      { param: 'endFlapW', label: `端翼 ${fmt(endFlapW)}`, x1: -endFlapW, y1: -wallH - 8, x2: 0, y2: -wallH - 8, secondary: true },
      { param: 'tabLength', label: `锁舌 ${fmt(tabLength)}`, x1: innerX - innerW - tabDepth - 8, y1: tabs[0] - tabLength / 2, x2: innerX - innerW - tabDepth - 8, y2: tabs[0] + tabLength / 2, secondary: true },
      { param: 'earNotch', label: `让位 ${fmt(earNotch)}`, x1: -earW - 8, y1: lidTop, x2: -earW - 8, y2: lidTop + earNotch, secondary: true },
      { param: 'thickness', label: `侧墙 ${fmt(sideW)} + ${fmt(strip)} + ${fmt(innerW)}`, x1: innerX - innerW, y1: W / 2, x2: 0, y2: W / 2, secondary: true }
    ]
    return { parts: [{ id: 'body', name: '盒体', count: 1, panels }], annotations }
  }
})
