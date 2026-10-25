/**
 * 描述: 概览工作台页面 (OverviewPage)
 * 主要功能:
 *   - 草稿提醒条：一张直接打开，多张进入已筛选的草稿列表
 *   - 四张 KPI：出库额、出库毛利、当前库存成本、最短可售天数
 *   - 全宽出入库趋势双折线，拥有独立的近 7 天 / 近 30 天 / 自定义区间
 *   - 全宽最近单据表格，日期筛选与趋势互不影响
 *   - 排版按《综合页》概览原型：卡头只放标题，日期筛选单独一行放在卡头下面
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, FileEdit, ImageIcon, RotateCw } from 'lucide-react'
import type { DocumentSummary } from '@shared/erp/types'
import type { DailySeriesItem, ProductHealthItem, StatsSummaryResult } from '@shared/erp/schemas'
import {
  Button,
  ConfirmDialog,
  DocStatusBadge,
  DocTypeBadge,
  EmptyState,
  Panel,
  RangeFilter,
  StatCard,
  TableEmpty,
  presetRange,
  type DateRange
} from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import { useDataChanged } from '@erp/lib/dataEvents'
import { useNav } from '@erp/app/navigation'
import { usePageActive } from '@erp/app/usePageActive'
import { unwrap, errorMessage } from '@erp/lib/api'
import { formatCents, formatQty } from '@erp/lib/format'
import { TrendChart } from '@erp/features/overview/TrendChart'
import styles from './OverviewPage.module.css'

/** KPI 固定统计口径：近 30 天（用户 2026-10-21 确认） */
const KPI_RANGE = presetRange('30d')

export function OverviewPage(): React.JSX.Element {
  const { navigate } = useNav()
  const { visit } = usePageActive('overview')
  const toast = useToast()
  const { openProduct, openDocument, newProduct, openImport } = useEntityDrawers()

  // 基础数据：KPI 汇总、库存健康度、草稿、单据列表
  const [summary, setSummary] = useState<StatsSummaryResult | null>(null)
  const [health, setHealth] = useState<ProductHealthItem[]>([])
  const [pendingDrafts, setPendingDrafts] = useState<DocumentSummary[]>([])
  const [allDocs, setAllDocs] = useState<DocumentSummary[] | null>(null)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [baseLoading, setBaseLoading] = useState(true)
  const [seedConfirmOpen, setSeedConfirmOpen] = useState(false)

  // 趋势图与最近单据各自的日期区间
  const [trendRange, setTrendRange] = useState<DateRange>(KPI_RANGE)
  const [trendData, setTrendData] = useState<DailySeriesItem[] | null>(null)
  const [trendError, setTrendError] = useState<string | null>(null)
  const [trendLoading, setTrendLoading] = useState(true)
  const [recentRange, setRecentRange] = useState<DateRange>(KPI_RANGE)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadBase = useCallback(async () => {
    try {
      const [sum, healthRows, drafts, docs] = await Promise.all([
        unwrap(window.api.erp.stats.getSummary(KPI_RANGE)),
        unwrap(window.api.erp.stats.getProductHealth()),
        unwrap(window.api.erp.documents.list({ status: 'draft', limit: 200 })),
        unwrap(window.api.erp.documents.list({ limit: 200 }))
      ])
      setSummary(sum)
      setHealth(healthRows)
      setPendingDrafts(drafts)
      setAllDocs(docs)
      setBaseError(null)
    } catch (err) {
      setBaseError(errorMessage(err))
    } finally {
      setBaseLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBase()
  }, [loadBase])

  // 从其他页面切回来时刷新（页面常驻后不再靠重新挂载）
  useEffect(() => {
    if (visit === 0) return
    void loadBase()
    setRefreshKey((k) => k + 1)
  }, [visit, loadBase])

  useDataChanged(() => {
    void loadBase()
    setRefreshKey((k) => k + 1)
  })

  // 趋势数据：只统计已生效单据，失败时显示错误，不把失败当 0
  useEffect(() => {
    let alive = true
    setTrendLoading(true)
    unwrap(window.api.erp.stats.getDailySeries({ from: trendRange.from, to: trendRange.to }))
      .then((rows) => {
        if (!alive) return
        setTrendData(rows)
        setTrendError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setTrendData(null)
        setTrendError(errorMessage(err))
      })
      .finally(() => {
        if (alive) setTrendLoading(false)
      })
    return () => {
      alive = false
    }
  }, [trendRange, refreshKey])

  const outboundDrafts = useMemo(() => pendingDrafts.filter((d) => d.type === 'outbound'), [pendingDrafts])

  const stockCostCents = useMemo(() => health.reduce((acc, item) => acc + item.costValueCents, 0), [health])
  const stockQty = useMemo(() => health.reduce((acc, item) => acc + item.stock, 0), [health])

  const shortestSupply = useMemo(() => {
    const valid = health.filter((p) => p.status !== 'inactive' && p.daysOfSupply !== null)
    if (valid.length === 0) return null
    return [...valid].sort(
      (a, b) => (a.daysOfSupply ?? Number.MAX_SAFE_INTEGER) - (b.daysOfSupply ?? Number.MAX_SAFE_INTEGER)
    )[0]
  }, [health])

  const recentDocs = useMemo(() => {
    if (!allDocs) return []
    return allDocs
      .filter(
        (d) => (!recentRange.from || d.docDate >= recentRange.from) && (!recentRange.to || d.docDate <= recentRange.to)
      )
      .slice(0, 8)
  }, [allDocs, recentRange])

  const firstDraft = outboundDrafts[0] ?? null

  const handleDraftClick = (): void => {
    if (outboundDrafts.length === 1 && firstDraft) void openDocument(firstDraft.id)
    else navigate('documents', { documents: { status: 'draft' } })
  }

  const handleSeed = async (): Promise<void> => {
    try {
      await unwrap(window.api.erp.demo.seed())
      setSeedConfirmOpen(false)
      await loadBase()
      setRefreshKey((k) => k + 1)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  // 首次进入且没有任何商品时的空态
  if (!baseLoading && !baseError && health.length === 0) {
    return (
      <div className={styles.container}>
        <h1 className="srOnly">概览</h1>
        <EmptyState
          icon={<ImageIcon size={32} className={styles.emptyIcon} />}
          title="还没有商品，从这里开始"
          description="建立你的第一份商品画像，或者快速载入示例数据体验工作台完整能力。"
          actions={[
            { label: '新建第一个商品', variant: 'primary', onClick: newProduct },
            { label: '导入 CSV', variant: 'secondary', onClick: openImport },
            { label: '载入示例数据', variant: 'secondary', onClick: () => setSeedConfirmOpen(true) }
          ]}
        />
        <ConfirmDialog
          open={seedConfirmOpen}
          onOpenChange={setSeedConfirmOpen}
          title="载入示例数据"
          description="载入示例数据将生成预设商品、期初库存以及真实的出入库单据记录。确认载入吗？"
          confirmText="确认载入"
          onConfirm={() => void handleSeed()}
        />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <h1 className="srOnly">概览</h1>

      {baseError && (
        <div className={styles.baseError} role="alert">
          <AlertTriangle size={14} />
          <span>概览数据读取失败：{baseError}</span>
          <Button size="sm" variant="secondary" onClick={() => void loadBase()}>
            重试
          </Button>
        </div>
      )}

      {/* 1. 草稿提醒 */}
      <button
        type="button"
        className={`${styles.draftBar} ${outboundDrafts.length > 0 ? styles.draftActive : ''}`}
        onClick={handleDraftClick}
      >
        <span className={styles.draftLeft}>
          {outboundDrafts.length > 0 ? (
            <>
              <FileEdit size={15} className={styles.draftIcon} />
              <strong>{outboundDrafts.length} 张出库草稿待处理</strong>
              {firstDraft && (
                <span className={styles.draftMeta}>
                  {firstDraft.docNo} · {formatQty(firstDraft.totalQuantity)} 件{outboundDrafts.length > 1 ? ' 等' : ''}
                </span>
              )}
            </>
          ) : (
            <>
              <CheckCircle2 size={15} className={styles.draftOkIcon} />
              <span>暂无待处理的出库草稿</span>
            </>
          )}
        </span>
        <span className={styles.draftAction}>
          查看并处理 <ChevronRight size={14} />
        </span>
      </button>

      {/* 2. 四张 KPI，固定近 30 天口径 */}
      <section className={styles.kpiGrid} aria-label="核心经营指标">
        <StatCard
          size="lg"
          label="出库额"
          extra={<span className={styles.scope}>近 30 天</span>}
          value={summary ? `¥${formatCents(summary.current.outAmountCents)}` : baseLoading ? '…' : '—'}
          subtext={
            summary
              ? `${formatQty(summary.current.outQty)} 件 · ${summary.current.outDocCount} 单`
              : baseError
                ? '数据读取失败'
                : '近 30 天无出库记录'
          }
          onClick={() =>
            navigate('documents', { documents: { type: 'outbound', from: KPI_RANGE.from, to: KPI_RANGE.to } })
          }
        />
        <StatCard
          size="lg"
          label="出库毛利"
          extra={<span className={styles.scope}>近 30 天</span>}
          value={
            summary ? (
              <span className={summary.current.profitCents < 0 ? styles.negative : undefined}>
                ¥{formatCents(summary.current.profitCents)}
              </span>
            ) : baseLoading ? (
              '…'
            ) : (
              '—'
            )
          }
          subtext={
            summary
              ? summary.current.outAmountCents > 0
                ? `毛利率 ${(summary.current.profitRate * 100).toFixed(1)}%`
                : '近 30 天无出库记录'
              : baseError
                ? '数据读取失败'
                : '售价 − 成本快照'
          }
          onClick={() =>
            navigate('documents', { documents: { type: 'outbound', from: KPI_RANGE.from, to: KPI_RANGE.to } })
          }
        />
        <StatCard
          size="lg"
          label="当前库存成本"
          extra={<span className={styles.scope}>当前快照</span>}
          value={baseLoading ? '…' : `¥${formatCents(stockCostCents)}`}
          subtext={`${formatQty(stockQty)} 件 · ${health.length} 个商品`}
          onClick={() => navigate('products')}
        />
        <StatCard
          size="lg"
          label="最短可售天数"
          extra={<span className={styles.scope}>近 30 天</span>}
          value={
            shortestSupply && shortestSupply.daysOfSupply !== null
              ? `${shortestSupply.daysOfSupply} 天`
              : baseLoading
                ? '…'
                : '—'
          }
          subtext={shortestSupply ? shortestSupply.name : baseError ? '数据读取失败' : '近 30 天无出库样本'}
          onClick={() => (shortestSupply ? void openProduct(shortestSupply.productId) : navigate('products'))}
        />
      </section>

      {/* 3. 全宽趋势图 */}
      <Panel title="出入库趋势" flush>
        <div className={styles.filterBar}>
          <RangeFilter label="趋势统计区间" value={trendRange} onChange={setTrendRange} />
        </div>
        <div className={styles.chartArea}>
          {trendError ? (
            <div className={styles.errorBlock} role="alert">
              <span>趋势数据读取失败：{trendError}</span>
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCw size={13} />}
                onClick={() => {
                  setTrendError(null)
                  setRefreshKey((k) => k + 1)
                }}
              >
                重试
              </Button>
            </div>
          ) : trendData === null ? (
            <div className={styles.loadingBlock}>{trendLoading ? '正在读取趋势数据…' : '暂无趋势数据'}</div>
          ) : (
            <TrendChart data={trendData} height={300} />
          )}
        </div>
      </Panel>

      {/* 4. 全宽最近单据 */}
      <Panel title="最近单据" flush>
        <div className={styles.filterBar}>
          <RangeFilter label="最近单据日期区间" value={recentRange} onChange={setRecentRange} />
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.recentTable}>
            <thead>
              <tr>
                <th>单据编号</th>
                <th>类型</th>
                <th>日期</th>
                <th>渠道</th>
                <th>数量</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {allDocs === null ? (
                <TableEmpty cols={6} title="正在读取单据…" />
              ) : recentDocs.length === 0 ? (
                <TableEmpty cols={6} title="这个日期范围内没有单据" description="换一个日期区间，或去单据页开单" />
              ) : (
                recentDocs.map((doc) => (
                  <tr
                    key={doc.id}
                    className={`${styles.row} ${doc.status === 'voided' ? styles.voided : ''}`}
                    tabIndex={0}
                    onClick={() => void openDocument(doc.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void openDocument(doc.id)
                    }}
                  >
                    <td className={styles.docNo}>{doc.docNo}</td>
                    <td>
                      <DocTypeBadge type={doc.type} />
                    </td>
                    <td className={styles.date}>{doc.docDate}</td>
                    <td className={styles.secondary}>{doc.channelName || '—'}</td>
                    <td className={styles.qty}>{formatQty(doc.totalQuantity)} 件</td>
                    <td>
                      <DocStatusBadge status={doc.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <ConfirmDialog
        open={seedConfirmOpen}
        onOpenChange={setSeedConfirmOpen}
        title="载入示例数据"
        description="载入示例数据将生成预设商品、期初库存以及真实的出入库单据记录。确认载入吗？"
        confirmText="确认载入"
        onConfirm={() => void handleSeed()}
      />
    </div>
  )
}
