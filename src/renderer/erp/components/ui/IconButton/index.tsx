/**
 * 描述: 图标按钮组件 (IconButton)
 * 主要功能:
 *   - 提供 sm (28px) 与 md (32px) 正方形图标按钮
 *   - 强制要求 label 属性，自动兼作 aria-label 与悬停 Tooltip
 *   - 支持禁用原因 (disabledReason) 与加载态 (loading)
 */

import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode, type MouseEvent } from 'react'
import { Tooltip } from '../Tooltip'
import styles from './IconButton.module.css'

export type IconButtonVariant = 'ghost' | 'secondary' | 'danger'
export type IconButtonSize = 'sm' | 'md'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 按钮功能说明文案，用于无障碍无障碍描述及默认悬停 Tooltip */
  label: string
  /** 按钮内嵌图标元素 */
  icon: ReactNode
  /** 样式变体，默认为 ghost */
  variant?: IconButtonVariant
  /** 尺寸规格，默认为 md */
  size?: IconButtonSize
  /** 是否处于加载中 */
  loading?: boolean
  /** 禁用原因说明；若传入则悬停提示该文案并阻止点击 */
  disabledReason?: ReactNode
  /** Tooltip 弹出方位，默认 top */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
}

// #region IconButton 核心组件

/**
 * 用处: 渲染紧凑的方形图标按钮
 * 参数:
 *   - label: 必须传入的按钮文字说明
 *   - icon: 图标节点
 *   - variant: 样式变体
 *   - size: 尺寸大小
 * 功能:
 *   - 保证无障碍标准，自动注入 aria-label
 *   - 默认通过 Tooltip 展现说明文字
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    loading = false,
    disabledReason,
    tooltipSide = 'top',
    disabled = false,
    className = '',
    onClick,
    ...rest
  },
  ref
) {
  const isDisabled = Boolean(disabled || disabledReason || loading)

  const variantClass = variant === 'secondary' ? styles.secondary : variant === 'danger' ? styles.danger : styles.ghost

  const sizeClass = size === 'sm' ? styles.sm : styles.md

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (isDisabled) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    onClick?.(e)
  }

  const buttonElement = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={`${styles.iconButton} ${variantClass} ${sizeClass} ${className}`}
      disabled={disabled || loading}
      aria-disabled={isDisabled}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
    </button>
  )

  const tooltipText = disabledReason || label

  return (
    <Tooltip content={tooltipText} side={tooltipSide}>
      <span
        style={{
          display: 'inline-flex',
          cursor: isDisabled ? 'not-allowed' : undefined
        }}
      >
        {buttonElement}
      </span>
    </Tooltip>
  )
})

IconButton.displayName = 'IconButton'

// #endregion
