/**
 * 描述: 分段控件与标签切换组件 (SegmentedControl)
 * 主要功能:
 *   - 提供横向平铺选项切换与状态筛选
 *   - 支持每项携带独立计数徽标（如「草稿 1」、「待处理 3」）
 *   - 紧凑 32px 工作台外观，平滑过渡动效
 */

import React, { type ReactNode } from 'react'
import styles from './SegmentedControl.module.css'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: ReactNode
  count?: number
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  /** 候选选项列表 */
  options: Array<SegmentedOption<T>>
  /** 当前选中的值 */
  value: T
  /** 选项变更回调 */
  onChange: (val: T) => void
  /** 自定义类名 */
  className?: string
  /** 是否占满容器宽度 */
  fullWidth?: boolean
}

// #region SegmentedControl 核心组件

/**
 * 用处: 列表顶部状态切换（全部、草稿、已生效、已作废等）
 * 参数:
 *   - options: 选项数组
 *   - value / onChange: 状态流
 * 功能:
 *   - 激活项高亮居中浮起，未激活项平铺
 *   - 计数存在时渲染微型数字胶囊
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  className = '',
  fullWidth = false
}: SegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      role="tablist"
      className={`${styles.container} ${className}`}
      style={{
        display: fullWidth ? 'flex' : 'inline-flex',
        width: fullWidth ? '100%' : undefined
      }}
    >
      {options.map((opt) => {
        const isActive = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={opt.disabled}
            className={`${styles.item} ${isActive ? styles.active : ''}`}
            style={{
              flex: fullWidth ? 1 : undefined
            }}
            onClick={() => onChange(opt.value)}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && opt.count > 0 && <span className={styles.count}>{opt.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

// #endregion
