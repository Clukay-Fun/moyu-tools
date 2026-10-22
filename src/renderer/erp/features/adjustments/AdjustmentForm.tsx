/**
 * 描述: 库存调整通用内嵌表单组件 (AdjustmentForm)
 * 主要功能:
 *   - 支持「按盘点数」与「按差额」双模式自由切换
 *   - 动态计算并展示差额，自动映射入库/出库方向
 *   - 结转成本只读呈现，保证财务数据严谨
 *   - 动态提交按钮文本与原因必填禁用管控
 */

import React, { useState, type FormEvent } from 'react'
import type { Product, StockLevel, DocumentDetail } from '@shared/erp/types'
import { Button, Input, NumberInput, SegmentedControl } from '@erp/components/ui'
import { formatCents, formatQty, todayString } from '@erp/lib/format'
import { unwrap, errorMessage } from '@erp/lib/api'
import { useToast } from '@erp/components/Toast'
import styles from './AdjustmentForm.module.css'

// #region 组件属性与选项定义

export interface AdjustmentFormProps {
  /** 目标商品 */
  product: Product
  /** 当前库存状况 */
  stock: StockLevel
  /** 提交成功回调 */
  onSuccess: (doc: DocumentDetail) => void
  /** 取消/收起回调 */
  onCancel?: () => void
}

type AdjustMode = 'stocktake' | 'difference'

const MODE_OPTIONS = [
  { value: 'stocktake' as AdjustMode, label: '按盘点数' },
  { value: 'difference' as AdjustMode, label: '按差额' }
]

const DIRECTION_OPTIONS = [
  { value: 'decrease', label: '盘亏（减少）' },
  { value: 'increase', label: '盘盈（增加）' }
]

// #endregion

// #region AdjustmentForm 核心组件

/**
 * 用处: 商品抽屉内嵌折叠段与独立开单抽屉共用的调整表单
 * 参数:
 *   - product: 当前选中的商品对象
 *   - stock: 该商品的实时库存快照
 *   - onSuccess: 调整成功后的回调
 * 功能:
 *   - 提供盘点数计算与差额输入，直接写入库存调整流水
 */
export function AdjustmentForm({ product, stock, onSuccess, onCancel }: AdjustmentFormProps): React.JSX.Element {
  const toast = useToast()

  const [mode, setMode] = useState<AdjustMode>('stocktake')
  const [countedQty, setCountedQty] = useState<number | null>(stock.quantity)
  const [direction, setDirection] = useState<'increase' | 'decrease'>('decrease')
  const [diffQty, setDiffQty] = useState<number | null>(1)
  const [docDate, setDocDate] = useState<string>(todayString())
  const [reason, setReason] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)

  // 1. 差额与方向动态推导
  let finalDirection: 'increase' | 'decrease' = direction
  let finalQuantity = 0
  let summaryText: string

  if (mode === 'stocktake') {
    const target = countedQty ?? stock.quantity
    const delta = target - stock.quantity
    if (delta > 0) {
      finalDirection = 'increase'
      finalQuantity = delta
      summaryText = `${formatQty(stock.quantity)} → ${formatQty(target)}，盘盈 ${formatQty(delta)} ${product.unit}`
    } else if (delta < 0) {
      finalDirection = 'decrease'
      finalQuantity = Math.abs(delta)
      summaryText = `${formatQty(stock.quantity)} → ${formatQty(target)}，盘亏 ${formatQty(Math.abs(delta))} ${product.unit}`
    } else {
      finalQuantity = 0
      summaryText = `${formatQty(stock.quantity)} → ${formatQty(target)}，库存无变动`
    }
  } else {
    finalDirection = direction
    finalQuantity = diffQty ?? 0
    if (finalQuantity > 0) {
      const after = finalDirection === 'increase' ? stock.quantity + finalQuantity : stock.quantity - finalQuantity
      summaryText = `${formatQty(stock.quantity)} → ${formatQty(after)}，${finalDirection === 'increase' ? '盘盈' : '盘亏'} ${formatQty(finalQuantity)} ${product.unit}`
    } else {
      summaryText = '请输入调整数量'
    }
  }

  // 2. 校验状态与禁用原因
  const isTooManyDecrease = finalDirection === 'decrease' && finalQuantity > stock.quantity
  let disabledReason = ''

  if (finalQuantity <= 0) {
    disabledReason = '调整数量必须大于 0'
  } else if (isTooManyDecrease) {
    disabledReason = `盘亏数量不能超过当前库存 (${formatQty(stock.quantity)} ${product.unit})`
  } else if (!reason.trim()) {
    disabledReason = '请填写调整原因'
  }

  const isSubmitDisabled = Boolean(disabledReason) || submitting

  // 3. 动态按钮文案
  const submitButtonLabel = submitting
    ? '调整中…'
    : finalQuantity > 0
      ? `确认${finalDirection === 'increase' ? '盘盈' : '盘亏'} ${finalQuantity} ${product.unit}`
      : '确认调整'

  // 4. 提交表单
  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (isSubmitDisabled) return

    setSubmitting(true)
    try {
      const doc = await unwrap(
        window.api.erp.adjustments.create({
          skuId: product.defaultSku.id,
          direction: finalDirection,
          quantity: finalQuantity,
          // 盘盈与旧版一致：有库存按当前平均成本（服务端以 e4 精度计算），无库存按默认进价
          unitCostCents: finalDirection === 'increase' && stock.quantity <= 0 ? product.defaultCostCents : null,
          docDate,
          reason: reason.trim()
        })
      )
      toast(`已调整 ${doc.docNo}`, 'success')
      onSuccess(doc)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const avgCostDisplay =
    stock.quantity > 0
      ? `¥${formatCents(stock.avgCostCents)} / ${product.unit}（当前平均成本）`
      : `¥${formatCents(product.defaultCostCents)} / ${product.unit}（默认进价）`

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {/* 警示说明 */}
      <div className={styles.notice}>调整会直接生效并写入流水；录错了可以作废冲回，但不能修改。</div>

      {/* 模式选择 */}
      <div className={styles.modeRow}>
        <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={(val) => setMode(val as AdjustMode)} />
      </div>

      {/* 模式特定输入 */}
      {mode === 'stocktake' ? (
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label}>当前账面库存</label>
            <div className={styles.readOnlyVal}>
              {formatQty(stock.quantity)} {product.unit}
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>实际盘点数</label>
            <NumberInput value={countedQty ?? 0} onChange={(val) => setCountedQty(val)} min={0} step={1} />
          </div>
        </div>
      ) : (
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label}>调整方向</label>
            <SegmentedControl
              options={DIRECTION_OPTIONS}
              value={direction}
              onChange={(val) => setDirection(val as 'increase' | 'decrease')}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>调整数量</label>
            <NumberInput value={diffQty ?? 1} onChange={(val) => setDiffQty(val)} min={1} step={1} />
          </div>
        </div>
      )}

      {/* 变动摘要 */}
      <div className={styles.diffSummary}>
        <span>变动</span>
        <span
          className={`${styles.diffText} ${
            finalQuantity === 0 ? styles.zero : finalDirection === 'increase' ? styles.increase : styles.decrease
          }`}
        >
          {summaryText}
        </span>
      </div>

      {/* 财务与业务字段 */}
      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label}>按成本</label>
          <div className={styles.readOnlyVal}>{avgCostDisplay}</div>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>业务日期</label>
          <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
        </div>
      </div>

      {/* 调整原因 */}
      <div className={styles.field}>
        <label className={styles.label}>原因</label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：月末盘点少 3 件" />
        {disabledReason && <span className={styles.errorText}>{disabledReason}</span>}
      </div>

      {/* 底部按钮栏 */}
      <div className={styles.actions}>
        {onCancel && (
          <Button variant="ghost" size="sm" type="button" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
        )}
        <Button variant="primary" size="sm" type="submit" disabled={isSubmitDisabled}>
          {submitButtonLabel}
        </Button>
      </div>
    </form>
  )
}

// #endregion
