// 0201 对口运输箱（RSC）。
// 结构与尺寸换算来自 scope/plans/active/m0-dieline-0201.md 的样本（434×214×278，t=2）；
// 内/外尺寸公式按该单样本线性推导（内→制造 +2t/+2t/+4t，制造→外 +t/+t/+2t），标记待校准。

function rectPanel(x1, y1, x2, y2, edges) {
  return [
    { x: x1, y: y1, edge: edges.top || 'cut' },
    { x: x2, y: y1, edge: edges.right || 'cut' },
    { x: x2, y: y2, edge: edges.bottom || 'cut' },
    { x: x1, y: y2, edge: edges.left || 'cut' }
  ]
}

export const rsc0201Template = Object.freeze({
  id: 'rsc-0201',
  version: '0.2.0-draft',
  name: '0201 对口箱',
  category: '运输纸箱',
  description: '四面墙 + 上下对口摇盖 + 粘口，小型家具与整件运输外箱',
  defaults: { length: 434, width: 214, height: 278, thickness: 2, bleed: 3, material: 'corrugated-b' },
  ranges: {
    length: [50, 2000],
    width: [50, 2000],
    height: [30, 1500],
    thickness: [1, 12],
    bleed: [0, 10]
  },
  materials: [
    { id: 'corrugated-e', label: '瓦楞纸 E（三层）', thickness: [1.1, 2] },
    { id: 'corrugated-b', label: '瓦楞纸 B（三层）', thickness: [2.5, 3.2] },
    { id: 'corrugated-c', label: '瓦楞纸 C（三层）', thickness: [3.5, 4.2] },
    { id: 'corrugated-bc', label: '瓦楞纸 BC（五层）', thickness: [6, 7.5] }
  ],
  sizeConversion: { status: 'single-sample', sampleThickness: 2 },
  structureParams: [
    { key: 'glueFlap', label: '粘口宽', min: 15, max: 120, step: 0.5, auto: (p) => Math.min(60, Math.max(25, 0.1 * p.length)) },
    { key: 'flapDepth', label: '摇盖深', min: 10, max: 1000, step: 0.5, auto: (p) => p.width / 2 },
    { key: 'slotWidth', label: '开槽宽', min: 2, max: 30, step: 0.5, auto: (p) => 3 * p.thickness }
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
    if (structure.glueFlap >= params.length) errors.push('粘口宽需小于长度')
    if (structure.slotWidth >= Math.min(params.length, params.width) / 2) errors.push('开槽宽过大')
    if (structure.flapDepth > params.width) errors.push('摇盖深超过宽度，合拢时会互相压叠')
    return errors
  },

  sizes(params) {
    const { length, width, height, thickness: t } = params
    return {
      manufacturing: { length, width, height },
      inner: { length: length - 2 * t, width: width - 2 * t, height: height - 4 * t },
      outer: { length: length + t, width: width + t, height: height + 2 * t },
      calibrated: false,
      note: '内/外尺寸公式由 t=2 mm 单样本线性推导，待校准'
    }
  },

  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const { glueFlap, flapDepth: D, slotWidth: s } = this.resolveStructure(params)
    const taper = Math.min(4 * t + 4, H * 0.1)
    const half = s / 2
    const panels = []
    const push = (panel) => panels.push({ holes: [], angle: 90, ...panel })

    // 面板链：粘口 | P1(L) | P2(W) | P3(L) | P4(W)，P1 为根
    const widths = [L, W, L, W]
    const starts = [0]
    widths.forEach((panelWidth, index) => starts.push(starts[index] + panelWidth))
    const ids = ['panel1', 'panel2', 'panel3', 'panel4']
    const names = ['长面 1', '宽面 1', '长面 2', '宽面 2']

    widths.forEach((panelWidth, index) => {
      const x0 = starts[index]
      const x1 = starts[index + 1]
      const hasLeftSlot = index > 0
      const hasRightSlot = index < 3
      const sl = hasLeftSlot ? half : 0
      const sr = hasRightSlot ? half : 0
      const contour = [
        { x: x0, y: 0, edge: hasLeftSlot ? 'cut' : 'none' },
        { x: x0 + sl, y: 0, edge: 'none' },
        { x: x1 - sr, y: 0, edge: hasRightSlot ? 'cut' : 'none' },
        { x: x1, y: 0, edge: hasRightSlot ? 'none' : 'cut' },
        { x: x1, y: H, edge: hasRightSlot ? 'cut' : 'none' },
        { x: x1 - sr, y: H, edge: 'none' },
        { x: x0 + sl, y: H, edge: hasLeftSlot ? 'cut' : 'none' },
        { x: x0, y: H, edge: index === 0 ? 'none' : 'crease' }
      ].filter((vertex, position, list) => position === 0 || vertex.x !== list[position - 1].x || vertex.y !== list[position - 1].y)
      push({
        id: ids[index], name: names[index],
        parent: index === 0 ? null : ids[index - 1],
        hinge: index === 0 ? null : { a: [x0, 0], b: [x0, H] },
        order: 1, angle: index === 0 ? 0 : 90,
        contour
      })
      const flapOrder = index % 2 === 1 ? 2 : 3 // 宽面摇盖先合，长面摇盖后合
      push({
        id: `${ids[index]}Top`, name: `${names[index]}上摇盖`, parent: ids[index], order: flapOrder,
        hinge: { a: [x0 + sl, 0], b: [x1 - sr, 0] },
        contour: rectPanel(x0 + sl, -D, x1 - sr, 0, { bottom: 'crease' })
      })
      push({
        id: `${ids[index]}Bottom`, name: `${names[index]}下摇盖`, parent: ids[index], order: flapOrder,
        hinge: { a: [x0 + sl, H], b: [x1 - sr, H] },
        contour: rectPanel(x0 + sl, H, x1 - sr, H + D, { top: 'crease' })
      })
    })

    push({
      id: 'glueFlap', name: '粘口', parent: 'panel1', order: 1,
      hinge: { a: [0, 0], b: [0, H] },
      contour: [
        { x: 0, y: 0, edge: 'cut' },
        { x: -glueFlap, y: taper, edge: 'cut' },
        { x: -glueFlap, y: H - taper, edge: 'cut' },
        { x: 0, y: H, edge: 'crease' }
      ]
    })

    const fmt = (value) => Number(value.toFixed(1)).toString()
    const total = starts[4]
    const annotations = [
      { param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: H + D + 14, x2: L, y2: H + D + 14 },
      { param: 'width', label: `W ${fmt(W)} mm`, x1: L, y1: H + D + 14, x2: L + W, y2: H + D + 14 },
      { param: 'height', label: `H ${fmt(H)} mm`, x1: total + 14, y1: 0, x2: total + 14, y2: H },
      { param: 'glueFlap', label: `粘口 ${fmt(glueFlap)}`, x1: -glueFlap, y1: -D - 8, x2: 0, y2: -D - 8, secondary: true },
      { param: 'flapDepth', label: `摇盖 ${fmt(D)}`, x1: total + 14, y1: -D, x2: total + 14, y2: 0, secondary: true },
      { param: 'slotWidth', label: `槽 ${fmt(s)}`, x1: L - half, y1: -D - 8, x2: L + half, y2: -D - 8, secondary: true }
    ]
    return { parts: [{ id: 'body', name: '箱体', count: 1, panels }], annotations }
  }
})
