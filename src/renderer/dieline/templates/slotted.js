// 四面板开槽箱公共结构：粘口 | L 面 | W 面 | L 面(+包差) | W 面，两端各挂一片摇盖，面板间按开槽宽让位。
// 0201 对口箱（摇盖深 = W/2）与全盖舌插盒（摇盖深 = W）都由它生成。

function rectPanel(x1, y1, x2, y2, edges) {
  return [
    { x: x1, y: y1, edge: edges.top || 'cut' },
    { x: x2, y: y1, edge: edges.right || 'cut' },
    { x: x2, y: y2, edge: edges.bottom || 'cut' },
    { x: x1, y: y2, edge: edges.left || 'cut' }
  ]
}

/**
 * @param {object} spec
 * @param {number} spec.L 长面宽度
 * @param {number} spec.W 宽面宽度
 * @param {number} spec.H 箱高
 * @param {number} spec.t 纸板厚度
 * @param {number} spec.glueFlap 粘口宽
 * @param {number} spec.flapDepth 摇盖深
 * @param {number} spec.slotWidth 开槽宽
 * @param {number} [spec.wrapAllowance] 外圈长面比内圈多出的包差
 * @returns {{ panels: object[], starts: number[], total: number, widths: number[] }}
 */
export function buildSlottedPanels(spec) {
  const { L, W, H, t, glueFlap, flapDepth: D, slotWidth: s, wrapAllowance = 0 } = spec
  const taper = Math.min(4 * t + 4, H * 0.1)
  const half = s / 2
  const panels = []
  const push = (panel) => panels.push({ holes: [], angle: 90, ...panel })

  const widths = [L, W, L + wrapAllowance, W]
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

  return { panels, starts, total: starts[4], widths }
}
