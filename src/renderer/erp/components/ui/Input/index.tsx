/**
 * 描述: 单行文本框与多行文本域组件 (Input / Textarea)
 * 主要功能:
 *   - 提供统一 32px 紧凑输入框及自适应文本域
 *   - 支持只读态（自动填充 subtle 背景）与错误提示浮标
 *   - 支持前置/后置装饰元素（prefix / suffix）
 */

import React, { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import styles from './Input.module.css'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  /** 校验错误文本，存在时边框变红并于下方显示 */
  error?: string
  /** 前置图元或符号 */
  prefix?: ReactNode
  /** 后置图元或动作按钮 */
  suffix?: ReactNode
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 校验错误文本 */
  error?: string
}

// #region Input 组件

/**
 * 用处: 单行紧凑输入框
 * 参数:
 *   - error: 错误说明文案
 *   - prefix / suffix: 前后置装饰物
 *   - readOnly / disabled: 只读与禁用属性
 * 功能:
 *   - 聚焦自动高亮聚焦环
 *   - 只读态呈现底色微灰
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error, prefix, suffix, className = '', readOnly, disabled, id, ...rest },
  ref
) {
  const containerClasses = [
    styles.inputContainer,
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
          readOnly={readOnly}
          disabled={disabled}
          className={styles.input}
          aria-invalid={Boolean(error)}
          {...rest}
        />
        {suffix && <span className={styles.suffix}>{suffix}</span>}
      </div>
      {error && <span className={styles.errorMessage}>{error}</span>}
    </div>
  )
})

Input.displayName = 'Input'

// #endregion

// #region Textarea 组件

/**
 * 用处: 多行文本输入域
 * 参数:
 *   - error: 错误提示
 * 功能:
 *   - 规范多行录入样式
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { error, className = '', readOnly, disabled, id, ...rest },
  ref
) {
  const containerClasses = [
    styles.textareaContainer,
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
        <textarea
          ref={ref}
          id={id}
          readOnly={readOnly}
          disabled={disabled}
          className={styles.textarea}
          aria-invalid={Boolean(error)}
          {...rest}
        />
      </div>
      {error && <span className={styles.errorMessage}>{error}</span>}
    </div>
  )
})

Textarea.displayName = 'Textarea'

// #endregion
