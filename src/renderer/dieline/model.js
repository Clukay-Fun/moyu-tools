// 结构模型：参数 → 面板轮廓 / 折叠关系 → 2D 图层、包围盒、出血轮廓。
// 2D、3D、PDF 都只消费这里的输出，不各自计算几何。
import polygonClipping from 'polygon-clipping'
import {
  contourEdgePaths, contourToSvgPath, offsetPolygon, pointsBounds, polygonToSvgPath, tessellateContour
} from './geometry.js'

export const PDF_PAGE_LIMIT_MM = 5080 // PDF 单页 14400 pt 上限

function buildBleed(panels, distance) {
  if (!(distance > 0)) return []
  const polygons = panels.map((panel) => [offsetPolygon(tessellateContour(panel.contour), distance)])
  try {
    const union = polygonClipping.union(...polygons)
    return union.map((polygon) => polygonToSvgPath(polygon[0]))
  } catch {
    return polygons.map((polygon) => polygonToSvgPath(polygon[0]))
  }
}

function buildPart(part, bleed) {
  const layers = { cut: [], crease: [], bleed: [], paper: [] }
  let bounds = null
  for (const panel of part.panels) {
    const edges = contourEdgePaths(panel.contour)
    layers.cut.push(...edges.cut)
    layers.crease.push(...edges.crease)
    layers.paper.push(contourToSvgPath(panel.contour))
    bounds = pointsBounds(tessellateContour(panel.contour), bounds)
    for (const hole of panel.holes || []) {
      layers.cut.push(contourToSvgPath(hole))
    }
  }
  layers.bleed = buildBleed(part.panels, bleed)
  const paperBounds = { ...bounds }
  if (bleed > 0) {
    bounds = { minX: bounds.minX - bleed, minY: bounds.minY - bleed, maxX: bounds.maxX + bleed, maxY: bounds.maxY + bleed }
  }
  return { ...part, layers, bounds, paperBounds }
}

// 标注排布：把尺寸线移到图纸外侧的车道上，避免压在刀线上或串到相邻部件。
// 横向标注排在部件下方，纵向标注排在部件右侧；跨度重叠的自动换到下一条车道，并补引出线。
function placeAnnotations(part, annotations) {
  const bounds = part.bounds
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  const step = Math.max(extent * 0.055, 10)
  const margin = Math.max(extent * 0.045, 8)
  const lanes = { horizontal: [], vertical: [] }
  const placed = []

  for (const annotation of annotations) {
    const horizontal = Math.abs(annotation.x2 - annotation.x1) >= Math.abs(annotation.y2 - annotation.y1)
    const axis = horizontal ? 'horizontal' : 'vertical'
    const from = horizontal ? Math.min(annotation.x1, annotation.x2) : Math.min(annotation.y1, annotation.y2)
    const to = horizontal ? Math.max(annotation.x1, annotation.x2) : Math.max(annotation.y1, annotation.y2)
    const pad = step * 0.6
    let lane = lanes[axis].findIndex((end) => from > end + pad)
    if (lane === -1) {
      lane = lanes[axis].length
      lanes[axis].push(to)
    } else {
      lanes[axis][lane] = to
    }
    const offset = (horizontal ? bounds.maxY + margin : bounds.maxX + margin) + lane * step
    const line = horizontal
      ? { x1: annotation.x1, y1: offset, x2: annotation.x2, y2: offset }
      : { x1: offset, y1: annotation.y1, x2: offset, y2: annotation.y2 }
    // 引出线：从被测位置拉到尺寸线，短于半个车道间距就不画
    const witness = []
    for (const [ox, oy, nx, ny] of [[annotation.x1, annotation.y1, line.x1, line.y1], [annotation.x2, annotation.y2, line.x2, line.y2]]) {
      if (Math.hypot(nx - ox, ny - oy) > step * 0.3) witness.push({ x1: ox, y1: oy, x2: nx, y2: ny })
    }
    placed.push({ ...annotation, ...line, witness })
  }
  return placed
}

function annotationBounds(bounds, annotations) {
  const result = { ...bounds }
  for (const annotation of annotations) {
    result.minX = Math.min(result.minX, annotation.x1, annotation.x2)
    result.maxX = Math.max(result.maxX, annotation.x1, annotation.x2)
    result.minY = Math.min(result.minY, annotation.y1, annotation.y2)
    result.maxY = Math.max(result.maxY, annotation.y1, annotation.y2)
  }
  const extent = Math.max(result.maxX - result.minX, result.maxY - result.minY)
  const pad = Math.max(extent * 0.03, 6)
  return { minX: result.minX - pad, minY: result.minY - pad, maxX: result.maxX + pad, maxY: result.maxY + pad }
}

/**
 * @returns {{ ok: true, model } | { ok: false, errors: string[] }}
 */
export function buildModel(template, rawParams) {
  const params = template.normalizeParams(rawParams)
  const errors = template.validate(params)
  if (errors.length) return { ok: false, errors }
  const built = template.build(params)
  const parts = built.parts.map((part) => buildPart(part, params.bleed))
  const defaultPart = parts[0].id
  const annotations = []
  for (const part of parts) {
    const own = built.annotations.filter((annotation) => (annotation.part || defaultPart) === part.id)
    const placed = placeAnnotations(part, own).map((annotation) => ({ ...annotation, part: part.id }))
    part.annotationBounds = annotationBounds(part.bounds, placed)
    part.primaryAnnotationBounds = annotationBounds(part.bounds, placed.filter((annotation) => !annotation.secondary))
    annotations.push(...placed)
  }
  // 多部件在 2D / 3D 里从左到右平铺，间距按标注占位计算；PDF 每个部件独立一页，用各自坐标
  const gap = Math.max(40, ...parts.map((part) => (part.annotationBounds.maxX - part.bounds.maxX) * 1.2))
  let cursor = 0
  const overall = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const part of parts) {
    part.layout = { x: cursor - part.annotationBounds.minX, y: 0 }
    cursor += part.annotationBounds.maxX - part.annotationBounds.minX + gap
    overall.minX = Math.min(overall.minX, part.annotationBounds.minX + part.layout.x)
    overall.maxX = Math.max(overall.maxX, part.annotationBounds.maxX + part.layout.x)
    overall.minY = Math.min(overall.minY, part.annotationBounds.minY)
    overall.maxY = Math.max(overall.maxY, part.annotationBounds.maxY)
  }
  const model = {
    templateId: template.id,
    templateVersion: template.version,
    params,
    parts,
    bounds: overall,
    sizes: template.sizes(params),
    annotations,
    foldSteps: Math.max(0, ...parts.flatMap((part) => part.panels.map((panel) => panel.order || 0)))
  }
  return { ok: true, model }
}
