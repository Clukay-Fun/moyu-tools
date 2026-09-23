// 2D 刀模 SVG 渲染：只消费 model.parts[].layers 与 annotations。
export const LINE_STYLE = Object.freeze({
  bleed: { color: '#3fb950', dash: '' },
  cut: { color: '#2036c9', dash: '' },
  crease: { color: '#e5312b', dash: '2.4 1.6' }
})
export const PAPER_COLORS = Object.freeze({
  'corrugated-e': '#f3ede2',
  'corrugated-b': '#efe4cf',
  cardboard: '#fbfbfb'
})

const SVG_NS = 'http://www.w3.org/2000/svg'

function el(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

function layerGroup(name, style, strokeWidth) {
  return el('g', {
    'data-layer': name,
    fill: 'none',
    stroke: style.color,
    'stroke-width': strokeWidth,
    'stroke-dasharray': style.dash,
    'vector-effect': 'non-scaling-stroke',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  })
}

function arrowLine(group, { x1, y1, x2, y2 }, size) {
  group.append(el('line', { x1, y1, x2, y2 }))
  const angle = Math.atan2(y2 - y1, x2 - x1)
  for (const [x, y, sign] of [[x1, y1, 1], [x2, y2, -1]]) {
    const head = el('path', {
      d: `M${x} ${y} L${x + sign * Math.cos(angle - 0.4) * size} ${y + sign * Math.sin(angle - 0.4) * size} L${x + sign * Math.cos(angle + 0.4) * size} ${y + sign * Math.sin(angle + 0.4) * size} Z`,
      fill: 'currentColor',
      stroke: 'none'
    })
    group.append(head)
  }
}

/**
 * @param {SVGSVGElement} svg
 * @param {object} model
 * @param {{ view: { centerX, centerY, baseWidth, baseHeight, zoom }, paper: string, focusParam: string|null, showAnnotations: boolean }} options
 */
export function renderModel2d(svg, model, options) {
  const { view, paper, focusParam, showAnnotations = true } = options
  const { minX, minY, maxX, maxY } = model.bounds
  const extent = Math.max(maxX - minX, maxY - minY)
  const viewWidth = view.baseWidth / view.zoom
  const viewHeight = view.baseHeight / view.zoom
  svg.replaceChildren()
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('viewBox', `${view.centerX - viewWidth / 2} ${view.centerY - viewHeight / 2} ${viewWidth} ${viewHeight}`)

  const content = el('g')
  svg.append(content)

  const partOffset = Object.fromEntries(model.parts.map((part) => [part.id, part.layout]))
  for (const part of model.parts) {
    const partGroup = el('g', { 'data-part': part.id, transform: `translate(${part.layout.x} ${part.layout.y})` })
    const paperGroup = el('g', { 'data-layer': 'paper', fill: paper, stroke: 'none' })
    for (const path of part.layers.paper) paperGroup.append(el('path', { d: path }))
    partGroup.append(paperGroup)
    for (const name of ['bleed', 'cut', 'crease']) {
      const group = layerGroup(name, LINE_STYLE[name], name === 'bleed' ? 1 : 1.2)
      for (const path of part.layers[name]) group.append(el('path', { d: path }))
      partGroup.append(group)
    }
    if (model.parts.length > 1) {
      const label = el('text', {
        x: (part.bounds.minX + part.bounds.maxX) / 2,
        y: part.bounds.minY - Math.max(extent / 60, 5),
        'font-size': Math.max(extent / 55, 6),
        'font-family': 'system-ui, sans-serif',
        'font-weight': 700,
        fill: '#555c74',
        'text-anchor': 'middle'
      })
      label.textContent = `${part.name} ×${part.count}`
      partGroup.append(label)
    }
    content.append(partGroup)
  }

  if (showAnnotations) {
    const fontSize = Math.max(extent / 48, 6)
    const group = el('g', { 'data-layer': 'annotation', color: '#1f6fe5', stroke: '#1f6fe5', 'stroke-width': 0.9, 'vector-effect': 'non-scaling-stroke', fill: 'none' })
    for (const annotation of model.annotations) {
      const classes = ['dieline-annotation']
      if (annotation.secondary) classes.push('secondary')
      if (annotation.param === focusParam) classes.push('focus')
      const offset = partOffset[annotation.part] || { x: 0, y: 0 }
      const item = el('g', { 'data-param': annotation.param, class: classes.join(' '), transform: `translate(${offset.x} ${offset.y})` })
      for (const line of annotation.witness || []) {
        item.append(el('line', { ...line, 'stroke-width': 0.5, 'stroke-dasharray': '2 2', opacity: 0.55 }))
      }
      arrowLine(item, annotation, fontSize * 0.55)
      const midX = (annotation.x1 + annotation.x2) / 2
      const midY = (annotation.y1 + annotation.y2) / 2
      const vertical = Math.abs(annotation.x2 - annotation.x1) < Math.abs(annotation.y2 - annotation.y1)
      const text = el('text', {
        x: vertical ? midX + fontSize * 0.5 : midX,
        y: vertical ? midY : midY - fontSize * 0.7,
        'font-size': annotation.secondary ? fontSize * 0.75 : fontSize,
        'font-family': 'system-ui, sans-serif',
        'font-weight': 600,
        fill: 'currentColor',
        stroke: 'none',
        'text-anchor': vertical ? 'start' : 'middle',
        'dominant-baseline': vertical ? 'middle' : 'auto'
      })
      text.textContent = annotation.label
      item.append(text)
      group.append(item)
    }
    content.append(group)
  }
}
