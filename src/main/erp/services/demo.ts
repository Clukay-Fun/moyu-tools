import type { Db } from '../db/connection'
import { transaction } from '../db/connection'
import { ServiceError } from './errors'
import { updateProduct, getProduct, createProduct, listProducts } from './products'
import { createOpening } from './opening'
import { createDraft, confirmDocument, voidDocument } from './documents'
import { createAdjustment } from './adjustments'
import { removeAttachmentsOfDocument } from './attachments'
import { existsSync, unlinkSync } from 'node:fs'
import { localToday } from './reports'

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function hasBusinessData(db: Db): boolean {
  return !!db.prepare('SELECT 1 FROM documents LIMIT 1').get()
}

/** 载入一套示例业务数据：期初 + 两周出入库 + 作废 / 草稿 / 调整。只允许在空库上执行。 */
export function seedDemo(db: Db): { documents: number } {
  if (hasBusinessData(db)) throw new ServiceError('NOT_EMPTY', '已有业务数据，不能载入示例数据')
  const today = localToday()
  return transaction(db, () => {
    const p = getProduct(db)
    updateProduct(db, p.id, {
      isActive: true,
      code: p.code,
      name: p.name,
      unit: p.unit,
      defaultCostCents: 1000,
      defaultPriceCents: 2990,
      lowStockThreshold: 100
    })
    const skuId = p.defaultSku.id
    createOpening(db, {
      skuId,
      quantity: 300,
      unitCostCents: 1000,
      docDate: shift(today, -15),
      note: '示例：导入前实际库存'
    })
    const mk = (
      type: 'inbound' | 'outbound',
      day: number,
      qty: number,
      price: number,
      channelId: number | null = null,
      no = '',
      note = ''
    ) =>
      confirmDocument(
        db,
        createDraft(db, {
          type,
          docDate: shift(today, day),
          channelId,
          externalOrderNo: no,
          note,
          items: [{ skuId, quantity: qty, unitPriceCents: price }]
        }).id
      )
    mk('inbound', -12, 200, 1100, null, '', '示例：第二批到货')
    mk('outbound', -12, 40, 2990, 1, 'DY10001')
    mk('outbound', -11, 12, 2990, 4, 'WX2001')
    mk('outbound', -9, 25, 2990, 2, 'TB2001')
    mk('inbound', -6, 150, 1200)
    mk('outbound', -5, 60, 2890, 3, 'PDD3001', '示例：拼多多活动价')
    mk('outbound', -4, 8, 2990, 5, '', '示例：线下门店')
    mk('outbound', -2, 18, 2990, 4, 'WX2009')
    const v = mk('outbound', -1, 5, 2990, 1, 'DY10002')
    voidDocument(db, v.id, '示例：客户取消')
    createAdjustment(db, {
      skuId,
      direction: 'decrease',
      quantity: 3,
      unitCostCents: null,
      docDate: shift(today, -1),
      reason: '示例：盘点少 3 件'
    })
    mk('inbound', 0, 80, 1150)
    mk('outbound', 0, 33, 2990, 1, 'DY10003')
    createDraft(db, {
      type: 'outbound',
      docDate: today,
      channelId: 5,
      externalOrderNo: '',
      note: '示例：待发货草稿',
      items: [{ skuId, quantity: 4, unitPriceCents: 2990 }]
    })
    // 第二个商品，演示多商品
    const existing2 = listProducts(db).find((x) => x.code === 'FG002')
    const p2 =
      existing2 ??
      createProduct(db, {
        code: 'FG002',
        name: '发光车轮贴',
        unit: '套',
        isActive: true,
        defaultCostCents: 1800,
        defaultPriceCents: 4990,
        lowStockThreshold: 30
      })
    const sku2 = p2.defaultSku.id
    createOpening(db, {
      skuId: sku2,
      quantity: 60,
      unitCostCents: 1800,
      docDate: shift(today, -10),
      note: '示例：期初'
    })
    const mk2 = (
      type: 'inbound' | 'outbound',
      day: number,
      qty: number,
      price: number,
      channelId: number | null = null,
      no = ''
    ) =>
      confirmDocument(
        db,
        createDraft(db, {
          type,
          docDate: shift(today, day),
          channelId,
          externalOrderNo: no,
          note: '',
          items: [{ skuId: sku2, quantity: qty, unitPriceCents: price }]
        }).id
      )
    mk2('outbound', -7, 6, 4990, 1, 'DY20001')
    mk2('outbound', -3, 9, 4990, 2, 'TB20002')
    mk2('inbound', -2, 40, 1900)
    mk2('outbound', 0, 4, 4990, 4, 'WX20003')
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM documents').get() as { c: number }
    return { documents: c }
  })
}

/** 清空全部业务数据（单据 / 流水 / 附件 / 库存快照），保留商品资料与渠道。 */
export function resetBusinessData(db: Db, attachmentsDir: string): void {
  const files = transaction(db, () => {
    const docs = db.prepare('SELECT id FROM documents').all() as unknown as { id: number }[]
    const paths = docs.flatMap((d) => removeAttachmentsOfDocument(db, attachmentsDir, d.id))
    db.exec('DELETE FROM stock_movements; DELETE FROM document_items; DELETE FROM documents;')
    db.prepare(`UPDATE sku_stock SET quantity = 0, cost_value_e4 = 0, updated_at = ?`).run(new Date().toISOString())
    return paths
  })
  for (const f of files) if (existsSync(f)) unlinkSync(f)
}
