// 管状折叠纸盒系列：直插盒（STE）、反插盒（RTE）、化妆品挂孔盒、0217 提手锁底箱。
// 参考 scope/plans/active/dieline-refs/preset-gallery.png 的盒型缩略图，比例为常规折叠纸盒经验值，未经参考刀模校准。
import { makeTemplate, CARTON_MATERIALS, CORRUGATED_MATERIALS, fmt } from './common.js'
import { buildTube, makeAttachments } from './tube.js'

const TUBE_RANGES = { length: [20, 1200], width: [15, 800], height: [20, 1500], thickness: [0.3, 5], bleed: [0, 10] }

const glueParam = { key: 'glueFlap', label: '粘口宽', min: 8, max: 80, step: 0.5, auto: (p) => Math.min(30, Math.max(10, 0.12 * p.width + 6)) }
const tuckParam = { key: 'tuckLength', label: '插舌长', min: 6, max: 120, step: 0.5, auto: (p) => Math.min(45, Math.max(12, 0.5 * p.width)) }
const dustParam = { key: 'dustDepth', label: '防尘翼深', min: 5, max: 800, step: 0.5, auto: (p) => Math.max(5, p.width - 2 * p.thickness - 1) }

function tubeExtraValidate(params, structure) {
  const errors = []
  if (structure.glueFlap >= params.width) errors.push('粘口宽需小于宽度')
  if (structure.dustDepth !== undefined && structure.dustDepth > params.width) errors.push('防尘翼深不能超过宽度')
  if (structure.tuckLength !== undefined && structure.tuckLength > params.height) errors.push('插舌长不能超过高度')
  return errors
}

function tubeAnnotations(L, W, H, structure, total, extras = []) {
  const bottomY = H + (structure.bottomExtent || 0) + 14
  return [
    { param: 'width', label: `W ${fmt(W)} mm`, x1: 0, y1: bottomY, x2: W, y2: bottomY },
    { param: 'length', label: `L ${fmt(L)} mm`, x1: W, y1: bottomY, x2: W + L, y2: bottomY },
    { param: 'height', label: `H ${fmt(H)} mm`, x1: total + 14, y1: 0, x2: total + 14, y2: H },
    { param: 'glueFlap', label: `粘口 ${fmt(structure.glueFlap)}`, x1: -structure.glueFlap, y1: -8, x2: 0, y2: -8, secondary: true },
    ...extras
  ]
}

function buildTuckBox(params, structure, { reverse, hangHole }) {
  const { length: L, width: W, height: H, thickness: t } = params
  const { glueFlap, tuckLength, dustDepth } = structure
  const at = makeAttachments(H)
  const holes = []
  if (hangHole) {
    const r = structure.holeDiameter / 2
    const cx = W + L / 2
    const cy = -(W + t) + Math.max(r + 3, W * 0.35)
    holes.push([
      { x: cx - r, y: cy - r, r, edge: 'cut' }, { x: cx + r, y: cy - r, r, edge: 'cut' },
      { x: cx + r, y: cy + r, r, edge: 'cut' }, { x: cx - r, y: cy + r, r, edge: 'cut' }
    ])
  }
  const lidDepth = W + t
  const topLid = at.tuckLid({ end: 'top', lidDepth, tuckLength, t, holes })
  const bottomLid = at.tuckLid({ end: 'bottom', lidDepth, tuckLength, t })
  const dustTop = at.dust({ end: 'top', depth: dustDepth, t })
  const dustBottom = at.dust({ end: 'bottom', depth: dustDepth, t })
  const attachments = [
    [dustTop, dustBottom],
    [topLid, reverse ? null : bottomLid].filter(Boolean),
    [dustTop, dustBottom],
    [reverse ? bottomLid : null].filter(Boolean)
  ]
  const tube = buildTube({ widths: [W, L, W, L], H, t, glueFlap, attachments })
  const bottomExtent = lidDepth + tuckLength
  const annotations = tubeAnnotations(L, W, H, { ...structure, bottomExtent }, tube.total, [
    { param: 'tuckLength', label: `插舌 ${fmt(tuckLength)}`, x1: W + L + 8, y1: -lidDepth - tuckLength, x2: W + L + 8, y2: -lidDepth, secondary: true },
    { param: 'dustDepth', label: `防尘翼 ${fmt(dustDepth)}`, x1: -8, y1: -dustDepth, x2: -8, y2: 0, secondary: true }
  ])
  return { parts: [{ id: 'body', name: '盒体', count: 1, panels: tube.panels }], annotations }
}

export const tuckEndTemplate = makeTemplate({
  id: 'tuck-end',
  version: '0.1.0-draft',
  name: '直插盒',
  category: '折叠纸盒',
  description: '上下插舌在同一面板（STE），小件配件、五金包装',
  defaults: { length: 120, width: 60, height: 180, thickness: 0.6, bleed: 3, material: 'cardboard' },
  ranges: TUBE_RANGES,
  materials: CARTON_MATERIALS,
  structureParams: [glueParam, tuckParam, dustParam],
  extraValidate: tubeExtraValidate,
  build(params) {
    return buildTuckBox(params, this.resolveStructure(params), { reverse: false, hangHole: false })
  }
})

export const reverseTuckTemplate = makeTemplate({
  id: 'reverse-tuck',
  version: '0.1.0-draft',
  name: '反插盒',
  category: '折叠纸盒',
  description: '上下插舌在相对面板（RTE），常规彩盒',
  defaults: { length: 120, width: 60, height: 180, thickness: 0.6, bleed: 3, material: 'cardboard' },
  ranges: TUBE_RANGES,
  materials: CARTON_MATERIALS,
  structureParams: [glueParam, tuckParam, dustParam],
  extraValidate: tubeExtraValidate,
  build(params) {
    return buildTuckBox(params, this.resolveStructure(params), { reverse: true, hangHole: false })
  }
})

export const cosmeticBoxTemplate = makeTemplate({
  id: 'cosmetic-box',
  version: '0.1.0-draft',
  name: '化妆品挂孔盒',
  category: '折叠纸盒',
  description: '反插盒 + 上盖挂孔，细长型小件包装',
  defaults: { length: 50, width: 50, height: 160, thickness: 0.5, bleed: 3, material: 'cardboard' },
  ranges: TUBE_RANGES,
  materials: CARTON_MATERIALS,
  structureParams: [glueParam, tuckParam, dustParam,
    { key: 'holeDiameter', label: '挂孔直径', min: 3, max: 30, step: 0.5, auto: () => 6 }],
  extraValidate(params, structure) {
    const errors = tubeExtraValidate(params, structure)
    if (structure.holeDiameter + 6 > params.width) errors.push('挂孔直径过大')
    return errors
  },
  build(params) {
    return buildTuckBox(params, this.resolveStructure(params), { reverse: true, hangHole: true })
  }
})

export const carryHandleTemplate = makeTemplate({
  id: 'fefco-0217',
  version: '0.1.0-draft',
  name: '0217 提手锁底箱',
  category: '运输纸箱',
  description: '顶部提手立板，底部插舌锁底，可手提的中小件外箱',
  defaults: { length: 300, width: 200, height: 250, thickness: 3, bleed: 3, material: 'corrugated-b' },
  ranges: { length: [60, 1200], width: [40, 800], height: [60, 1200], thickness: [1, 8], bleed: [0, 10] },
  materials: CORRUGATED_MATERIALS,
  structureParams: [
    { key: 'glueFlap', label: '粘口宽', min: 15, max: 100, step: 0.5, auto: (p) => Math.min(50, Math.max(25, 0.15 * p.width)) },
    { key: 'handleHeight', label: '提手高', min: 30, max: 300, step: 0.5, auto: (p) => Math.min(120, Math.max(50, 0.35 * p.width + 30)) },
    { key: 'handleSlotW', label: '提手孔长', min: 40, max: 200, step: 0.5, auto: (p) => Math.min(110, Math.max(60, 0.35 * p.length)) },
    { key: 'handleSlotH', label: '提手孔宽', min: 15, max: 60, step: 0.5, auto: () => 25 },
    { key: 'tongueW', label: '锁舌宽', min: 20, max: 400, step: 0.5, auto: (p) => Math.max(20, 0.3 * p.length) }
  ],
  extraValidate(params, structure) {
    const errors = []
    if (structure.glueFlap >= params.width) errors.push('粘口宽需小于宽度')
    if (structure.handleSlotW + 20 > params.length) errors.push('提手孔长需小于长度减 20')
    if (structure.handleSlotH + 10 > structure.handleHeight) errors.push('提手孔宽需小于提手高减 10')
    if (structure.tongueW + 20 > params.length) errors.push('锁舌宽需小于长度减 20')
    return errors
  },
  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const structure = this.resolveStructure(params)
    const { glueFlap, handleHeight, handleSlotW, handleSlotH, tongueW } = structure
    const at = makeAttachments(H)
    const closeDepth = W / 2
    const handle = at.handle({ end: 'top', closeDepth, handleHeight, slotW: handleSlotW, slotH: handleSlotH, t })
    const topDust = at.dust({ end: 'top', depth: Math.max(10, W * 0.45), t })
    const bottomDust = at.dust({ end: 'bottom', depth: Math.max(10, W * 0.5), t, order: 2 })
    const tongueLen = Math.min(0.25 * W, 40)
    const lockMain = at.lockTongue({ end: 'bottom', depth: W * 0.5, tongueW, tongueLen, t, order: 4 })
    const lockSlot = at.lockSlot({ end: 'bottom', depth: W * 0.55, slotW: tongueW + 2, slotAt: W * 0.5 - (t + 1), t, order: 3 })
    const attachments = [
      [topDust, bottomDust],
      [handle, lockMain],
      [topDust, bottomDust],
      [handle, lockSlot]
    ]
    const tube = buildTube({ widths: [W, L, W, L], H, t, glueFlap, attachments })
    const bottomExtent = W * 0.55 + tongueLen
    const annotations = tubeAnnotations(L, W, H, { ...structure, bottomExtent }, tube.total, [
      { param: 'handleHeight', label: `提手 ${fmt(handleHeight)}`, x1: W + L + 8, y1: -closeDepth - handleHeight, x2: W + L + 8, y2: -closeDepth, secondary: true },
      { param: 'handleSlotW', label: `孔 ${fmt(handleSlotW)}×${fmt(handleSlotH)}`, x1: W + L / 2 - handleSlotW / 2, y1: -closeDepth - handleHeight - 8, x2: W + L / 2 + handleSlotW / 2, y2: -closeDepth - handleHeight - 8, secondary: true },
      { param: 'tongueW', label: `锁舌 ${fmt(tongueW)}`, x1: W + L / 2 - tongueW / 2, y1: H + W * 0.5 + tongueLen + 8, x2: W + L / 2 + tongueW / 2, y2: H + W * 0.5 + tongueLen + 8, secondary: true }
    ])
    return { parts: [{ id: 'body', name: '箱体', count: 1, panels: tube.panels }], annotations }
  }
})
