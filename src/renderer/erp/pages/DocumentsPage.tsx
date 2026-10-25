/**
 * 描述: 单据列表页 (DocumentsPage)
 * 主要功能:
 *   - 表格卡顶部一行筛选条：类型、状态、日期、搜索、总数，右侧固定「开单」与「更多」；
 *     放不下时自动换行，操作区仍靠右；下面是 9 列表格（表格自己横向滚动）和底栏计数
 *   - 「更多」里提供导出当前列表 CSV（按当前筛选，主进程生成）与清除筛选条件
 *   - 窄窗口下表格横向滚动；点击一行打开真实单据弹窗
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MoreVertical, Upload, Scale, Search, Download, FilterX } from 'lucide-react'
import type { DocumentListFilter, DocumentStatus, DocumentSummary, DocumentType } from '@shared/erp/types'
import {
  DateRangePicker,
  DocStatusBadge,
  DocTypeBadge,
  IconButton,
  Input,
  Menu,
  SegmentedControl,
  TableEmpty,
  useDrawer,
  type DateRange
} from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { useNav } from '@erp/app/navigation'
import { usePageActive } from '@erp/app/usePageActive'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import { unwrap, errorMessage } from '@erp/lib/api'
import { useDataChanged } from '@erp/lib/dataEvents'
import { formatCents, formatQty } from '@erp/lib/format'
import { NewDocumentButton } from '@erp/features/documents/NewDocumentButton'
import styles from './DocumentsPage.module.css'

type TypeFilter = 'all' | DocumentType
type StatusFilter = 'all' | DocumentStatus

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'inbound', label: '入库' },
  { value: 'outbound', label: '出库' },
  { value: 'adjustment', label: '调整' },
  { value: 'opening', label: '期初' }
]

export function DocumentsPage(): React.JSX.Element {
  const { location } = useNav()
  const { active, visit } = usePageActive('documents')
  const { currentDrawer } = useDrawer()
  const { openDocument, openAdjustment, openImport } = useEntityDrawers()
  const toast = useToast()
  const searchRef = useRef<HTMLInputElement>(null)
  const initial = location.params.documents ?? {}

  const [type, setType] = useState<TypeFilter>(initial.type ?? 'all')
  const [status, setStatus] = useState<StatusFilter>(initial.status ?? 'all')
  const [range, setRange] = useState<DateRange>({ from: initial.from ?? '', to: initial.to ?? '' })
  const [query, setQuery] = useState('')
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null)
  const [total, setTotal] = useState(0)
  const [draftCount, setDraftCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const requestId = useRef(0)

  const currentFilter = useCallback(
    (limit?: number): DocumentListFilter => ({
      type: type === 'all' ? undefined : type,
      status: status === 'all' ? undefined : status,
      from: range.from || undefined,
      to: range.to || undefined,
      q: query.trim() || undefined,
      ...(limit ? { limit } : {})
    }),
    [type, status, range.from, range.to, query]
  )

  // 筛选交给主进程：列表最多显示 1000 张，同时取总数判断是否被截断
  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const [items, counted, drafts] = await Promise.all([
        unwrap(window.api.erp.documents.list(currentFilter(1000))),
        unwrap(window.api.erp.documents.count(currentFilter())),
        unwrap(window.api.erp.documents.count({ status: 'draft' }))
      ])
      if (id !== requestId.current) return
      setDocs(items)
      setTotal(counted)
      setDraftCount(drafts)
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(errorMessage(err))
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [currentFilter])

  // 搜索输入防抖；类型 / 状态 / 日期即时生效
  useEffect(() => {
    const delay = query.trim() ? 220 : 0
    const timer = window.setTimeout(() => void load(), delay)
    return () => window.clearTimeout(timer)
  }, [load, query])

  useDataChanged(() => void load())

  // 从别的页面切回来时刷新
  useEffect(() => {
    if (visit > 0) void load()
  }, [visit, load])

  // 页面已常驻：其他页面带过来的筛选作为「外部指令」，只改对应条件，不重置其余状态
  const appliedSeq = useRef(-1)
  useEffect(() => {
    if (!active || appliedSeq.current === location.seq) return
    appliedSeq.current = location.seq
    const next = location.params.documents
    if (!next) return
    if (next.type) setType(next.type)
    if (next.status) setStatus(next.status)
    if (next.from || next.to) setRange({ from: next.from ?? '', to: next.to ?? '' })
  }, [active, location.seq, location.params.documents])

  // ⌘F 聚焦搜索框：只在单据页是当前页时生效
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const visible = docs ?? []

  const clearFilters = (): void => {
    setType('all')
    setStatus('all')
    setRange({ from: '', to: '' })
    setQuery('')
  }

  // 由主进程按同一筛选条件生成 CSV，不受列表 1000 张上限影响
  const handleExportList = async (): Promise<void> => {
    if (total === 0) {
      toast('当前筛选结果为空，没有可导出的单据', 'error')
      return
    }
    setExporting(true)
    try {
      const saved = await unwrap(window.api.erp.csv.exportDocumentList(currentFilter()))
      if (saved) toast(`已导出当前列表到: ${saved}`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setExporting(false)
    }
  }

  const moreItems = [
    {
      key: 'export-list',
      label: exporting ? '正在导出…' : '导出当前列表 CSV',
      icon: <Download size={14} />,
      disabled: exporting,
      onClick: handleExportList
    },
    {
      key: 'clear-filters',
      label: '清除筛选条件',
      icon: <FilterX size={14} />,
      onClick: clearFilters
    },
    'separator' as const,
    { key: 'import', label: '导入 CSV', icon: <Upload size={14} />, onClick: openImport },
    { key: 'adjust', label: '库存调整', icon: <Scale size={14} />, onClick: () => openAdjustment() }
  ]

  return (
    <div className={styles.container}>
      <h1 className="srOnly">单据</h1>

      <main className={styles.mainPanel}>
        {/* 固定两行：上行类型 / 状态筛选 + 开单操作，下行日期 / 搜索 / 数量 */}
        <div className={styles.toolbar}>
          <div className={styles.toolRow}>
            <div className={styles.filterGroups}>
              <SegmentedControl options={TYPE_OPTIONS} value={type} onChange={setType} />
              <SegmentedControl
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'draft', label: '草稿', count: draftCount || undefined },
                  { value: 'confirmed', label: '已生效' },
                  { value: 'voided', label: '已作废' }
                ]}
                value={status}
                onChange={(v) => setStatus(v as StatusFilter)}
              />
            </div>
            <div className={styles.toolActions}>
              <NewDocumentButton />
              <Menu
                align="end"
                trigger={<IconButton label="更多" icon={<MoreVertical size={16} />} variant="secondary" />}
                items={moreItems}
              />
            </div>
          </div>
          <div className={styles.toolRow}>
            <DateRangePicker value={range} onChange={setRange} />
            <div className={styles.search}>
              <Search size={14} className={styles.searchIcon} />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="单号 / 订单号 / 渠道 / 备注"
              />
            </div>
            <span className={styles.count}>{loading ? '正在筛选…' : `共 ${total} 张`}</span>
          </div>
        </div>

        {error && <p className={styles.error}>读取失败：{error}</p>}
        {docs && total > docs.length && (
          <p className={styles.truncated} role="status">
            当前筛选共 {total} 张，列表只显示最近 {docs.length} 张；导出会包含全部 {total} 张。
          </p>
        )}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.colDate}>日期</th>
                <th className={styles.colType}>类型</th>
                <th className={styles.colNo}>单号</th>
                <th className={styles.colStatus}>状态</th>
                <th className={styles.colChannel}>渠道 · 订单号</th>
                <th className={`${styles.num} ${styles.colQty}`}>数量</th>
                <th className={`${styles.num} ${styles.colMoney}`}>金额</th>
                <th className={`${styles.num} ${styles.colProfit}`}>毛利</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {!docs ? (
                <TableEmpty cols={9} title="正在读取单据…" />
              ) : visible.length === 0 ? (
                <TableEmpty cols={9} title="没有符合条件的单据" description="换个筛选条件，或点左上角「开单」" />
              ) : (
                visible.map((d) => {
                  const profit =
                    d.type === 'outbound' && d.status === 'confirmed' && d.totalCostCents !== null
                      ? d.totalAmountCents - d.totalCostCents
                      : null
                  const channel = [d.channelName, d.externalOrderNo].filter(Boolean).join(' · ')
                  const selected = currentDrawer?.id === `document-${d.id}`
                  return (
                    <tr
                      key={d.id}
                      className={`${styles.row} ${d.status === 'voided' ? styles.voided : ''} ${selected ? styles.selected : ''}`}
                      onClick={() => openDocument(d.id)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openDocument(d.id)
                      }}
                    >
                      <td className={styles.date}>{d.docDate}</td>
                      <td>
                        <DocTypeBadge type={d.type} />
                      </td>
                      <td className={styles.docNo}>{d.docNo}</td>
                      <td>
                        <DocStatusBadge status={d.status} />
                      </td>
                      <td className={styles.secondary} title={channel}>
                        {channel || '—'}
                      </td>
                      <td className={styles.num}>{formatQty(d.totalQuantity)}</td>
                      <td className={styles.num}>¥{formatCents(d.totalAmountCents)}</td>
                      <td className={`${styles.num} ${profit !== null && profit < 0 ? styles.negative : ''}`}>
                        {profit === null ? '—' : `¥${formatCents(profit)}`}
                      </td>
                      <td className={`${styles.secondary} ${styles.noteCell}`} title={d.note}>
                        {d.note || '—'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {docs && <footer className={styles.footer}>显示 {visible.length} 张单据</footer>}
      </main>
    </div>
  )
}
