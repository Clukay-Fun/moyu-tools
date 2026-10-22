// E0 Spike：验证主进程 node:sqlite 建库读写、moyu-file:// 读图。E1 搬入正式服务层后删除。
import { ipcMain, nativeImage } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from './db'
import { erpDatabasePath, erpDataDir } from './paths'

function writeSpikeImage(path: string): void {
  const size = 64
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      // BGRA：主题紫到青的对角渐变
      pixels[i] = 230 - Math.round((x + y) * 0.4)
      pixels[i + 1] = 120 + Math.round((x + y) * 0.7)
      pixels[i + 2] = 105
      pixels[i + 3] = 255
    }
  }
  writeFileSync(path, nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG())
}

export function registerErpSpikeHandlers(): void {
  ipcMain.handle('erp:spike', () => {
    const db = openDatabase(erpDatabasePath())
    try {
      db.exec('CREATE TABLE IF NOT EXISTS spike (id INTEGER PRIMARY KEY, at TEXT NOT NULL)')
      db.prepare('INSERT INTO spike (at) VALUES (?)').run(new Date().toISOString())
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM spike').get() as { count: number }
      const { version } = db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
      const image = join(erpDataDir(), 'spike.png')
      if (!existsSync(image)) writeSpikeImage(image)
      return { count, sqlite: version, dbPath: erpDatabasePath(), imageUrl: 'moyu-file://erp/spike.png' }
    } finally {
      db.close()
    }
  })
}
