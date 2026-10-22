import { app } from 'electron'
import { join } from 'node:path'

/** 库存 / 定制的数据目录。开发与打包都落在 userData 下，不再写仓库里的 data/。 */
export function erpDataDir(): string {
  return join(app.getPath('userData'), 'erp')
}

export function erpDatabasePath(): string {
  return join(erpDataDir(), 'moyu-erp.db')
}
