/**
 * 描述: 工作台通用面板结构组件 (Panel)
 * 主要功能:
 *   - 统一 44px 高度面板头，左侧标题与计数，右侧操作插槽
 *   - 支持表格贴边模式 (flush)，去除冗余边距
 *   - 提供组件复合模式与属性直传两种使用方式
 */

import React, { type HTMLAttributes, type ReactNode } from 'react'
import styles from './Panel.module.css'

// #region Panel 基础容器

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 面板标题（提供后自动渲染默认 PanelHeader） */
  title?: ReactNode
  /** 标题旁计数数字或副文本 */
  count?: ReactNode
  /** 头部右侧操作动作区域 */
  actions?: ReactNode
  /** 内容是否贴边（无 padding，适合内嵌表格） */
  flush?: boolean
  /** 自定义类名 */
  className?: string
  /** 子元素 */
  children?: ReactNode
}

/**
 * 用处: 全局所有工作台面板标准外框
 * 参数:
 *   - title: 面板名称
 *   - count: 统计数量或辅助说明
 *   - actions: 操作按钮区域
 *   - flush: 是否贴边内嵌表格
 * 功能:
 *   - 消除杂乱卡片边框阴影，建立统一工作台视觉层级
 */
export function Panel({
  title,
  count,
  actions,
  flush = false,
  className = '',
  children,
  ...rest
}: PanelProps): React.JSX.Element {
  const hasHeader = Boolean(title || actions)

  return (
    <div className={`${styles.panel} ${className}`} {...rest}>
      {hasHeader && (
        <PanelHeader>
          <div className={styles.titleArea}>
            {title && <h3 className={styles.title}>{title}</h3>}
            {count !== undefined && count !== null && <span className={styles.count}>{count}</span>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </PanelHeader>
      )}
      <div className={`${styles.body} ${flush ? styles.flush : ''}`}>{children}</div>
    </div>
  )
}

// #endregion

// #region Panel 子结构组件

export interface PanelHeaderProps extends HTMLAttributes<HTMLDivElement> {
  className?: string
  children?: ReactNode
}

/**
 * 用处: 面板自定义头部
 * 参数:
 *   - children: 头部内容插槽
 * 功能:
 *   - 固定 44px 紧凑高度，下边框隔离
 */
export function PanelHeader({ className = '', children, ...rest }: PanelHeaderProps): React.JSX.Element {
  return (
    <div className={`${styles.header} ${className}`} {...rest}>
      {children}
    </div>
  )
}

export interface PanelBodyProps extends HTMLAttributes<HTMLDivElement> {
  flush?: boolean
  className?: string
  children?: ReactNode
}

/**
 * 用处: 面板内容区
 * 参数:
 *   - flush: 是否贴边
 * 功能:
 *   - 承载面板内部主体图表、明细列表或表格
 */
export function PanelBody({ flush = false, className = '', children, ...rest }: PanelBodyProps): React.JSX.Element {
  return (
    <div className={`${styles.body} ${flush ? styles.flush : ''} ${className}`} {...rest}>
      {children}
    </div>
  )
}

// #endregion
