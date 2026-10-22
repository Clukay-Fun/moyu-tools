/**
 * 描述: 状态与类型徽标套件 (Badge / DocTypeBadge / DocStatusBadge / StockBadge)
 * 主要功能:
 *   - 规范化 20px 高度、4px 小方角微型徽标
 *   - 严禁绿色数据语义（入库蓝、出库琥珀、调整紫、期初灰蓝）
 *   - DocStatusBadge：草稿为灰色描边，已生效为中性实心加 ✓，已作废为灰色文字加删除线
 *   - StockBadge：告急红色、低于预警琥珀色、已停用灰色
 */

import React, { type ReactNode } from 'react'
import { Check } from 'lucide-react'
import styles from './Badge.module.css'

// #region 通用 Badge

export interface BadgeProps {
  children: ReactNode
  variant?: 'neutral' | 'inbound' | 'outbound' | 'adjustment' | 'opening' | 'danger' | 'warning'
  className?: string
}

export function Badge({ children, variant = 'neutral', className = '' }: BadgeProps): React.JSX.Element {
  const variantClass =
    variant === 'inbound'
      ? styles.inbound
      : variant === 'outbound'
        ? styles.outbound
        : variant === 'adjustment'
          ? styles.adjustment
          : variant === 'opening'
            ? styles.opening
            : variant === 'danger'
              ? styles.stockCritical
              : variant === 'warning'
                ? styles.stockWarning
                : styles.stockNormal

  return <span className={`${styles.badge} ${variantClass} ${className}`}>{children}</span>
}

// #endregion

// #region DocTypeBadge 单据类型徽标

export type DocType = 'inbound' | 'outbound' | 'adjustment' | 'opening'

export interface DocTypeBadgeProps {
  type: DocType
  className?: string
}

export const TYPE_LABEL: Record<DocType, string> = {
  inbound: '入库',
  outbound: '出库',
  adjustment: '调整',
  opening: '期初'
}

const docTypeStyles: Record<DocType, string> = {
  inbound: styles.inbound,
  outbound: styles.outbound,
  adjustment: styles.adjustment,
  opening: styles.opening
}

/**
 * 用处: 标明单据类型（入库/出库/调整/期初）
 * 参数:
 *   - type: 单据类型
 * 功能:
 *   - 严格映射对应语义色彩
 */
export function DocTypeBadge({ type, className = '' }: DocTypeBadgeProps): React.JSX.Element {
  return (
    <span className={`${styles.badge} ${docTypeStyles[type] || styles.inbound} ${className}`}>
      {TYPE_LABEL[type] || type}
    </span>
  )
}

// #endregion

// #region DocStatusBadge 单据状态徽标

export type DocStatus = 'draft' | 'confirmed' | 'voided'

export interface DocStatusBadgeProps {
  status: DocStatus
  className?: string
}

/**
 * 用处: 标明单据状态（草稿/已生效/已作废）
 * 参数:
 *   - status: 单据生命周期状态
 * 功能:
 *   - 草稿灰框、生效中性实心带钩、作废中划线
 */
export function DocStatusBadge({ status, className = '' }: DocStatusBadgeProps): React.JSX.Element {
  if (status === 'draft') {
    return <span className={`${styles.badge} ${styles.draft} ${className}`}>草稿</span>
  }
  if (status === 'confirmed') {
    return (
      <span className={`${styles.badge} ${styles.confirmed} ${className}`}>
        <span className={styles.icon}>
          <Check size={11} strokeWidth={2.5} />
        </span>
        <span>已生效</span>
      </span>
    )
  }
  return <span className={`${styles.badge} ${styles.voided} ${className}`}>已作废</span>
}

// #endregion

// #region StockBadge 库存健康状态徽标

export type StockStatus = 'out' | 'critical' | 'low' | 'ok' | 'inactive'

/** 需要店主处理的健康状态（缺货、告急、低于预警） */
export function isStockAlert(status: StockStatus | undefined): boolean {
  return status === 'out' || status === 'critical' || status === 'low'
}

export interface StockBadgeProps {
  status: StockStatus
  label?: string
  className?: string
}

/**
 * 用处: 标明库存健康度（告急/低于预警/正常/已停用）
 * 参数:
 *   - status: 库存状态
 *   - label: 自定义文字（默认使用标准文案）
 * 功能:
 *   - 缺货、告急红色，低于预警琥珀色，停用灰色
 */
export function StockBadge({ status, label, className = '' }: StockBadgeProps): React.JSX.Element {
  if (status === 'out') {
    return <span className={`${styles.badge} ${styles.stockCritical} ${className}`}>{label || '缺货'}</span>
  }
  if (status === 'critical') {
    return <span className={`${styles.badge} ${styles.stockCritical} ${className}`}>{label || '告急'}</span>
  }
  if (status === 'low') {
    return <span className={`${styles.badge} ${styles.stockWarning} ${className}`}>{label || '低于预警'}</span>
  }
  if (status === 'inactive') {
    return <span className={`${styles.badge} ${styles.stockInactive} ${className}`}>{label || '已停用'}</span>
  }
  return <span className={`${styles.badge} ${styles.stockNormal} ${className}`}>{label || '正常'}</span>
}

// #endregion
