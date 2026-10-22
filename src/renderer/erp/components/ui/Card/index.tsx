/**
 * 描述: 面板卡片与核心指标卡组件 (Card / StatCard)
 * 主要功能:
 *   - 规范化 1px 细边框、无阴影的工作台卡片
 *   - StatCard 呈现 28px 等宽品牌色数字
 *   - 支持副文本与较上期环比变化百分比（中性色 ▲▼）
 *   - 支持整卡点击交互
 */

import React, { type HTMLAttributes, type ReactNode } from 'react'
import { ArrowUp, ArrowDown } from 'lucide-react'
import styles from './Card.module.css'

// #region Card 基础卡片

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  className?: string
}

export function Card({ children, className = '', ...rest }: CardProps): React.JSX.Element {
  return (
    <div className={`${styles.card} ${className}`} {...rest}>
      {children}
    </div>
  )
}

// #endregion

// #region StatCard 关键指标卡

export interface StatCardProps {
  /** 指标标题 */
  label: string
  /** 指标主数值 */
  value: ReactNode
  /** 数值颜色是否使用中性色（默认使用品牌色） */
  neutral?: boolean
  /** 右上角可选辅助元素 */
  extra?: ReactNode
  /** 底部副文本说明 */
  subtext?: ReactNode
  /** 环比变化数值百分比，正数上升，负数下降 */
  changePercentage?: number | null
  /** 点击回调 */
  onClick?: () => void
  /** 尺寸：md 概览 KPI（28px），sm 抽屉内概要（20px） */
  size?: 'md' | 'sm'
  /** 自定义类名 */
  className?: string
}

/**
 * 用处: 概览与看板页顶部 KPI 指标磁贴
 * 参数:
 *   - label: 统计项目名称
 *   - value: 格式化后的指标值
 *   - changePercentage: 较上期变动比例
 * 功能:
 *   - 突出 28px 等宽金融数值
 *   - 渲染 ▲▼ 趋势变化符
 */
export function StatCard({
  label,
  value,
  neutral = false,
  extra,
  subtext,
  changePercentage,
  onClick,
  size = 'md',
  className = ''
}: StatCardProps): React.JSX.Element {
  const isClickable = Boolean(onClick)

  return (
    <div
      className={`${styles.statCard} ${size === 'sm' ? styles.small : ''} ${isClickable ? styles.clickable : ''} ${className}`}
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={(e) => {
        if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick?.()
        }
      }}
    >
      <div className={styles.labelRow}>
        <span className={styles.label}>{label}</span>
        {extra}
      </div>

      <div className={styles.valueRow}>
        <span className={`${styles.value} ${neutral ? styles.neutral : ''}`}>{value}</span>
      </div>

      {(subtext || changePercentage !== undefined) && (
        <div className={styles.footerRow}>
          {subtext && <span className={styles.subtext}>{subtext}</span>}
          {changePercentage !== undefined && changePercentage !== null && (
            <span className={styles.trend}>
              <span className={styles.trendIcon}>
                {changePercentage >= 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              </span>
              <span>{Math.abs(changePercentage)}%</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// #endregion
