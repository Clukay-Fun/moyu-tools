// PDF 导出：1:1 矢量刀模，路径字符串与 2D 完全同源（pdf-lib drawSvgPath）。
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { PDF_PAGE_LIMIT_MM } from './model.js'
import { LINE_STYLE } from './render2d.js'

const MM = 72 / 25.4
const MARGIN = 15
const FOOTER = 26

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16)
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)
}

function drawArrow(page, x, y, angle, size, color) {
  const point = (offset) => ({ x: x + Math.cos(angle + offset) * size, y: y + Math.sin(angle + offset) * size })
  page.drawLine({ start: { x, y }, end: point(0.4), thickness: 0.4, color })
  page.drawLine({ start: { x, y }, end: point(-0.4), thickness: 0.4, color })
}

/**
 * @param {object} model 已确认的几何快照
 * @param {{ includeAnnotations: boolean }} options
 * @returns {Promise<Uint8Array>}
 */
export async function buildDielinePdf(model, options) {
  const { includeAnnotations = true } = options
  const documentPdf = await PDFDocument.create()
  const { length, width, height } = model.params
  documentPdf.setTitle(`${model.templateId} ${length}x${width}x${height} mm`)
  documentPdf.setSubject('Vector dieline draft - structure proportions not factory calibrated')
  const font = await documentPdf.embedFont(StandardFonts.Helvetica)
  const colors = {
    bleed: hexToRgb(LINE_STYLE.bleed.color),
    cut: hexToRgb(LINE_STYLE.cut.color),
    crease: hexToRgb(LINE_STYLE.crease.color),
    annotation: rgb(0.12, 0.43, 0.9),
    text: rgb(0.25, 0.25, 0.3)
  }

  for (const part of model.parts) {
    const bounds = includeAnnotations ? part.primaryAnnotationBounds : part.bounds
    const widthMm = bounds.maxX - bounds.minX + MARGIN * 2
    const heightMm = bounds.maxY - bounds.minY + MARGIN + FOOTER
    if (widthMm > PDF_PAGE_LIMIT_MM || heightMm > PDF_PAGE_LIMIT_MM) {
      throw new Error(`展开尺寸 ${Math.round(widthMm)}×${Math.round(heightMm)} mm 超过 PDF 单页上限 ${PDF_PAGE_LIMIT_MM} mm`)
    }
    const page = documentPdf.addPage([widthMm * MM, heightMm * MM])
    const pageHeight = heightMm * MM
    const originX = MARGIN * MM - bounds.minX * MM
    const originY = pageHeight - MARGIN * MM + bounds.minY * MM
    const toX = (x) => originX + x * MM
    const toY = (y) => originY - y * MM

    for (const [layer, thickness] of [['bleed', 0.25], ['cut', 0.35], ['crease', 0.35]]) {
      for (const path of part.layers[layer]) {
        page.drawSvgPath(path, {
          x: originX,
          y: originY,
          scale: MM,
          borderColor: colors[layer],
          borderWidth: thickness,
          borderDashArray: layer === 'crease' ? [3, 2] : undefined
        })
      }
    }

    if (includeAnnotations) {
      for (const annotation of model.annotations.filter((entry) => !entry.secondary && entry.part === part.id)) {
        for (const line of annotation.witness || []) {
          page.drawLine({
            start: { x: toX(line.x1), y: toY(line.y1) },
            end: { x: toX(line.x2), y: toY(line.y2) },
            thickness: 0.2,
            color: colors.annotation,
            dashArray: [2, 2]
          })
        }
        const start = { x: toX(annotation.x1), y: toY(annotation.y1) }
        const end = { x: toX(annotation.x2), y: toY(annotation.y2) }
        page.drawLine({ start, end, thickness: 0.4, color: colors.annotation })
        const angle = Math.atan2(end.y - start.y, end.x - start.x)
        drawArrow(page, start.x, start.y, angle, 6, colors.annotation)
        drawArrow(page, end.x, end.y, angle + Math.PI, 6, colors.annotation)
        const vertical = Math.abs(annotation.x2 - annotation.x1) < Math.abs(annotation.y2 - annotation.y1)
        // Helvetica 只有 WinAnsi 字集，标注优先用 pdfLabel，否则剔除非 ASCII 字符
        const label = annotation.pdfLabel || annotation.label.replace(/[^\x20-\x7e]/g, '').trim()
        const textWidth = font.widthOfTextAtSize(label, 9)
        page.drawText(label, {
          x: vertical ? (start.x + end.x) / 2 + 4 : (start.x + end.x) / 2 - textWidth / 2,
          y: vertical ? (start.y + end.y) / 2 - 3 : (start.y + end.y) / 2 + 3,
          size: 9,
          font,
          color: colors.annotation
        })
      }
    }

    const sizes = model.sizes
    const fmt = (size) => `${size.length} x ${size.width} x ${size.height} mm`
    const lines = [
      `${model.templateId}  part: ${part.id} x${part.count}  template ${model.templateVersion}`,
      `Manufacturing ${fmt(sizes.manufacturing)}   Inner ${fmt(sizes.inner)}   Outer ${fmt(sizes.outer)}${sizes.calibrated ? '' : ' (inner/outer estimated, not calibrated)'}`,
      `Board ${model.params.material}  thickness ${model.params.thickness} mm  bleed ${model.params.bleed} mm   Scale 1:1 - print at 100%.  ENGINEERING DRAFT`
    ]
    lines.forEach((line, index) => {
      page.drawText(line, { x: MARGIN * MM, y: (FOOTER - 6 - index * 4.2) * MM, size: 7, font, color: colors.text })
    })
    const calX = MARGIN * MM
    const calY = 5 * MM
    page.drawLine({ start: { x: calX, y: calY }, end: { x: calX + 100 * MM, y: calY }, thickness: 0.6, color: colors.text })
    page.drawLine({ start: { x: calX, y: calY - 4 }, end: { x: calX, y: calY + 4 }, thickness: 0.6, color: colors.text })
    page.drawLine({ start: { x: calX + 100 * MM, y: calY - 4 }, end: { x: calX + 100 * MM, y: calY + 4 }, thickness: 0.6, color: colors.text })
    page.drawText('100 mm calibration', { x: calX + 102 * MM, y: calY - 2, size: 6, font, color: colors.text })
  }
  return documentPdf.save()
}
