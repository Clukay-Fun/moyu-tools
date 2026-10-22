/**
 * 描述: 紧凑工作台表格样式与容器组件 (Table)
 * 主要功能:
 *   - 规范化 36px 紧凑行高、吸顶表头与整行悬停高亮
 *   - 提供数值靠右对齐与等宽排版类名
 *   - 导出结构化表格组件与底层 CSS Modules 类名
 */

import React, {
  forwardRef,
  type TableHTMLAttributes,
  type HTMLAttributes,
  type ThHTMLAttributes,
  type TdHTMLAttributes
} from 'react'
import styles from './Table.module.css'

export const tableStyles = styles

// #region Table 结构化组件

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  containerClassName?: string
}

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { children, className = '', containerClassName = '', ...rest },
  ref
) {
  return (
    <div className={`${styles.container} ${containerClassName}`}>
      <table ref={ref} className={`${styles.table} ${className}`} {...rest}>
        {children}
      </table>
    </div>
  )
})

Table.displayName = 'Table'

export function TableHead({
  children,
  className = '',
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return (
    <thead className={`${styles.thead} ${className}`} {...rest}>
      {children}
    </thead>
  )
}

export function TableBody({
  children,
  className = '',
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return (
    <tbody className={`${styles.tbody} ${className}`} {...rest}>
      {children}
    </tbody>
  )
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  clickable?: boolean
}

export function TableRow({ children, clickable = false, className = '', ...rest }: TableRowProps): React.JSX.Element {
  return (
    <tr className={`${styles.tr} ${clickable ? styles.clickable : ''} ${className}`} {...rest}>
      {children}
    </tr>
  )
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean
}

export function TableCell({ children, numeric = false, className = '', ...rest }: TableCellProps): React.JSX.Element {
  return (
    <td className={`${styles.td} ${numeric ? styles.numeric : ''} ${className}`} {...rest}>
      {children}
    </td>
  )
}

export interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean
}

export function TableHeaderCell({
  children,
  numeric = false,
  className = '',
  ...rest
}: TableHeaderCellProps): React.JSX.Element {
  return (
    <th className={`${styles.th} ${numeric ? styles.numeric : ''} ${className}`} {...rest}>
      {children}
    </th>
  )
}

export interface TableEmptyProps {
  cols: number
  title?: string
  description?: string
}

export function TableEmpty({ cols, title = '暂无数据', description }: TableEmptyProps): React.JSX.Element {
  return (
    <tr>
      <td
        colSpan={cols}
        style={{
          padding: 'var(--erp-space-6)',
          textAlign: 'center',
          color: 'var(--erp-text-tertiary)',
          fontSize: 'var(--erp-font-size-xs)'
        }}
      >
        <div style={{ fontWeight: 500, color: 'var(--erp-text-secondary)', marginBottom: 2 }}>{title}</div>
        {description && <div>{description}</div>}
      </td>
    </tr>
  )
}

// #endregion
