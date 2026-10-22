/**
 * 描述: 下拉选择框组件 (Select)
 * 主要功能:
 *   - 基于 Base UI Select 原语封装，具备完整键盘无障碍导航
 *   - 统一 32px 紧凑触发器与圆角浮层
 *   - 支持错误状态标红与禁用态
 */

import React, { type ReactNode } from 'react'
import { Select as BaseSelect } from '@base-ui/react'
import { ChevronDown, Check } from 'lucide-react'
import styles from './Select.module.css'

export interface SelectOption<T = string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export interface SelectProps<T = string> {
  /** 当前选中的值 */
  value?: T
  /** 默认选中的值 */
  defaultValue?: T
  /** 值变动回调 */
  onChange?: (value: T) => void
  /** 选项列表 */
  options: Array<SelectOption<T>>
  /** 未选择时的占位文案 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 错误文案 */
  error?: string
  /** 自定义类名 */
  className?: string
  /** 触发器 ID */
  id?: string
}

// #region Select 组件实现

/**
 * 用处: 渲染带键盘无障碍支持的下拉选择菜单
 * 参数:
 *   - value / onChange: 受控选项流
 *   - options: 选项结构数组 [{ value, label, disabled? }]
 *   - placeholder: 占位提示文案
 * 功能:
 *   - Base UI 原生下拉浮层与键盘上下切换/回车选中
 */
export function Select<T extends string = string>({
  value,
  defaultValue,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  error,
  className = '',
  id
}: SelectProps<T>): React.JSX.Element {
  const triggerClasses = [styles.trigger, error ? styles.hasError : '', className].filter(Boolean).join(' ')

  return (
    <div className={styles.wrapper}>
      <BaseSelect.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={(val) => onChange?.(val as T)}
        disabled={disabled}
      >
        <BaseSelect.Trigger id={id} className={triggerClasses}>
          {/* 显示选项文字而不是原始 value；空字符串也是合法选项（例如「全部」） */}
          <BaseSelect.Value placeholder={placeholder}>
            {(v: T | null) => options.find((opt) => opt.value === v)?.label ?? placeholder}
          </BaseSelect.Value>
          <BaseSelect.Icon className={styles.icon}>
            <ChevronDown size={14} />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner side="bottom" align="start" sideOffset={4} className={styles.positioner}>
            <BaseSelect.Popup className={styles.popup}>
              <BaseSelect.List className={styles.list}>
                {options.map((opt) => (
                  <BaseSelect.Item
                    key={String(opt.value)}
                    value={opt.value}
                    disabled={opt.disabled}
                    className={styles.item}
                  >
                    <BaseSelect.ItemText>{opt.label}</BaseSelect.ItemText>
                    <BaseSelect.ItemIndicator className={styles.itemIndicator}>
                      <Check size={14} />
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
      {error && <span className={styles.errorMessage}>{error}</span>}
    </div>
  )
}

// #endregion
