import { app, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { BackupInspection, TrashEntry } from '@shared/erp/types'
import { state } from './appState'
import { createBackup, inspectBackup, restoreBackup } from './services/backup'
import { ServiceError } from './services/errors'
import { notifyMainWindow, owner } from './window'
import { IPC } from '@shared/erp/ipc'

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export async function createBackupInteractive(): Promise<string | null> {
  const r = await dialog.showSaveDialog(owner()!, {
    title: '保存备份',
    defaultPath: join(app.getPath('documents'), `摸鱼库存备份-${stamp()}.zip`),
    filters: [{ name: '摸鱼库存备份', extensions: ['zip'] }]
  })
  if (r.canceled || !r.filePath) return null
  createBackup(
    state.db,
    { dbPath: state.dbPath, attachmentsDir: state.attachmentsDir, psdAssetsDir: state.psdAssetsDir },
    app.getVersion(),
    r.filePath,
    null
  )
  return r.filePath
}

export async function pickBackupFile(): Promise<string | null> {
  const r = await dialog.showOpenDialog(owner()!, {
    title: '选择备份文件',
    filters: [{ name: '摸鱼库存备份', extensions: ['zip'] }],
    properties: ['openFile']
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

export function inspectBackupFile(path: string): BackupInspection {
  if (typeof path !== 'string' || !path.toLowerCase().endsWith('.zip'))
    throw new ServiceError('VALIDATION', '只支持 .zip 备份文件')
  return inspectBackup(path)
}

/**
 * 关闭当前库 → 恢复 → 接管新连接 → 通知 renderer 重新加载库存 / 定制数据。任何失败都会尝试重新打开原库。
 * 外观偏好归摸鱼自己的设置管，备份里的 preferences.json 不再回写。
 */
export function restoreBackupFile(path: string): void {
  inspectBackupFile(path)
  state.close()
  try {
    const db = restoreBackup(path, { dbPath: state.dbPath, attachmentsDir: state.attachmentsDir, psdAssetsDir: state.psdAssetsDir }, state.trashDir)
    state.adopt(db)
  } catch (err) {
    state.open()
    throw err
  }
  // 不能整窗 reload（会打断摸鱼其他模块的进行中状态），只让库存 / 定制丢弃内存状态重新加载
  notifyMainWindow(IPC.dataReplaced)
}

function dirSize(p: string): number {
  const st = statSync(p)
  if (st.isFile()) return st.size
  return readdirSync(p).reduce((sum, n) => sum + dirSize(join(p, n)), 0)
}

/** 恢复时移入回收目录的历史数据。 */
export function listTrash(): TrashEntry[] {
  if (!existsSync(state.trashDir)) return []
  return readdirSync(state.trashDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = join(state.trashDir, d.name)
      return { name: d.name, createdAt: statSync(p).mtime.toISOString(), sizeBytes: dirSize(p) }
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}

export function clearTrash(): void {
  if (existsSync(state.trashDir)) rmSync(state.trashDir, { recursive: true, force: true })
}
