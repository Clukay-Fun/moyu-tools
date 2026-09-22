// 刀模路径原语：轮廓 = 顶点数组 {x, y, r?, edge?}
// r：该顶点的圆角半径；edge：从该顶点到下一顶点这条边的类型 'cut' | 'crease' | 'none'（none = 与相邻面板共边，由对方绘制）。
// 同一份轮廓同时产出 SVG path（2D / PDF）、THREE.Shape 指令（3D）和离散多边形（出血偏移、包围盒）。

const EPS = 1e-9

function normalize(x, y) {
  const length = Math.hypot(x, y) || 1
  return [x / length, y / length]
}

/** 把带圆角的轮廓展开为 M/L/A 指令序列（闭合）。 */
export function contourToCommands(contour) {
  const count = contour.length
  if (count < 3) return []
  const corners = contour.map((vertex, index) => {
    const prev = contour[(index - 1 + count) % count]
    const next = contour[(index + 1) % count]
    const radius = vertex.r || 0
    if (radius <= EPS) return { start: [vertex.x, vertex.y], end: [vertex.x, vertex.y], arc: null }
    const [u1x, u1y] = normalize(vertex.x - prev.x, vertex.y - prev.y)
    const [u2x, u2y] = normalize(next.x - vertex.x, next.y - vertex.y)
    const cross = u1x * u2y - u1y * u2x
    const dot = u1x * u2x + u1y * u2y
    const turn = Math.atan2(Math.abs(cross), dot)
    if (turn < 1e-4) return { start: [vertex.x, vertex.y], end: [vertex.x, vertex.y], arc: null }
    const interior = Math.PI - turn
    const inLength = Math.hypot(vertex.x - prev.x, vertex.y - prev.y)
    const outLength = Math.hypot(next.x - vertex.x, next.y - vertex.y)
    let r = radius
    let tangent = r / Math.tan(interior / 2)
    const limit = Math.min(inLength, outLength) * 0.49
    if (tangent > limit) {
      tangent = limit
      r = tangent * Math.tan(interior / 2)
    }
    const start = [vertex.x - u1x * tangent, vertex.y - u1y * tangent]
    const end = [vertex.x + u2x * tangent, vertex.y + u2y * tangent]
    const [bx, by] = normalize(u2x - u1x, u2y - u1y)
    const centerDistance = r / Math.sin(interior / 2)
    const center = [vertex.x + bx * centerDistance, vertex.y + by * centerDistance]
    const a1 = Math.atan2(start[1] - center[1], start[0] - center[0])
    const a2 = Math.atan2(end[1] - center[1], end[0] - center[0])
    let delta = a2 - a1
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    return { start, end, arc: { r, cx: center[0], cy: center[1], a1, a2, clockwise: delta < 0, sweep: cross > 0 ? 1 : 0 } }
  })

  const commands = [{ type: 'M', x: corners[0].end[0], y: corners[0].end[1] }]
  for (let index = 0; index < count; index += 1) {
    const edge = contour[index].edge || 'cut'
    const nextIndex = (index + 1) % count
    const nextCorner = corners[nextIndex]
    commands.push({ type: 'L', x: nextCorner.start[0], y: nextCorner.start[1], edge })
    if (nextCorner.arc) {
      const arcEdge = contour[nextIndex].edge || 'cut'
      commands.push({ type: 'A', x: nextCorner.end[0], y: nextCorner.end[1], edge: arcEdge, ...nextCorner.arc })
    }
  }
  return commands
}

function formatNumber(value) {
  return Number(value.toFixed(3)).toString()
}

function commandToSvg(command) {
  if (command.type === 'M') return `M${formatNumber(command.x)} ${formatNumber(command.y)}`
  if (command.type === 'L') return `L${formatNumber(command.x)} ${formatNumber(command.y)}`
  return `A${formatNumber(command.r)} ${formatNumber(command.r)} 0 0 ${command.sweep} ${formatNumber(command.x)} ${formatNumber(command.y)}`
}

/** 闭合填充路径（纸面底色、3D 轮廓校验用）。 */
export function contourToSvgPath(contour) {
  const commands = contourToCommands(contour)
  if (!commands.length) return ''
  return `${commands.map(commandToSvg).join(' ')} Z`
}

/** 按边类型拆成多段 path，连续同类边合并。返回 { cut: [...], crease: [...] }。 */
export function contourEdgePaths(contour) {
  const commands = contourToCommands(contour)
  const result = { cut: [], crease: [] }
  if (!commands.length) return result
  let current = null
  let cursor = { x: commands[0].x, y: commands[0].y }
  for (const command of commands.slice(1)) {
    const length = Math.hypot(command.x - cursor.x, command.y - cursor.y)
    if (command.edge === 'none' || (length < 1e-6 && command.type === 'L')) {
      current = null
    } else {
      if (!current || current.edge !== command.edge) {
        current = { edge: command.edge, parts: [`M${formatNumber(cursor.x)} ${formatNumber(cursor.y)}`] }
        result[command.edge].push(current)
      }
      current.parts.push(commandToSvg(command))
    }
    cursor = { x: command.x, y: command.y }
  }
  return { cut: result.cut.map((entry) => entry.parts.join(' ')), crease: result.crease.map((entry) => entry.parts.join(' ')) }
}

/** 离散成多边形点列 [[x, y], ...]。 */
export function tessellateContour(contour, arcSteps = 10) {
  const commands = contourToCommands(contour)
  const points = []
  for (const command of commands) {
    if (command.type === 'A') {
      let delta = command.a2 - command.a1
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 2) * arcSteps))
      for (let step = 1; step <= steps; step += 1) {
        const angle = command.a1 + delta * (step / steps)
        points.push([command.cx + Math.cos(angle) * command.r, command.cy + Math.sin(angle) * command.r])
      }
    } else {
      points.push([command.x, command.y])
    }
  }
  // 指令序列末尾会回到起点，多边形不需要闭合重复点
  if (points.length > 1) {
    const [fx, fy] = points[0]
    const [lx, ly] = points[points.length - 1]
    if (Math.hypot(lx - fx, ly - fy) < 1e-6) points.pop()
  }
  return points
}

export function signedArea(points) {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]
    const [x2, y2] = points[(index + 1) % points.length]
    area += x1 * y2 - x2 * y1
  }
  return area / 2
}

export function centroid(points) {
  let x = 0
  let y = 0
  points.forEach(([px, py]) => { x += px; y += py })
  return [x / points.length, y / points.length]
}

/** 多边形斜接外扩（distance > 0 向外）。 */
export function offsetPolygon(points, distance) {
  const count = points.length
  const orientation = signedArea(points) > 0 ? 1 : -1
  const result = []
  for (let index = 0; index < count; index += 1) {
    const prev = points[(index - 1 + count) % count]
    const cur = points[index]
    const next = points[(index + 1) % count]
    const [u1x, u1y] = normalize(cur[0] - prev[0], cur[1] - prev[1])
    const [u2x, u2y] = normalize(next[0] - cur[0], next[1] - cur[1])
    // y 向下坐标系中，正向（顺时针）多边形的外法线是 (−uy, ux)·orientation
    const n1 = [u1y * orientation, -u1x * orientation]
    const n2 = [u2y * orientation, -u2x * orientation]
    const [bx, by] = normalize(n1[0] + n2[0], n1[1] + n2[1])
    const cos = bx * n1[0] + by * n1[1]
    const scale = Math.min(distance / Math.max(cos, 0.35), distance * 3)
    result.push([cur[0] + bx * scale, cur[1] + by * scale])
  }
  return result
}

export function pointsBounds(points, initial = null) {
  const bounds = initial || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const [x, y] of points) {
    if (x < bounds.minX) bounds.minX = x
    if (y < bounds.minY) bounds.minY = y
    if (x > bounds.maxX) bounds.maxX = x
    if (y > bounds.maxY) bounds.maxY = y
  }
  return bounds
}

export function polygonToSvgPath(points) {
  if (!points.length) return ''
  return `${points.map(([x, y], index) => `${index ? 'L' : 'M'}${formatNumber(x)} ${formatNumber(y)}`).join(' ')} Z`
}

/** 以 x = axis 为镜像轴翻转轮廓（用于左右对称部件）。 */
export function mirrorContourX(contour, axis) {
  return contour.map((vertex) => ({ ...vertex, x: axis * 2 - vertex.x }))
}

export function mirrorPointX([x, y], axis) {
  return [axis * 2 - x, y]
}
