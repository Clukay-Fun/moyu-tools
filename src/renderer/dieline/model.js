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

/**
 * @returns {{ ok: true, model } | { ok: false, errors: string[] }}
 */
export function buildModel(template, rawParams) {
  const params = template.normalizeParams(rawParams)
  const errors = template.validate(params)
  if (errors.length) return { ok: false, errors }
  const built = template.build(params)
  const parts = built.parts.map((part) => buildPart(part, params.bleed))
  // 多部件在 2D / 3D 里从左到右平铺；PDF 每个部件独立一页，用各自坐标
  const gap = 40
  let cursor = 0
  const overall = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const part of parts) {
    part.layout = { x: cursor - part.bounds.minX, y: 0 }
    cursor += part.bounds.maxX - part.bounds.minX + gap
    overall.minX = Math.min(overall.minX, part.bounds.minX + part.layout.x)
    overall.maxX = Math.max(overall.maxX, part.bounds.maxX + part.layout.x)
    overall.minY = Math.min(overall.minY, part.bounds.minY)
    overall.maxY = Math.max(overall.maxY, part.bounds.maxY)
  }
  const model = {
    templateId: template.id,
    templateVersion: template.version,
    params,
    parts,
    bounds: overall,
    sizes: template.sizes(params),
    annotations: built.annotations.map((annotation) => ({ part: parts[0].id, ...annotation })),
    foldSteps: Math.max(0, ...parts.flatMap((part) => part.panels.map((panel) => panel.order || 0)))
  }
  return { ok: true, model }
}
