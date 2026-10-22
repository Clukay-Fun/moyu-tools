/**
 * 描述: 商品右侧抽屉流核心组件 (ProductDrawerContent)
 * 主要功能:
 *   - 查看模式：166px 主图、商品信息、5 格 StatCard 财务概要、期初信息条与就地补录
 *   - 调整库存：内嵌统一 AdjustmentForm 折叠表单，支持动态计算与差额盘点
 *   - 变动流水：嵌入多维筛选与分页的 ProductMovements 变动记录
 *   - 编辑与新建模式：集成于右侧抽屉内，支持编码 SKU 动态关联、脏状态离开二次确认
 */

import React, { useState, useEffect, useCallback, type FormEvent } from 'react'
import { Pencil, MoreVertical, Scale, PackagePlus, Power } from 'lucide-react'
import type { Product, StockLevel, DocumentSummary, DocumentDetail } from '@shared/erp/types'
import type { ProductHealthItem } from '@shared/erp/schemas'
import {
  Button,
  IconButton,
  Input,
  NumberInput,
  StatCard,
  Menu,
  StockBadge,
  isStockAlert,
  useDrawer
} from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { formatCents, formatQty, parseCents, todayString } from '@erp/lib/format'
import { ProductImage } from './ProductImage'
import { AdjustmentForm } from '@erp/features/adjustments/AdjustmentForm'
import { ProductMovements } from './ProductMovements'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import styles from './ProductDrawerContent.module.css'

// #region 类型与参数接口

export interface ProductDrawerContentProps {
  /** 初始模式：查看、编辑或新建 */
  initialMode?: 'view' | 'edit' | 'create'
  /** 目标商品（新建模式下为 null） */
  product: Product | null
  /** 健康指标数据（可选） */
  healthItem?: ProductHealthItem | null
  /** 数据更新通知 */
  onDataChanged?: () => void
}

interface FormState {
  code: string
  name: string
  unit: string
  defaultCost: string
  defaultPrice: string
  lowStockThreshold: number
  isActive: boolean
}

function formFromProduct(product: Product | null): FormState {
  return {
    code: product?.code ?? '',
    name: product?.name ?? '',
    unit: product?.unit ?? '件',
    defaultCost: product ? formatCents(product.defaultCostCents).replaceAll(',', '') : '',
    defaultPrice: product ? formatCents(product.defaultPriceCents).replaceAll(',', '') : '',
    lowStockThreshold: product?.lowStockThreshold ?? 0,
    isActive: product?.isActive ?? true
  }
}

// #endregion

// #region ProductDrawerContent 主组件

/**
 * 用处: 商品抽屉内容区组件，承接详情、调整、期初与编辑表单
 * 功能:
 *   - 彻底废止居中模态弹窗套弹窗，收敛为丝滑的右侧工作台抽屉流
 */
export function ProductDrawerContent({
  initialMode = 'view',
  product: initialProduct,
  healthItem,
  onDataChanged
}: ProductDrawerContentProps): React.JSX.Element {
  const toast = useToast()
  const { closeDrawer, setDirty, setTitle } = useDrawer()
  const { openDocument } = useEntityDrawers()

  const [mode, setMode] = useState<'view' | 'edit' | 'create'>(initialMode)
  const [product, setProduct] = useState<Product | null>(initialProduct)
  const [stock, setStock] = useState<StockLevel | null>(null)
  const [currentHealthItem, setCurrentHealthItem] = useState<ProductHealthItem | null>(healthItem ?? null)
  const [opening, setOpening] = useState<DocumentSummary | null>(null)
  const [adjustOpen, setAdjustOpen] = useState<boolean>(false)
  const [openingFormOpen, setOpeningFormOpen] = useState<boolean>(false)
  const [movementRefreshKey, setMovementRefreshKey] = useState<number>(0)

  // 1. 表单状态与脏检测
  const [form, setForm] = useState<FormState>(() => formFromProduct(initialProduct))
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [saving, setSaving] = useState<boolean>(false)

  // 2. 期初内嵌录入状态
  const [openingQty, setOpeningQty] = useState<number | null>(null)
  const [openingUnitCost, setOpeningUnitCost] = useState<string>(
    initialProduct ? formatCents(initialProduct.defaultCostCents).replaceAll(',', '') : ''
  )
  const [openingDate, setOpeningDate] = useState<string>(todayString())
  const [openingNote, setOpeningNote] = useState<string>('')
  const [openingSaving, setOpeningSaving] = useState<boolean>(false)

  const handleOpenDocument = openDocument

  // 刷新当前商品详情与期初
  const refreshProductData = useCallback(async (p: Product) => {
    try {
      const [s, o, health] = await Promise.all([
        unwrap(window.api.erp.inventory.getStock(p.defaultSku.id)),
        unwrap(window.api.erp.opening.get(p.defaultSku.id)).catch(() => null),
        unwrap(window.api.erp.stats.getProductHealth())
          .then((items) => items.find((item) => item.productId === p.id) ?? null)
          .catch(() => null)
      ])
      setStock(s)
      setOpening(o)
      setCurrentHealthItem(health)
    } catch {
      // 忽略部分初始化读取异常
    }
  }, [])

  useEffect(() => {
    if (product) {
      setForm(formFromProduct(product))
      setFormErrors({})
      void refreshProductData(product)
    }
  }, [product, refreshProductData])

  // #region 查看模式交互处理

  // 切换商品停用/启用状态
  const handleToggleActive = async (): Promise<void> => {
    if (!product) return
    try {
      const updated = await unwrap(
        window.api.erp.products.update(product.id, {
          code: product.code,
          name: product.name,
          unit: product.unit,
          defaultCostCents: product.defaultCostCents,
          defaultPriceCents: product.defaultPriceCents,
          lowStockThreshold: product.lowStockThreshold,
          isActive: !product.isActive
        })
      )
      setProduct(updated)
      toast(updated.isActive ? '商品已启用' : '商品已停用', 'success')
      onDataChanged?.()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  // 导出单商品变动流水
  const handleExportMovements = async (): Promise<void> => {
    if (!product) return
    try {
      const path = await unwrap(window.api.erp.csv.exportMovements({ skuId: product.defaultSku.id }))
      if (path) toast(`已导出流水到: ${path}`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  // 调整成功回调
  const handleAdjustmentSuccess = (_doc: DocumentDetail): void => {
    setAdjustOpen(false)
    setMovementRefreshKey((key) => key + 1)
    if (product) void refreshProductData(product)
    onDataChanged?.()
  }

  // 录入期初提交
  const handleOpeningSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!product || openingQty === null || openingQty < 1) {
      toast('请输入有效的期初数量', 'error')
      return
    }
    const costCents = parseCents(openingUnitCost)
    if (costCents === null || costCents < 0) {
      toast('请输入有效的期初单价', 'error')
      return
    }

    setOpeningSaving(true)
    try {
      await unwrap(
        window.api.erp.opening.create({
          skuId: product.defaultSku.id,
          quantity: openingQty,
          unitCostCents: costCents,
          docDate: openingDate,
          note: openingNote.trim()
        })
      )
      toast('期初库存录入成功', 'success')
      setOpeningFormOpen(false)
      setMovementRefreshKey((key) => key + 1)
      await refreshProductData(product)
      onDataChanged?.()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setOpeningSaving(false)
    }
  }

  // #endregion

  // #region 表单与编辑新建处理

  const updateField = <K extends keyof FormState>(k: K, val: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [k]: val }))
    setDirty(true)
  }

  // 保存商品修改或新建
  const handleSaveProduct = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const nextErrors: Partial<Record<keyof FormState, string>> = {}

    if (!form.code.trim()) nextErrors.code = '请输入商品编码'
    if (!form.name.trim()) nextErrors.name = '请输入商品名称'
    if (!form.unit.trim()) nextErrors.unit = '请输入商品单位'

    const costCents = parseCents(form.defaultCost)
    const priceCents = parseCents(form.defaultPrice)
    if (costCents === null) nextErrors.defaultCost = '请输入非负金额'
    if (priceCents === null) nextErrors.defaultPrice = '请输入非负金额'

    setFormErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setSaving(true)
    try {
      if (mode === 'create') {
        const created = await unwrap(
          window.api.erp.products.create({
            code: form.code.trim(),
            name: form.name.trim(),
            unit: form.unit.trim(),
            defaultCostCents: costCents ?? 0,
            defaultPriceCents: priceCents ?? 0,
            lowStockThreshold: form.lowStockThreshold ?? 0,
            isActive: true
          })
        )
        toast('商品创建成功', 'success')
        setDirty(false)
        setProduct(created)
        setTitle(created.name)
        setMode('view')
        onDataChanged?.()
      } else if (product) {
        const updated = await unwrap(
          window.api.erp.products.update(product.id, {
            code: form.code.trim(),
            name: form.name.trim(),
            unit: form.unit.trim(),
            defaultCostCents: costCents ?? 0,
            defaultPriceCents: priceCents ?? 0,
            lowStockThreshold: form.lowStockThreshold ?? 0,
            isActive: form.isActive
          })
        )
        toast('商品修改已保存', 'success')
        setDirty(false)
        setProduct(updated)
        setTitle(updated.name)
        setMode('view')
        onDataChanged?.()
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  // #endregion

  // #region 渲染分流

  if (mode === 'edit' || mode === 'create') {
    return (
      <form onSubmit={handleSaveProduct} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className={styles.wrap} style={{ flex: 1, overflowY: 'auto' }}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>商品编码</label>
            <Input value={form.code} onChange={(e) => updateField('code', e.target.value)} placeholder="例如：FG002" />
            {mode === 'create' && (
              <span className={styles.fieldHint}>
                SKU 将自动生成为 {form.code.trim() ? `${form.code.trim()}-DEFAULT` : '—'}
              </span>
            )}
            {formErrors.code && <span className={styles.fieldError}>{formErrors.code}</span>}
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>商品名称</label>
            <Input
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="例如：高透亚克力双层立牌 15cm"
            />
            {formErrors.name && <span className={styles.fieldError}>{formErrors.name}</span>}
          </div>

          <div className={styles.formRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>计量单位</label>
              <Input
                value={form.unit}
                onChange={(e) => updateField('unit', e.target.value)}
                placeholder="件 / 个 / 套"
              />
              {formErrors.unit && <span className={styles.fieldError}>{formErrors.unit}</span>}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>库存预警阈值</label>
              <NumberInput
                value={form.lowStockThreshold}
                onChange={(val) => updateField('lowStockThreshold', val ?? 0)}
                min={0}
                step={1}
              />
            </div>
          </div>

          <div className={styles.formRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>默认进价 (元)</label>
              <Input
                value={form.defaultCost}
                onChange={(e) => updateField('defaultCost', e.target.value)}
                placeholder="0.00"
              />
              {formErrors.defaultCost && <span className={styles.fieldError}>{formErrors.defaultCost}</span>}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>默认售价 (元)</label>
              <Input
                value={form.defaultPrice}
                onChange={(e) => updateField('defaultPrice', e.target.value)}
                placeholder="0.00"
              />
              {formErrors.defaultPrice && <span className={styles.fieldError}>{formErrors.defaultPrice}</span>}
            </div>
          </div>

          {mode === 'edit' && (
            <div className={styles.switchRow}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--erp-space-2)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => updateField('isActive', e.target.checked)}
                />
                <span style={{ fontSize: 'var(--erp-font-size-xs)' }}>启用此商品（允许正常出入库与开单）</span>
              </label>
            </div>
          )}
        </div>

        {/* 底部固定操作栏 */}
        <div className={styles.stickyFooter}>
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              setDirty(false)
              setForm(formFromProduct(mode === 'edit' ? product : null))
              setFormErrors({})
              if (mode === 'create') {
                closeDrawer()
              } else {
                setMode('view')
              }
            }}
          >
            取消
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存商品资料'}
          </Button>
        </div>
      </form>
    )
  }

  if (!product) return <div style={{ padding: 'var(--erp-space-4)' }}>未找到商品</div>

  // #endregion

  // #region 查看模式主渲染

  const healthStatus = currentHealthItem?.status
  const menuItems = [
    {
      key: 'toggle-active',
      label: product.isActive ? '停用此商品' : '重新启用商品',
      icon: <Power size={14} />,
      onClick: handleToggleActive
    },
    {
      key: 'export-movements',
      label: '导出商品流水 CSV',
      onClick: handleExportMovements
    }
  ]

  return (
    <div className={styles.wrap}>
      {/* 1. 头部画像卡 */}
      <div className={styles.viewHeader}>
        <div className={styles.profileInfo}>
          <ProductImage product={product} onChanged={(p) => setProduct(p)} size={166} />
          <div className={styles.profileMeta}>
            <span className={styles.productName}>{product.name}</span>
            <span className={styles.productSub}>
              {product.code} · <span className="mono">{product.defaultSku.code}</span> · {product.unit}
            </span>
            {(!product.isActive || (healthStatus && isStockAlert(healthStatus))) && (
              <span className={styles.badges}>
                {!product.isActive ? (
                  <StockBadge status="inactive" />
                ) : (
                  healthStatus && <StockBadge status={healthStatus} />
                )}
              </span>
            )}
          </div>
        </div>

        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setForm(formFromProduct(product))
              setFormErrors({})
              setDirty(false)
              setMode('edit')
            }}
          >
            <Pencil size={14} /> 编辑
          </Button>
          <Menu
            trigger={<IconButton label="更多操作" icon={<MoreVertical size={14} />} variant="ghost" size="sm" />}
            items={menuItems}
          />
        </div>
      </div>

      {/* 2. 5 格核心 StatCard 概览网格（可售天数不在指标区） */}
      <div className={styles.statGrid}>
        <StatCard
          size="sm"
          label="当前库存"
          value={`${formatQty(stock?.quantity ?? 0)} ${product.unit}`}
          subtext={`预警值 ${formatQty(product.lowStockThreshold)} ${product.unit}`}
        />
        <StatCard
          size="sm"
          label="平均成本"
          value={stock && stock.quantity > 0 ? `¥${formatCents(stock.avgCostCents)}` : '—'}
        />
        <StatCard size="sm" label="库存成本" value={`¥${formatCents(stock?.costValueCents ?? 0)}`} />
        <StatCard size="sm" label="默认进价" value={`¥${formatCents(product.defaultCostCents)}`} />
        <StatCard size="sm" label="默认售价" value={`¥${formatCents(product.defaultPriceCents)}`} />
      </div>

      {/* 3. 期初信息条与补录 */}
      <div className={styles.openingCard}>
        <div className={styles.openingHeader}>
          <span>期初</span>
          {!opening && product.isActive && !openingFormOpen && (
            <Button size="sm" variant="secondary" onClick={() => setOpeningFormOpen(true)}>
              <PackagePlus size={14} /> 录入期初库存
            </Button>
          )}
        </div>

        {opening ? (
          <div className={styles.openingGrid}>
            <div className={styles.openingStat}>
              <span className={styles.openingStatLabel}>期初单号</span>
              <button type="button" className={styles.openingLink} onClick={() => handleOpenDocument(opening.id)}>
                {opening.docNo}
              </button>
            </div>
            <div className={styles.openingStat}>
              <span className={styles.openingStatLabel}>业务日期</span>
              <span className={styles.openingStatVal}>{opening.docDate}</span>
            </div>
            <div className={styles.openingStat}>
              <span className={styles.openingStatLabel}>期初数量</span>
              <span className={styles.openingStatVal}>
                {formatQty(opening.totalQuantity)} {product.unit}
              </span>
            </div>
            <div className={styles.openingStat}>
              <span className={styles.openingStatLabel}>成本总额</span>
              <span className={styles.openingStatVal}>¥{formatCents(opening.totalAmountCents)}</span>
            </div>
          </div>
        ) : openingFormOpen ? (
          <form
            onSubmit={handleOpeningSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--erp-space-2)' }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--erp-space-2)' }}>
              <div>
                <label className={styles.fieldLabel}>期初数量</label>
                <NumberInput value={openingQty} onChange={(v) => setOpeningQty(v)} min={1} precision={0} />
              </div>
              <div>
                <label className={styles.fieldLabel}>单件成本 (元)</label>
                <Input
                  value={openingUnitCost}
                  onChange={(e) => setOpeningUnitCost(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--erp-space-2)' }}>
              <div>
                <label className={styles.fieldLabel}>业务日期</label>
                <Input type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />
              </div>
              <div>
                <label className={styles.fieldLabel}>备注</label>
                <Input value={openingNote} onChange={(e) => setOpeningNote(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--erp-space-2)' }}>
              <Button size="sm" variant="ghost" type="button" onClick={() => setOpeningFormOpen(false)}>
                取消
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={openingSaving}>
                {openingSaving ? '写入中…' : '确认期初'}
              </Button>
            </div>
          </form>
        ) : (
          <div className={styles.openingEmpty}>
            <span>还没有期初。期初只能录入一次，是库存和平均成本的起点；之后纠错请用库存调整。</span>
          </div>
        )}
      </div>

      {/* 4. 库存调整内嵌折叠段 */}
      {product.isActive && stock && (
        <div className={styles.adjustmentSection}>
          <div className={styles.adjustmentSectionHeader}>
            <span className={styles.adjustmentSectionTitle}>库存调整（盘亏 / 盘盈）</span>
            <Button size="sm" variant={adjustOpen ? 'ghost' : 'secondary'} onClick={() => setAdjustOpen(!adjustOpen)}>
              <Scale size={14} /> {adjustOpen ? '收起调整' : '调整库存'}
            </Button>
          </div>
          {adjustOpen && (
            <div className={styles.adjustmentBody}>
              <AdjustmentForm
                product={product}
                stock={stock}
                onSuccess={handleAdjustmentSuccess}
                onCancel={() => setAdjustOpen(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* 5. 专属库存流水表格 */}
      <div className={styles.movementSection}>
        <span className={styles.movementTitle}>商品变动流水</span>
        <ProductMovements product={product} onOpenDocument={handleOpenDocument} refreshKey={movementRefreshKey} />
      </div>
    </div>
  )

  // #endregion
}

// #endregion
