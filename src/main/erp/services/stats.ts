/**
 * 描述: 统计与健康度只读业务查询服务 (Stats Service)
 * 主要功能:
 *   - 提供概览 KPI 环比汇总 (stats.getSummary)
 *   - 提供日频出入库连续序列 (stats.getDailySeries)
 *   - 提供最新业务活动日期检索 (stats.getLatestActivityDate)
 *   - 提供商品库存健康度与可售天数判定 (stats.getProductHealth)
 */

import type { Db } from '../db/connection'
import { e4ToCents } from '@shared/erp/money'
import {
  statsSummaryResultSchema,
  dailySeriesItemSchema,
  productHealthItemSchema,
  type StatsSummaryInput,
  type StatsSummaryResult,
  type StatsPeriodSummary,
  type StatsDailySeriesInput,
  type DailySeriesItem,
  type ProductHealthItem
} from '@shared/erp/schemas'
import { z } from 'zod'
import { ServiceError } from './errors'
import { listStock } from './inventory'

// #region 日期计算辅助函数

export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localToday(d)
}

function countDaysBetween(from: string, to: string): number {
  const d1 = new Date(`${from}T00:00:00`).getTime()
  const d2 = new Date(`${to}T00:00:00`).getTime()
  return Math.round((d2 - d1) / (24 * 3600 * 1000)) + 1
}

function calcPercentageChange(current: number, previous: number): number | null {
  if (previous === 0) {
    return current === 0 ? 0 : null
  }
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1))
}

// #endregion

// #region 1. 概览 KPI 环比汇总 (getStatsSummary)

function queryPeriodSummary(db: Db, from: string, to: string): StatsPeriodSummary {
  // 出库单数
  const outDocRow = db
    .prepare(
      `SELECT COUNT(DISTINCT d.id) AS c
       FROM documents d
       WHERE d.status = 'confirmed' AND d.type = 'outbound' AND d.doc_date BETWEEN ? AND ?`
    )
    .get(from, to) as { c: number }

  // 出库数量、金额与成本
  const outItemRow = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity), 0) AS qty,
              COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS amount,
              COALESCE(SUM(i.quantity * COALESCE(i.cost_snapshot_e4, 0)), 0) AS cost_e4
       FROM documents d
       JOIN document_items i ON i.document_id = d.id
       WHERE d.status = 'confirmed' AND d.type = 'outbound' AND d.doc_date BETWEEN ? AND ?`
    )
    .get(from, to) as { qty: number; amount: number; cost_e4: number | bigint }

  // 入库数量与金额
  const inItemRow = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity), 0) AS qty,
              COALESCE(SUM(i.quantity * i.unit_price_cents), 0) AS amount
       FROM documents d
       JOIN document_items i ON i.document_id = d.id
       WHERE d.status = 'confirmed' AND d.type = 'inbound' AND d.doc_date BETWEEN ? AND ?`
    )
    .get(from, to) as { qty: number; amount: number }

  const outAmountCents = Number(outItemRow.amount)
  const outCostCents = e4ToCents(BigInt(outItemRow.cost_e4))
  const profitCents = outAmountCents - outCostCents
  const profitRate = outAmountCents > 0 ? Number((profitCents / outAmountCents).toFixed(4)) : 0

  return {
    outAmountCents,
    outCostCents,
    profitCents,
    profitRate,
    outQty: Number(outItemRow.qty),
    outDocCount: Number(outDocRow.c),
    inQty: Number(inItemRow.qty),
    inAmountCents: Number(inItemRow.amount)
  }
}

export function getStatsSummary(db: Db, input: StatsSummaryInput): StatsSummaryResult {
  if (input.from > input.to) {
    throw new ServiceError('VALIDATION', '开始日期不能晚于结束日期')
  }

  const days = countDaysBetween(input.from, input.to)
  const prevTo = shiftDate(input.from, -1)
  const prevFrom = shiftDate(prevTo, -(days - 1))

  const current = queryPeriodSummary(db, input.from, input.to)
  const previous = queryPeriodSummary(db, prevFrom, prevTo)

  const changes = {
    outAmount: calcPercentageChange(current.outAmountCents, previous.outAmountCents),
    outCost: calcPercentageChange(current.outCostCents, previous.outCostCents),
    profit: calcPercentageChange(current.profitCents, previous.profitCents),
    outQty: calcPercentageChange(current.outQty, previous.outQty),
    outDocCount: calcPercentageChange(current.outDocCount, previous.outDocCount),
    inQty: calcPercentageChange(current.inQty, previous.inQty),
    inAmount: calcPercentageChange(current.inAmountCents, previous.inAmountCents)
  }

  return statsSummaryResultSchema.parse({
    current,
    previous,
    changes
  })
}

// #endregion

// #region 2. 逐日连续序列 (getStatsDailySeries)

interface DailyQueryRow {
  date: string
  type: 'inbound' | 'outbound'
  qty: number
  amount: number
  cost_e4: number | bigint
}

export function getStatsDailySeries(db: Db, input: StatsDailySeriesInput): DailySeriesItem[] {
  if (input.from > input.to) {
    throw new ServiceError('VALIDATION', '开始日期不能晚于结束日期')
  }

  const rows = db
    .prepare(
      `SELECT d.doc_date AS date, d.type,
              SUM(i.quantity) AS qty,
              SUM(i.quantity * i.unit_price_cents) AS amount,
              SUM(i.quantity * COALESCE(i.cost_snapshot_e4, 0)) AS cost_e4
       FROM documents d
       JOIN document_items i ON i.document_id = d.id
       JOIN skus s ON s.id = i.sku_id
       WHERE d.status = 'confirmed' AND d.type IN ('inbound', 'outbound')
         AND d.doc_date BETWEEN ? AND ?
         AND (? IS NULL OR s.product_id = ?)
       GROUP BY d.doc_date, d.type`
    )
    .all(input.from, input.to, input.productId ?? null, input.productId ?? null) as unknown as DailyQueryRow[]

  const map = new Map<string, { inQty: number; inAmount: number; outQty: number; outAmount: number; outCost: number }>()
  for (const r of rows) {
    const entry = map.get(r.date) ?? {
      inQty: 0,
      inAmount: 0,
      outQty: 0,
      outAmount: 0,
      outCost: 0
    }
    if (r.type === 'inbound') {
      entry.inQty += Number(r.qty)
      entry.inAmount += Number(r.amount)
    } else {
      entry.outQty += Number(r.qty)
      entry.outAmount += Number(r.amount)
      entry.outCost += e4ToCents(BigInt(r.cost_e4))
    }
    map.set(r.date, entry)
  }

  // 生成从 from 到 to 每一天的连续完整序列
  const result: DailySeriesItem[] = []
  const days = countDaysBetween(input.from, input.to)

  for (let i = 0; i < days; i++) {
    const date = shiftDate(input.from, i)
    const day = map.get(date) ?? {
      inQty: 0,
      inAmount: 0,
      outQty: 0,
      outAmount: 0,
      outCost: 0
    }
    result.push({
      date,
      inQty: day.inQty,
      inAmountCents: day.inAmount,
      outQty: day.outQty,
      outAmountCents: day.outAmount,
      outCostCents: day.outCost,
      profitCents: day.outAmount - day.outCost
    })
  }

  return z.array(dailySeriesItemSchema).parse(result)
}

// #endregion

// #region 3. 最近活动日期 (getLatestActivityDate)

export function getLatestActivityDate(db: Db): string | null {
  const row = db
    .prepare(
      `SELECT MAX(doc_date) AS latest
       FROM documents
       WHERE status = 'confirmed'`
    )
    .get() as { latest: string | null } | undefined

  return row?.latest ?? null
}

// #endregion

// #region 4. 商品健康度与可售天数 (getProductHealth)

interface OutStatRow {
  product_id: number
  doc_count: number
  out_qty: number
}

export function getProductHealth(db: Db, windowDays = 30, baseDate?: string): ProductHealthItem[] {
  const stockRows = listStock(db)
  const today = baseDate ?? localToday()
  const windowFrom = shiftDate(today, -(windowDays - 1))

  // 统计每个商品在指定窗口期内的出库件数与出库单数
  const outStats = db
    .prepare(
      `SELECT s.product_id,
              COUNT(DISTINCT d.id) AS doc_count,
              COALESCE(SUM(i.quantity), 0) AS out_qty
       FROM documents d
       JOIN document_items i ON i.document_id = d.id
       JOIN skus s ON s.id = i.sku_id
       WHERE d.status = 'confirmed' AND d.type = 'outbound'
         AND d.doc_date BETWEEN ? AND ?
       GROUP BY s.product_id`
    )
    .all(windowFrom, today) as unknown as OutStatRow[]

  const statsMap = new Map<number, { docCount: number; outQty: number }>()
  for (const s of outStats) {
    statsMap.set(s.product_id, {
      docCount: Number(s.doc_count),
      outQty: Number(s.out_qty)
    })
  }

  const items: ProductHealthItem[] = stockRows.map((sr) => {
    const p = sr.product
    const st = sr.stock
    const stat = statsMap.get(p.id) ?? { docCount: 0, outQty: 0 }

    const dailyOut = stat.outQty / windowDays
    let daysOfSupply: number | null

    if (stat.docCount < 3 || dailyOut === 0) {
      daysOfSupply = null
    } else if (st.quantity <= 0) {
      daysOfSupply = 0
    } else {
      daysOfSupply = Math.floor(st.quantity / dailyOut)
    }

    // 按顺序取第一个命中的：缺货 → 可售不足 7 天 → 低于预警 → 正常；停用商品单独标记
    let status: ProductHealthItem['status']
    if (!p.isActive) status = 'inactive'
    else if (st.quantity <= 0) status = 'out'
    else if (daysOfSupply !== null && daysOfSupply < 7) status = 'critical'
    else if (p.lowStockThreshold > 0 && st.quantity <= p.lowStockThreshold) status = 'low'
    else status = 'ok'

    return {
      productId: p.id,
      name: p.name,
      code: p.code,
      skuCode: p.defaultSku.code,
      stock: st.quantity,
      avgCostCents: st.avgCostCents,
      costValueCents: st.costValueCents,
      lowStockThreshold: p.lowStockThreshold,
      windowOutQty: stat.outQty,
      windowOutDocCount: stat.docCount,
      daysOfSupply,
      status
    }
  })

  return z.array(productHealthItemSchema).parse(items)
}

// #endregion
