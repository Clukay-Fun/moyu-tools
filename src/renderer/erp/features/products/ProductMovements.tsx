/**
 * 描述: 商品专属库存变动流水组件 (ProductMovements)
 * 主要功能:
 *   - 提供类型、渠道、时间范围及单号多维检索过滤
 *   - 严格呈现业务流水（时间、类型徽标、单号、渠道订单、数量、成本、结存）
 *   - 作废冲回行样式弱化
 *   - 支持点击单号跳转/打开对应单据抽屉
 *   - 支持导出当前商品变动流水 CSV
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Download, ChevronLeft, ChevronRight } from 'lucide-react'
import type { MovementKind, MovementRow, Page, Product, SalesChannel } from '@shared/erp/types'
import { Button, IconButton, Input, Select, DateRangePicker, DocTypeBadge, Badge, TableEmpty } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { formatCents, formatOccurred, formatQty, shiftDate, signedQty, todayString } from '@erp/lib/format'
import styles from './ProductMovements.module.css'

// #region 类型定义与选项映射

export interface ProductMovementsProps {
  /** 关联商品 */
  product: Product
  /** 点击单据打开单据抽屉回调 */
  onOpenDocument?: (documentId: number) => void
  /** 商品抽屉中调整或补录期初后重新载入流水 */
  refreshKey?: number
}

const KIND_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'opening', label: '期初' },
  { value: 'inbound', label: '入库' },
  { value: 'outbound', label: '出库' },
  { value: 'adjustment', label: '调整' },
  { value: 'void', label: '作废冲回' }
]

const PAGE_SIZE = 20

// #endregion

// #region ProductMovements 组件实现

/**
 * 用处: 商品抽屉底部的库存变动流水列表
 * 参数:
 *   - product: 当前查看的商品
 *   - onOpenDocument: 点击单据时的抽屉联动回调
 * 功能:
 *   - 详实记录每一笔出入库、调整与期初凭证
 */
export function ProductMovements({
  product,
  onOpenDocument,
  refreshKey = 0
}: ProductMovementsProps): React.JSX.Element {
  const toast = useToast()

  const [kind, setKind] = useState<string>('all')
  const [channelId, setChannelId] = useState<string>('all')
  const [range, setRange] = useState<{ from: string; to: string }>(() => ({
    from: shiftDate(todayString(), -29),
    to: todayString()
  }))
  const [docNo, setDocNo] = useState<string>('')
  const [page, setPage] = useState<number>(1)
  const [channels, setChannels] = useState<SalesChannel[]>([])
  const [data, setData] = useState<Page<MovementRow> | null>(null)
  const [exporting, setExporting] = useState<boolean>(false)

  // 载入渠道列表
  useEffect(() => {
    let alive = true
    unwrap(window.api.erp.channels.list())
      .then((chs) => {
        if (alive) setChannels(chs)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 载入变动流水
  const load = useCallback(async () => {
    try {
      const res = await unwrap(
        window.api.erp.inventory.listMovements({
          skuId: product.defaultSku.id,
          kind: kind === 'all' ? undefined : (kind as MovementKind),
          channelId: channelId === 'all' ? undefined : Number(channelId),
          from: range.from || undefined,
          to: range.to || undefined,
          docNo: docNo.trim() || undefined,
          page,
          pageSize: PAGE_SIZE
        })
      )
      setData(res)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [product.defaultSku.id, kind, channelId, range.from, range.to, docNo, page, toast])

  useEffect(() => {
    const timer = setTimeout(() => void load(), docNo ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, docNo, refreshKey])

  // 导出该商品流水
  const handleExportCsv = async (): Promise<void> => {
    setExporting(true)
    try {
      const p = await unwrap(
        window.api.erp.csv.exportMovements({
          skuId: product.defaultSku.id,
          kind: kind === 'all' ? undefined : (kind as MovementKind),
          channelId: channelId === 'all' ? undefined : Number(channelId),
          from: range.from || undefined,
          to: range.to || undefined,
          docNo: docNo.trim() || undefined
        })
      )
      if (p) toast(`已导出该商品流水到: ${p}`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setExporting(false)
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--erp-space-3)' }}>
      {/* 筛选工具栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--erp-space-2)',
          flexWrap: 'wrap'
        }}
      >
        <div style={{ width: 110 }}>
          <Select
            options={KIND_OPTIONS}
            value={kind}
            onChange={(val) => {
              setKind(val)
              setPage(1)
            }}
          />
        </div>

        <div style={{ width: 120 }}>
          <Select
            options={[
              { value: 'all', label: '全部渠道' },
              ...channels.map((c) => ({ value: String(c.id), label: c.name }))
            ]}
            value={channelId}
            onChange={(val) => {
              setChannelId(val)
              setPage(1)
            }}
          />
        </div>

        <DateRangePicker
          value={range}
          onChange={(newRange) => {
            setRange(newRange)
            setPage(1)
          }}
        />

        <div style={{ flex: 1, minWidth: 140 }}>
          <Input
            value={docNo}
            onChange={(e) => {
              setDocNo(e.target.value)
              setPage(1)
            }}
            placeholder="搜单号 / 订单号"
          />
        </div>

        <IconButton
          label="导出当前流水 CSV"
          icon={<Download size={14} />}
          variant="secondary"
          size="sm"
          disabled={exporting || !data || data.total === 0}
          onClick={handleExportCsv}
        />
      </div>

      {/* 变动记录表格 */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>单号</th>
              <th>渠道 · 订单号</th>
              <th className={styles.num}>数量</th>
              <th className={styles.num}>成本</th>
              <th className={styles.num}>结存</th>
            </tr>
          </thead>
          <tbody>
            {!data || data.rows.length === 0 ? (
              <TableEmpty cols={7} title="暂无符合条件的变动流水" />
            ) : (
              data.rows.map((m) => (
                <tr
                  key={m.id}
                  className={m.kind === 'void' ? styles.voidRow : undefined}
                  onClick={() => onOpenDocument?.(m.documentId)}
                  data-clickable={onOpenDocument ? '' : undefined}
                >
                  <td className={styles.time}>{formatOccurred(m.occurredAt)}</td>
                  <td>
                    {m.kind === 'void' ? <Badge variant="neutral">作废冲回</Badge> : <DocTypeBadge type={m.kind} />}
                  </td>
                  <td className={styles.docNo}>{m.docNo}</td>
                  <td className={styles.channel} title={[m.channelName, m.externalOrderNo].filter(Boolean).join(' · ')}>
                    {[m.channelName, m.externalOrderNo].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className={`${styles.num} ${styles.qty}`}>{signedQty(m.quantityDelta)}</td>
                  <td className={`${styles.num} ${styles.muted}`}>¥{formatCents(m.unitCostCents)}</td>
                  <td className={styles.num}>{formatQty(m.quantityAfter)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 分页控制区 */}
      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 'var(--erp-font-size-xs)',
            color: 'var(--erp-text-secondary)'
          }}
        >
          <span>共 {data?.total ?? 0} 条变动流水</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--erp-space-2)' }}>
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft size={14} /> 上一页
            </Button>
            <span>
              {page} / {totalPages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              下一页 <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// #endregion
