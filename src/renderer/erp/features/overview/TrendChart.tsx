/**
 * 描述: 出入库趋势双折线图 (TrendChart)
 * 主要功能:
 *   - 纯 SVG 绘制入库（蓝）/ 出库（橙棕）两条折线，逐自然日统计
 *   - 纵轴单位为「件」，横轴按范围稀疏显示日期
 *   - 悬停显示当天日期与两组件数
 *   - 没有交易时两条线落在 0 上并给出说明，不伪造数据
 */

import React, { useEffect, useRef, useState } from 'react'
import type { DailySeriesItem } from '@shared/erp/schemas'
import { formatQty } from '@erp/lib/format'
import styles from './TrendChart.module.css'

export interface TrendChartProps {
  data: DailySeriesItem[]
  /** 图表高度（默认 260px） */
  height?: number
}

interface Point {
  date: string
  inQty: number
  outQty: number
  x: number
  inY: number
  outY: number
}

export function TrendChart({ data, height = 260 }: TrendChartProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hovered, setHovered] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(280, Math.round(entry.contentRect.width)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const padL = 42
  const padR = 16
  const padB = 28
  const padT = 18
  const innerW = Math.max(10, width - padL - padR)
  const innerH = Math.max(10, height - padT - padB)
  const maxVal = Math.max(1, ...data.map((d) => Math.max(d.inQty, d.outQty)))
  const tickCount = maxVal < 4 ? maxVal : 4
  const step = Math.max(1, Math.ceil(maxVal / tickCount))
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => i * step)
  const actualMax = ticks[ticks.length - 1] || maxVal
  const getY = (v: number): number => padT + innerH - (v / actualMax) * innerH

  const points: Point[] = data.map((d, i) => {
    const x = data.length <= 1 ? padL + innerW / 2 : padL + (i * innerW) / (data.length - 1)
    return { date: d.date, inQty: d.inQty, outQty: d.outQty, x, inY: getY(d.inQty), outY: getY(d.outQty) }
  })

  const line = (key: 'inY' | 'outY'): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p[key].toFixed(1)}`).join(' ')

  // 30 天范围大约显示 6 个日期刻度，首尾始终显示
  const labelInterval = Math.max(1, Math.ceil(points.length / 6))
  const isEmpty = data.length > 0 && data.every((d) => d.inQty === 0 && d.outQty === 0)
  const hover = hovered !== null ? points[hovered] : null
  const hoverZoneW = points.length > 1 ? Math.max(10, innerW / (points.length - 1)) : innerW

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem}>
          <span className={`${styles.legendLine} ${styles.inLine}`} />
          入库件数
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.legendLine} ${styles.outLine}`} />
          出库件数
        </span>
        <span className={styles.unit}>单位：件</span>
      </div>

      <div className={styles.plot} style={{ height }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          className={styles.svg}
          role="img"
          aria-label="出入库趋势折线图"
          onMouseLeave={() => setHovered(null)}
        >
          {ticks.map((t) => {
            const y = getY(t)
            return (
              <g key={t}>
                <line x1={padL} x2={width - padR} y1={y} y2={y} className={styles.grid} />
                <text x={padL - 8} y={y + 3} className={styles.tick} textAnchor="end">
                  {t}
                </text>
              </g>
            )
          })}

          {points.map((p, i) => {
            const showLabel = i === 0 || i === points.length - 1 || i % labelInterval === 0
            return (
              <g key={p.date}>
                <rect
                  x={p.x - hoverZoneW / 2}
                  y={padT}
                  width={hoverZoneW}
                  height={innerH}
                  className={styles.hoverZone}
                  onMouseEnter={() => setHovered(i)}
                />
                {showLabel && (
                  <text x={p.x} y={height - 8} className={styles.tick} textAnchor="middle">
                    {p.date.slice(5)}
                  </text>
                )}
              </g>
            )
          })}

          <path d={line('inY')} className={styles.inPath} />
          <path d={line('outY')} className={styles.outPath} />

          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={padT} y2={padT + innerH} className={styles.hoverLine} />
              <circle cx={hover.x} cy={hover.inY} r={3.5} className={styles.inDot} />
              <circle cx={hover.x} cy={hover.outY} r={3.5} className={styles.outDot} />
            </>
          )}
        </svg>

        {isEmpty && <div className={styles.emptyText}>当前范围内没有出入库记录（入库 0 件，出库 0 件）</div>}

        {hover && (
          <div
            className={styles.tooltip}
            style={{
              left: `${Math.min(width - 80, Math.max(80, hover.x))}px`,
              top: `${Math.max(8, Math.min(hover.inY, hover.outY) - 10)}px`
            }}
          >
            <div className={styles.tooltipTitle}>{hover.date}</div>
            <div className={`${styles.tooltipRow} ${styles.inRow}`}>
              <span>入库</span>
              <span>{formatQty(hover.inQty)} 件</span>
            </div>
            <div className={`${styles.tooltipRow} ${styles.outRow}`}>
              <span>出库</span>
              <span>{formatQty(hover.outQty)} 件</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
