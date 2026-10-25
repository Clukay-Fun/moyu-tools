/**
 * 描述: 商品管理工作台页面 (ProductsPage)
 * 主要功能:
 *   - 顶部只有一行工具条：搜索、商品总数、显示已停用，右侧固定「新建商品」与「更多」；下面是三列商品卡，不套外框
 *   - 商品卡：1:1 大图、名称、编码 / SKU、库存 / 平均成本 / 售价、底栏预警值与「查看详情」
 *   - 库存告急 / 缺货在卡片图片右上角显示徽标；不展示可售天数
 *   - 搜索与「显示已停用」保留；整卡点击打开商品详情
 *   - 预警值编辑移到详情弹窗的「编辑」，列表不再就地编辑
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, MoreVertical, Upload, Download, ImageIcon, ArrowUpRight } from 'lucide-react'
import type { StockRow } from '@shared/erp/types'
import type { ProductHealthItem } from '@shared/erp/schemas'
import { Button, IconButton, Input, Menu, StockBadge, isStockAlert } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { formatCents, formatQty } from '@erp/lib/format'
import { productImageUrl } from '@erp/features/products/ProductImage'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import { useDataChanged } from '@erp/lib/dataEvents'
import { usePageActive } from '@erp/app/usePageActive'
import styles from './ProductsPage.module.css'

export function ProductsPage(): React.JSX.Element {
  const toast = useToast()
  const { visit } = usePageActive('products')
  const { openProduct, newProduct, openImport } = useEntityDrawers()

  const [rows, setRows] = useState<StockRow[] | null>(null)
  const [healthItems, setHealthItems] = useState<ProductHealthItem[]>([])
  const [loadError, setLoadError] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(true)
  const [search, setSearch] = useState<string>('')
  const [showInactive, setShowInactive] = useState<boolean>(false)
  const [exporting, setExporting] = useState<boolean>(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [stockList, healthList] = await Promise.all([
        unwrap(window.api.erp.inventory.listStock()),
        unwrap(window.api.erp.stats.getProductHealth())
      ])
      setRows(stockList)
      setHealthItems(healthList)
      setLoadError(false)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // 从别的页面切回来时刷新库存与健康度
  useEffect(() => {
    if (visit > 0) void loadData()
  }, [visit, loadData])

  useDataChanged(() => void loadData())

  const healthByProduct = useMemo(() => new Map(healthItems.map((h) => [h.productId, h])), [healthItems])

  const filteredRows = useMemo(() => {
    if (!rows) return []
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (!showInactive && !r.product.isActive) return false
      if (!q) return true
      return (
        r.product.name.toLowerCase().includes(q) ||
        r.product.code.toLowerCase().includes(q) ||
        r.product.defaultSku.code.toLowerCase().includes(q)
      )
    })
  }, [rows, search, showInactive])

  const handleExportAllMovements = async (): Promise<void> => {
    setExporting(true)
    try {
      const p = await unwrap(window.api.erp.csv.exportMovements({}))
      if (p) toast(`已导出全部流水到: ${p}`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setExporting(false)
    }
  }

  const moreMenuItems = [
    { key: 'import-csv', label: '导入 CSV', icon: <Upload size={14} />, onClick: openImport },
    {
      key: 'export-all-movements',
      label: exporting ? '正在导出…' : '导出全部流水 CSV',
      icon: <Download size={14} />,
      disabled: exporting,
      onClick: handleExportAllMovements
    }
  ]

  return (
    <div className={styles.container}>
      <h1 className="srOnly">商品</h1>

      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索商品名称 / 编码 / SKU" />
        </div>
        <span className={styles.countText}>共 {filteredRows.length} 个商品</span>
        <label className={styles.switchLabel}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          <span>显示已停用</span>
        </label>
        <div className={styles.toolActions}>
          <Button variant="primary" onClick={newProduct}>
            <Plus size={16} /> 新建商品
          </Button>
          <Menu
            align="end"
            trigger={<IconButton label="更多选项" icon={<MoreVertical size={16} />} variant="secondary" />}
            items={moreMenuItems}
          />
        </div>
      </div>

      {loadError && (
        <div className={styles.loadError} role="alert">
          <span>
            <strong>读取失败</strong>商品与库存数据未能加载。
          </span>
          <Button size="sm" variant="secondary" onClick={() => void loadData()} disabled={loading}>
            {loading ? '重试中…' : '重试'}
          </Button>
        </div>
      )}

      <div className={styles.gridWrap}>
        {rows === null ? (
          <div className={styles.gridState}>{loadError ? '读取失败' : '正在读取商品…'}</div>
        ) : filteredRows.length === 0 ? (
          <div className={styles.gridState}>暂无符合条件的商品记录</div>
        ) : (
          <div className={styles.grid}>
            {filteredRows.map((r) => {
              const p = r.product
              const health = healthByProduct.get(p.id)
              const url = productImageUrl(p)
              const alert = health ? isStockAlert(health.status) : false

              return (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.card} ${!p.isActive ? styles.inactive : ''}`}
                  data-product-card
                  aria-label={`${p.name}，当前库存 ${formatQty(r.stock.quantity)} ${p.unit}`}
                  onClick={() => void openProduct(p.id)}
                >
                  <span className={styles.imageWrap}>
                    {url ? (
                      <img src={url} alt={p.name} loading="lazy" />
                    ) : (
                      <ImageIcon size={36} strokeWidth={1.2} className={styles.imagePlaceholder} />
                    )}
                    {!p.isActive ? (
                      <span className={styles.badgeSlot}>
                        <StockBadge status="inactive" />
                      </span>
                    ) : alert && health ? (
                      <span className={styles.badgeSlot}>
                        <StockBadge status={health.status} />
                      </span>
                    ) : null}
                  </span>

                  <span className={styles.cardBody}>
                    <span className={styles.productName} title={p.name}>
                      {p.name}
                    </span>
                    <span className={styles.productMeta}>
                      {p.code} · <span className="mono">{p.defaultSku.code}</span>
                    </span>

                    <span className={styles.metrics}>
                      <span className={styles.metric}>
                        <span className={styles.metricLabel}>当前库存</span>
                        <span className={styles.metricValue}>
                          {formatQty(r.stock.quantity)} {p.unit}
                        </span>
                      </span>
                      <span className={styles.metric}>
                        <span className={styles.metricLabel}>平均成本</span>
                        <span className={styles.metricValue}>
                          {r.stock.quantity > 0 ? `¥${formatCents(r.stock.avgCostCents)}` : '—'}
                        </span>
                      </span>
                      <span className={styles.metric}>
                        <span className={styles.metricLabel}>默认售价</span>
                        <span className={styles.metricValue}>
                          {p.defaultPriceCents > 0 ? `¥${formatCents(p.defaultPriceCents)}` : '—'}
                        </span>
                      </span>
                    </span>

                    <span className={styles.cardFooter}>
                      <span className={styles.threshold}>
                        库存预警值 {formatQty(p.lowStockThreshold)} {p.unit}
                      </span>
                      <span className={styles.detailLink}>
                        查看详情 <ArrowUpRight size={13} />
                      </span>
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
