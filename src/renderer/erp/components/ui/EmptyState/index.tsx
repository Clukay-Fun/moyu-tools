/**
 * 描述: 空状态占位提示组件 (EmptyState)
 * 主要功能:
 *   - 居中展示灰度图标、一句话原因说明
 *   - 支持平铺最多 3 个引导操作按钮
 *   - 适配列表无数据、搜索未命中及初始化引导等情境
 */

import React, { type ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { Button, type ButtonVariant } from '../Button'
import styles from './EmptyState.module.css'

export interface EmptyStateAction {
  label: string
  onClick: () => void
  variant?: ButtonVariant
}

export interface EmptyStateProps {
  /** 居中示意图标，默认为收件箱图元 */
  icon?: ReactNode
  /** 简明标题，如「暂无商品」 */
  title?: string
  /** 一句话原因阐述或建议 */
  description?: ReactNode
  /** 快捷动作按钮清单（最多渲染 3 个） */
  actions?: EmptyStateAction[]
  /** 自定义拓展子内容 */
  children?: ReactNode
  /** 自定义容器类名 */
  className?: string
}

// #region EmptyState 核心组件

/**
 * 用处: 渲染列表无数据或检索为空时的优雅占位引导
 * 参数:
 *   - icon: 图标节点
 *   - title: 主标题
 *   - description: 次级说明
 *   - actions: 引导按钮组
 * 功能:
 *   - 统一定制视觉空白区，引导用户执行初始化或重试
 */
export function EmptyState({
  icon = <Inbox size={22} />,
  title = '暂无数据',
  description,
  actions,
  children,
  className = ''
}: EmptyStateProps): React.JSX.Element {
  const visibleActions = actions?.slice(0, 3)

  return (
    <div className={`${styles.container} ${className}`}>
      {icon && <div className={styles.icon}>{icon}</div>}
      {title && <h4 className={styles.title}>{title}</h4>}
      {description && <p className={styles.description}>{description}</p>}

      {visibleActions && visibleActions.length > 0 && (
        <div className={styles.actions}>
          {visibleActions.map((action, index) => (
            <Button
              key={index}
              size="sm"
              variant={action.variant || (index === 0 ? 'primary' : 'secondary')}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {children}
    </div>
  )
}

// #endregion
