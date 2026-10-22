/**
 * 描述: 页面标准顶栏组件 (PageHeader)
 * 主要功能:
 *   - 规范化 56px 固定高度、底部分割线
 *   - 左侧展示 20px 品牌色页面大标题，支持附加计数指示
 *   - 右侧灵活承接动作按钮区 (actions)
 */

import React, { type ReactNode } from 'react'
import styles from './PageHeader.module.css'

export interface PageHeaderProps {
  /** 页面主标题 */
  title: string
  /** 旁边附加的计数或辅助说明 */
  count?: number | string
  /** 右侧操作按钮区 */
  actions?: ReactNode
  /** 自定义类名 */
  className?: string
}

// #region PageHeader 核心组件

/**
 * 用处: 所有一级视图（概览、商品、单据、定制、设置）的统一顶栏
 * 参数:
 *   - title: 页面大标题
 *   - count: 关联条数或状态标示
 *   - actions: 右侧交互组件
 * 功能:
 *   - 确立统一的 56px 视窗起始基线
 */
export function PageHeader({ title, count, actions, className = '' }: PageHeaderProps): React.JSX.Element {
  return (
    <header className={`${styles.header} ${className}`}>
      <div className={styles.left}>
        <h1 className={styles.title}>{title}</h1>
        {count !== undefined && <span className={styles.count}>{count}</span>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  )
}

// #endregion
