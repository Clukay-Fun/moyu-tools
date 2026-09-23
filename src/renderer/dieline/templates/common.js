// 模板公共骨架：参数归一化、结构参数自动值、通用范围校验、尺寸估算。
// 各模板只需提供 build() 与（可选）extraValidate() / sizes()。

export const CORRUGATED_MATERIALS = Object.freeze([
  { id: 'corrugated-e', label: '瓦楞纸 E（三层）', thickness: [1.1, 2] },
  { id: 'corrugated-b', label: '瓦楞纸 B（三层）', thickness: [2.5, 3.2] },
  { id: 'corrugated-c', label: '瓦楞纸 C（三层）', thickness: [3.5, 4.2] },
  { id: 'cardboard', label: '白卡纸', thickness: [0.3, 1] }
])

export const CARTON_MATERIALS = Object.freeze([
  { id: 'cardboard', label: '白卡纸', thickness: [0.3, 1] },
  { id: 'corrugated-e', label: '瓦楞纸 E（三层）', thickness: [1.1, 2] },
  { id: 'corrugated-b', label: '瓦楞纸 B（三层）', thickness: [2.5, 3.2] }
])

export const fmt = (value) => Number(value.toFixed(1)).toString()

/** 自动结构值：有绝对下限时也不能超过它所依附的尺寸，否则小盒子会算出比盒子还大的粘口。 */
export const fitTo = (value, limit) => Math.min(value, limit)

// 长宽高不设行业标准上下限，只挡住画不出几何的值；10 m 是防呆上限，正常盒型碰不到。
const MAX_DIMENSION_MM = 10000
const DIMENSION_LABELS = Object.freeze({ length: '长', width: '宽', height: '高' })

/**
 * 通用参数校验：长宽高只要求正数，厚度/出血与结构参数仍按模板范围。
 * @param {object} template 模板本身（取 ranges / structureParams / resolveStructure）
 * @param {object} params 归一化后的参数
 * @param {Function} [extraValidate] 模板自己的结构冲突校验，签名 (params, structure) => string[]
 * @returns {string[]}
 */
export function validateParams(template, params, extraValidate) {
  const errors = []
  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const value = params[key]
    if (!Number.isFinite(value) || value <= 0) errors.push(`${label}需大于 0`)
    else if (value > MAX_DIMENSION_MM) errors.push(`${label}超过 ${MAX_DIMENSION_MM} mm`)
  }
  for (const [key, label] of [['thickness', '厚度'], ['bleed', '出血']]) {
    const range = template.ranges[key]
    if (!range) continue
    const value = params[key]
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) errors.push(`${label}需在 ${range[0]}–${range[1]} mm`)
  }
  if (errors.length) return errors
  for (const entry of template.structureParams || []) {
    const value = params[entry.key]
    if (value !== null && (!Number.isFinite(value) || value < entry.min || value > entry.max)) {
      errors.push(`${entry.label}需在 ${entry.min}–${entry.max} mm`)
    }
  }
  if (errors.length) return errors
  return extraValidate ? extraValidate.call(template, params, template.resolveStructure(params)) : []
}

/**
 * @param {object} spec 模板描述：id/version/name/category/description/defaults/ranges/materials/structureParams/build/extraValidate/sizes/sizeConversion
 */
export function makeTemplate(spec) {
  const template = {
    sizeConversion: { status: 'estimated' },
    structureParams: [],
    ...spec,

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
        const value = Number.isFinite(manual) ? manual : entry.auto(params)
        return [entry.key, entry.integer ? Math.round(value) : value]
      }))
      return resolved
    },

    validate(params) {
      return validateParams(this, params, spec.extraValidate)
    }
  }
  if (!spec.sizes) {
    template.sizes = function sizes(params) {
      const { length, width, height, thickness: t } = params
      return {
        manufacturing: { length, width, height },
        inner: { length: length - 2 * t, width: width - 2 * t, height: height - 2 * t },
        outer: { length: length + 2 * t, width: width + 2 * t, height: height + 2 * t },
        calibrated: false,
        note: '内/外尺寸按单壁 ±t 估算，待打样校准'
      }
    }
  }
  return Object.freeze(template)
}
