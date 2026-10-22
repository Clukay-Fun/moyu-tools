import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import type { Db } from '../db/connection'
import { nowIso, transaction } from '../db/connection'
import { parseCents, centsToE4 } from '@shared/erp/money'
import type { CsvImportPreview, CsvImportResult, CsvImportRow } from '@shared/erp/types'
import { ServiceError } from './errors'
import { listProducts } from './products'
import { getStock, applyMovement } from './inventory'
import { listChannels } from './channels'
import { nextDocNo } from './docNo'

/** 标准模板列（顺序固定，表头必须完全一致）。一行 = 一张单据的一行明细。 */
export const CSV_COLUMNS = ['商品编码', '类型', '日期', '数量', '单价', '渠道', '外部订单号', '备注'] as const
/** 旧模板（单商品，无商品编码列）仍然接受，所有行归到第一个启用商品 */
export const LEGACY_COLUMNS = ['类型', '日期', '数量', '单价', '渠道', '外部订单号', '备注'] as const

export const CSV_TEMPLATE_ROWS: string[][] = [
  ['FG001', '期初', '2026-08-31', '300', '10.00', '', '', '导入前实际库存（每个商品最多一行，且需尚未录入期初）'],
  ['FG001', '入库', '2026-09-01', '100', '10.50', '', '', '首批到货'],
  ['FG001', '出库', '2026-09-02', '2', '29.90', '抖音小店', 'DY20260902001', ''],
  ['FG001', '出库', '2026-09-02', '1', '29.90', '微信', '', '朋友代购']
]

export function buildTemplateCsv(): string {
  return stringify([[...CSV_COLUMNS], ...CSV_TEMPLATE_ROWS])
}

const TYPE_MAP: Record<string, 'inbound' | 'outbound' | 'opening'> = {
  期初: 'opening',
  opening: 'opening',
  入库: 'inbound',
  进货: 'inbound',
  in: 'inbound',
  inbound: 'inbound',
  出库: 'outbound',
  销售: 'outbound',
  out: 'outbound',
  outbound: 'outbound'
}

/** 解码：优先严格 UTF-8（去 BOM），失败则按 GBK（Windows Excel 另存 CSV 的默认编码）。 */
export function decodeCsv(buf: Uint8Array): { text: string; encoding: 'utf-8' | 'gbk' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
  }
}

interface ParsedRow {
  row: CsvImportRow
  quantity: number | null
  unitPriceCents: number | null
  channelId: number | null
  skuId: number | null
}

export interface PreviewContext {
  fileName: string
  encoding: 'utf-8' | 'gbk'
}

function parseRecords(text: string): { records: string[][]; legacy: boolean } {
  let records: string[][]
  try {
    records = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: true, bom: true }) as string[][]
  } catch (err) {
    throw new ServiceError('CSV_PARSE', `CSV 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (records.length === 0) throw new ServiceError('CSV_EMPTY', '文件为空')
  const [header, ...rest] = records
  const expected = CSV_COLUMNS.join(',')
  const legacy = header.join(',') === LEGACY_COLUMNS.join(',')
  if (!legacy && header.join(',') !== expected)
    throw new ServiceError('CSV_HEADER', `表头不符合标准模板。应为：${expected}；实际：${header.join(',')}`)
  if (rest.length === 0) throw new ServiceError('CSV_EMPTY', '文件只有表头，没有数据行')
  if (rest.length > 5000) throw new ServiceError('CSV_TOO_LARGE', '单次最多导入 5000 行')
  // 旧模板：补上空的商品编码列，后面统一处理
  return { records: legacy ? rest.map((r) => ['', ...r]) : rest, legacy }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 按日期（同日按行序）得到执行顺序 */
function executionOrder(parsed: ParsedRow[]): number[] {
  return parsed
    .map((_, i) => i)
    .sort((a, b) => {
      const da = parsed[a].row.docDate
      const db2 = parsed[b].row.docDate
      if (da !== db2) return da < db2 ? -1 : 1
      const oa = parsed[a].row.type === 'opening' ? 0 : 1
      const ob = parsed[b].row.type === 'opening' ? 0 : 1
      return oa !== ob ? oa - ob : a - b
    })
}

/** 解析并逐行校验，模拟库存变化。不写库。 */
export function previewImport(db: Db, text: string, ctx: PreviewContext): CsvImportPreview & { parsed: ParsedRow[] } {
  const { records } = parseRecords(text)
  const products = listProducts(db)
  const defaultProduct = products.find((p) => p.isActive) ?? products[0]
  if (!defaultProduct) throw new ServiceError('NOT_FOUND', '没有商品')
  const byCode = new Map(products.map((p) => [p.code, p]))
  const stockOf = new Map(products.map((p) => [p.defaultSku.id, getStock(db, p.defaultSku.id).quantity]))
  const stockBefore = [...stockOf.values()].reduce((a, b) => a + b, 0)
  const hasMovementsStmt = db.prepare(`SELECT 1 FROM stock_movements WHERE sku_id = ? LIMIT 1`)
  const openingLineBySku = new Map<number, number>()
  const channelByName = new Map(listChannels(db).map((c) => [c.name, c]))
  const seenOrders = new Map<string, number>()
  const existingDup = db.prepare(
    `SELECT doc_no FROM documents WHERE channel_id = ? AND external_order_no = ? AND status <> 'voided' LIMIT 1`
  )

  const parsed: ParsedRow[] = records.map((cells, i) => {
    const [
      productCodeRaw = '',
      typeText = '',
      docDate = '',
      quantity = '',
      unitPrice = '',
      channel = '',
      externalOrderNo = '',
      note = ''
    ] = cells
    const productCode = productCodeRaw.trim()
    const messages: string[] = []
    let status: CsvImportRow['status'] = 'ok'
    const fail = (m: string): void => {
      messages.push(m)
      status = 'error'
    }
    const warn = (m: string): void => {
      messages.push(m)
      if (status === 'ok') status = 'warning'
    }

    if (cells.length > CSV_COLUMNS.length) fail(`列数过多（${cells.length} 列）`)
    const product = productCode ? byCode.get(productCode) : defaultProduct
    if (!product) fail(`商品编码不存在：「${productCode}」`)
    else if (!product.isActive) fail(`商品「${product.code}」已停用`)
    const skuId = product?.defaultSku.id ?? null
    const type = TYPE_MAP[typeText.trim().toLowerCase()] ?? null
    if (!type) fail(`类型无法识别：「${typeText}」，应为 期初 / 入库 / 出库`)
    if (type === 'opening' && skuId !== null) {
      if (hasMovementsStmt.get(skuId)) fail('该商品已有库存流水，不能再导入期初；请改用库存调整')
      const prevLine = openingLineBySku.get(skuId)
      if (prevLine !== undefined) fail(`该商品在第 ${prevLine} 行已有期初，每个商品只能有一行`)
      else openingLineBySku.set(skuId, i + 2)
    }
    if (!DATE_RE.test(docDate) || Number.isNaN(Date.parse(docDate)))
      fail(`日期格式错误：「${docDate}」，应为 YYYY-MM-DD`)
    const qty = /^\d+$/.test(quantity) ? Number(quantity) : null
    if (qty === null || qty < 1) fail(`数量错误：「${quantity}」，应为正整数`)
    const price = parseCents(unitPrice)
    if (price === null) fail(`单价错误：「${unitPrice}」，应为非负金额，最多两位小数`)
    let channelId: number | null = null
    if ((type === 'inbound' || type === 'opening') && (channel || externalOrderNo))
      fail(`${type === 'opening' ? '期初' : '入库'}行不能填写渠道或外部订单号`)
    if (type === 'outbound' && channel) {
      const c = channelByName.get(channel)
      if (!c) fail(`渠道不存在：「${channel}」，请先在设置中添加`)
      else channelId = c.id
    }
    if (note.length > 200) fail('备注超过 200 字')
    if (externalOrderNo.length > 64) fail('外部订单号超过 64 字')
    if (type === 'outbound' && channelId !== null && externalOrderNo) {
      const key = `${channelId}|${externalOrderNo}`
      const prev = seenOrders.get(key)
      if (prev !== undefined) warn(`与第 ${prev} 行外部订单号重复`)
      else seenOrders.set(key, i + 2)
      const dup = existingDup.get(channelId, externalOrderNo) as { doc_no: string } | undefined
      if (dup) warn(`已有单据 ${dup.doc_no} 使用相同外部订单号`)
    }

    return {
      row: {
        line: i + 2,
        productCode: product?.code ?? productCode,
        type,
        typeText,
        docDate,
        quantity,
        unitPrice,
        channel,
        externalOrderNo,
        note,
        status,
        messages
      },
      quantity: qty,
      unitPriceCents: price,
      channelId,
      skuId
    }
  })

  // 字段全部合法时才模拟库存；否则库存不足的提示没有意义
  // 期初必须是最早的日期
  const opening = parsed.find((p) => p.row.type === 'opening' && p.row.status !== 'error')
  if (opening) {
    const earlier = parsed.find((p) => p !== opening && p.row.status !== 'error' && p.row.docDate < opening.row.docDate)
    if (earlier) {
      opening.row.messages.push(
        `期初日期必须早于或等于其他所有行（第 ${earlier.row.line} 行是 ${earlier.row.docDate}）`
      )
      opening.row.status = 'error'
    }
  }
  const hasFieldErrors = parsed.some((p) => p.row.status === 'error')
  const sim = new Map(stockOf)
  let inQty = 0
  let inAmount = 0
  let outQty = 0
  let outAmount = 0
  for (const i of executionOrder(parsed)) {
    const p = parsed[i]
    if (p.row.status === 'error' || p.quantity === null || p.unitPriceCents === null || p.skuId === null) continue
    const stock = sim.get(p.skuId) ?? 0
    if (p.row.type === 'opening') {
      sim.set(p.skuId, stock + p.quantity)
    } else if (p.row.type === 'inbound') {
      sim.set(p.skuId, stock + p.quantity)
      inQty += p.quantity
      inAmount += p.quantity * p.unitPriceCents
    } else {
      if (!hasFieldErrors && stock < p.quantity) {
        p.row.messages.push(`库存不足：按日期顺序执行到此行时该商品库存为 ${stock}，需要 ${p.quantity}`)
        p.row.status = 'error'
        continue
      }
      sim.set(p.skuId, stock - p.quantity)
      outQty += p.quantity
      outAmount += p.quantity * p.unitPriceCents
    }
  }

  const errorCount = parsed.filter((p) => p.row.status === 'error').length
  const warningCount = parsed.filter((p) => p.row.status === 'warning').length
  return {
    fileName: ctx.fileName,
    encoding: ctx.encoding,
    rows: parsed.map((p) => p.row),
    total: parsed.length,
    okCount: parsed.length - errorCount - warningCount,
    warningCount,
    errorCount,
    inQty,
    inAmountCents: inAmount,
    outQty,
    outAmountCents: outAmount,
    stockBefore,
    stockAfter: errorCount ? null : [...sim.values()].reduce((a, b) => a + b, 0),
    canCommit: errorCount === 0,
    parsed
  }
}

/** 重新解析校验，全部通过后在单个事务内写入已确认单据。任一行失败整批不写。 */
export function commitImport(db: Db, text: string, ctx: PreviewContext, acknowledgeWarnings: boolean): CsvImportResult {
  const preview = previewImport(db, text, ctx)
  if (preview.errorCount > 0)
    throw new ServiceError('CSV_HAS_ERRORS', `存在 ${preview.errorCount} 行错误，未写入任何数据`)
  if (preview.warningCount > 0 && !acknowledgeWarnings)
    throw new ServiceError('CSV_HAS_WARNINGS', `存在 ${preview.warningCount} 行重复订单号警告，请确认后再导入`)
  return transaction(db, () => {
    const docNos: string[] = []
    const now = nowIso()
    const insertDoc = db.prepare(
      `INSERT INTO documents (doc_no, type, status, doc_date, channel_id, external_order_no, note, confirmed_at, created_at, updated_at)
       VALUES (?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    const insertItem = db.prepare(
      `INSERT INTO document_items (document_id, line_no, sku_id, quantity, unit_price_cents) VALUES (?, 1, ?, ?, ?) RETURNING id`
    )
    const lastCost = db.prepare(
      `SELECT unit_cost_e4 FROM stock_movements WHERE document_item_id = ? ORDER BY id DESC LIMIT 1`
    )
    const setSnapshot = db.prepare(`UPDATE document_items SET cost_snapshot_e4 = ? WHERE id = ?`)

    for (const i of executionOrder(preview.parsed)) {
      const p = preview.parsed[i]
      const type = p.row.type!
      const skuId = p.skuId!
      const quantity = p.quantity!
      const unitPriceCents = p.unitPriceCents!
      const docNo = nextDocNo(db, type, p.row.docDate)
      const note = p.row.note || `CSV 导入：${ctx.fileName}`
      const { id: docId } = insertDoc.get(
        docNo,
        type,
        p.row.docDate,
        p.channelId,
        p.row.externalOrderNo || null,
        note,
        now,
        now,
        now
      ) as { id: number }
      const { id: itemId } = insertItem.get(docId, skuId, quantity, unitPriceCents) as { id: number }
      const occurredAt = `${p.row.docDate}T00:00:00`
      if (type === 'opening') {
        setSnapshot.run(centsToE4(unitPriceCents), itemId)
        applyMovement(db, {
          skuId,
          documentId: docId,
          documentItemId: itemId,
          kind: 'opening',
          quantityDelta: quantity,
          unitCostE4: centsToE4(unitPriceCents),
          occurredAt
        })
      } else if (type === 'inbound') {
        applyMovement(db, {
          skuId,
          documentId: docId,
          documentItemId: itemId,
          kind: 'inbound',
          quantityDelta: quantity,
          unitCostE4: centsToE4(unitPriceCents),
          occurredAt
        })
      } else {
        applyMovement(db, {
          skuId,
          documentId: docId,
          documentItemId: itemId,
          kind: 'outbound',
          quantityDelta: -quantity,
          unitCostE4: 0n,
          occurredAt
        })
        const mv = lastCost.get(itemId) as { unit_cost_e4: number | bigint }
        setSnapshot.run(mv.unit_cost_e4, itemId)
      }
      docNos.push(docNo)
    }
    const stockAfter = listProducts(db).reduce((a, p) => a + getStock(db, p.defaultSku.id).quantity, 0)
    return { documentCount: docNos.length, docNos, stockAfter }
  })
}
