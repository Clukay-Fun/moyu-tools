/**
 * 描述: 数字专用输入框组件 (NumberInput)
 * 主要功能:
 *   - 等宽数字、强制靠右对齐展示
 *   - 支持货币符号前缀 (¥) 与单位后缀 (件、个等)
 *   - 支持键盘上下方向键 (↑/↓) 微调步长，严格受控
 *   - 继承错误提示与只读/禁用视觉规范
 */

import React, { forwardRef, useState, useEffect, type KeyboardEvent, type ChangeEvent, type ReactNode } from 'react'
import styles from './NumberInput.module.css'

export interface NumberInputProps {
  /** 当前数值 */
  value?: number | null
  /** 数值变动回调 */
  onChange?: (val: number | null) => void
  /** 允许的最小值 */
  min?: number
  /** 允许的最大值 */
  max?: number
  /** 上下键微调步长，默认为 1 */
  step?: number
  /** 小数保留位数，默认无限制 */
  precision?: number
  /** 前置图元或符号，例如 "¥" */
  prefix?: ReactNode
  /** 后置图元或单位，例如 "件" */
  suffix?: ReactNode
  /** 占位提示文案 */
  placeholder?: string
  /** 错误文案 */
  error?: string
  /** 是否只读 */
  readOnly?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 附加样式类名 */
  className?: string
  /** 自动聚焦 */
  autoFocus?: boolean
  /** 键盘按下事件 */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** 失焦事件 */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void
  /** 元素 ID */
  id?: string
}

// #region NumberInput 组件实现

/**
 * 用处: 专用于库存、成本、单价、数量等金融与计数量录入
 * 参数:
 *   - value / onChange: 受控数值流
 *   - min / max / step: 边界与步进限制
 *   - prefix / suffix: 符号与量词
 * 功能:
 *   - 限制非法非数字输入
 *   - 监听方向键增减并限制步进与极值
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    value,
    onChange,
    min,
    max,
    step = 1,
    precision,
    prefix,
    suffix,
    placeholder,
    error,
    readOnly = false,
    disabled = false,
    className = '',
    autoFocus,
    onKeyDown,
    onBlur,
    id
  },
  ref
) {
  const [textValue, setTextValue] = useState<string>(value !== undefined && value !== null ? String(value) : '')

  useEffect(() => {
    setTextValue(value !== undefined && value !== null ? String(value) : '')
  }, [value])

  const clampValue = (val: number): number => {
    let result = val
    if (min !== undefined && result < min) result = min
    if (max !== undefined && result > max) result = max
    if (precision !== undefined) {
      result = Number(result.toFixed(precision))
    }
    return result
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value.trim()
    setTextValue(raw)

    if (raw === '' || raw === '-') {
      onChange?.(null)
      return
    }

    const parsed = Number(raw)
    if (!Number.isNaN(parsed)) {
      onChange?.(parsed)
    }
  }

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>): void => {
    onBlur?.(e)
    if (textValue === '' || textValue === '-') {
      onChange?.(null)
      return
    }
    const parsed = Number(textValue)
    if (!Number.isNaN(parsed)) {
      const clamped = clampValue(parsed)
      setTextValue(String(clamped))
      onChange?.(clamped)
    } else {
      setTextValue(value !== undefined && value !== null ? String(value) : '')
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    onKeyDown?.(e)
    if (readOnly || disabled) return

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const current = value ?? 0
      const delta = e.key === 'ArrowUp' ? step : -step
      const updated = clampValue(current + delta)
      setTextValue(String(updated))
      onChange?.(updated)
    }
  }

  const containerClasses = [
    styles.root,
    error ? styles.hasError : '',
    readOnly ? styles.readOnly : '',
    disabled ? styles.disabled : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={styles.wrapper}>
      <div className={containerClasses}>
        {prefix && <span className={styles.prefix}>{prefix}</span>}
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="decimal"
          className={styles.input}
          value={textValue}
          placeholder={placeholder}
          readOnly={readOnly}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={handleInputChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          aria-invalid={Boolean(error)}
        />
        {suffix && <span className={styles.suffix}>{suffix}</span>}
      </div>
      {error && <span className={styles.errorMessage}>{error}</span>}
    </div>
  )
})

NumberInput.displayName = 'NumberInput'

// #endregion
