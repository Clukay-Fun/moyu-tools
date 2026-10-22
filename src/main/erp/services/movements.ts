import type { Db } from '../db/connection'
import { e4ToCents } from '@shared/erp/money'
import type { MovementFilter, MovementRow, Page } from '@shared/erp/types'

interface Row {
  id: number
  sku_id: number
  product_name: string
  product_code: string
  occurred_at: string
  kind: MovementRow['kind']
  document_id: number
  doc_no: string
  doc_type: MovementRow['docType']
  channel_name: string | null
  external_order_no: string | null
  quantity_delta: number
  quantity_after: number
  unit_price_cents: number | null
  unit_cost_e4: number | bigint
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function listMovements(db: Db, filter: MovementFilter = {}): Page<MovementRow> {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.kind) {
    where.push('m.kind = ?')
    params.push(filter.kind)
  }
  if (filter.skuId) {
    where.push('m.sku_id = ?')
    params.push(filter.skuId)
  }
  if (filter.channelId) {
    where.push('d.channel_id = ?')
    params.push(filter.channelId)
  }
  if (filter.from && DATE_RE.test(filter.from)) {
    where.push('substr(m.occurred_at, 1, 10) >= ?')
    params.push(filter.from)
  }
  if (filter.to && DATE_RE.test(filter.to)) {
    where.push('substr(m.occurred_at, 1, 10) <= ?')
    params.push(filter.to)
  }
  if (filter.docNo?.trim()) {
    where.push('(d.doc_no LIKE ? OR d.external_order_no LIKE ?)')
    const like = `%${filter.docNo.trim()}%`
    params.push(like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const base = `FROM stock_movements m
    JOIN documents d ON d.id = m.document_id
    LEFT JOIN sales_channels c ON c.id = d.channel_id
    LEFT JOIN document_items i ON i.id = m.document_item_id
    JOIN skus s ON s.id = m.sku_id
    JOIN products p ON p.id = s.product_id
    ${whereSql}`

  const { total } = db.prepare(`SELECT COUNT(*) AS total ${base}`).get(...params) as { total: number }
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 500)
  const page = Math.max(filter.page ?? 1, 1)
  const rows = db
    .prepare(
      `SELECT m.id, m.sku_id, p.name AS product_name, p.code AS product_code, m.occurred_at, m.kind, m.document_id, d.doc_no, d.type AS doc_type, c.name AS channel_name,
              d.external_order_no, m.quantity_delta, m.quantity_after, i.unit_price_cents, m.unit_cost_e4
       ${base} ORDER BY m.occurred_at DESC, m.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as Row[]

  return {
    total,
    page,
    pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      skuId: r.sku_id,
      productName: r.product_name,
      productCode: r.product_code,
      occurredAt: r.occurred_at,
      kind: r.kind,
      documentId: r.document_id,
      docNo: r.doc_no,
      docType: r.doc_type,
      channelName: r.channel_name,
      externalOrderNo: r.external_order_no ?? '',
      quantityDelta: r.quantity_delta,
      quantityAfter: r.quantity_after,
      unitPriceCents: r.unit_price_cents,
      unitCostCents: e4ToCents(BigInt(r.unit_cost_e4))
    }))
  }
}
