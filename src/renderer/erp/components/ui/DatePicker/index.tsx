/**
 * 描述: 日期录入与区间选择组件 (DateInput / DateRangePicker)
 * 主要功能:
 *   - 提供原生外观统一的单日录入组件 DateInput
 *   - 基于 Base UI Popover 封装具备预设（今天/7天/30天/本月/上月/全部）的 DateRangePicker
 *   - 等宽数字呈现，自动防溢出对齐
 */

import React, { useState, forwardRef, type InputHTMLAttributes } from 'react'
import { Popover } from '@base-ui/react'
import { Calendar as CalendarIcon } from 'lucide-react'
import { Button } from '../Button'
import styles from './DatePicker.module.css'

export interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 错误文案 */
  error?: string
}

// #region DateInput 单日录入

/**
 * 用处: 规范化原生日期输入控件外观
 * 参数:
 *   - value / onChange: 受控原生事件
 *   - error: 错误文案
 * 功能:
 *   - 等宽字体与紧凑 32px 高度排版
 */
export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { className = '', disabled, ...rest },
  ref
) {
  return <input ref={ref} type="date" disabled={disabled} className={`${styles.dateInput} ${className}`} {...rest} />
})

DateInput.displayName = 'DateInput'

// #endregion

// #region DateRangePicker 范围选择器

export interface DateRange {
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}

export type DateRangePreset = 'today' | '7days' | '30days' | 'thisMonth' | 'lastMonth' | 'all'

export interface DateRangePickerProps {
  /** 当前起止日期 */
  value: DateRange
  /** 范围变更回调 */
  onChange: (range: DateRange) => void
  /** 触发按钮自定义类名 */
  className?: string
  /** 是否禁用 */
  disabled?: boolean
}

/**
 * 辅助函数: 格式化 Date 为本地 YYYY-MM-DD
 */
function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 辅助函数: 获取预设区间的日期对
 */
export function getPresetDateRange(preset: DateRangePreset): DateRange {
  const now = new Date()
  const todayStr = formatDate(now)

  switch (preset) {
    case 'today':
      return { from: todayStr, to: todayStr }
    case '7days': {
      const past = new Date(now)
      past.setDate(past.getDate() - 6)
      return { from: formatDate(past), to: todayStr }
    }
    case '30days': {
      const past = new Date(now)
      past.setDate(past.getDate() - 29)
      return { from: formatDate(past), to: todayStr }
    }
    case 'thisMonth': {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: formatDate(firstDay), to: todayStr }
    }
    case 'lastMonth': {
      const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: formatDate(firstDay), to: formatDate(lastDay) }
    }
    case 'all':
    default:
      // 空区间表示不限日期
      return { from: '', to: '' }
  }
}

/**
 * 用处: 常用区间快捷与自定义跨期选择
 * 参数:
 *   - value: 起止日期对象 { from, to }
 *   - onChange: 变更通知
 * 功能:
 *   - 弹出预设按钮矩阵，支持一键切换常用会计区间
 *   - 支持精确挑选起止自然日并一键确认
 */
export function DateRangePicker({
  value,
  onChange,
  className = '',
  disabled = false
}: DateRangePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [tempFrom, setTempFrom] = useState(value.from)
  const [tempTo, setTempTo] = useState(value.to)

  const handleOpenChange = (isOpen: boolean): void => {
    setOpen(isOpen)
    if (isOpen) {
      setTempFrom(value.from)
      setTempTo(value.to)
    }
  }

  const handleApplyPreset = (preset: DateRangePreset): void => {
    const range = getPresetDateRange(preset)
    onChange(range)
    setOpen(false)
  }

  const handleCustomApply = (): void => {
    if (tempFrom && tempTo) {
      onChange({ from: tempFrom, to: tempTo })
      setOpen(false)
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger className={`${styles.rangeTrigger} ${className}`} disabled={disabled} aria-label="选择日期区间">
        <span className={styles.rangeIcon}>
          <CalendarIcon size={14} />
        </span>
        <span className={styles.rangeText}>
          {value.from || value.to ? `${value.from || '最早'} ~ ${value.to || '今天'}` : '全部日期'}
        </span>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className={styles.popup}>
            <div className={styles.presetGrid}>
              <button type="button" className={styles.presetButton} onClick={() => handleApplyPreset('today')}>
                今天
              </button>
              <button type="button" className={styles.presetButton} onClick={() => handleApplyPreset('7days')}>
                近 7 天
              </button>
              <button type="button" className={styles.presetButton} onClick={() => handleApplyPreset('30days')}>
                近 30 天
              </button>
              <button type="button" className={styles.presetButton} onClick={() => handleApplyPreset('thisMonth')}>
                本月
              </button>
              <button type="button" className={styles.presetButton} onClick={() => handleApplyPreset('lastMonth')}>
                上月
              </button>
              <button type="button" className={styles.presetButton} onClick={() => handleApplyPreset('all')}>
                全部
              </button>
            </div>

            <div className={styles.customSection}>
              <span className={styles.customLabel}>自定义区间</span>
              <div className={styles.customInputs}>
                <DateInput value={tempFrom} onChange={(e) => setTempFrom(e.target.value)} max={tempTo} />
                <span className={styles.customSeparator}>至</span>
                <DateInput value={tempTo} onChange={(e) => setTempTo(e.target.value)} min={tempFrom} />
              </div>
            </div>

            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button size="sm" variant="primary" onClick={handleCustomApply}>
                应用
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

// #endregion
