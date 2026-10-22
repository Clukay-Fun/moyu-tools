import type {
  AdjustmentInput,
  ProductUpdateInput,
  ProductCreateInput,
  OpeningStockInput,
  DocumentDraftInput,
  ChannelCreateInput,
  ChannelUpdateInput,
  PsdJobCreateInput,
  PsdSlotCreateInput,
  PsdSlotUpdateInput,
  PsdTemplateCreateInput,
  PsdTemplateRenameInput,
  StatsSummaryInput,
  StatsSummaryResult,
  StatsDailySeriesInput,
  DailySeriesItem,
  ProductHealthInput,
  ProductHealthItem,
  PendingSummaryResult,
  ProductLastPrices
} from './schemas'
import type { PsdAssetKind, PsdBoard } from './psd'
import type {
  Attachment,
  AttachmentUpload,
  BackupInspection,
  CsvImportPreview,
  CsvImportResult,
  DocumentDetail,
  TrashEntry,
  DocumentListFilter,
  DocumentSummary,
  IpcResult,
  MovementFilter,
  MovementRow,
  Overview,
  Page,
  Product,
  StockRow,
  Summary,
  SummaryRange,
  SalesChannel,
  StockLevel
} from './types'

// renderer ↔ main 的白名单 IPC 契约。
// 通道名集中定义，preload 只暴露这里列出的方法，不暴露通用 invoke。

export const IPC = {
  appGetInfo: 'erp:app:getInfo',
  appRevealPath: 'erp:app:revealPath',
  /** 恢复备份后主进程通知 renderer：库已整体替换，库存 / 定制重新加载（不再整窗 reload） */
  dataReplaced: 'erp:data:replaced',
  statsGetSummary: 'erp:stats:getSummary',
  statsGetDailySeries: 'erp:stats:getDailySeries',
  statsGetLatestActivityDate: 'erp:stats:getLatestActivityDate',
  statsGetProductHealth: 'erp:stats:getProductHealth',
  documentsGetPendingSummary: 'erp:documents:getPendingSummary',
  productsGetLastPrices: 'erp:products:getLastPrices',
  productsGet: 'erp:products:get',
  productsUpdate: 'erp:products:update',
  productsList: 'erp:products:list',
  productsGetById: 'erp:products:getById',
  productsCreate: 'erp:products:create',
  inventoryListStock: 'erp:inventory:listStock',
  inventoryGetStock: 'erp:inventory:getStock',
  openingGet: 'erp:opening:get',
  openingCreate: 'erp:opening:create',
  documentsList: 'erp:documents:list',
  documentsCount: 'erp:documents:count',
  documentsGet: 'erp:documents:get',
  documentsCreateDraft: 'erp:documents:createDraft',
  documentsUpdateDraft: 'erp:documents:updateDraft',
  documentsDeleteDraft: 'erp:documents:deleteDraft',
  documentsConfirm: 'erp:documents:confirm',
  documentsVoid: 'erp:documents:void',
  documentsFindDuplicate: 'erp:documents:findDuplicate',
  channelsList: 'erp:channels:list',
  channelsCreate: 'erp:channels:create',
  channelsUpdate: 'erp:channels:update',
  inventoryListMovements: 'erp:inventory:listMovements',
  overviewGet: 'erp:overview:get',
  summaryGet: 'erp:summary:get',
  csvPickImportFile: 'erp:csv:pickImportFile',
  csvPreview: 'erp:csv:preview',
  csvCommit: 'erp:csv:commit',
  csvSaveTemplate: 'erp:csv:saveTemplate',
  csvExportDocumentList: 'erp:csv:exportDocumentList',
  csvExportMovements: 'erp:csv:exportMovements',
  csvExportSummary: 'erp:csv:exportSummary',
  attachmentsList: 'erp:attachments:list',
  attachmentsAdd: 'erp:attachments:add',
  attachmentsRemove: 'erp:attachments:remove',
  backupCreate: 'erp:backup:create',
  backupPick: 'erp:backup:pick',
  backupInspect: 'erp:backup:inspect',
  backupRestore: 'erp:backup:restore',
  adjustmentsCreate: 'erp:adjustments:create',
  productsSetImage: 'erp:products:setImage',
  productsClearImage: 'erp:products:clearImage',
  csvExportDocument: 'erp:csv:exportDocument',
  backupListTrash: 'erp:backup:listTrash',
  backupClearTrash: 'erp:backup:clearTrash',
  demoSeed: 'erp:demo:seed',
  demoReset: 'erp:demo:reset',
  demoHasData: 'erp:demo:hasData',
  psdGetBoard: 'erp:psd:getBoard',
  psdPickTemplate: 'erp:psd:pickTemplate',
  psdCreateTemplate: 'erp:psd:createTemplate',
  psdDeleteTemplate: 'erp:psd:deleteTemplate',
  psdAddSlot: 'erp:psd:addSlot',
  psdUpdateSlot: 'erp:psd:updateSlot',
  psdRenameTemplate: 'erp:psd:renameTemplate',
  psdDeleteSlot: 'erp:psd:deleteSlot',
  psdImportAsset: 'erp:psd:importAsset',
  psdCreateCutout: 'erp:psd:createCutout',
  psdConfirmCutout: 'erp:psd:confirmCutout',
  psdCancelCutout: 'erp:psd:cancelCutout',
  psdDeleteAsset: 'erp:psd:deleteAsset',
  psdCreateJob: 'erp:psd:createJob',
  psdCancelJob: 'erp:psd:cancelJob',
  psdRetryJob: 'erp:psd:retryJob',
  psdSync: 'erp:psd:sync',
  psdRequeueStuck: 'erp:psd:requeueStuck',
  psdOpenBridge: 'erp:psd:openBridge',
  psdOpenOutputDir: 'erp:psd:openOutputDir',
  psdPickBridgeDir: 'erp:psd:pickBridgeDir',
  psdPickOutputDir: 'erp:psd:pickOutputDir',
  psdInstallPlugin: 'erp:psd:installPlugin',
  psdOpenPlugin: 'erp:psd:openPlugin',
  psdOpenUxpDeveloperTool: 'erp:psd:openUxpDeveloperTool',
  psdOpenPhotoshop: 'erp:psd:openPhotoshop',
  psdRevealJob: 'erp:psd:revealJob'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
  userDataPath: string
  dbPath: string
}

// preload 挂在 window.api.erp 下的 API 形状（库存 / 定制）。
export interface ErpApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    /** 在 Finder / 资源管理器中显示数据目录或数据库文件；只接受这两个固定位置 */
    revealPath(target: 'data' | 'db'): Promise<IpcResult<void>>
    /** 恢复备份后库被整体替换；返回取消订阅函数 */
    onDataReplaced(handler: () => void): () => void
  }
  products: {
    /** 第一个商品（兼容） */
    get(): Promise<IpcResult<Product>>
    list(): Promise<IpcResult<Product[]>>
    getById(id: number): Promise<IpcResult<Product>>
    create(input: ProductCreateInput): Promise<IpcResult<Product>>
    update(id: number, input: ProductUpdateInput): Promise<IpcResult<Product>>
    setImage(id: number, upload: AttachmentUpload): Promise<IpcResult<Product>>
    clearImage(id: number): Promise<IpcResult<Product>>
    getLastPrices(input: { productIds: number[] }): Promise<IpcResult<ProductLastPrices>>
  }
  stats: {
    getSummary(input: StatsSummaryInput): Promise<IpcResult<StatsSummaryResult>>
    getDailySeries(input: StatsDailySeriesInput): Promise<IpcResult<DailySeriesItem[]>>
    getLatestActivityDate(): Promise<IpcResult<string | null>>
    getProductHealth(input?: ProductHealthInput): Promise<IpcResult<ProductHealthItem[]>>
  }
  inventory: {
    getStock(skuId: number): Promise<IpcResult<StockLevel>>
    listStock(): Promise<IpcResult<StockRow[]>>
    listMovements(filter: MovementFilter): Promise<IpcResult<Page<MovementRow>>>
  }
  overview: {
    get(): Promise<IpcResult<Overview>>
  }
  summary: {
    get(range: SummaryRange): Promise<IpcResult<Summary>>
  }
  csv: {
    /** 打开文件选择框，取消返回 null */
    pickImportFile(): Promise<IpcResult<string | null>>
    preview(path: string): Promise<IpcResult<CsvImportPreview>>
    /** 重新解析校验后在单个事务内写入；acknowledgeWarnings 为 false 且存在警告时拒绝 */
    commit(path: string, acknowledgeWarnings: boolean): Promise<IpcResult<CsvImportResult>>
    saveTemplate(): Promise<IpcResult<string | null>>
    /** 按当前筛选导出全部单据列表（主进程生成 CSV，不受列表 1000 张上限限制） */
    exportDocumentList(filter: DocumentListFilter): Promise<IpcResult<string | null>>
    exportMovements(filter: MovementFilter): Promise<IpcResult<string | null>>
    exportSummary(range: SummaryRange): Promise<IpcResult<string | null>>
    exportDocument(id: number): Promise<IpcResult<string | null>>
  }
  opening: {
    /** 该 SKU 已确认的期初单，没有则为 null */
    get(skuId: number): Promise<IpcResult<DocumentSummary | null>>
    create(input: OpeningStockInput): Promise<IpcResult<DocumentSummary>>
  }
  documents: {
    list(filter: DocumentListFilter): Promise<IpcResult<DocumentSummary[]>>
    /** 满足筛选条件的总数（列表最多返回 1000 张，用这个判断是否被截断） */
    count(filter: DocumentListFilter): Promise<IpcResult<number>>
    get(id: number): Promise<IpcResult<DocumentDetail>>
    createDraft(input: DocumentDraftInput): Promise<IpcResult<DocumentDetail>>
    updateDraft(id: number, input: DocumentDraftInput): Promise<IpcResult<DocumentDetail>>
    deleteDraft(id: number): Promise<IpcResult<void>>
    confirm(id: number): Promise<IpcResult<DocumentDetail>>
    void(id: number, reason: string): Promise<IpcResult<DocumentDetail>>
    getPendingSummary(): Promise<IpcResult<PendingSummaryResult>>
    /** 同渠道下已存在相同外部订单号的单据（用于提示，不阻断） */
    findDuplicate(
      channelId: number | null,
      externalOrderNo: string,
      excludeId: number | null
    ): Promise<IpcResult<DocumentSummary | null>>
  }
  channels: {
    list(): Promise<IpcResult<SalesChannel[]>>
    create(input: ChannelCreateInput): Promise<IpcResult<SalesChannel>>
    update(id: number, input: ChannelUpdateInput): Promise<IpcResult<SalesChannel>>
  }
  attachments: {
    list(documentId: number): Promise<IpcResult<Attachment[]>>
    add(documentId: number, upload: AttachmentUpload): Promise<IpcResult<Attachment>>
    remove(id: number): Promise<IpcResult<void>>
  }
  backup: {
    /** 保存对话框 → 生成备份，取消返回 null；preferences 为界面偏好（外观配色等），随备份一起保存 */
    create(preferences?: Record<string, unknown>): Promise<IpcResult<string | null>>
    pick(): Promise<IpcResult<string | null>>
    inspect(path: string): Promise<IpcResult<BackupInspection>>
    /** 恢复成功后主进程会重新加载窗口；备份里带界面偏好时先写回 renderer 再重载 */
    restore(path: string): Promise<IpcResult<void>>
    listTrash(): Promise<IpcResult<TrashEntry[]>>
    clearTrash(): Promise<IpcResult<void>>
  }
  adjustments: {
    /** 直接生成已确认的库存调整单 */
    create(input: AdjustmentInput): Promise<IpcResult<DocumentDetail>>
  }
  demo: {
    hasData(): Promise<IpcResult<boolean>>
    /** 空库上载入示例数据 */
    seed(): Promise<IpcResult<{ documents: number }>>
    /** 清空全部业务数据，保留商品与渠道 */
    reset(): Promise<IpcResult<void>>
  }
  psd: {
    getBoard(): Promise<IpcResult<PsdBoard>>
    pickTemplate(): Promise<IpcResult<string | null>>
    createTemplate(input: PsdTemplateCreateInput): Promise<IpcResult<PsdBoard>>
    deleteTemplate(id: number): Promise<IpcResult<PsdBoard>>
    addSlot(input: PsdSlotCreateInput): Promise<IpcResult<PsdBoard>>
    /** 只更新模板配置里的图层映射，不修改 PSD 文件 */
    updateSlot(input: PsdSlotUpdateInput): Promise<IpcResult<PsdBoard>>
    renameTemplate(input: PsdTemplateRenameInput): Promise<IpcResult<PsdBoard>>
    deleteSlot(id: number): Promise<IpcResult<PsdBoard>>
    /** 取消选择时返回 null */
    importAsset(kind: PsdAssetKind): Promise<IpcResult<PsdBoard | null>>
    createCutout(assetId: number): Promise<IpcResult<PsdBoard>>
    confirmCutout(jobId: number): Promise<IpcResult<PsdBoard>>
    cancelCutout(jobId: number): Promise<IpcResult<PsdBoard>>
    deleteAsset(id: number): Promise<IpcResult<PsdBoard>>
    createJob(input: PsdJobCreateInput): Promise<IpcResult<PsdBoard>>
    cancelJob(id: number): Promise<IpcResult<PsdBoard>>
    retryJob(id: number): Promise<IpcResult<PsdBoard>>
    sync(): Promise<IpcResult<PsdBoard>>
    requeueStuck(): Promise<IpcResult<{ board: PsdBoard; count: number }>>
    openBridge(): Promise<IpcResult<void>>
    openOutputDir(): Promise<IpcResult<void>>
    pickBridgeDir(): Promise<IpcResult<PsdBoard | null>>
    pickOutputDir(): Promise<IpcResult<PsdBoard | null>>
    installPlugin(): Promise<IpcResult<PsdBoard>>
    openPlugin(): Promise<IpcResult<void>>
    openUxpDeveloperTool(): Promise<IpcResult<void>>
    openPhotoshop(): Promise<IpcResult<void>>
    revealJob(id: number): Promise<IpcResult<void>>
  }
}
