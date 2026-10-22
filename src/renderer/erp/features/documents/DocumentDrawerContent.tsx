/**
 * 描述: 单据查看弹窗内容 (DocumentDrawerContent)
 * 主要功能:
 *   - 头部：单号、类型与状态徽标，按状态给出操作（确认 / 编辑 / 删除草稿、作废、导出）
 *   - 信息区两列键值对、明细表（商品可点开商品弹窗）、出库的成本与毛利行、附件
 *   - 作废、删除草稿、确认都走 ConfirmDialog，按钮写明具体动作
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Pencil, Trash2, Check, Ban, Download } from 'lucide-react'
import type { DocumentDetail, StockLevel } from '@shared/erp/types'
import { Button, ConfirmDialog, DocStatusBadge, DocTypeBadge, Input, useDrawer, TYPE_LABEL } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import { unwrap, errorMessage } from '@erp/lib/api'
import { emitDataChanged } from '@erp/lib/dataEvents'
import { formatCents, formatQty } from '@erp/lib/format'
import { AttachmentPanel } from '@erp/features/attachments/AttachmentPanel'
import styles from './DocumentDrawerContent.module.css'

type Dialog = 'delete' | 'confirm' | 'void' | null

const formatTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('zh-CN') : '—')

export function DocumentDrawerContent({ id }: { id: number }): React.JSX.Element {
  const toast = useToast()
  const { setTitle, closeDrawer } = useDrawer()
  const { openProduct, editDocument } = useEntityDrawers()
  const [doc, setDoc] = useState<DocumentDetail | null>(null)
  const [stocks, setStocks] = useState<Map<number, StockLevel>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [voidReason, setVoidReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await unwrap(window.api.erp.documents.get(id))
      setDoc(d)
      setTitle(d.docNo)
      // 草稿的预估成本按当前平均成本
      if (d.status === 'draft' && d.type === 'outbound') {
        const rows = await unwrap(window.api.erp.inventory.listStock())
        setStocks(new Map(rows.map((r) => [r.product.defaultSku.id, r.stock])))
      }
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [id, setTitle])

  useEffect(() => {
    void load()
  }, [load])

  async function run(action: () => Promise<void>, success: string): Promise<void> {
    setBusy(true)
    try {
      await action()
      toast(success, 'success')
      setDialog(null)
      emitDataChanged()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function exportDocument(): Promise<void> {
    if (!doc) return
    try {
      const p = await unwrap(window.api.erp.csv.exportDocument(doc.id))
      if (p) toast(`单据已导出到: ${p}`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  if (error) return <p className={styles.error}>读取失败：{error}</p>
  if (!doc) return <p className={styles.loading}>正在读取单据…</p>

  const label = TYPE_LABEL[doc.type]
  const isOutbound = doc.type === 'outbound'

  // 出库成本：已生效 / 已作废按成本快照，草稿按当前平均成本预估
  let costCents: number | null = null
  if (isOutbound) {
    if (doc.status === 'draft') {
      costCents = doc.items.reduce((a, it) => a + it.quantity * (stocks.get(it.skuId)?.avgCostCents ?? 0), 0)
    } else if (doc.items.every((it) => it.costSnapshotCents !== null)) {
      costCents = doc.totalCostCents ?? doc.items.reduce((a, it) => a + it.quantity * (it.costSnapshotCents ?? 0), 0)
    }
  }
  const profitCents = costCents === null ? null : doc.totalAmountCents - costCents
  const qtyText = `${formatQty(doc.totalQuantity)} 件`
  const voidEffect =
    doc.type === 'outbound'
      ? `库存 +${qtyText}`
      : doc.type === 'inbound'
        ? `库存 −${qtyText}`
        : doc.adjustDirection === 'increase'
          ? `库存 −${qtyText}`
          : `库存 +${qtyText}`

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headMain}>
          <div className={styles.badges}>
            <DocTypeBadge type={doc.type} />
            <DocStatusBadge status={doc.status} />
            {doc.status === 'voided' && <span className={styles.voidedAt}>作废于 {formatTime(doc.voidedAt)}</span>}
          </div>
        </div>
        <div className={styles.actions}>
          {doc.status !== 'draft' && (
            <Button variant="ghost" size="sm" onClick={exportDocument}>
              <Download size={14} /> 导出
            </Button>
          )}
          {doc.status === 'draft' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDialog('delete')}>
                <Trash2 size={14} /> 删除草稿
              </Button>
              <Button variant="secondary" size="sm" onClick={() => editDocument(doc.id)}>
                <Pencil size={14} /> 编辑
              </Button>
              <Button variant="primary" size="sm" onClick={() => setDialog('confirm')}>
                <Check size={14} /> 确认{label}
              </Button>
            </>
          )}
          {doc.status === 'confirmed' && doc.type !== 'opening' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setVoidReason('')
                setDialog('void')
              }}
            >
              <Ban size={14} /> 作废
            </Button>
          )}
        </div>
      </div>

      <dl className={styles.meta}>
        <div>
          <dt>日期</dt>
          <dd>{doc.docDate}</dd>
        </div>
        {isOutbound && (
          <>
            <div>
              <dt>渠道</dt>
              <dd>{doc.channelName ?? '—'}</dd>
            </div>
            <div>
              <dt>外部订单号</dt>
              <dd className="mono">{doc.externalOrderNo || '—'}</dd>
            </div>
          </>
        )}
        {doc.type === 'adjustment' && (
          <div>
            <dt>调整方向</dt>
            <dd>{doc.adjustDirection === 'increase' ? '盘盈增加' : '盘亏减少'}</dd>
          </div>
        )}
        <div>
          <dt>{doc.type === 'adjustment' ? '原因' : '备注'}</dt>
          <dd>{doc.note || '—'}</dd>
        </div>
        {doc.confirmedAt && (
          <div>
            <dt>生效时间</dt>
            <dd>{formatTime(doc.confirmedAt)}</dd>
          </div>
        )}
        {doc.status === 'voided' && (
          <div>
            <dt>作废原因</dt>
            <dd>{doc.voidReason || '—'}</dd>
          </div>
        )}
      </dl>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.idx}>#</th>
              <th>商品 / SKU</th>
              <th className={styles.num}>数量</th>
              <th className={styles.num}>{isOutbound ? '售价' : doc.type === 'adjustment' ? '按成本' : '单价'}</th>
              <th className={styles.num}>小计</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((it) => (
              <tr key={it.id}>
                <td className={styles.idx}>{it.lineNo}</td>
                <td>
                  <button type="button" className={styles.productLink} onClick={() => void openProductBySku(it.skuId)}>
                    {it.productName}
                  </button>
                  <span className={styles.sku}>{it.skuCode}</span>
                </td>
                <td className={styles.num}>{formatQty(it.quantity)}</td>
                <td className={styles.num}>¥{formatCents(it.unitPriceCents)}</td>
                <td className={styles.num}>¥{formatCents(it.quantity * it.unitPriceCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td>合计</td>
              <td className={styles.num}>{formatQty(doc.totalQuantity)}</td>
              <td />
              <td className={`${styles.num} ${styles.total}`}>¥{formatCents(doc.totalAmountCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 金额汇总：按单据类型给出适用口径 */}
      <div className={styles.summary} aria-label="金额汇总">
        {doc.type === 'outbound' &&
          [
            { label: '出库金额', value: `¥${formatCents(doc.totalAmountCents)}` },
            {
              label: doc.status === 'draft' ? '预估成本' : '出库成本',
              value: costCents === null ? '—' : `¥${formatCents(costCents)}`
            },
            {
              label: doc.status === 'draft' ? '预估毛利' : '毛利',
              value: profitCents === null ? '—' : `¥${formatCents(profitCents)}`,
              tone: profitCents !== null && profitCents < 0 ? 'negative' : 'profit'
            }
          ].map((item) => (
            <div key={item.label} className={styles.summaryItem}>
              <span className={styles.summaryLabel}>{item.label}</span>
              <span
                className={`${styles.summaryValue} ${item.tone === 'negative' ? styles.negative : item.tone === 'profit' ? styles.profitValue : ''}`}
              >
                {item.value}
              </span>
            </div>
          ))}

        {doc.type === 'inbound' &&
          [
            { label: '入库数量', value: `${formatQty(doc.totalQuantity)} 件` },
            { label: '进价合计', value: `¥${formatCents(doc.totalAmountCents)}` },
            { label: '入库总额', value: `¥${formatCents(doc.totalAmountCents)}` }
          ].map((item) => (
            <div key={item.label} className={styles.summaryItem}>
              <span className={styles.summaryLabel}>{item.label}</span>
              <span className={styles.summaryValue}>{item.value}</span>
            </div>
          ))}

        {doc.type === 'adjustment' && (
          <>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>调整数量</span>
              <span className={styles.summaryValue}>
                {doc.adjustDirection === 'increase' ? '+' : '−'}
                {formatQty(doc.totalQuantity)} 件
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>成本影响</span>
              <span className={styles.summaryValue}>
                {doc.adjustDirection === 'increase' ? '+' : '−'}¥
                {formatCents(doc.totalCostCents ?? doc.totalAmountCents)}
              </span>
            </div>
          </>
        )}

        {doc.type === 'opening' && (
          <>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>期初数量</span>
              <span className={styles.summaryValue}>{formatQty(doc.totalQuantity)} 件</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>期初成本</span>
              <span className={styles.summaryValue}>¥{formatCents(doc.totalCostCents ?? doc.totalAmountCents)}</span>
            </div>
          </>
        )}
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>附件</h3>
        <AttachmentPanel documentId={doc.id} readOnly={doc.status === 'voided'} />
      </section>

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        danger
        title="删除这张草稿？"
        description={`${doc.docNo} 将被永久删除。草稿还没有影响库存。`}
        confirmText="删除草稿"
        loading={busy}
        onConfirm={() =>
          run(async () => {
            await unwrap(window.api.erp.documents.deleteDraft(doc.id))
            closeDrawer(true)
          }, '草稿已删除')
        }
      />
      <ConfirmDialog
        open={dialog === 'confirm'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`确认${label}？`}
        description={`确认后库存${doc.type === 'inbound' ? '增加' : '减少'} ${qtyText}。生效后不能修改，只能作废。`}
        confirmText={`确认${label}`}
        loading={busy}
        onConfirm={() =>
          run(async () => {
            setDoc(await unwrap(window.api.erp.documents.confirm(doc.id)))
          }, `已确认 ${doc.docNo}`)
        }
      />
      <ConfirmDialog
        open={dialog === 'void'}
        onOpenChange={(o) => !o && setDialog(null)}
        danger
        title={`作废 ${doc.docNo}？`}
        description={`作废后会生成冲回流水，${voidEffect}。作废不可撤销。`}
        confirmText="作废并冲回"
        loading={busy}
        onConfirm={() => {
          if (!voidReason.trim()) {
            toast('请填写作废原因', 'error')
            return
          }
          return run(async () => {
            setDoc(await unwrap(window.api.erp.documents.void(doc.id, voidReason)))
          }, `已作废 ${doc.docNo}`)
        }}
      >
        <label className={styles.voidLabel}>
          作废原因
          <Input
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            maxLength={200}
            autoFocus
            placeholder="必填，例如：发错货 / 重复录入"
          />
        </label>
      </ConfirmDialog>
    </div>
  )

  async function openProductBySku(skuId: number): Promise<void> {
    try {
      const rows = await unwrap(window.api.erp.inventory.listStock())
      const row = rows.find((r) => r.product.defaultSku.id === skuId)
      if (row) await openProduct(row.product.id)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
}
