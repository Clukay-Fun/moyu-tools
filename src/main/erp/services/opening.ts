import type { Db } from '../db/connection'
import { nowIso, transaction } from '../db/connection'
import { openingStockSchema, type OpeningStockInput } from '@shared/erp/schemas'
import { centsToE4 } from '@shared/erp/money'
import type { DocumentSummary } from '@shared/erp/types'
import { ServiceError } from './errors'
import { nextDocNo } from './docNo'
import { getDocumentSummary } from './documents'
import { applyMovement } from './inventory'

/** 该 SKU 已确认的期初单（每个 SKU 最多一张）。 */
export function getOpening(db: Db, skuId: number): DocumentSummary | null {
  const row = db
    .prepare(
      `SELECT d.id FROM documents d
       WHERE d.type = 'opening' AND d.status = 'confirmed'
         AND EXISTS (SELECT 1 FROM document_items x WHERE x.document_id = d.id AND x.sku_id = ?)
       LIMIT 1`
    )
    .get(skuId) as { id: number } | undefined
  return row ? getDocumentSummary(db, row.id) : null
}

/**
 * 录入期初库存：直接生成已确认的期初单 + 明细 + 流水，并写入库存快照。
 * 规则：该 SKU 尚无任何流水时才允许；之后纠错走库存调整。
 */
export function createOpening(db: Db, raw: OpeningStockInput): DocumentSummary {
  const input = openingStockSchema.parse(raw)
  return transaction(db, () => {
    const hasMovement = db.prepare(`SELECT 1 FROM stock_movements WHERE sku_id = ? LIMIT 1`).get(input.skuId)
    if (hasMovement) throw new ServiceError('OPENING_EXISTS', '该商品已有库存流水，不能再录入期初库存')

    const now = nowIso()
    const docNo = nextDocNo(db, 'opening', input.docDate)
    const doc = db
      .prepare(
        `INSERT INTO documents (doc_no, type, status, doc_date, note, confirmed_at, created_at, updated_at)
         VALUES (?, 'opening', 'confirmed', ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(docNo, input.docDate, input.note, now, now, now) as { id: number }
    const item = db
      .prepare(
        `INSERT INTO document_items (document_id, line_no, sku_id, quantity, unit_price_cents, cost_snapshot_e4)
         VALUES (?, 1, ?, ?, ?, ?) RETURNING id`
      )
      .get(doc.id, input.skuId, input.quantity, input.unitCostCents, centsToE4(input.unitCostCents)) as {
      id: number
    }
    applyMovement(db, {
      skuId: input.skuId,
      documentId: doc.id,
      documentItemId: item.id,
      kind: 'opening',
      quantityDelta: input.quantity,
      unitCostE4: centsToE4(input.unitCostCents),
      occurredAt: `${input.docDate}T00:00:00`
    })
    return getDocumentSummary(db, doc.id)
  })
}
