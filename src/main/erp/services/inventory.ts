import type { Db } from '../db/connection'
import { nowIso } from '../db/connection'
import { e4ToCents } from '@shared/erp/money'
import type { StockLevel, StockRow } from '@shared/erp/types'
import { listProducts } from './products'
import { ServiceError } from './errors'

interface StockDbRow {
  sku_id: number
  quantity: number
  cost_value_e4: number | bigint
}

export function getStock(db: Db, skuId: number): StockLevel {
  const row = db.prepare(`SELECT sku_id, quantity, cost_value_e4 FROM sku_stock WHERE sku_id = ?`).get(skuId) as
    StockDbRow | undefined
  if (!row) throw new ServiceError('NOT_FOUND', 'SKU 不存在')
  const costValue = BigInt(row.cost_value_e4)
  return {
    skuId: row.sku_id,
    quantity: row.quantity,
    costValueCents: e4ToCents(costValue),
    avgCostCents: row.quantity > 0 ? e4ToCents(costValue / BigInt(row.quantity)) : 0
  }
}

export interface ApplyMovementInput {
  skuId: number
  documentId: number
  documentItemId: number | null
  kind: 'opening' | 'inbound' | 'outbound' | 'adjustment' | 'void'
  quantityDelta: number
  /** 入库/期初：本次单价；出库：忽略，按当前平均成本；作废：按原流水成本 */
  unitCostE4: bigint
  occurredAt: string
}

/**
 * 写一条不可变流水并更新库存快照。必须在事务内调用。
 * 移动加权平均：入库时 cost_value += qty × 单价；出库时 cost_value -= qty × 当前平均成本。
 */
export function applyMovement(db: Db, input: ApplyMovementInput): void {
  const row = db.prepare(`SELECT quantity, cost_value_e4 FROM sku_stock WHERE sku_id = ?`).get(input.skuId) as
    { quantity: number; cost_value_e4: number | bigint } | undefined
  if (!row) throw new ServiceError('NOT_FOUND', 'SKU 不存在')

  const before = row.quantity
  const after = before + input.quantityDelta
  if (after < 0) throw new ServiceError('INSUFFICIENT_STOCK', `库存不足：当前 ${before}，需要 ${-input.quantityDelta}`)

  const costValueBefore = BigInt(row.cost_value_e4)
  let unitCostE4: bigint
  let costDelta: bigint
  if (input.quantityDelta >= 0) {
    unitCostE4 = input.unitCostE4
    costDelta = BigInt(input.quantityDelta) * unitCostE4
  } else {
    // 减少库存按当前平均成本结转；清零时把成本余额一并清掉，避免残留舍入误差。
    unitCostE4 = input.kind === 'void' ? input.unitCostE4 : before > 0 ? costValueBefore / BigInt(before) : 0n
    costDelta = after === 0 ? -costValueBefore : BigInt(input.quantityDelta) * unitCostE4
    // 作废入库按原单价冲回；其间若已按平均成本出过库、又以更低单价入过库，原价冲回会超过当前成本余额。
    // 冲回最多扣到 0，库存成本和之后的平均成本都不会变成负数。
    if (costDelta < -costValueBefore) costDelta = -costValueBefore
  }

  const now = nowIso()
  db.prepare(
    `INSERT INTO stock_movements
       (sku_id, document_id, document_item_id, kind, quantity_delta, quantity_before, quantity_after,
        unit_cost_e4, cost_value_delta_e4, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.skuId,
    input.documentId,
    input.documentItemId,
    input.kind,
    input.quantityDelta,
    before,
    after,
    unitCostE4,
    costDelta,
    input.occurredAt,
    now
  )
  db.prepare(`UPDATE sku_stock SET quantity = ?, cost_value_e4 = ?, updated_at = ? WHERE sku_id = ?`).run(
    after,
    costValueBefore + costDelta,
    now,
    input.skuId
  )
}

/** 全部商品的库存行（含停用），启用在前。 */
export function listStock(db: Db): StockRow[] {
  const hasOpening = db.prepare(
    `SELECT 1 FROM documents d JOIN document_items i ON i.document_id = d.id
     WHERE d.type = 'opening' AND d.status = 'confirmed' AND i.sku_id = ? LIMIT 1`
  )
  return listProducts(db).map((product) => {
    const stock = getStock(db, product.defaultSku.id)
    const opened = !!hasOpening.get(product.defaultSku.id)
    return { product, stock, hasOpening: opened, lowStock: opened && stock.quantity <= product.lowStockThreshold }
  })
}
