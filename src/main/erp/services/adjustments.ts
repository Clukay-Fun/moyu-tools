import type { Db } from '../db/connection'
import { localDateTime, nowIso, transaction } from '../db/connection'
import { adjustmentSchema, type AdjustmentInput } from '@shared/erp/schemas'
import { centsToE4 } from '@shared/erp/money'
import type { DocumentDetail } from '@shared/erp/types'
import { ServiceError } from './errors'
import { nextDocNo } from './docNo'
import { applyMovement } from './inventory'
import { getDocument } from './documents'

/**
 * 库存调整：盘盈增加 / 盘亏减少，直接生成已确认单据 + 流水。
 * 增加按给定单位成本（默认当前平均成本）计入；减少按当前平均成本结转。
 * 纠错期初、盘点差异都走这里，不改历史。
 */
export function createAdjustment(db: Db, raw: AdjustmentInput): DocumentDetail {
  const input = adjustmentSchema.parse(raw)
  return transaction(db, () => {
    const stock = db.prepare(`SELECT quantity, cost_value_e4 FROM sku_stock WHERE sku_id = ?`).get(input.skuId) as
      { quantity: number; cost_value_e4: number | bigint } | undefined
    if (!stock) throw new ServiceError('NOT_FOUND', 'SKU 不存在')
    if (input.direction === 'decrease' && stock.quantity < input.quantity)
      throw new ServiceError('INSUFFICIENT_STOCK', `库存不足：当前 ${stock.quantity}，最多减少 ${stock.quantity}`)

    const avgE4 = stock.quantity > 0 ? BigInt(stock.cost_value_e4) / BigInt(stock.quantity) : 0n
    const unitCostE4 =
      input.direction === 'increase' && input.unitCostCents !== null ? centsToE4(input.unitCostCents) : avgE4
    const unitPriceCents = Number(unitCostE4 / 100n)

    const now = nowIso()
    const docNo = nextDocNo(db, 'adjustment', input.docDate)
    const { id: docId } = db
      .prepare(
        `INSERT INTO documents (doc_no, type, status, doc_date, note, adjust_direction, confirmed_at, created_at, updated_at)
         VALUES (?, 'adjustment', 'confirmed', ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(docNo, input.docDate, input.reason, input.direction, now, now, now) as { id: number }
    const { id: itemId } = db
      .prepare(
        `INSERT INTO document_items (document_id, line_no, sku_id, quantity, unit_price_cents, cost_snapshot_e4)
         VALUES (?, 1, ?, ?, ?, ?) RETURNING id`
      )
      .get(docId, input.skuId, input.quantity, unitPriceCents, unitCostE4) as { id: number }
    applyMovement(db, {
      skuId: input.skuId,
      documentId: docId,
      documentItemId: itemId,
      kind: 'adjustment',
      quantityDelta: input.direction === 'increase' ? input.quantity : -input.quantity,
      unitCostE4,
      occurredAt: `${input.docDate}T${localDateTime().slice(11)}`
    })
    return getDocument(db, docId)
  })
}
