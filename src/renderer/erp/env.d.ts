// moyu preload 暴露给库存 / 定制的接口（只声明 erp 部分；其余 window.api 由 moyu 的 JS 使用）
export interface ErpSpikeResult {
  count: number
  sqlite: string
  dbPath: string
  imageUrl: string
}

declare global {
  interface Window {
    api: {
      erp: {
        spike: () => Promise<ErpSpikeResult>
      }
    }
  }
}
