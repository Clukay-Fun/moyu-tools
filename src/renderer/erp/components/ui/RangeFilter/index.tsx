/**
 * 描述: 日期区间筛选（近 7 天 / 近 30 天 / 自定义）
 * 主要功能:
 *   - 概览的趋势图和最近单据各用一份，状态互不影响
 *   - 一行排开：「日期范围」+ 三个单选 + 常驻的「开始 至 结束」日期框；非自定义时日期框只读显示当前区间
 *   - 自定义区间必填，并校验起始日期不晚于结束日期
 */

import { useState, type ReactElement } from 'react'
import type { DateRange } from '../DatePicker'
import { shiftDate, todayString } from '@erp/lib/format'
import styles from './RangeFilter.module.css'

export type RangePreset = '7d' | '30d' | 'custom'

const OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'custom', label: '自定义' }
]

export function presetRange(preset: '7d' | '30d'): DateRange {
  const today = todayString()
  return { from: shiftDate(today, preset === '7d' ? -6 : -29), to: today }
}

function detectPreset(range: DateRange): RangePreset {
  const seven = presetRange('7d')
  const thirty = presetRange('30d')
  if (range.from === seven.from && range.to === seven.to) return '7d'
  if (range.from === thirty.from && range.to === thirty.to) return '30d'
  return 'custom'
}

export interface RangeFilterProps {
  value: DateRange
  onChange: (range: DateRange) => void
  /** 无障碍名称，如「趋势统计区间」 */
  label: string
}

export function RangeFilter({ value, onChange, label }: RangeFilterProps): ReactElement {
  const [preset, setPreset] = useState<RangePreset>(() => detectPreset(value))
  const [custom, setCustom] = useState<DateRange>(value)
  const valid = preset !== 'custom' || (!!custom.from && !!custom.to && custom.from <= custom.to)

  const choose = (next: RangePreset): void => {
    setPreset(next)
    if (next === 'custom') {
      setCustom(value.from && value.to ? value : { from: '', to: '' })
      return
    }
    onChange(presetRange(next))
  }

  const changeCustom = (next: DateRange): void => {
    setCustom(next)
    if (next.from && next.to && next.from <= next.to) onChange(next)
  }

  const isCustom = preset === 'custom'
  const shown = isCustom ? custom : value

  return (
    <div className={styles.wrap} role="group" aria-label={label}>
      <span className={styles.label}>日期范围</span>
      <div className={styles.radios} role="radiogroup" aria-label={`${label}预设`}>
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={preset === option.value}
            className={styles.radio}
            onClick={() => choose(option.value)}
          >
            <span className={styles.circle} aria-hidden="true" />
            {option.label}
          </button>
        ))}
      </div>
      <div className={styles.range}>
        <input
          type="date"
          aria-label="开始日期"
          value={shown.from}
          max={shown.to || undefined}
          disabled={!isCustom}
          onChange={(e) => changeCustom({ ...custom, from: e.target.value })}
        />
        <span className={styles.sep}>至</span>
        <input
          type="date"
          aria-label="结束日期"
          value={shown.to}
          min={shown.from || undefined}
          disabled={!isCustom}
          onChange={(e) => changeCustom({ ...custom, to: e.target.value })}
        />
      </div>
      {!valid && (
        <span className={styles.error} role="alert">
          起止日期必填，且起始不能晚于结束
        </span>
      )}
    </div>
  )
}
