/**
 * 描述: 设置页的分组与行 (SettingsGroup / SettingRow / SettingsDisclosure / SettingPath)
 * 主要功能:
 *   - 输出摸鱼设置页的全局类名（styles/07-settings-format.css），和原生的通用、外观等分类是同一套外观
 *   - 行式结构：名称与说明在左，控件在右；同组的行共用一个圆角容器，行之间一条分隔线
 */

import type { ReactElement, ReactNode } from 'react'

export function SettingsGroup({
  title,
  danger,
  children
}: {
  title?: string
  danger?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <>
      {title && <h2 className="settings-group-title">{title}</h2>}
      <div className={`m-card settings-group${danger ? ' is-danger' : ''}`}>{children}</div>
    </>
  )
}

export function SettingRow({
  label,
  desc,
  path,
  children
}: {
  label: ReactNode
  desc?: ReactNode
  /** 目录类设置：当前路径显示在说明下面 */
  path?: string | null
  children?: ReactNode
}): ReactElement {
  return (
    <div className="setting-row">
      <span className="setting-label">
        {label}
        {desc && <small>{desc}</small>}
        {path !== undefined && <SettingPath path={path} />}
      </span>
      {children && <div className="setting-row-control">{children}</div>}
    </div>
  )
}

/** 默认收起的分组：标题行本身就是展开按钮 */
export function SettingsDisclosure({
  title,
  label,
  desc,
  children
}: {
  title?: string
  label: ReactNode
  desc?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <>
      {title && <h2 className="settings-group-title">{title}</h2>}
      <details className="m-card settings-group settings-disclosure">
        <summary className="setting-row">
          <span className="setting-label">
            {label}
            {desc && <small>{desc}</small>}
          </span>
          <svg className="ic settings-disclosure-arrow" aria-hidden="true">
            <use href="#ic-chevron-down" />
          </svg>
        </summary>
        <div className="settings-disclosure-body">{children}</div>
      </details>
    </>
  )
}

/** 路径只占一行：超长时省略，悬停看完整路径 */
function SettingPath({ path }: { path: string | null | undefined }): ReactElement {
  return (
    <span className="setting-path" title={path ?? undefined}>
      {path ?? '加载中…'}
    </span>
  )
}
