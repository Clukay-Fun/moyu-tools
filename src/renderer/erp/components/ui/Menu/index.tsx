/**
 * 描述: 下拉操作菜单套件 (Menu)
 * 主要功能:
 *   - 基于 Base UI Menu 原语封装，提供浮动操作清单
 *   - 专用于「更多」二级操作与左侧「开单」分体按钮下拉
 *   - 菜单项支持左侧图标、标题文案以及右侧键盘快捷键徽记
 *   - 支持危险操作项高亮及分组分割线
 */

import React, { type ReactElement, type ReactNode } from 'react'
import { Menu as BaseMenu } from '@base-ui/react'
import styles from './Menu.module.css'

export interface MenuItemOption {
  key: string
  label: ReactNode
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick?: () => void
}

export interface MenuProps {
  /** 触发元素，必须为单个 ReactElement */
  trigger: ReactElement
  /** 菜单项列表；使用 'separator' 作为分割线标识 */
  items: Array<MenuItemOption | 'separator'>
  /** 弹出位置 */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 对齐方式 */
  align?: 'start' | 'center' | 'end'
}

// #region Menu 组件实现

/**
 * 用处: 渲染点击后浮出的快捷功能菜单
 * 参数:
 *   - trigger: 触发器节点
 *   - items: 菜单项或分割线
 * 功能:
 *   - 键盘上下键聚焦与快捷键右对齐
 */
export function Menu({ trigger, items, side = 'bottom', align = 'start' }: MenuProps): React.JSX.Element {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={4} className={styles.positioner}>
          <BaseMenu.Popup className={styles.popup}>
            <div className={styles.list} role="menu">
              {items.map((item, index) => {
                if (item === 'separator') {
                  return <div key={`sep-${index}`} className={styles.separator} role="separator" />
                }

                return (
                  <BaseMenu.Item
                    key={item.key}
                    disabled={item.disabled}
                    className={`${styles.item} ${item.danger ? styles.danger : ''}`}
                    onClick={item.onClick}
                  >
                    <div className={styles.itemLeft}>
                      {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                      <span className={styles.itemLabel}>{item.label}</span>
                    </div>
                    {item.shortcut && <span className={styles.itemShortcut}>{item.shortcut}</span>}
                  </BaseMenu.Item>
                )
              })}
            </div>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

// #endregion
