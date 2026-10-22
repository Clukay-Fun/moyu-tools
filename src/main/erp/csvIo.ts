import { app, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Db } from './db/connection'
import type { CsvImportPreview, CsvImportResult, DocumentListFilter, MovementFilter, SummaryRange } from '@shared/erp/types'
import { ServiceError } from './services/errors'
import { buildTemplateCsv, commitImport, decodeCsv, previewImport } from './services/csvImport'
import {
  buildDocumentCsv,
  buildDocumentListCsv,
  buildMovementsCsv,
  buildSummaryCsv,
  CSV_BOM
} from './services/csvExport'
import { owner } from './window'

// 文件对话框与磁盘读写只在主进程发生；renderer 只拿到路径字符串。

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

export async function pickImportFile(): Promise<string | null> {
  const r = await dialog.showOpenDialog(owner()!, {
    title: '选择要导入的 CSV',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile']
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

function readImport(path: string): { text: string; ctx: { fileName: string; encoding: 'utf-8' | 'gbk' } } {
  if (typeof path !== 'string' || !path.toLowerCase().match(/\.(csv|txt)$/))
    throw new ServiceError('VALIDATION', '只支持 .csv 文件')
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    throw new ServiceError('NOT_FOUND', '文件不存在或无法读取')
  }
  if (buf.length > MAX_IMPORT_BYTES) throw new ServiceError('CSV_TOO_LARGE', '文件超过 5MB')
  const { text, encoding } = decodeCsv(buf)
  return { text, ctx: { fileName: basename(path), encoding } }
}

export function previewImportFile(db: Db, path: string): CsvImportPreview {
  const { text, ctx } = readImport(path)
  const { parsed: _parsed, ...preview } = previewImport(db, text, ctx)
  return preview
}

export function commitImportFile(db: Db, path: string, ack: boolean): CsvImportResult {
  const { text, ctx } = readImport(path)
  return commitImport(db, text, ctx, ack === true)
}

async function saveCsv(defaultName: string, content: string): Promise<string | null> {
  const r = await dialog.showSaveDialog(owner()!, {
    title: '导出 CSV',
    defaultPath: join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, content, 'utf8')
  return r.filePath
}

export function saveTemplate(): Promise<string | null> {
  return saveCsv('摸鱼工具箱-库存导入模板.csv', CSV_BOM + buildTemplateCsv())
}

export function exportDocumentList(db: Db, filter: DocumentListFilter): Promise<string | null> {
  const { fileName, content } = buildDocumentListCsv(db, filter ?? {})
  return saveCsv(fileName, content)
}

export function exportMovements(db: Db, filter: MovementFilter): Promise<string | null> {
  const tag = [filter.from, filter.to].filter(Boolean).join('_')
  return saveCsv(`库存流水${tag ? `-${tag}` : ''}.csv`, buildMovementsCsv(db, filter ?? {}))
}

export function exportSummary(db: Db, range: SummaryRange): Promise<string | null> {
  return saveCsv(`出入库汇总-${range.from}_${range.to}.csv`, buildSummaryCsv(db, range))
}

export function exportDocument(db: Db, id: number): Promise<string | null> {
  const { fileName, content } = buildDocumentCsv(db, id)
  return saveCsv(fileName, content)
}
