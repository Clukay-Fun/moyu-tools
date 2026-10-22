import type { Db } from '../db/connection'
import { nowIso, transaction } from '../db/connection'
import {
  productCreateSchema,
  productUpdateSchema,
  productLastPricesSchema,
  type ProductCreateInput,
  type ProductUpdateInput,
  type ProductLastPrices
} from '@shared/erp/schemas'
import type { Product } from '@shared/erp/types'
import { ServiceError } from './errors'

interface ProductRow {
  id: number
  code: string
  name: string
  unit: string
  is_active: number
  image_path: string | null
  default_cost_cents: number
  default_price_cents: number
  low_stock_threshold: number
  sku_id: number
  sku_code: string
}

const SELECT = `
  SELECT p.id, p.code, p.name, p.unit, p.is_active, p.image_path, p.default_cost_cents, p.default_price_cents,
         p.low_stock_threshold, s.id AS sku_id, s.code AS sku_code
  FROM products p JOIN skus s ON s.product_id = p.id AND s.is_default = 1`

function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    unit: r.unit,
    isActive: r.is_active === 1,
    imagePath: r.image_path,
    defaultCostCents: r.default_cost_cents,
    defaultPriceCents: r.default_price_cents,
    lowStockThreshold: r.low_stock_threshold,
    defaultSku: { id: r.sku_id, productId: r.id, code: r.sku_code, isDefault: true }
  }
}

/** 全部商品，启用的在前，按编码排序。 */
export function listProducts(db: Db, includeInactive = true): Product[] {
  const rows = db
    .prepare(`${SELECT} ${includeInactive ? '' : 'WHERE p.is_active = 1'} ORDER BY p.is_active DESC, p.code`)
    .all() as unknown as ProductRow[]
  return rows.map(toProduct)
}

export function getProductById(db: Db, id: number): Product {
  const row = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as ProductRow | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '商品不存在')
  return toProduct(row)
}

/** 兼容单商品调用：第一个商品。 */
export function getProduct(db: Db): Product {
  const first = listProducts(db)[0]
  if (!first) throw new ServiceError('NOT_FOUND', '商品不存在')
  return first
}

function assertCodeFree(db: Db, code: string, exceptId: number | null): void {
  const dup = db.prepare(`SELECT id FROM products WHERE code = ? AND id <> ?`).get(code, exceptId ?? -1)
  if (dup) throw new ServiceError('DUPLICATE_CODE', `商品编码 ${code} 已存在`)
}

export function createProduct(db: Db, raw: ProductCreateInput): Product {
  const input = productCreateSchema.parse(raw)
  return transaction(db, () => {
    assertCodeFree(db, input.code, null)
    const now = nowIso()
    const { id } = db
      .prepare(
        `INSERT INTO products (code, name, unit, is_active, default_cost_cents, default_price_cents, low_stock_threshold, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        input.code,
        input.name,
        input.unit,
        input.isActive ? 1 : 0,
        input.defaultCostCents,
        input.defaultPriceCents,
        input.lowStockThreshold,
        now,
        now
      ) as { id: number }
    const { id: skuId } = db
      .prepare(`INSERT INTO skus (product_id, code, is_default, created_at) VALUES (?, ?, 1, ?) RETURNING id`)
      .get(id, `${input.code}-DEFAULT`, now) as { id: number }
    db.prepare(`INSERT INTO sku_stock (sku_id, quantity, cost_value_e4, updated_at) VALUES (?, 0, 0, ?)`).run(
      skuId,
      now
    )
    return getProductById(db, id)
  })
}

export function updateProduct(db: Db, id: number, raw: ProductUpdateInput): Product {
  const input = productUpdateSchema.parse(raw)
  return transaction(db, () => {
    getProductById(db, id)
    assertCodeFree(db, input.code, id)
    if (!input.isActive) {
      const active = db.prepare(`SELECT COUNT(*) AS c FROM products WHERE is_active = 1 AND id <> ?`).get(id) as {
        c: number
      }
      if (active.c === 0) throw new ServiceError('VALIDATION', '至少保留一个启用的商品')
    }
    db.prepare(
      `UPDATE products SET code = ?, name = ?, unit = ?, is_active = ?, default_cost_cents = ?, default_price_cents = ?,
         low_stock_threshold = ?, updated_at = ? WHERE id = ?`
    ).run(
      input.code,
      input.name,
      input.unit,
      input.isActive ? 1 : 0,
      input.defaultCostCents,
      input.defaultPriceCents,
      input.lowStockThreshold,
      nowIso(),
      id
    )
    // 默认 SKU 编码跟随商品编码
    db.prepare(`UPDATE skus SET code = ? WHERE product_id = ? AND is_default = 1`).run(`${input.code}-DEFAULT`, id)
    return getProductById(db, id)
  })
}

export function getLastPrices(db: Db, productIds: number[]): ProductLastPrices {
  if (productIds.length === 0) return {}

  const result: ProductLastPrices = {}
  for (const pid of productIds) {
    // 最近一次已确认入库的进价
    const inRow = db
      .prepare(
        `SELECT i.unit_price_cents
         FROM documents d
         JOIN document_items i ON i.document_id = d.id
         JOIN skus s ON s.id = i.sku_id
         WHERE d.status = 'confirmed' AND d.type = 'inbound' AND s.product_id = ?
         ORDER BY d.doc_date DESC, d.id DESC
         LIMIT 1`
      )
      .get(pid) as { unit_price_cents: number } | undefined

    // 最近一次已确认出库的售价
    const outRow = db
      .prepare(
        `SELECT i.unit_price_cents
         FROM documents d
         JOIN document_items i ON i.document_id = d.id
         JOIN skus s ON s.id = i.sku_id
         WHERE d.status = 'confirmed' AND d.type = 'outbound' AND s.product_id = ?
         ORDER BY d.doc_date DESC, d.id DESC
         LIMIT 1`
      )
      .get(pid) as { unit_price_cents: number } | undefined

    result[String(pid)] = {
      lastInboundPriceCents: inRow ? inRow.unit_price_cents : null,
      lastOutboundPriceCents: outRow ? outRow.unit_price_cents : null
    }
  }

  return productLastPricesSchema.parse(result)
}
