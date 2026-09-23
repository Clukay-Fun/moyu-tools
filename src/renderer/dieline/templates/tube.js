// 管状折叠纸盒公共结构：粘口 | 侧板(W) | 面板(L) | 侧板(W) | 面板(L)，两端按需挂防尘翼、插舌盖、提手翼、锁底片。
// 坐标：面板链沿 x，盒高沿 y（0..H）；上端附件 y<0，下端附件 y>H。

const IDS = ['side1', 'front', 'side2', 'back']

// 重合顶点合并，保留后者的边类型（后者才是真正离开该点的那条边）
function dedupe(contour) {
  const result = []
  for (const vertex of contour) {
    const previous = result[result.length - 1]
    if (previous && Math.abs(previous.x - vertex.x) < 1e-6 && Math.abs(previous.y - vertex.y) < 1e-6) previous.edge = vertex.edge
    else result.push({ ...vertex })
  }
  const first = result[0]
  const last = result[result.length - 1]
  if (result.length > 1 && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
    result.pop()
  }
  return result
}
const NAMES = ['侧板 1', '前板', '侧板 2', '后板']

function edgeSegments(x0, x1, y, span, direction, edgeType) {
  // 面板上/下沿：附件折线段用 'none'（由子面板画折线），其余为切线。direction=1 表示从 x0 向 x1
  const vertices = []
  if (!span) return vertices
  const [a, b] = span
  if (direction === 1) {
    if (a > x0 + 1e-6) vertices.push({ x: a, y, edge: 'none' })
    vertices.push({ x: b, y, edge: edgeType })
  } else {
    if (b < x1 - 1e-6) vertices.push({ x: b, y, edge: 'none' })
    vertices.push({ x: a, y, edge: edgeType })
  }
  return vertices
}

/**
 * @param {object} spec
 * @param {number[]} spec.widths 四块面板宽度 [W, L, W, L]
 * @param {number} spec.H
 * @param {number} spec.t
 * @param {number} spec.glueFlap
 * @param {Array<Array<object>>} spec.attachments 每块面板的附件列表：{ end: 'top'|'bottom', build(panelIndex, x0, x1, ctx) → { panels, span } }
 */
export function buildTube(spec) {
  const { widths, H, t, glueFlap, attachments } = spec
  const starts = [0]
  widths.forEach((width, index) => starts.push(starts[index] + width))
  const panels = []
  const spansTop = []
  const spansBottom = []
  const extra = []

  widths.forEach((width, index) => {
    const x0 = starts[index]
    const x1 = starts[index + 1]
    let topSpan = null
    let bottomSpan = null
    for (const attachment of attachments[index] || []) {
      const result = attachment.build(IDS[index], x0, x1)
      extra.push(...result.panels)
      if (attachment.end === 'top') topSpan = result.span
      else bottomSpan = result.span
    }
    spansTop.push(topSpan)
    spansBottom.push(bottomSpan)
  })

  widths.forEach((width, index) => {
    const x0 = starts[index]
    const x1 = starts[index + 1]
    const last = index === widths.length - 1
    const contour = [{ x: x0, y: 0, edge: spansTop[index] && spansTop[index][0] <= x0 + 1e-6 ? 'none' : 'cut' }]
    contour.push(...edgeSegments(x0, x1, 0, spansTop[index], 1, 'cut'))
    contour.push({ x: x1, y: 0, edge: last ? 'cut' : 'none' })
    contour.push({ x: x1, y: H, edge: spansBottom[index] && spansBottom[index][1] >= x1 - 1e-6 ? 'none' : 'cut' })
    contour.push(...edgeSegments(x0, x1, H, spansBottom[index], -1, 'cut'))
    contour.push({ x: x0, y: H, edge: index === 0 ? 'none' : 'crease' })
    panels.push({
      id: IDS[index], name: NAMES[index], holes: [],
      parent: index === 0 ? null : IDS[index - 1],
      hinge: index === 0 ? null : { a: [x0, 0], b: [x0, H] },
      order: 1, angle: index === 0 ? 0 : 90,
      contour: dedupe(contour)
    })
  })

  const taper = Math.min(4 * t + 4, H * 0.1)
  panels.push({
    id: 'glueFlap', name: '粘口', holes: [], parent: IDS[0], order: 1, angle: 90,
    hinge: { a: [0, 0], b: [0, H] },
    contour: [
      { x: 0, y: 0, edge: 'cut' },
      { x: -glueFlap, y: taper, edge: 'cut' },
      { x: -glueFlap, y: H - taper, edge: 'cut' },
      { x: 0, y: H, edge: 'crease' }
    ]
  })
  panels.push(...extra)
  return { panels, starts, total: starts[widths.length], ids: IDS }
}

// ---- 附件 ----

export function makeAttachments(H) {
  const yOf = (end) => (end === 'top' ? 0 : H)
  const dir = (end) => (end === 'top' ? -1 : 1)

  return {
    dust({ end, depth, t, order = 2 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const inset = t
          const shrink = Math.min(depth * 0.35, (x1 - x0) * 0.3)
          const a = x0 + inset
          const b = x1 - inset
          const outer = y + s * depth
          const contour = end === 'top'
            ? [
                { x: a, y, edge: 'cut' }, { x: a + shrink, y: outer, r: 2 * t, edge: 'cut' },
                { x: b - shrink, y: outer, r: 2 * t, edge: 'cut' }, { x: b, y, edge: 'crease' }
              ]
            : [
                { x: b, y, edge: 'cut' }, { x: b - shrink, y: outer, r: 2 * t, edge: 'cut' },
                { x: a + shrink, y: outer, r: 2 * t, edge: 'cut' }, { x: a, y, edge: 'crease' }
              ]
          return {
            span: [a, b],
            panels: [{
              id: `${panelId}${end === 'top' ? 'Top' : 'Bottom'}Dust`, name: `${end === 'top' ? '上' : '下'}防尘翼`, holes: [],
              parent: panelId, order, angle: 90,
              hinge: end === 'top' ? { a: [a, y], b: [b, y] } : { a: [b, y], b: [a, y] },
              contour
            }]
          }
        }
      }
    },

    /** 插舌盖：盖板（深 = W）+ 圆角插舌，两侧留 t+1 让位；holes 可放挂孔。 */
    tuckLid({ end, lidDepth, tuckLength, t, holes = [], orderLid = 3, orderTuck = 4 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const yLid = y + s * lidDepth
          const yTuck = yLid + s * tuckLength
          const inset = t + 1
          const r = Math.min(tuckLength * 0.45, (x1 - x0) * 0.2)
          const prefix = `${panelId}${end === 'top' ? 'Top' : 'Bottom'}`
          const lidContour = end === 'top'
            ? [{ x: x0, y: yLid, edge: 'none' }, { x: x1, y: yLid, edge: 'cut' }, { x: x1, y, edge: 'crease' }, { x: x0, y, edge: 'cut' }]
            : [{ x: x0, y, edge: 'crease' }, { x: x1, y, edge: 'cut' }, { x: x1, y: yLid, edge: 'none' }, { x: x0, y: yLid, edge: 'cut' }]
          const tuckContour = end === 'top'
            ? [{ x: x0 + inset, y: yTuck, r, edge: 'cut' }, { x: x1 - inset, y: yTuck, r, edge: 'cut' }, { x: x1 - inset, y: yLid, edge: 'crease' }, { x: x0 + inset, y: yLid, edge: 'cut' }]
            : [{ x: x0 + inset, y: yLid, edge: 'crease' }, { x: x1 - inset, y: yLid, edge: 'cut' }, { x: x1 - inset, y: yTuck, r, edge: 'cut' }, { x: x0 + inset, y: yTuck, r, edge: 'cut' }]
          return {
            span: [x0, x1],
            panels: [
              {
                id: `${prefix}Lid`, name: `${end === 'top' ? '上' : '下'}盖板`, holes, parent: panelId, order: orderLid, angle: 90,
                hinge: { a: [x0, y], b: [x1, y] }, contour: lidContour
              },
              {
                id: `${prefix}Tuck`, name: `${end === 'top' ? '上' : '下'}插舌`, holes: [], parent: `${prefix}Lid`, order: orderTuck, angle: 90,
                hinge: { a: [x0 + inset, yLid], b: [x1 - inset, yLid] }, contour: tuckContour
              }
            ]
          }
        }
      }
    },

    /** 提手翼：封口翼（深 = closeDepth，折 90°）+ 提手立板（再折 90° 立起，带提手孔）。 */
    handle({ end, closeDepth, handleHeight, slotW, slotH, t, orderClose = 3, orderHandle = 4 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const yClose = y + s * closeDepth
          const yHandle = yClose + s * handleHeight
          const inset = t
          const prefix = `${panelId}${end === 'top' ? 'Top' : 'Bottom'}`
          const cx = (x0 + x1) / 2
          const slotCenterY = yClose + s * (handleHeight * 0.55)
          const hole = [
            { x: cx - slotW / 2, y: slotCenterY - slotH / 2, r: slotH / 2, edge: 'cut' },
            { x: cx + slotW / 2, y: slotCenterY - slotH / 2, r: slotH / 2, edge: 'cut' },
            { x: cx + slotW / 2, y: slotCenterY + slotH / 2, r: slotH / 2, edge: 'cut' },
            { x: cx - slotW / 2, y: slotCenterY + slotH / 2, r: slotH / 2, edge: 'cut' }
          ]
          const closeContour = end === 'top'
            ? [{ x: x0 + inset, y: yClose, edge: 'none' }, { x: x1 - inset, y: yClose, edge: 'cut' }, { x: x1 - inset, y, edge: 'crease' }, { x: x0 + inset, y, edge: 'cut' }]
            : [{ x: x0 + inset, y, edge: 'crease' }, { x: x1 - inset, y, edge: 'cut' }, { x: x1 - inset, y: yClose, edge: 'none' }, { x: x0 + inset, y: yClose, edge: 'cut' }]
          const r = Math.min(handleHeight * 0.3, (x1 - x0) * 0.15)
          const handleContour = end === 'top'
            ? [{ x: x0 + inset, y: yHandle, r, edge: 'cut' }, { x: x1 - inset, y: yHandle, r, edge: 'cut' }, { x: x1 - inset, y: yClose, edge: 'crease' }, { x: x0 + inset, y: yClose, edge: 'cut' }]
            : [{ x: x0 + inset, y: yClose, edge: 'crease' }, { x: x1 - inset, y: yClose, edge: 'cut' }, { x: x1 - inset, y: yHandle, r, edge: 'cut' }, { x: x0 + inset, y: yHandle, r, edge: 'cut' }]
          return {
            span: [x0 + inset, x1 - inset],
            panels: [
              {
                id: `${prefix}Close`, name: '封口翼', holes: [], parent: panelId, order: orderClose, angle: 90,
                hinge: { a: [x0 + inset, y], b: [x1 - inset, y] }, contour: closeContour
              },
              {
                id: `${prefix}Handle`, name: '提手立板', holes: [hole], parent: `${prefix}Close`, order: orderHandle, angle: 90,
                hinge: { a: [x0 + inset, yClose], b: [x1 - inset, yClose] }, contour: handleContour
              }
            ]
          }
        }
      }
    },

    /** 单边斜切防尘翼：贴着盖板的一侧竖直，远离盖板的一侧斜收。 */
    dustAngled({ end, depth, t, angleSide, order = 2 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const outer = y + s * depth
          const inset = t
          const run = Math.min(depth * 0.35, (x1 - x0) * 0.35)
          const a = x0 + (angleSide === 'left' ? 0 : inset)
          const b = x1 - (angleSide === 'right' ? 0 : inset)
          const topA = angleSide === 'left' ? a + run : a
          const topB = angleSide === 'right' ? b - run : b
          const contour = end === 'top'
            ? [
                { x: a, y, edge: 'cut' }, { x: topA, y: outer, r: 2 * t, edge: 'cut' },
                { x: topB, y: outer, r: 2 * t, edge: 'cut' }, { x: b, y, edge: 'crease' }
              ]
            : [
                { x: b, y, edge: 'cut' }, { x: topB, y: outer, r: 2 * t, edge: 'cut' },
                { x: topA, y: outer, r: 2 * t, edge: 'cut' }, { x: a, y, edge: 'crease' }
              ]
          return {
            span: [a, b],
            panels: [{
              id: `${panelId}${end === 'top' ? 'Top' : 'Bottom'}Dust`, name: `${end === 'top' ? '上' : '下'}防尘翼`, holes: [],
              parent: panelId, order, angle: 90,
              hinge: end === 'top' ? { a: [a, y], b: [b, y] } : { a: [b, y], b: [a, y] },
              contour
            }]
          }
        }
      }
    },

    /** 自锁底斜角片：一侧 45° 斜边，另一侧齐边（1-2-3 底的两片窄面）。 */
    crashCorner({ end, depth, diagonal, order = 2 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const contour = [
            { x: x0, y, edge: 'cut' },
            { x: x0 + diagonal, y: y + s * diagonal, edge: 'cut' },
            { x: x0 + diagonal, y: y + s * depth, edge: 'cut' },
            { x: x1, y: y + s * depth, edge: 'cut' },
            { x: x1, y, edge: 'crease' }
          ]
          return {
            span: [x0, x1],
            panels: [{
              id: `${panelId}${end === 'top' ? 'Top' : 'Bottom'}Corner`, name: '自锁底斜角片', holes: [],
              parent: panelId, order, angle: 90,
              hinge: { a: [x0, y], b: [x1, y] },
              contour
            }]
          }
        }
      }
    },

    /** 自锁底承片：两侧 45° 斜边 + 中央锁舌（与斜角片互锁的那一片）。 */
    crashTab({ end, depth, diagonal, order = 3 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const contour = [
            { x: x0, y, edge: 'cut' },
            { x: x0 + diagonal, y: y + s * diagonal, edge: 'cut' },
            { x: x0 + diagonal, y: y + s * depth, edge: 'cut' },
            { x: x1 - diagonal, y: y + s * depth, edge: 'cut' },
            { x: x1 - diagonal, y: y + s * diagonal, edge: 'cut' },
            { x: x1, y, edge: 'crease' }
          ]
          return {
            span: [x0, x1],
            panels: [{
              id: `${panelId}${end === 'top' ? 'Top' : 'Bottom'}Tab`, name: '自锁底承片', holes: [],
              parent: panelId, order, angle: 90,
              hinge: { a: [x0, y], b: [x1, y] },
              contour
            }]
          }
        }
      }
    },

    /** 自锁底主片：两端深、中间浅的封底翼（带肩）。 */
    crashMain({ end, depth, stepDepth, legWidth, order = 3 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const contour = [
            { x: x0, y, edge: 'cut' },
            { x: x0, y: y + s * depth, edge: 'cut' },
            { x: x0 + legWidth, y: y + s * depth, edge: 'cut' },
            { x: x0 + legWidth, y: y + s * stepDepth, edge: 'cut' },
            { x: x1 - legWidth, y: y + s * stepDepth, edge: 'cut' },
            { x: x1 - legWidth, y: y + s * depth, edge: 'cut' },
            { x: x1, y: y + s * depth, edge: 'cut' },
            { x: x1, y, edge: 'crease' }
          ]
          return {
            span: [x0, x1],
            panels: [{
              id: `${panelId}${end === 'top' ? 'Top' : 'Bottom'}Main`, name: '自锁底主片', holes: [],
              parent: panelId, order, angle: 90,
              hinge: { a: [x0, y], b: [x1, y] },
              contour
            }]
          }
        }
      }
    },

    /** 锁底主片：封底翼 + 中央插舌。 */
    lockTongue({ end, depth, tongueW, tongueLen, t, order = 3 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const inset = t
          const yEdge = y + s * depth
          const yTip = yEdge + s * tongueLen
          const cx = (x0 + x1) / 2
          const r = Math.min(tongueLen * 0.4, tongueW * 0.2)
          const prefix = `${panelId}${end === 'top' ? 'Top' : 'Bottom'}`
          const contour = end === 'top'
            ? [
                { x: x0 + inset, y: yEdge, r: 2 * t, edge: 'cut' }, { x: cx - tongueW / 2, y: yEdge, edge: 'cut' }, { x: cx - tongueW / 2, y: yTip, r, edge: 'cut' },
                { x: cx + tongueW / 2, y: yTip, r, edge: 'cut' }, { x: cx + tongueW / 2, y: yEdge, edge: 'cut' }, { x: x1 - inset, y: yEdge, r: 2 * t, edge: 'cut' },
                { x: x1 - inset, y, edge: 'crease' }, { x: x0 + inset, y, edge: 'cut' }
              ]
            : [
                { x: x0 + inset, y, edge: 'crease' }, { x: x1 - inset, y, edge: 'cut' }, { x: x1 - inset, y: yEdge, r: 2 * t, edge: 'cut' },
                { x: cx + tongueW / 2, y: yEdge, edge: 'cut' }, { x: cx + tongueW / 2, y: yTip, r, edge: 'cut' }, { x: cx - tongueW / 2, y: yTip, r, edge: 'cut' },
                { x: cx - tongueW / 2, y: yEdge, edge: 'cut' }, { x: x0 + inset, y: yEdge, r: 2 * t, edge: 'cut' }
              ]
          return {
            span: [x0 + inset, x1 - inset],
            panels: [{
              id: `${prefix}Lock`, name: '锁底主片', holes: [], parent: panelId, order, angle: 90,
              hinge: end === 'top' ? { a: [x0 + inset, y], b: [x1 - inset, y] } : { a: [x0 + inset, y], b: [x1 - inset, y] }, contour
            }]
          }
        }
      }
    },

    /** 锁底承片：封底翼，带承接插舌的开槽。 */
    lockSlot({ end, depth, slotW, slotAt, t, order = 3 }) {
      return {
        end,
        build(panelId, x0, x1) {
          const y = yOf(end)
          const s = dir(end)
          const inset = t
          const yEdge = y + s * depth
          const cx = (x0 + x1) / 2
          const ySlot = y + s * slotAt
          const half = (t + 1) / 2
          const slot = [
            { x: cx - slotW / 2, y: ySlot - half, r: half, edge: 'cut' }, { x: cx + slotW / 2, y: ySlot - half, r: half, edge: 'cut' },
            { x: cx + slotW / 2, y: ySlot + half, r: half, edge: 'cut' }, { x: cx - slotW / 2, y: ySlot + half, r: half, edge: 'cut' }
          ]
          const prefix = `${panelId}${end === 'top' ? 'Top' : 'Bottom'}`
          const contour = end === 'top'
            ? [{ x: x0 + inset, y: yEdge, r: 2 * t, edge: 'cut' }, { x: x1 - inset, y: yEdge, r: 2 * t, edge: 'cut' }, { x: x1 - inset, y, edge: 'crease' }, { x: x0 + inset, y, edge: 'cut' }]
            : [{ x: x0 + inset, y, edge: 'crease' }, { x: x1 - inset, y, edge: 'cut' }, { x: x1 - inset, y: yEdge, r: 2 * t, edge: 'cut' }, { x: x0 + inset, y: yEdge, r: 2 * t, edge: 'cut' }]
          return {
            span: [x0 + inset, x1 - inset],
            panels: [{
              id: `${prefix}Slot`, name: '锁底承片', holes: [slot], parent: panelId, order, angle: 90,
              hinge: { a: [x0 + inset, y], b: [x1 - inset, y] }, contour
            }]
          }
        }
      }
    }
  }
}
