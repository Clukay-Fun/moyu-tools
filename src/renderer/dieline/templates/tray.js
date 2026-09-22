// 双层侧墙锁底托盘：底板 + 前后墙（带端翼）+ 左右双层侧墙（顶条 + 带锁舌内折翼）。
// 飞机盒的盒体与天地盖的盖/底都由它生成；坐标系以底板左上角为原点。
import { mirrorContourX, mirrorPointX } from '../geometry.js'

export function rect(x1, y1, x2, y2, options = {}) {
  const { r = 0, edges = {} } = options
  return [
    { x: x1, y: y1, r: options.rTopLeft ?? r, edge: edges.top || 'cut' },
    { x: x2, y: y1, r: options.rTopRight ?? r, edge: edges.right || 'cut' },
    { x: x2, y: y2, r: options.rBottomRight ?? r, edge: edges.bottom || 'cut' },
    { x: x1, y: y2, r: options.rBottomLeft ?? r, edge: edges.left || 'cut' }
  ]
}

export function mirrorPanel(panel, axis) {
  return {
    ...panel,
    id: panel.id.replace(/Left$/, 'Right'),
    name: panel.name.replace('左', '右'),
    parent: panel.parent?.replace(/Left$/, 'Right') || panel.parent,
    contour: mirrorContourX(panel.contour, axis),
    holes: (panel.holes || []).map((hole) => mirrorContourX(hole, axis)),
    hinge: panel.hinge ? { a: mirrorPointX(panel.hinge.a, axis), b: mirrorPointX(panel.hinge.b, axis) } : null
  }
}

/**
 * @param {object} spec
 * @param {number} spec.L 底板长（x 向）
 * @param {number} spec.W 底板宽（y 向）
 * @param {number} spec.H 墙高
 * @param {number} spec.t 纸板厚
 * @param {number} spec.endFlapW 前后墙端翼宽
 * @param {number} spec.tabLength 锁舌长
 * @param {string} [spec.backWallTop] 后墙上沿边类型（飞机盒挂盖板时为 'none'）
 * @param {number} [spec.orderBase] 折叠顺序起点
 * @returns {{ panels: object[], metrics: object }}
 */
export function buildTrayPanels(spec) {
  const { L, W, H, t, endFlapW, tabLength, backWallTop = 'cut', orderBase = 0 } = spec
  const wallH = H + 2 * t
  const sideW = H + t
  const strip = 3 * t
  const innerW = H + t
  const tabDepth = 2 * t + 2
  const tabOffset = 0.19 * W
  const slotX = t + 1
  const slotW = 2 * t
  const tabs = [W / 2 - tabOffset, W / 2 + tabOffset]
  const innerX = -sideW - strip

  const panels = []
  const push = (panel) => panels.push({ holes: [], angle: 90, ...panel })

  const slotHoles = []
  for (const centerY of tabs) {
    const half = (tabLength + 2) / 2
    slotHoles.push(rect(slotX, centerY - half, slotX + slotW, centerY + half, { r: t }))
    slotHoles.push(rect(L - slotX - slotW, centerY - half, L - slotX, centerY + half, { r: t }))
  }
  push({
    id: 'base', name: '底板', parent: null, hinge: null, order: 0, angle: 0,
    contour: rect(0, 0, L, W, { edges: { top: 'none', right: 'none', bottom: 'none', left: 'none' } }),
    holes: slotHoles
  })

  push({
    id: 'backWall', name: '后墙', parent: 'base', order: orderBase + 4,
    hinge: { a: [0, 0], b: [L, 0] },
    contour: [
      { x: 0, y: -wallH, edge: backWallTop }, { x: L, y: -wallH, edge: 'none' }, { x: L, y: -t, edge: 'cut' },
      { x: L, y: 0, edge: 'crease' }, { x: 0, y: 0, edge: 'cut' }, { x: 0, y: -t, edge: 'none' }
    ]
  })
  push({
    id: 'frontWall', name: '前墙', parent: 'base', order: orderBase + 4,
    hinge: { a: [0, W], b: [L, W] },
    contour: [
      { x: 0, y: W, edge: 'crease' }, { x: L, y: W, edge: 'cut' }, { x: L, y: W + t, edge: 'none' },
      { x: L, y: W + wallH, edge: 'cut' }, { x: 0, y: W + wallH, edge: 'none' }, { x: 0, y: W + t, edge: 'cut' }
    ]
  })
  const backFlapLeft = {
    id: 'backFlapLeft', name: '后墙左端翼', parent: 'backWall', order: orderBase + 3,
    hinge: { a: [0, -wallH], b: [0, -t] },
    contour: rect(-endFlapW, -wallH, 0, -t, { rTopLeft: 2 * t, rBottomLeft: 2 * t, edges: { right: 'crease' } })
  }
  const frontFlapLeft = {
    id: 'frontFlapLeft', name: '前墙左端翼', parent: 'frontWall', order: orderBase + 3,
    hinge: { a: [0, W + t], b: [0, W + wallH] },
    contour: rect(-endFlapW, W + t, 0, W + wallH, { rTopLeft: 2 * t, rBottomLeft: 2 * t, edges: { right: 'crease' } })
  }
  push(backFlapLeft)
  push(mirrorPanel(backFlapLeft, L / 2))
  push(frontFlapLeft)
  push(mirrorPanel(frontFlapLeft, L / 2))

  const sideLeft = {
    id: 'sideWallLeft', name: '左侧墙', parent: 'base', order: orderBase + 2,
    hinge: { a: [0, 0], b: [0, W] },
    contour: rect(-sideW, 0, 0, W, { edges: { top: 'cut', right: 'crease', bottom: 'cut', left: 'none' } })
  }
  const stripLeft = {
    id: 'sideStripLeft', name: '左侧墙顶条', parent: 'sideWallLeft', order: orderBase + 1,
    hinge: { a: [-sideW, 0], b: [-sideW, W] },
    contour: [
      { x: -sideW - strip, y: 0, edge: 'cut' }, { x: -sideW, y: 0, edge: 'crease' }, { x: -sideW, y: W, edge: 'cut' },
      { x: -sideW - strip, y: W, edge: 'cut' }, { x: -sideW - strip, y: W - t, edge: 'none' }, { x: -sideW - strip, y: t, edge: 'cut' }
    ]
  }
  const innerContour = [
    { x: innerX, y: t, edge: 'cut' },
    { x: innerX - innerW, y: t, r: 2 * t, edge: 'cut' }
  ]
  for (const centerY of tabs) {
    const half = tabLength / 2
    innerContour.push(
      { x: innerX - innerW, y: centerY - half, edge: 'cut' },
      { x: innerX - innerW - tabDepth, y: centerY - half, r: t, edge: 'cut' },
      { x: innerX - innerW - tabDepth, y: centerY + half, r: t, edge: 'cut' },
      { x: innerX - innerW, y: centerY + half, edge: 'cut' }
    )
  }
  innerContour.push(
    { x: innerX - innerW, y: W - t, r: 2 * t, edge: 'cut' },
    { x: innerX, y: W - t, edge: 'crease' }
  )
  const innerLeft = {
    id: 'sideInnerLeft', name: '左侧墙内折翼', parent: 'sideStripLeft', order: orderBase + 1,
    hinge: { a: [innerX, t], b: [innerX, W - t] },
    contour: innerContour
  }
  for (const panel of [sideLeft, stripLeft, innerLeft]) {
    push(panel)
    push(mirrorPanel(panel, L / 2))
  }

  return {
    panels,
    metrics: { wallH, sideW, strip, innerW, tabDepth, innerX, tabs, outerLeft: innerX - innerW - tabDepth, outerRight: L - (innerX - innerW - tabDepth) }
  }
}
