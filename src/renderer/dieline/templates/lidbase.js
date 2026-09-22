// 天地盖（盖 + 底两个独立托盘，双层侧墙锁底结构）。
// 无参考刀模；结构复用飞机盒盒体托盘，盖底配合规则参考行业公开资料：
// 配合间隙 0.2–1.0 mm（精装）/ 瓦楞取 t/2，盖深默认「盖到底」。
import { buildTrayPanels } from './tray.js'

export const lidBaseTemplate = Object.freeze({
  id: 'lid-base',
  version: '0.1.0-draft',
  name: '天地盖',
  category: '托盘纸盒',
  description: '盖、底两件独立成型，扁平部件、板件与套装包装',
  defaults: { length: 500, width: 350, height: 80, thickness: 3, bleed: 3, material: 'corrugated-b' },
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
    { key: 'lidHeight', label: '盖高', min: 10, max: 600, step: 0.5, auto: (p) => p.height },
    { key: 'gap', label: '配合间隙', min: 0, max: 5, step: 0.1, auto: (p) => Math.min(2, Math.max(0.5, p.thickness / 2)) },
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

  lidSize(params) {
    const { gap } = this.resolveStructure(params)
    const t = params.thickness
    // 底盒四周都是双壁（侧墙双层、端墙 + 端翼），外尺寸 ≈ 制造尺寸 + 4t
    return { length: params.length + 4 * t + 2 * gap, width: params.width + 4 * t + 2 * gap }
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
    const t = params.thickness
    for (const [name, H] of [['底盒', params.height], ['盖', structure.lidHeight]]) {
      if (H * 2 + t * 6 > params.length) errors.push(`${name}高度过大：长度需大于 2 倍高度加壁厚`)
    }
    if (structure.tabLength * 2 + 4 * t >= params.width) errors.push('锁舌长过大，两个锁舌会重叠')
    if (structure.endFlapW * 2 > params.length) errors.push('端翼宽超过长度的一半')
    return errors
  },

  sizes(params) {
    const { length, width, height, thickness: t } = params
    const { lidHeight, gap } = this.resolveStructure(params)
    const lid = this.lidSize(params)
    return {
      manufacturing: { length, width, height },
      inner: { length: length - 4 * t, width: width - 4 * t, height: height - t },
      outer: { length: lid.length + 4 * t, width: lid.width + 4 * t, height: height + 2 * t + gap + Math.max(0, lidHeight - height) },
      calibrated: false,
      note: '内尺寸按双壁扣除 4t、外尺寸按盖外壁估算，待打样校准'
    }
  },

  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const { lidHeight, gap, endFlapW, tabLength } = this.resolveStructure(params)
    const lid = this.lidSize(params)
    const base = buildTrayPanels({ L, W, H, t, endFlapW, tabLength })
    const lidTray = buildTrayPanels({ L: lid.length, W: lid.width, H: lidHeight, t, endFlapW: endFlapW + 2 * t + gap, tabLength })
    const fmt = (value) => Number(value.toFixed(1)).toString()
    const baseM = base.metrics
    const lidM = lidTray.metrics

    const annotations = [
      { part: 'base', param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: W + baseM.wallH + 14, x2: L, y2: W + baseM.wallH + 14 },
      { part: 'base', param: 'width', label: `W ${fmt(W)} mm`, x1: baseM.outerRight + 14, y1: 0, x2: baseM.outerRight + 14, y2: W },
      { part: 'base', param: 'height', label: `H ${fmt(H)} mm`, x1: L / 2, y1: -baseM.wallH, x2: L / 2, y2: 0, inline: true },
      { part: 'base', param: 'endFlapW', label: `端翼 ${fmt(endFlapW)}`, x1: -endFlapW, y1: -baseM.wallH - 8, x2: 0, y2: -baseM.wallH - 8, secondary: true },
      { part: 'base', param: 'tabLength', label: `锁舌 ${fmt(tabLength)}`, x1: baseM.outerLeft - 8, y1: baseM.tabs[0] - tabLength / 2, x2: baseM.outerLeft - 8, y2: baseM.tabs[0] + tabLength / 2, secondary: true },
      { part: 'lid', param: 'gap', label: `盖 L ${fmt(lid.length)} mm`, pdfLabel: `LID L ${fmt(lid.length)} mm`, x1: 0, y1: lid.width + lidM.wallH + 14, x2: lid.length, y2: lid.width + lidM.wallH + 14 },
      { part: 'lid', param: 'gap', label: `盖 W ${fmt(lid.width)} mm`, pdfLabel: `LID W ${fmt(lid.width)} mm`, x1: lidM.outerRight + 14, y1: 0, x2: lidM.outerRight + 14, y2: lid.width },
      { part: 'lid', param: 'lidHeight', label: `盖高 ${fmt(lidHeight)} mm`, pdfLabel: `LID H ${fmt(lidHeight)} mm`, x1: lid.length / 2, y1: -lidM.wallH, x2: lid.length / 2, y2: 0, inline: true }
    ]
    return {
      parts: [
        { id: 'base', name: '底盒', count: 1, panels: base.panels, anchor: [L / 2, W / 2] },
        {
          id: 'lid', name: '盖', count: 1, panels: lidTray.panels, anchor: [lid.length / 2, lid.width / 2],
          assemble: { over: 'base', flip: true, lift: H + 2 * t + gap }
        }
      ],
      annotations
    }
  }
})
