// 十字隔档：长向隔板（底部开半槽）与宽向隔板（顶部开半槽）互插成网格。
// 两个部件各为单片平板，数量 = 格数 − 1；3D 装配按网格位置立起并互插。

import { validateParams } from './common.js'

function dividerContour(length, height, slotPositions, slotWidth, fromTop) {
  const depth = height / 2
  const half = slotWidth / 2
  const contour = []
  if (fromTop) {
    contour.push({ x: 0, y: 0, edge: 'cut' })
    for (const x of slotPositions) {
      contour.push({ x: x - half, y: 0, edge: 'cut' }, { x: x - half, y: depth, edge: 'cut' }, { x: x + half, y: depth, edge: 'cut' }, { x: x + half, y: 0, edge: 'cut' })
    }
    contour.push({ x: length, y: 0, edge: 'cut' }, { x: length, y: height, edge: 'cut' }, { x: 0, y: height, edge: 'cut' })
  } else {
    contour.push({ x: 0, y: 0, edge: 'cut' }, { x: length, y: 0, edge: 'cut' }, { x: length, y: height, edge: 'cut' })
    for (const x of [...slotPositions].reverse()) {
      contour.push({ x: x + half, y: height, edge: 'cut' }, { x: x + half, y: height - depth, edge: 'cut' }, { x: x - half, y: height - depth, edge: 'cut' }, { x: x - half, y: height, edge: 'cut' })
    }
    contour.push({ x: 0, y: height, edge: 'cut' })
  }
  return contour
}

export const dividerTemplate = Object.freeze({
  id: 'cross-divider',
  version: '0.1.0-draft',
  name: '十字隔档',
  category: '内衬隔档',
  description: '互插隔板网格，配件分区、部件定位与隔离',
  defaults: { length: 400, width: 300, height: 80, thickness: 3, bleed: 0, material: 'corrugated-b' },
  ranges: {
    length: [40, 2000],
    width: [40, 2000],
    height: [15, 600],
    thickness: [0.5, 8],
    bleed: [0, 10]
  },
  materials: [
    { id: 'corrugated-e', label: '瓦楞纸 E（三层）', thickness: [1.1, 2] },
    { id: 'corrugated-b', label: '瓦楞纸 B（三层）', thickness: [2.5, 3.2] },
    { id: 'corrugated-c', label: '瓦楞纸 C（三层）', thickness: [3.5, 4.2] },
    { id: 'cardboard', label: '白卡纸', thickness: [0.5, 1] }
  ],
  sizeConversion: { status: 'exact' },
  structureParams: [
    { key: 'columns', label: '长向格数', min: 2, max: 20, step: 1, auto: () => 3 },
    { key: 'rows', label: '宽向格数', min: 2, max: 20, step: 1, auto: () => 2 },
    { key: 'slotClearance', label: '槽口余量', min: 0, max: 3, step: 0.1, auto: (p) => Math.min(1, Math.max(0.2, p.thickness * 0.15)) }
  ],

  normalizeParams(raw) {
    const number = (value, fallback) => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : fallback)
    return {
      length: number(raw.length, NaN),
      width: number(raw.width, NaN),
      height: number(raw.height, NaN),
      thickness: number(raw.thickness, this.defaults.thickness),
      bleed: number(raw.bleed, this.defaults.bleed),
      material: this.materials.some((entry) => entry.id === raw.material) ? raw.material : this.defaults.material,
      ...Object.fromEntries(this.structureParams.map((entry) => [entry.key, number(raw[entry.key], null)]))
    }
  },

  resolveStructure(params) {
    const resolved = Object.fromEntries(this.structureParams.map((entry) => {
      const manual = params[entry.key]
      return [entry.key, Number.isFinite(manual) ? manual : entry.auto(params)]
    }))
    resolved.columns = Math.round(resolved.columns)
    resolved.rows = Math.round(resolved.rows)
    return resolved
  },

  validate(params) {
    return validateParams(this, params, (checked, structure) => {
      const errors = []
      const { columns, rows, slotClearance } = structure
      const slot = params.thickness + slotClearance
      if (params.length / columns <= slot * 2) errors.push('长向格数过多，格宽小于两倍槽宽')
      if (params.width / rows <= slot * 2) errors.push('宽向格数过多，格宽小于两倍槽宽')
      return errors
    })
  },

  sizes(params) {
    const { length, width, height, thickness: t } = params
    const { columns, rows } = this.resolveStructure(params)
    return {
      manufacturing: { length, width, height },
      inner: { length: Number((length / columns - t).toFixed(1)), width: Number((width / rows - t).toFixed(1)), height },
      outer: { length, width, height },
      calibrated: true,
      note: '内尺寸为单格净空（已扣除一片隔板厚度）'
    }
  },

  build(params) {
    const { length: L, width: W, height: H, thickness: t } = params
    const { columns, rows, slotClearance } = this.resolveStructure(params)
    const slotWidth = t + slotClearance
    const columnPositions = Array.from({ length: columns - 1 }, (_, index) => (L / columns) * (index + 1))
    const rowPositions = Array.from({ length: rows - 1 }, (_, index) => (W / rows) * (index + 1))
    const fmt = (value) => Number(value.toFixed(1)).toString()

    const longPanel = {
      id: 'longDivider', name: '长向隔板', parent: null, hinge: null, order: 0, angle: 0, holes: [],
      contour: dividerContour(L, H, columnPositions, slotWidth, false)
    }
    const shortPanel = {
      id: 'shortDivider', name: '宽向隔板', parent: null, hinge: null, order: 0, angle: 0, holes: [],
      contour: dividerContour(W, H, rowPositions, slotWidth, true)
    }
    // 装配姿态：网格原点对齐第一片长向隔板的平铺位置，让它原地立起；其余长向隔板沿地面平移，
    // 宽向隔板绕 z 转 90° 后抬起、移到网格位置落下互插
    const gridY = H / 2 - rowPositions[0]
    const longPoses = rowPositions.map((y) => ({ x: L / 2, y: gridY + y, z: H / 2, rotX: 90, rotZ: 0, motion: 'ground' }))
    const shortPoses = columnPositions.map((x) => ({ x, y: gridY + W / 2, z: H / 2, rotX: 90, rotZ: 90, motion: 'lift' }))

    const annotations = [
      { part: 'long', param: 'length', label: `L ${fmt(L)} mm`, x1: 0, y1: H + 12, x2: L, y2: H + 12 },
      { part: 'long', param: 'height', label: `H ${fmt(H)} mm`, x1: L + 12, y1: 0, x2: L + 12, y2: H },
      { part: 'short', param: 'width', label: `W ${fmt(W)} mm`, x1: 0, y1: H + 12, x2: W, y2: H + 12 },
      { part: 'long', param: 'slotClearance', label: `槽 ${fmt(slotWidth)}`, x1: columnPositions[0] - slotWidth / 2, y1: H / 2 - 6, x2: columnPositions[0] + slotWidth / 2, y2: H / 2 - 6, secondary: true },
      { part: 'long', param: 'columns', label: `格 ${fmt(L / columns)}`, x1: 0, y1: -8, x2: L / columns, y2: -8, secondary: true },
      { part: 'short', param: 'rows', label: `格 ${fmt(W / rows)}`, x1: 0, y1: -8, x2: W / rows, y2: -8, secondary: true }
    ]
    return {
      parts: [
        {
          id: 'long', name: '长向隔板', count: rows - 1, panels: [longPanel], anchor: [L / 2, H / 2],
          assemble: { over: 'long', mode: 'pose', poses: longPoses }
        },
        {
          id: 'short', name: '宽向隔板', count: columns - 1, panels: [shortPanel], anchor: [W / 2, H / 2],
          assemble: { over: 'long', mode: 'pose', poses: shortPoses }
        }
      ],
      annotations
    }
  }
})
