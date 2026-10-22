import type { ErpApi } from '@shared/erp/ipc'
import type { PhotoshopStatus } from '@shared/photoshop'

// window.api 由 src/preload/index.js 暴露；这里只声明库存 / 定制用到的部分
declare global {
  interface Window {
    api: {
      erp: ErpApi
      photoshop: {
        getStatus(): Promise<PhotoshopStatus>
        redetect(): Promise<PhotoshopStatus>
        onStatus(handler: (status: PhotoshopStatus) => void): () => void
      }
    }
  }
}

export {}
