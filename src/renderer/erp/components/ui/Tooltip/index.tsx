/**
 * 描述: 通用文字提示组件 (Tooltip)
 * 主要功能:
 *   - 延迟 400ms 弹出轻量文字提示气泡
 *   - 基于 Base UI Tooltip 原语封装，具备无障碍与自动边界检测
 *   - 支持四向定位、自定义偏移及条件禁用
 */

import React, { type ReactElement, type ReactNode } from 'react'
import { Tooltip as BaseTooltip } from '@base-ui/react'
import styles from './Tooltip.module.css'

export interface TooltipProps {
  /** 提示内容，若为空则不渲染弹层 */
  content: ReactNode
  /** 触发元素，必须为单个 ReactElement */
  children: ReactElement
  /** 弹出方位，默认为 top */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 与触发器距离，单位 px，默认为 6 */
  sideOffset?: number
  /** 出现延迟毫秒数，默认 400ms */
  delay?: number
  /** 是否禁用提示 */
  disabled?: boolean
}

// #region Tooltip 核心组件

/**
 * 用处: 包裹目标元素，在悬停或聚焦时延迟展示辅助提示信息
 * 参数:
 *   - content: 提示文本或内容节点
 *   - children: 单个可交互触发元素
 *   - side: 期望弹出方位
 *   - sideOffset: 间距偏移
 *   - delay: 延迟毫秒数
 *   - disabled: 是否禁用弹层
 * 功能:
 *   - 渲染 Base UI 气泡定位层与无障碍关联
 *   - 无内容或禁用时直接透传触发元素
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  sideOffset = 6,
  delay = 400,
  disabled = false
}: TooltipProps): ReactElement {
  if (!content || disabled) {
    return children
  }

  return (
    <BaseTooltip.Provider delay={delay}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={sideOffset}>
            <BaseTooltip.Popup className={styles.popup}>{content}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  )
}

export const TooltipProvider = BaseTooltip.Provider

// #endregion
