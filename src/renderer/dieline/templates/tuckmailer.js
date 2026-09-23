// 舌插盖自锁底盒（Tuck end mailer）：顶部单片插舌盖 + 两侧单边斜切防尘翼，底部 1-2-3 自锁底。
// 结构比例按 scope/plans/active/dieline-refs/preset-gallery.png 中 "Tuck end mailer box packaging dieline"
// 缩略图像素反推（面板链 L | W | L | W，盖深≈W，插舌≈0.26W，防尘翼≈0.62W，底深≈0.76W，斜边 45°），未经参考刀模校准。
import { makeTemplate, CARTON_MATERIALS, fmt } from './common.js'
import { buildTube, makeAttachments } from './tube.js'

export const tuckMailerTemplate = makeTemplate({
  id: 'tuck-mailer',
  version: '0.1.0-draft',
  name: '舌插盖自锁底盒',
  category: '折叠纸盒',
  description: '顶部插舌盖、底部自锁底，落地即成型，小件零售与快递内盒',
  defaults: { length: 120, width: 60, height: 160, thickness: 0.6, bleed: 3, material: 'cardboard' },
  ranges: {
    length: [25, 1000],
    width: [15, 600],
    height: [30, 1200],
    thickness: [0.3, 5],
    bleed: [0, 10]
  },
  materials: CARTON_MATERIALS,
  structureParams: [
    { key: 'glueFlap', label: '粘口宽', min: 8, max: 80, step: 0.5, auto: (p) => Math.min(30, Math.max(10, 0.12 * p.width + 6)) },
    { key: 'lidDepth', label: '盖深', min: 10, max: 600, step: 0.5, auto: (p) => p.width },
    { key: 'tuckLength', label: '插舌长', min: 5, max: 200, step: 0.5, auto: (p) => 0.26 * p.width },
    { key: 'dustDepth', label: '防尘翼深', min: 5, max: 600, step: 0.5, auto: (p) => 0.62 * p.width },
    { key: 'bottomDepth', label: '底盖深', min: 10, max: 600, step: 0.5, auto: (p) => 0.76 * p.width },
    { key: 'lockDiagonal', label: '锁底斜边', min: 5, max: 400, step: 0.5, auto: (p) => 0.5 * p.width }
  ],
  extraValidate(params, structure) {
    const errors = []
    if (structure.glueFlap >= params.width) errors.push('粘口宽需小于宽度')
    if (structure.lidDepth > params.width * 1.2) errors.push('盖深超过宽度的 1.2 倍')
    if (structure.tuckLength > params.height * 0.5) errors.push('插舌长不能超过高度的一半')
    if (structure.dustDepth > params.width) errors.push('防尘翼深不能超过宽度')
    if (structure.lockDiagonal > structure.bottomDepth) errors.push('锁底斜边不能超过底盖深')
    if (structure.lockDiagonal * 2 >= params.length) errors.push('锁底斜边过大，承片中间没有锁舌')
    if (structure.lockDiagonal >= params.width) errors.push('锁底斜边需小于宽度')
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
    const { glueFlap, lidDepth, tuckLength, dustDepth, bottomDepth, lockDiagonal } = this.resolveStructure(params)
    const at = makeAttachments(H)
    // 面板链：粘口 | L(盖板面) | W | L | W；顶部只有第一块长面带盖，对面长面无顶盖
    const attachments = [
      [
        at.tuckLid({ end: 'top', lidDepth, tuckLength, t, orderLid: 3, orderTuck: 4 }),
        at.crashMain({ end: 'bottom', depth: bottomDepth, stepDepth: bottomDepth * 0.64, legWidth: 0.25 * L, order: 3 })
      ],
      [
        at.dustAngled({ end: 'top', depth: dustDepth, t, angleSide: 'right' }),
        at.crashCorner({ end: 'bottom', depth: bottomDepth, diagonal: lockDiagonal, order: 2 })
      ],
      [at.crashTab({ end: 'bottom', depth: bottomDepth, diagonal: lockDiagonal, order: 3 })],
      [
        at.dustAngled({ end: 'top', depth: dustDepth, t, angleSide: 'left' }),
        at.crashCorner({ end: 'bottom', depth: bottomDepth, diagonal: lockDiagonal, order: 2 })
      ]
    ]
    const tube = buildTube({ widths: [L, W, L, W], H, t, glueFlap, attachments })
    const annotations = [
      { param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: H + bottomDepth + 14, x2: L, y2: H + bottomDepth + 14 },
      { param: 'width', label: `W ${fmt(W)} mm`, x1: L, y1: H + bottomDepth + 14, x2: L + W, y2: H + bottomDepth + 14 },
      { param: 'height', label: `H ${fmt(H)} mm`, x1: tube.total + 14, y1: 0, x2: tube.total + 14, y2: H },
      { param: 'lidDepth', label: `盖 ${fmt(lidDepth)}`, x1: -8, y1: -lidDepth, x2: -8, y2: 0, secondary: true },
      { param: 'tuckLength', label: `插舌 ${fmt(tuckLength)}`, x1: L + 8, y1: -lidDepth - tuckLength, x2: L + 8, y2: -lidDepth, secondary: true },
      { param: 'dustDepth', label: `防尘翼 ${fmt(dustDepth)}`, x1: tube.total + 14, y1: -dustDepth, x2: tube.total + 14, y2: 0, secondary: true },
      { param: 'bottomDepth', label: `底盖 ${fmt(bottomDepth)}`, x1: tube.total + 14, y1: H, x2: tube.total + 14, y2: H + bottomDepth, secondary: true },
      { param: 'lockDiagonal', label: `斜边 ${fmt(lockDiagonal)}`, x1: L, y1: H, x2: L + lockDiagonal, y2: H + lockDiagonal, secondary: true }
    ]
    return { parts: [{ id: 'body', name: '盒体', count: 1, panels: tube.panels }], annotations }
  }
})
