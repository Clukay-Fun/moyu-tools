import { z } from 'zod'
import { SLOT_KEY_PATTERN, isSafeLayerName } from './psd'

// 表单、IPC、CSV 共用的校验规则。

export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), '日期无效')

export const centsInt = z.number().int('金额精度到分').min(0, '金额不能为负')
export const qtyInt = z.number().int('数量必须是整数')

export const productUpdateSchema = z.object({
  code: z.string().trim().min(1, '编码不能为空').max(32, '编码过长'),
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称过长'),
  unit: z.string().trim().min(1, '单位不能为空').max(8, '单位过长'),
  defaultCostCents: centsInt,
  defaultPriceCents: centsInt,
  lowStockThreshold: z.number().int().min(0, '预警值不能为负'),
  isActive: z.boolean().default(true)
})
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>
export const productCreateSchema = productUpdateSchema
export type ProductCreateInput = z.infer<typeof productCreateSchema>

export const openingStockSchema = z.object({
  skuId: z.number().int().positive(),
  quantity: qtyInt.min(1, '期初数量至少为 1'),
  unitCostCents: centsInt,
  docDate: dateString,
  note: z.string().trim().max(200, '备注过长').default('')
})
export type OpeningStockInput = z.infer<typeof openingStockSchema>

export const documentItemSchema = z.object({
  skuId: z.number().int().positive(),
  quantity: qtyInt.min(1, '数量至少为 1'),
  unitPriceCents: centsInt
})

export const documentDraftSchema = z.object({
  type: z.enum(['inbound', 'outbound']),
  docDate: dateString,
  channelId: z.number().int().positive().nullable().default(null),
  externalOrderNo: z.string().trim().max(64, '订单号过长').default(''),
  note: z.string().trim().max(200, '备注过长').default(''),
  items: z.array(documentItemSchema).min(1, '至少需要一行商品')
})
export type DocumentDraftInput = z.infer<typeof documentDraftSchema>

export const channelCreateSchema = z.object({
  name: z.string().trim().min(1, '渠道名不能为空').max(32, '渠道名过长')
})
export const channelUpdateSchema = z.object({
  name: z.string().trim().min(1, '渠道名不能为空').max(32, '渠道名过长'),
  isActive: z.boolean()
})
export type ChannelCreateInput = z.infer<typeof channelCreateSchema>
export type ChannelUpdateInput = z.infer<typeof channelUpdateSchema>

const psdLayerName = z
  .string()
  .trim()
  .min(1, '图层名不能为空')
  .max(80, '图层名过长')
  .refine((name) => isSafeLayerName(name), '图层名含有不能使用的字符')

const psdTemplateName = z.string().trim().min(1, '模板名称不能为空').max(64, '模板名称过长')

export const psdTemplateCreateSchema = z.object({
  name: psdTemplateName,
  sourcePath: z.string().trim().min(1, '请选择 PSD')
})
export type PsdTemplateCreateInput = z.infer<typeof psdTemplateCreateSchema>

export const psdSlotCreateSchema = z
  .object({
    templateId: z.number().int().positive(),
    slotKey: z.string().trim().regex(SLOT_KEY_PATTERN, '位置编号应为 slot_01 到 slot_99'),
    dogLayer: psdLayerName,
    nameLayer: psdLayerName
  })
  .refine((value) => value.dogLayer !== value.nameLayer, '狗图图层和名字图层不能同名')
export type PsdSlotCreateInput = z.infer<typeof psdSlotCreateSchema>

export const psdSlotUpdateSchema = z
  .object({
    id: z.number().int().positive(),
    dogLayer: psdLayerName,
    nameLayer: psdLayerName
  })
  .refine((value) => value.dogLayer !== value.nameLayer, '狗图图层和名字图层不能同名')
export type PsdSlotUpdateInput = z.infer<typeof psdSlotUpdateSchema>

export const psdTemplateRenameSchema = z.object({
  id: z.number().int().positive(),
  name: psdTemplateName
})
export type PsdTemplateRenameInput = z.infer<typeof psdTemplateRenameSchema>

export const psdAssetKindSchema = z.enum(['dog', 'name'])

export const psdJobCreateSchema = z
  .object({
    templateId: z.number().int().positive(),
    title: z.string().trim().min(1, '请填写定制标题').max(60, '标题过长'),
    format: z.enum(['psd', 'tiff']).default('psd'),
    items: z
      .array(
        z.object({
          slotId: z.number().int().positive(),
          dogAssetId: z.number().int().positive(),
          nameAssetId: z.number().int().positive()
        })
      )
      .min(1, '至少选择一个位置')
  })
  .refine(
    (value) => new Set(value.items.map((item) => item.slotId)).size === value.items.length,
    '同一个位置不能重复替换'
  )
export type PsdJobCreateInput = z.infer<typeof psdJobCreateSchema>

export const adjustmentSchema = z.object({
  skuId: z.number().int().positive(),
  direction: z.enum(['increase', 'decrease']),
  quantity: qtyInt.min(1, '调整数量至少为 1'),
  /** 仅增加时有效；不传则按当前平均成本 */
  unitCostCents: centsInt.nullable().default(null),
  docDate: dateString,
  reason: z.string().trim().min(1, '请填写调整原因').max(200, '原因过长')
})
export type AdjustmentInput = z.infer<typeof adjustmentSchema>

// #region 阶段 4 只读数据接口 Schema

export const statsSummaryInputSchema = z.object({
  from: dateString,
  to: dateString
})
export type StatsSummaryInput = z.infer<typeof statsSummaryInputSchema>

export const statsPeriodSummarySchema = z.object({
  outAmountCents: z.number().int(),
  outCostCents: z.number().int(),
  profitCents: z.number().int(),
  profitRate: z.number(),
  outQty: z.number().int(),
  outDocCount: z.number().int(),
  inQty: z.number().int(),
  inAmountCents: z.number().int()
})
export type StatsPeriodSummary = z.infer<typeof statsPeriodSummarySchema>

export const statsSummaryResultSchema = z.object({
  current: statsPeriodSummarySchema,
  previous: statsPeriodSummarySchema,
  changes: z.object({
    outAmount: z.number().nullable(),
    outCost: z.number().nullable(),
    profit: z.number().nullable(),
    outQty: z.number().nullable(),
    outDocCount: z.number().nullable(),
    inQty: z.number().nullable(),
    inAmount: z.number().nullable()
  })
})
export type StatsSummaryResult = z.infer<typeof statsSummaryResultSchema>

export const statsDailySeriesInputSchema = z.object({
  from: dateString,
  to: dateString,
  productId: z.number().int().positive().optional()
})
export type StatsDailySeriesInput = z.infer<typeof statsDailySeriesInputSchema>

export const dailySeriesItemSchema = z.object({
  date: dateString,
  inQty: z.number().int(),
  inAmountCents: z.number().int(),
  outQty: z.number().int(),
  outAmountCents: z.number().int(),
  outCostCents: z.number().int(),
  profitCents: z.number().int()
})
export type DailySeriesItem = z.infer<typeof dailySeriesItemSchema>

export const productHealthInputSchema = z.object({
  windowDays: z.number().int().positive().default(30),
  baseDate: dateString.optional()
})
export type ProductHealthInput = z.infer<typeof productHealthInputSchema>

export const productHealthItemSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  code: z.string(),
  skuCode: z.string(),
  stock: z.number().int(),
  avgCostCents: z.number().int(),
  costValueCents: z.number().int(),
  lowStockThreshold: z.number().int(),
  windowOutQty: z.number().int(),
  windowOutDocCount: z.number().int(),
  daysOfSupply: z.number().int().nullable(),
  /** out 缺货 · critical 可售不足 7 天 · low 低于预警 · ok 正常 · inactive 已停用 */
  status: z.enum(['out', 'critical', 'low', 'ok', 'inactive'])
})
export type ProductHealthItem = z.infer<typeof productHealthItemSchema>

export const pendingDraftItemSchema = z.object({
  id: z.number().int().positive(),
  docNo: z.string(),
  type: z.enum(['inbound', 'outbound']),
  docDate: dateString,
  totalQuantity: z.number().int(),
  totalAmountCents: z.number().int(),
  note: z.string()
})
export type PendingDraftItem = z.infer<typeof pendingDraftItemSchema>

export const pendingSummaryResultSchema = z.object({
  drafts: z.array(pendingDraftItemSchema),
  draftCount: z.number().int()
})
export type PendingSummaryResult = z.infer<typeof pendingSummaryResultSchema>

export const productLastPricesSchema = z.record(
  z.string(),
  z.object({
    lastInboundPriceCents: z.number().int().nullable(),
    lastOutboundPriceCents: z.number().int().nullable()
  })
)
export type ProductLastPrices = z.infer<typeof productLastPricesSchema>

// #endregion
