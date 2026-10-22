/**
 * 描述: 标准按钮组件 (Button)
 * 主要功能:
 *   - 提供 primary、secondary、ghost、danger 四种变体
 *   - 提供 sm (28px)、md (32px) 两种尺寸
 *   - 支持加载中 (loading) 与禁用原因 (disabledReason) 浮层提示
 */

import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode, type MouseEvent } from 'react'
import { Tooltip } from '../Tooltip'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 按钮形态变体，默认为 secondary */
  variant?: ButtonVariant
  /** 尺寸大小，默认为 md */
  size?: ButtonSize
  /** 是否处于加载状态 */
  loading?: boolean
  /** 禁用原因说明；若传入则悬停显示 Tooltip 并阻止操作 */
  disabledReason?: ReactNode
  /** 前置图标 */
  icon?: ReactNode
  /** 后置图标 */
  iconRight?: ReactNode
  /** 是否撑满容器宽度 */
  fullWidth?: boolean
}

// #region Button 核心组件

/**
 * 用处: 渲染系统统一交互按钮
 * 参数:
 *   - variant: 样式变体
 *   - size: 尺寸规格
 *   - loading: 加载指示
 *   - disabledReason: 禁用提示文案
 *   - icon / iconRight: 前后置图标
 * 功能:
 *   - 提供无障碍键盘焦点与点击交互
 *   - 自动集成 disabledReason 浮层
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabledReason,
    icon,
    iconRight,
    fullWidth = false,
    disabled = false,
    children,
    className = '',
    style,
    onClick,
    ...rest
  },
  ref
) {
  const isDisabled = Boolean(disabled || disabledReason || loading)

  const variantClass =
    variant === 'primary'
      ? styles.primary
      : variant === 'ghost'
        ? styles.ghost
        : variant === 'danger'
          ? styles.danger
          : variant === 'danger-solid'
            ? styles.dangerSolid
            : styles.secondary

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
      className={`${styles.button} ${variantClass} ${sizeClass} ${className}`}
      style={{
        width: fullWidth ? '100%' : undefined,
        ...style
      }}
      disabled={disabled || loading}
      aria-disabled={isDisabled}
      onClick={handleClick}
      {...rest}
    >
      {loading ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : (
        icon && <span style={{ display: 'inline-flex' }}>{icon}</span>
      )}
      {children && <span>{children}</span>}
      {!loading && iconRight && <span style={{ display: 'inline-flex' }}>{iconRight}</span>}
    </button>
  )

  if (disabledReason) {
    return (
      <Tooltip content={disabledReason} side="top">
        <span
          style={{
            display: fullWidth ? 'flex' : 'inline-flex',
            cursor: 'not-allowed',
            width: fullWidth ? '100%' : undefined
          }}
        >
          {buttonElement}
        </span>
      </Tooltip>
    )
  }

  return buttonElement
})

Button.displayName = 'Button'

// #endregion
