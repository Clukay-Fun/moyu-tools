import type { Db } from '../db/connection'
import { localDateTime, nowIso, transaction } from '../db/connection'
import {
  documentDraftSchema,
  pendingSummaryResultSchema,
  type DocumentDraftInput,
  type PendingSummaryResult
} from '@shared/erp/schemas'
import { centsToE4, e4ToCents } from '@shared/erp/money'
import type { DocumentDetail, DocumentItem, DocumentListFilter, DocumentSummary } from '@shared/erp/types'
import { ServiceError } from './errors'
import { nextDocNo } from './docNo'
import { applyMovement } from './inventory'
import { removeAttachmentsOfDocument } from './attachments'
import { existsSync, unlinkSync } from 'node:fs'

interface DocRow {
  id: number
  doc_no: string
  type: DocumentSummary['type']
  status: DocumentSummary['status']
  doc_date: string
  note: string
  confirmed_at: string | null
  voided_at: string | null
  void_reason: string | null
  adjust_direction: 'increase' | 'decrease' | null
  channel_id: number | null
  channel_name: string | null
  external_order_no: string | null
  total_qty: number | null
  total_amount: number | null
  total_cost_e4: number | bigint | null
}

interface ItemRow {
  id: number
  line_no: number
  sku_id: number
  sku_code: string
  product_name: string
  quantity: number
  unit_price_cents: number
  cost_snapshot_e4: number | bigint | null
}

const SUMMARY_SELECT = `
  SELECT d.id, d.doc_no, d.type, d.status, d.doc_date, d.note, d.confirmed_at, d.voided_at, d.void_reason,
         d.adjust_direction, d.channel_id, c.name AS channel_name, d.external_order_no,
         SUM(i.quantity) AS total_qty, SUM(i.quantity * i.unit_price_cents) AS total_amount,
         SUM(i.quantity * i.cost_snapshot_e4) AS total_cost_e4
  FROM documents d
  LEFT JOIN sales_channels c ON c.id = d.channel_id
  LEFT JOIN document_items i ON i.document_id = d.id`

function toSummary(r: DocRow): DocumentSummary {
  return {
    id: r.id,
    docNo: r.doc_no,
    type: r.type,
    status: r.status,
    docDate: r.doc_date,
    note: r.note,
    confirmedAt: r.confirmed_at,
    channelName: r.channel_name,
    externalOrderNo: r.external_order_no ?? '',
    totalQuantity: Number(r.total_qty ?? 0),
    totalAmountCents: Number(r.total_amount ?? 0),
    // 只有已生效 / 已作废的出库单有成本快照；草稿与其他类型为 null
    totalCostCents: r.type === 'outbound' && r.total_cost_e4 !== null ? e4ToCents(BigInt(r.total_cost_e4)) : null,
    voidedAt: r.voided_at
  }
}

function toItem(r: ItemRow): DocumentItem {
  return {
    id: r.id,
    lineNo: r.line_no,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    productName: r.product_name,
    quantity: r.quantity,
    unitPriceCents: r.unit_price_cents,
    costSnapshotCents: r.cost_snapshot_e4 === null ? null : e4ToCents(BigInt(r.cost_snapshot_e4))
  }
}

function documentWhere(filter: DocumentListFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.type) {
    where.push('d.type = ?')
    params.push(filter.type)
  }
  if (filter.status) {
    where.push('d.status = ?')
    params.push(filter.status)
  }
  if (filter.from) {
    where.push('d.doc_date >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    where.push('d.doc_date <= ?')
    params.push(filter.to)
  }
  const q = filter.q?.trim().toLowerCase()
  if (q) {
    // 用户输入按字面量匹配：转义 LIKE 的 % / _ / 反斜杠，避免搜 "%" 时匹配全部单据
    const literal = q.replace(/[\\%_]/g, '\\$&')
    where.push(
      `(LOWER(d.doc_no) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(d.external_order_no, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(c.name, '')) LIKE ? ESCAPE '\\' OR LOWER(d.note) LIKE ? ESCAPE '\\')`
    )
    const like = `%${literal}%`
    params.push(like, like, like, like)
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function queryDocuments(db: Db, filter: DocumentListFilter, limit: number | null): DocumentSummary[] {
  const where = documentWhere(filter)
  const sql = `${SUMMARY_SELECT} ${where.sql}
    GROUP BY d.id ORDER BY d.doc_date DESC, d.id DESC ${limit === null ? '' : 'LIMIT ?'}`
  const rows = db.prepare(sql).all(...where.params, ...(limit === null ? [] : [limit])) as unknown as DocRow[]
  return rows.map(toSummary)
}

export function listDocuments(db: Db, filter: DocumentListFilter = {}): DocumentSummary[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  return queryDocuments(db, filter, limit)
}

/** 导出用：同一套筛选条件，但不截断到 1000 张 */
export function listAllDocuments(db: Db, filter: DocumentListFilter = {}): DocumentSummary[] {
  return queryDocuments(db, filter, null)
}

/** 满足筛选条件的单据总数，用于提示列表是否被 1000 张上限截断 */
export function countDocuments(db: Db, filter: DocumentListFilter = {}): number {
  const where = documentWhere(filter)
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT d.id) AS c
       FROM documents d
       LEFT JOIN sales_channels c ON c.id = d.channel_id
       ${where.sql}`
    )
    .get(...where.params) as { c: number }
  return Number(row.c)
}

export function getDocumentSummary(db: Db, id: number): DocumentSummary {
  const row = db.prepare(`${SUMMARY_SELECT} WHERE d.id = ? GROUP BY d.id`).get(id) as DocRow | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '单据不存在')
  return toSummary(row)
}

export function getDocument(db: Db, id: number): DocumentDetail {
  const row = db.prepare(`${SUMMARY_SELECT} WHERE d.id = ? GROUP BY d.id`).get(id) as DocRow | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '单据不存在')
  const items = db
    .prepare(
      `SELECT i.id, i.line_no, i.sku_id, s.code AS sku_code, p.name AS product_name,
              i.quantity, i.unit_price_cents, i.cost_snapshot_e4
       FROM document_items i JOIN skus s ON s.id = i.sku_id JOIN products p ON p.id = s.product_id
       WHERE i.document_id = ? ORDER BY i.line_no`
    )
    .all(id) as unknown as ItemRow[]
  return {
    ...toSummary(row),
    adjustDirection: row.adjust_direction,
    channelId: row.channel_id,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    items: items.map(toItem)
  }
}

/** 同渠道下相同外部订单号的其他单据（不含已作废）。用于提示，不阻断。 */
export function findDuplicateOrder(
  db: Db,
  channelId: number | null,
  externalOrderNo: string,
  excludeId: number | null
): DocumentSummary | null {
  const no = externalOrderNo.trim()
  if (!no || channelId === null) return null
  const row = db
    .prepare(
      `${SUMMARY_SELECT}
       WHERE d.channel_id = ? AND d.external_order_no = ? AND d.status <> 'voided' AND d.id <> ?
       GROUP BY d.id ORDER BY d.id DESC LIMIT 1`
    )
    .get(channelId, no, excludeId ?? -1) as DocRow | undefined
  return row ? toSummary(row) : null
}

function assertSkusExist(db: Db, items: DocumentDraftInput['items']): void {
  const check = db.prepare(`SELECT 1 FROM skus WHERE id = ?`)
  for (const it of items) if (!check.get(it.skuId)) throw new ServiceError('NOT_FOUND', `SKU ${it.skuId} 不存在`)
}

function assertChannel(db: Db, input: DocumentDraftInput): void {
  if (input.type === 'inbound' && (input.channelId !== null || input.externalOrderNo))
    throw new ServiceError('VALIDATION', '入库单不能填写销售渠道或外部订单号')
  if (input.channelId !== null && !db.prepare(`SELECT 1 FROM sales_channels WHERE id = ?`).get(input.channelId))
    throw new ServiceError('NOT_FOUND', '销售渠道不存在')
}

function writeItems(db: Db, documentId: number, items: DocumentDraftInput['items']): void {
  db.prepare(`DELETE FROM document_items WHERE document_id = ?`).run(documentId)
  const ins = db.prepare(
    `INSERT INTO document_items (document_id, line_no, sku_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?)`
  )
  items.forEach((it, i) => ins.run(documentId, i + 1, it.skuId, it.quantity, it.unitPriceCents))
}

export function createDraft(db: Db, raw: DocumentDraftInput): DocumentDetail {
  const input = documentDraftSchema.parse(raw)
  return transaction(db, () => {
    assertSkusExist(db, input.items)
    assertChannel(db, input)
    const now = nowIso()
    const { id } = db
      .prepare(
        `INSERT INTO documents (doc_no, type, status, doc_date, channel_id, external_order_no, note, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        nextDocNo(db, input.type, input.docDate),
        input.type,
        input.docDate,
        input.channelId,
        input.externalOrderNo || null,
        input.note,
        now,
        now
      ) as { id: number }
    writeItems(db, id, input.items)
    return getDocument(db, id)
  })
}

function getDraftOrThrow(db: Db, id: number): DocumentDetail {
  const doc = getDocument(db, id)
  if (doc.status !== 'draft')
    throw new ServiceError('NOT_DRAFT', `单据 ${doc.docNo} 已${doc.status === 'confirmed' ? '生效' : '作废'}，不能修改`)
  return doc
}

/** 修改草稿。单据类型不可改；日期改变时单号保持不变，避免引用漂移。 */
export function updateDraft(db: Db, id: number, raw: DocumentDraftInput): DocumentDetail {
  const input = documentDraftSchema.parse(raw)
  return transaction(db, () => {
    const doc = getDraftOrThrow(db, id)
    if (doc.type !== input.type) throw new ServiceError('VALIDATION', '不能修改单据类型')
    assertSkusExist(db, input.items)
    assertChannel(db, input)
    db.prepare(
      `UPDATE documents SET doc_date = ?, channel_id = ?, external_order_no = ?, note = ?, updated_at = ? WHERE id = ?`
    ).run(input.docDate, input.channelId, input.externalOrderNo || null, input.note, nowIso(), id)
    writeItems(db, id, input.items)
    return getDocument(db, id)
  })
}

/** 删除草稿；attachmentsDir 提供时一并清理附件文件（事务提交后再删文件）。 */
export function deleteDraft(db: Db, id: number, attachmentsDir?: string): void {
  const files = transaction(db, () => {
    getDraftOrThrow(db, id)
    const paths = attachmentsDir ? removeAttachmentsOfDocument(db, attachmentsDir, id) : []
    db.prepare(`DELETE FROM document_items WHERE document_id = ?`).run(id)
    db.prepare(`DELETE FROM documents WHERE id = ?`).run(id)
    return paths
  })
  for (const f of files) if (existsSync(f)) unlinkSync(f)
}

/** 草稿 → 已生效：逐行写流水并更新库存。库存不足时整单回滚。 */
export function confirmDocument(db: Db, id: number): DocumentDetail {
  return transaction(db, () => {
    const doc = getDraftOrThrow(db, id)
    if (doc.items.length === 0) throw new ServiceError('VALIDATION', '单据没有商品明细')
    // 业务时间取单据日期 + 当前时刻，保证同日流水按确认先后排序
    const occurredAt = `${doc.docDate}T${localDateTime().slice(11)}`
    const setSnapshot = db.prepare(`UPDATE document_items SET cost_snapshot_e4 = ? WHERE id = ?`)
    for (const item of doc.items) {
      if (doc.type === 'inbound') {
        applyMovement(db, {
          skuId: item.skuId,
          documentId: id,
          documentItemId: item.id,
          kind: 'inbound',
          quantityDelta: item.quantity,
          unitCostE4: centsToE4(item.unitPriceCents),
          occurredAt
        })
      } else {
        applyMovement(db, {
          skuId: item.skuId,
          documentId: id,
          documentItemId: item.id,
          kind: 'outbound',
          quantityDelta: -item.quantity,
          unitCostE4: 0n,
          occurredAt
        })
        const mv = db
          .prepare(`SELECT unit_cost_e4 FROM stock_movements WHERE document_item_id = ? ORDER BY id DESC LIMIT 1`)
          .get(item.id) as { unit_cost_e4: number | bigint }
        setSnapshot.run(mv.unit_cost_e4, item.id)
      }
    }
    const now = nowIso()
    db.prepare(`UPDATE documents SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`).run(
      now,
      now,
      id
    )
    return getDocument(db, id)
  })
}

/** 已生效 → 已作废：按原流水逐条反向冲回，原单据与原流水永久保留。 */
export function voidDocument(db: Db, id: number, reason: string): DocumentDetail {
  const trimmed = reason.trim()
  if (!trimmed) throw new ServiceError('VALIDATION', '请填写作废原因')
  return transaction(db, () => {
    const doc = getDocument(db, id)
    if (doc.status !== 'confirmed') throw new ServiceError('NOT_CONFIRMED', '只有已生效单据可以作废')
    if (doc.type === 'opening') throw new ServiceError('VALIDATION', '期初单不能作废，请通过库存调整纠错')
    const movements = db
      .prepare(
        `SELECT sku_id, document_item_id, quantity_delta, unit_cost_e4 FROM stock_movements
         WHERE document_id = ? AND kind <> 'void' ORDER BY id`
      )
      .all(id) as {
      sku_id: number
      document_item_id: number | null
      quantity_delta: number
      unit_cost_e4: number | bigint
    }[]
    const occurredAt = localDateTime()
    const now = nowIso()
    for (const mv of movements) {
      applyMovement(db, {
        skuId: mv.sku_id,
        documentId: id,
        documentItemId: mv.document_item_id,
        kind: 'void',
        quantityDelta: -mv.quantity_delta,
        unitCostE4: BigInt(mv.unit_cost_e4),
        occurredAt
      })
    }
    db.prepare(
      `UPDATE documents SET status = 'voided', voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?`
    ).run(now, trimmed, now, id)
    return getDocument(db, id)
  })
}

export function getPendingSummary(db: Db): PendingSummaryResult {
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_no, d.type, d.doc_date, d.note,
              COALESCE(SUM(i.quantity), 0) AS total_qty,
              COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS total_amount
       FROM documents d
       LEFT JOIN document_items i ON i.document_id = d.id
       WHERE d.status = 'draft'
       GROUP BY d.id
       ORDER BY d.id DESC`
    )
    .all() as {
    id: number
    doc_no: string
    type: 'inbound' | 'outbound'
    doc_date: string
    note: string
    total_qty: number
    total_amount: number
  }[]

  const drafts = rows.map((r) => ({
    id: r.id,
    docNo: r.doc_no,
    type: r.type,
    docDate: r.doc_date,
    totalQuantity: Number(r.total_qty),
    totalAmountCents: Number(r.total_amount),
    note: r.note || ''
  }))

  return pendingSummaryResultSchema.parse({
    drafts,
    draftCount: drafts.length
  })
}
