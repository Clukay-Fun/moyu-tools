// 主进程与 renderer 共用的领域类型（读模型）。

export type DocumentType = 'inbound' | 'outbound' | 'opening' | 'adjustment'
export type AdjustDirection = 'increase' | 'decrease'
export type DocumentStatus = 'draft' | 'confirmed' | 'voided'

export interface Product {
  id: number
  code: string
  name: string
  unit: string
  isActive: boolean
  imagePath: string | null
  defaultCostCents: number
  defaultPriceCents: number
  lowStockThreshold: number
  defaultSku: Sku
}

export interface Sku {
  id: number
  productId: number
  code: string
  isDefault: boolean
}

export interface StockLevel {
  skuId: number
  quantity: number
  /** 移动加权平均成本，整数分（由 e4 四舍五入得到，仅展示用） */
  avgCostCents: number
  /** 库存成本总额，整数分 */
  costValueCents: number
}

export interface DocumentSummary {
  id: number
  docNo: string
  type: DocumentType
  status: DocumentStatus
  docDate: string
  note: string
  totalQuantity: number
  totalAmountCents: number
  confirmedAt: string | null
  channelName: string | null
  externalOrderNo: string
  /** 出库成本合计（成本快照），只有生效过的出库单有值 */
  totalCostCents: number | null
  voidedAt: string | null
}

export interface AppError {
  code: string
  message: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppError }

export type UpdateStatus =
  'idle' | 'unsupported' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  releaseNotes: string | null
  progress: number | null
  lastCheckedAt: number | null
  autoCheck: boolean
  portable: boolean
  message: string | null
}

export interface SalesChannel {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
}

export interface DocumentItem {
  id: number
  lineNo: number
  skuId: number
  skuCode: string
  productName: string
  quantity: number
  unitPriceCents: number
  /** 出库确认时的平均成本快照（分），未确认或入库为 null */
  costSnapshotCents: number | null
}

export interface DocumentDetail extends DocumentSummary {
  adjustDirection: AdjustDirection | null
  channelId: number | null
  channelName: string | null
  externalOrderNo: string
  voidedAt: string | null
  voidReason: string | null
  items: DocumentItem[]
}

export interface DocumentListFilter {
  type?: DocumentType
  status?: DocumentStatus
  /** 业务日期起（YYYY-MM-DD，含） */
  from?: string
  /** 业务日期止（YYYY-MM-DD，含） */
  to?: string
  /** 单号 / 订单号 / 渠道 / 备注 的模糊搜索 */
  q?: string
  limit?: number
}

export type MovementKind = 'opening' | 'inbound' | 'outbound' | 'adjustment' | 'void'

export interface MovementRow {
  id: number
  skuId: number
  productName: string
  productCode: string
  occurredAt: string
  kind: MovementKind
  documentId: number
  docNo: string
  docType: DocumentType
  channelName: string | null
  externalOrderNo: string
  quantityDelta: number
  quantityAfter: number
  /** 单据明细上的单价（进价 / 售价），分 */
  unitPriceCents: number | null
  /** 本次流水的结转成本，分 */
  unitCostCents: number
}

export interface MovementFilter {
  kind?: MovementKind
  skuId?: number
  channelId?: number
  from?: string
  to?: string
  /** 单号模糊匹配 */
  docNo?: string
  page?: number
  pageSize?: number
}

export interface Page<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export interface DailyFlow {
  date: string
  inQty: number
  inAmountCents: number
  outQty: number
  outAmountCents: number
  /** 出库成本（成本快照），分 */
  outCostCents: number
}

export interface StockRow {
  product: Product
  stock: StockLevel
  hasOpening: boolean
  lowStock: boolean
}

export interface Overview {
  /** 全部启用商品的库存行 */
  rows: StockRow[]
  totalQuantity: number
  totalCostValueCents: number
  lowStockCount: number
  /** 兼容：第一个商品（单商品场景） */
  product: Product
  stock: StockLevel
  lowStock: boolean
  today: { inQty: number; inAmountCents: number; outQty: number; outAmountCents: number }
  trend: DailyFlow[]
  recentDocuments: DocumentSummary[]
  hasOpening: boolean
}

export interface SummaryRange {
  from: string
  to: string
  /** 不传为全部商品 */
  skuId?: number
}

export interface Summary {
  range: SummaryRange
  inQty: number
  inAmountCents: number
  outQty: number
  outAmountCents: number
  /** 出库成本（按成本快照），分 */
  outCostCents: number
  inDocCount: number
  outDocCount: number
  daily: DailyFlow[]
}

// ---- CSV 导入 / 导出 ----

export type CsvRowStatus = 'ok' | 'warning' | 'error'

export interface CsvImportRow {
  /** 文件中的行号（含表头，从 1 起） */
  line: number
  productCode: string
  type: 'inbound' | 'outbound' | 'opening' | null
  typeText: string
  docDate: string
  quantity: string
  unitPrice: string
  channel: string
  externalOrderNo: string
  note: string
  status: CsvRowStatus
  messages: string[]
}

export interface CsvImportPreview {
  fileName: string
  encoding: 'utf-8' | 'gbk'
  rows: CsvImportRow[]
  total: number
  okCount: number
  warningCount: number
  errorCount: number
  inQty: number
  inAmountCents: number
  outQty: number
  outAmountCents: number
  stockBefore: number
  /** 全部写入后的预计库存；有错误行时为 null */
  stockAfter: number | null
  canCommit: boolean
}

export interface CsvImportResult {
  documentCount: number
  docNos: string[]
  stockAfter: number
}

// ---- 附件 ----

export interface Attachment {
  id: number
  documentId: number
  fileName: string
  /** 相对附件目录的路径，renderer 通过 moyu-file://attachments/<relPath> 访问 */
  relPath: string
  mime: string
  size: number
  createdAt: string
}

export interface AttachmentUpload {
  fileName: string
  mime: string
  data: ArrayBuffer
}

// ---- 备份 ----

export interface BackupManifest {
  app: string
  formatVersion: number
  appVersion: string
  schemaVersion: number
  createdAt: string
  counts: { documents: number; movements: number; attachments: number }
  files: { path: string; size: number; sha256: string }[]
}

export interface TrashEntry {
  name: string
  createdAt: string
  sizeBytes: number
}

export interface BackupInspection {
  path: string
  manifest: BackupManifest
  /** 为空表示可以恢复 */
  problems: string[]
}
