// 刀模 SVG：与 2D / PDF 同源的路径，按图层分组（BLEED / CUT / CREASE），单位 mm，供 Illustrator 另存为 .ai。
import { LINE_STYLE } from './render2d.js'

const escapeXml = (text) => String(text).replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char]))

/**
 * @param {object} model 已确认的几何快照
 * @param {{ includeAnnotations?: boolean }} options
 */
export function buildDielineSvg(model, options = {}) {
  const { includeAnnotations = false } = options
  const { minX, minY, maxX, maxY } = model.bounds
  const margin = 10
  const width = maxX - minX + margin * 2
  const height = maxY - minY + margin * 2
  const rows = ['<?xml version="1.0" encoding="UTF-8"?>']
  rows.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="${minX - margin} ${minY - margin} ${width} ${height}">`)
  rows.push(`<title>${escapeXml(model.templateId)} ${model.params.length}x${model.params.width}x${model.params.height} mm</title>`)
  rows.push('<desc>Engineering draft dieline - layers BLEED / CUT / CREASE, units mm, scale 1:1</desc>')
  for (const part of model.parts) {
    rows.push(`<g id="${escapeXml(part.id)}" transform="translate(${part.layout.x} ${part.layout.y})">`)
    for (const [layer, strokeWidth, dash] of [['bleed', 0.2, ''], ['cut', 0.25, ''], ['crease', 0.25, '3 2']]) {
      rows.push(`<g id="${layer.toUpperCase()}_${escapeXml(part.id)}" fill="none" stroke="${LINE_STYLE[layer].color}" stroke-width="${strokeWidth}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round" stroke-linejoin="round">`)
      for (const path of part.layers[layer]) rows.push(`<path d="${path}"/>`)
      rows.push('</g>')
    }
    rows.push('</g>')
  }
  if (includeAnnotations) {
    rows.push('<g id="ANNOTATION" fill="none" stroke="#1f6fe5" stroke-width="0.2">')
    const offsets = Object.fromEntries(model.parts.map((part) => [part.id, part.layout]))
    for (const annotation of model.annotations.filter((entry) => !entry.secondary)) {
      const offset = offsets[annotation.part] || { x: 0, y: 0 }
      for (const line of annotation.witness || []) {
        rows.push(`<line x1="${line.x1 + offset.x}" y1="${line.y1 + offset.y}" x2="${line.x2 + offset.x}" y2="${line.y2 + offset.y}" stroke-width="0.12" stroke-dasharray="2 2" opacity="0.55"/>`)
      }
      rows.push(`<line x1="${annotation.x1 + offset.x}" y1="${annotation.y1 + offset.y}" x2="${annotation.x2 + offset.x}" y2="${annotation.y2 + offset.y}"/>`)
      const midX = (annotation.x1 + annotation.x2) / 2 + offset.x
      const midY = (annotation.y1 + annotation.y2) / 2 + offset.y
      const vertical = Math.abs(annotation.x2 - annotation.x1) < Math.abs(annotation.y2 - annotation.y1)
      rows.push(`<text x="${vertical ? midX + 3 : midX}" y="${vertical ? midY : midY - 3}" font-family="Arial, sans-serif" font-size="5" fill="#1f6fe5" stroke="none" text-anchor="${vertical ? 'start' : 'middle'}">${escapeXml(annotation.pdfLabel || annotation.label)}</text>`)
    }
    rows.push('</g>')
  }
  rows.push('</svg>')
  return rows.join('\n')
}
