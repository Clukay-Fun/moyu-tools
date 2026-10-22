/**
 * 描述: 商品搜索选择组合框 (Combobox)
 * 主要功能:
 *   - 支持按商品名称、编码 (code)、SKU 模糊多维度搜索过滤
 *   - 列表项支持商品缩略图、主标题、次标题与库存徽标
 *   - 完备的键盘上下导航、回车确认、Esc 退出交互
 */

import React, { useState, useRef, useEffect, type ReactNode, type KeyboardEvent, type ChangeEvent } from 'react'
import { Search, X, Package } from 'lucide-react'
import styles from './Combobox.module.css'

export interface ComboboxItem<T = any> {
  id: string | number
  label: string
  sublabel?: string
  thumbnail?: string | null
  badge?: ReactNode
  keywords?: string[]
  raw?: T
}

export interface ComboboxProps<T = any> {
  /** 候选数据源 */
  items: Array<ComboboxItem<T>>
  /** 当前选中的项 */
  value?: ComboboxItem<T> | null
  /** 选中变动回调 */
  onSelect?: (item: ComboboxItem<T> | null) => void
  /** 占位提示文案 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 校验错误文本 */
  error?: string
  /** 自定义类名 */
  className?: string
  /** 无匹配项时的占位文本 */
  emptyText?: string
  /** 自动聚焦 */
  autoFocus?: boolean
}

// #region 过滤辅助算法

/**
 * 用处: 对候选数据集根据关键词执行多字段子串不区分大小写模糊匹配
 * 参数:
 *   - items: 待过滤项列表
 *   - query: 用户输入的检索词
 * 功能:
 *   - 匹配 label, sublabel 与 keywords，返回命中列表
 */
export function filterComboboxItems<T>(items: Array<ComboboxItem<T>>, query: string): Array<ComboboxItem<T>> {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return items
  }

  return items.filter((item) => {
    if (item.label.toLowerCase().includes(trimmed)) return true
    if (item.sublabel && item.sublabel.toLowerCase().includes(trimmed)) return true
    if (item.keywords && item.keywords.some((kw) => kw.toLowerCase().includes(trimmed))) {
      return true
    }
    return false
  })
}

// #endregion

// #region Combobox 核心组件

/**
 * 用处: 渲染支持键盘操控的模糊搜索下拉组合框
 * 参数:
 *   - items: 全量候选项
 *   - value / onSelect: 选中项与变更事件
 *   - placeholder: 输入框占位符
 * 功能:
 *   - 监听输入实时过滤
 *   - 键盘上下键切换高亮项，Enter 键选中，Esc 键折叠
 */
export function Combobox<T = any>({
  items,
  value,
  onSelect,
  placeholder = '搜索商品名称 / 编码 / SKU...',
  disabled = false,
  error,
  className = '',
  emptyText = '未找到匹配商品',
  autoFocus = false
}: ComboboxProps<T>): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState(value ? value.label : '')
  const [highlightIndex, setHighlightIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (value) {
      setQuery(value.label)
    } else if (!isOpen) {
      setQuery('')
    }
  }, [value, isOpen])

  const filteredItems = filterComboboxItems(items, query)

  // 点击外部收起
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        if (value) {
          setQuery(value.label)
        } else {
          setQuery('')
        }
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [value])

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value)
    setIsOpen(true)
    setHighlightIndex(0)
  }

  const handleItemSelect = (item: ComboboxItem<T>): void => {
    onSelect?.(item)
    setQuery(item.label)
    setIsOpen(false)
  }

  const handleClear = (): void => {
    onSelect?.(null)
    setQuery('')
    setIsOpen(false)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setIsOpen(true)
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev < filteredItems.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : filteredItems.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isOpen && filteredItems[highlightIndex]) {
        handleItemSelect(filteredItems[highlightIndex])
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
    }
  }

  return (
    <div ref={containerRef} className={`${styles.wrapper} ${className}`}>
      <div className={`${styles.inputContainer} ${error ? styles.hasError : ''} ${disabled ? styles.disabled : ''}`}>
        <span className={styles.searchIcon}>
          <Search size={14} />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={styles.input}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {(query || value) && !disabled && (
          <button type="button" className={styles.clearButton} onClick={handleClear} aria-label="清除输入">
            <X size={12} />
          </button>
        )}
      </div>

      {isOpen && (
        <div className={styles.popup}>
          {filteredItems.length === 0 ? (
            <div className={styles.empty}>{emptyText}</div>
          ) : (
            <ul className={styles.list} role="listbox">
              {filteredItems.map((item, index) => {
                const isSelected = value?.id === item.id
                const isHighlighted = highlightIndex === index
                return (
                  <li
                    key={String(item.id)}
                    role="option"
                    aria-selected={isSelected}
                    className={`${styles.item} ${isHighlighted ? styles.highlighted : ''}`}
                    onClick={() => handleItemSelect(item)}
                    onMouseEnter={() => setHighlightIndex(index)}
                  >
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className={styles.thumbnail} />
                    ) : (
                      <div className={styles.thumbnailPlaceholder}>
                        <Package size={14} />
                      </div>
                    )}
                    <div className={styles.itemContent}>
                      <span className={styles.itemLabel}>{item.label}</span>
                      {item.sublabel && <span className={styles.itemSublabel}>{item.sublabel}</span>}
                    </div>
                    {item.badge && <div className={styles.itemBadge}>{item.badge}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {error && <div className={styles.errorMessage}>{error}</div>}
    </div>
  )
}

// #endregion
