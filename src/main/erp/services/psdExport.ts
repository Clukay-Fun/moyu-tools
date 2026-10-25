import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { Db } from '../db/connection'
import { nowIso, transaction } from '../db/connection'
import {
  psdAssetKindSchema,
  psdJobCreateSchema,
  psdSlotCreateSchema,
  psdSlotUpdateSchema,
  psdTemplateRenameSchema,
  psdTemplateCreateSchema,
  type PsdJobCreateInput,
  type PsdSlotCreateInput,
  type PsdSlotUpdateInput,
  type PsdTemplateRenameInput,
  type PsdTemplateCreateInput
} from '@shared/erp/schemas'
import {
  PSD_JOB_VERSION,
  allocateOutputName,
  parseJobFile,
  parseCutoutJobFile,
  safeOutputBase,
  type PsdAsset,
  type PsdAssetKind,
  type PsdBoard,
  type PsdCutoutJob,
  type PsdCutoutJobFile,
  type PsdCutoutStatus,
  type PsdJob,
  type PsdJobFile,
  type PsdJobItem,
  type PsdJobStatus,
  type PsdSlot,
  type PsdTemplate
} from '@shared/erp/psd'
import { ServiceError } from './errors'

export interface PsdPaths {
  assetsDir: string
  bridgeDir: string
  outputDir?: string
}

export interface PsdBoardContext {
  photoshopPath: string | null
  pluginDir: string
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const BRIDGE_FOLDERS = ['inbox', 'staging', 'outputs', 'done', 'failed', 'processing'] as const
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

interface ImageInfo {
  width: number
  height: number
  hasAlpha: boolean
  extension: 'png' | 'jpg'
}

interface TemplateRow {
  id: number
  name: string
  source_path: string
  created_at: string
}

interface SlotRow {
  id: number
  template_id: number
  slot_key: string
  dog_layer: string
  name_layer: string
  sort_order: number
}

interface AssetRow {
  id: number
  kind: PsdAssetKind
  label: string
  rel_path: string
  width: number
  height: number
  has_alpha: number
  bytes: number
  created_at: string
}

interface JobRow {
  id: number
  template_id: number | null
  template_name: string
  title: string
  status: PsdJobStatus
  output_file: string | null
  output_path: string | null
  error: string | null
  created_at: string
  finished_at: string | null
}

interface ItemRow {
  job_id: number
  slot_key: string
  dog_layer: string
  name_layer: string
  dog_label: string
  name_label: string
  dog_asset_id: number | null
  name_asset_id: number | null
}

interface CutoutRow {
  id: number
  asset_id: number
  asset_kind: PsdAssetKind
  asset_label: string
  status: PsdCutoutStatus
  output_file: string
  output_path: string | null
  confirmed_asset_id: number | null
  error: string | null
  created_at: string
  finished_at: string | null
}

export function resolvePsdAssetPath(assetsDir: string, relPath: string): string {
  if (
    !relPath ||
    relPath.includes('..') ||
    relPath.startsWith('/') ||
    relPath.startsWith('\\') ||
    relPath.includes('\\')
  ) {
    throw new ServiceError('VALIDATION', '非法素材路径')
  }
  const root = resolve(assetsDir)
  const full = resolve(root, relPath)
  if (full !== root && !full.startsWith(root + sep)) throw new ServiceError('VALIDATION', '非法素材路径')
  return full
}

export function resolvePsdBridgeOutputPath(bridgeDir: string, fileName: string): string {
  return resolvePsdOutputPath(join(bridgeDir, 'outputs'), fileName)
}

export function resolvePsdOutputPath(outputDir: string, fileName: string): string {
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new ServiceError('VALIDATION', '非法抠图输出文件名')
  }
  const root = resolve(outputDir)
  const full = resolve(root, fileName)
  if (full !== root && !full.startsWith(root + sep)) throw new ServiceError('VALIDATION', '非法抠图输出路径')
  return full
}

export function resolvePsdCutoutResultPath(db: Db, jobId: number): string | null {
  if (!Number.isSafeInteger(jobId) || jobId < 1) return null
  const row = db.prepare(`SELECT status, output_path FROM psd_cutout_jobs WHERE id = ?`).get(jobId) as
    { status: PsdCutoutStatus; output_path: string | null } | undefined
  if (row?.status !== 'ready' || !row.output_path || !existsSync(row.output_path)) return null
  return row.output_path
}

function outputDir(paths: PsdPaths): string {
  return paths.outputDir ?? join(paths.bridgeDir, 'outputs')
}

function outputDirForTask(paths: PsdPaths, taskOutputDir: string | undefined): string {
  const legacy = resolve(paths.bridgeDir, 'outputs')
  const configured = resolve(outputDir(paths))
  const candidate = taskOutputDir ? resolve(taskOutputDir) : legacy
  if (candidate !== configured && candidate !== legacy) {
    throw new ServiceError('VALIDATION', '任务导出目录与当前设置不符，请重新创建任务')
  }
  return candidate
}

interface TransparentPngInfo {
  width: number
  height: number
  alphaBounds: { left: number; top: number; right: number; bottom: number }
}

/** 解码 Photoshop 生成的 8-bit RGBA PNG，确认存在真实透明像素且图像内容四周留有窄边距。 */
export function inspectCutoutPng(buf: Buffer): TransparentPngInfo {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG))
    throw new ServiceError('VALIDATION', '抠图结果不是有效 PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = 0
  let interlace = 0
  const imageData: Buffer[] = []
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > buf.length) throw new ServiceError('VALIDATION', 'PNG 数据块已截断')
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      imageData.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = end
  }
  assertImageDimensions(width, height)
  if (bitDepth !== 8 || ![4, 6].includes(colorType) || interlace !== 0 || !imageData.length) {
    throw new ServiceError('VALIDATION', '抠图 PNG 必须是非隔行 8-bit RGBA 或灰度透明格式')
  }
  const channels = colorType === 6 ? 4 : 2
  const bytesPerLine = width * channels
  const decoded = inflateSync(Buffer.concat(imageData))
  const expected = (bytesPerLine + 1) * height
  if (decoded.length !== expected) throw new ServiceError('VALIDATION', '抠图 PNG 像素数据长度不正确')
  let previous = Buffer.alloc(bytesPerLine)
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  let hasTransparency = false
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = decoded[cursor++]
    const row = Buffer.from(decoded.subarray(cursor, cursor + bytesPerLine))
    cursor += bytesPerLine
    for (let x = 0; x < bytesPerLine; x++) {
      const raw = row[x]
      const a = x >= channels ? row[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      if (filter === 1) row[x] = (raw + a) & 0xff
      else if (filter === 2) row[x] = (raw + b) & 0xff
      else if (filter === 3) row[x] = (raw + Math.floor((a + b) / 2)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        row[x] = (raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      } else if (filter !== 0) throw new ServiceError('VALIDATION', 'PNG 使用了未知的扫描行过滤器')
    }
    const alphaOffset = colorType === 6 ? 3 : 1
    for (let x = 0; x < width; x++) {
      const alpha = row[x * channels + alphaOffset]
      if (alpha < 255) hasTransparency = true
      if (alpha > 0) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    }
    previous = row
  }
  if (!hasTransparency) throw new ServiceError('VALIDATION', '抠图结果没有真实透明像素')
  if (right < left || bottom < top) throw new ServiceError('VALIDATION', '抠图结果为空')
  const margins = [left, top, width - right - 1, height - bottom - 1]
  if (margins.some((margin) => margin < 1 || margin > 32)) {
    throw new ServiceError('VALIDATION', '抠图画布没有按要求裁紧并保留统一边距')
  }
  return { width, height, alphaBounds: { left, top, right, bottom } }
}

export function ensureBridge(bridgeDir: string): void {
  for (const name of BRIDGE_FOLDERS) mkdirSync(join(bridgeDir, name), { recursive: true })
}

function ensurePsdOutputDir(paths: PsdPaths): void {
  mkdirSync(outputDir(paths), { recursive: true })
}

export function photoshopSearchRoots(platform = process.platform): string[] {
  if (platform === 'darwin') return ['/Applications']
  if (platform === 'win32') {
    const roots = [
      process.env.ProgramW6432,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.SystemDrive ? join(process.env.SystemDrive, 'Program Files') : undefined,
      'C:\\Program Files\\Adobe',
      'C:\\Program Files',
      'C:\\Program Files (x86)\\Adobe',
      'C:\\Program Files (x86)',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Adobe') : undefined
    ]
    return [...new Set(roots.filter((root): root is string => Boolean(root)))]
  }
  return []
}

/** 在给定根目录下找版本名排序最后的 Photoshop。`.app` 本身是目录。 */
export function findPhotoshopApp(roots: readonly string[]): string | null {
  const hits: string[] = []
  const consider = (full: string, name: string): void => {
    if (/^Adobe Photoshop .+\.app$/i.test(name) || /^Photoshop\.exe$/i.test(name)) hits.push(full)
  }
  const walk = (dir: string, depth: number): void => {
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (!ent.isDirectory()) {
        consider(full, ent.name)
        continue
      }
      consider(full, ent.name)
      if (depth > 0 && !ent.name.endsWith('.app') && (ent.name === 'Adobe' || ent.name.startsWith('Adobe Photoshop'))) {
        walk(full, depth - 1)
      }
    }
  }
  for (const root of roots) walk(root, 2)
  hits.sort()
  return hits.at(-1) ?? null
}

function assertImageDimensions(width: number, height: number): void {
  if (!width || !height || width > 20000 || height > 20000) {
    throw new ServiceError('VALIDATION', '图片尺寸无效')
  }
}

function readPngInfo(buf: Buffer): ImageInfo {
  if (buf.length < 26 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ServiceError('VALIDATION', 'PNG 文件无效')
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const colorType = buf[25]
  assertImageDimensions(width, height)
  return { width, height, hasAlpha: colorType === 4 || colorType === 6, extension: 'png' }
}

function readJpegInfo(buf: Buffer): ImageInfo {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new ServiceError('VALIDATION', 'JPG 文件无效')
  let offset = 2
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < buf.length && buf[offset] === 0xff) offset += 1
    const marker = buf[offset]
    offset += 1
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buf.length) break
    const segmentLength = buf.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buf.length) break
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) break
      const height = buf.readUInt16BE(offset + 3)
      const width = buf.readUInt16BE(offset + 5)
      assertImageDimensions(width, height)
      return { width, height, hasAlpha: false, extension: 'jpg' }
    }
    offset += segmentLength
  }
  throw new ServiceError('VALIDATION', 'JPG 文件无效')
}

function readImageInfo(buf: Buffer): ImageInfo {
  if (buf.subarray(0, 8).equals(PNG_SIG)) return readPngInfo(buf)
  if (buf[0] === 0xff && buf[1] === 0xd8) return readJpegInfo(buf)
  throw new ServiceError('VALIDATION', '只支持 PNG / JPG 图片')
}

function assertTemplateFile(filePath: string): void {
  if (!filePath.toLowerCase().endsWith('.psd')) throw new ServiceError('VALIDATION', '只支持 .psd 模板')
  if (!existsSync(filePath)) throw new ServiceError('NOT_FOUND', 'PSD 文件不存在')
  const stat = statSync(filePath)
  if (!stat.isFile() || stat.size === 0) throw new ServiceError('VALIDATION', 'PSD 文件是空的')
}

function assertOutsideBridge(bridgeDir: string, filePath: string): void {
  const full = resolve(filePath)
  const root = resolve(bridgeDir)
  if (full === root || full.startsWith(root + sep)) {
    throw new ServiceError('VALIDATION', '请选择桥接目录以外的 PSD 模板')
  }
}

function writeAtomic(filePath: string, text: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, filePath)
}

function moveFile(from: string, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true })
  if (existsSync(to)) unlinkSync(to)
  renameSync(from, to)
}

function outputPathFor(rootPath: string, fileName: string | null): string | null {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null
  const root = resolve(rootPath)
  const full = resolve(root, fileName)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

function countOf(db: Db, sql: string, ...args: (string | number)[]): number {
  return (db.prepare(sql).get(...args) as { c: number }).c
}

export function createPsdTemplate(db: Db, input: PsdTemplateCreateInput): number {
  const data = psdTemplateCreateSchema.parse(input)
  assertTemplateFile(data.sourcePath)
  const now = nowIso()
  const row = db
    .prepare(`INSERT INTO psd_templates (name, source_path, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id`)
    .get(data.name, resolve(data.sourcePath), now, now) as { id: number }
  return row.id
}

export function deletePsdTemplate(db: Db, templateId: number): void {
  if (!db.prepare(`SELECT id FROM psd_templates WHERE id = ?`).get(templateId)) {
    throw new ServiceError('NOT_FOUND', '模板不存在')
  }
  if (
    countOf(
      db,
      `SELECT COUNT(*) AS c FROM psd_jobs WHERE template_id = ? AND status IN ('queued', 'running')`,
      templateId
    )
  ) {
    throw new ServiceError('VALIDATION', '还有等待中的导出任务，不能删除模板')
  }
  db.prepare(`DELETE FROM psd_templates WHERE id = ?`).run(templateId)
}

export function addPsdSlot(db: Db, input: PsdSlotCreateInput): number {
  const data = psdSlotCreateSchema.parse(input)
  if (!db.prepare(`SELECT id FROM psd_templates WHERE id = ?`).get(data.templateId)) {
    throw new ServiceError('NOT_FOUND', '模板不存在')
  }
  const rows = db
    .prepare(`SELECT slot_key, dog_layer, name_layer FROM psd_slots WHERE template_id = ?`)
    .all(data.templateId) as { slot_key: string; dog_layer: string; name_layer: string }[]
  if (rows.some((row) => row.slot_key === data.slotKey)) throw new ServiceError('VALIDATION', '这个位置编号已经存在')
  const used = new Set(rows.flatMap((row) => [row.dog_layer, row.name_layer]))
  if (used.has(data.dogLayer) || used.has(data.nameLayer)) {
    throw new ServiceError('VALIDATION', '图层名已经用在别的位置上')
  }
  const sort = (
    db
      .prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM psd_slots WHERE template_id = ?`)
      .get(data.templateId) as {
      n: number
    }
  ).n
  const row = db
    .prepare(
      `INSERT INTO psd_slots (template_id, slot_key, dog_layer, name_layer, sort_order) VALUES (?, ?, ?, ?, ?) RETURNING id`
    )
    .get(data.templateId, data.slotKey, data.dogLayer, data.nameLayer, sort) as { id: number }
  db.prepare(`UPDATE psd_templates SET updated_at = ? WHERE id = ?`).run(nowIso(), data.templateId)
  return row.id
}

export function deletePsdSlot(db: Db, slotId: number): void {
  const slot = db.prepare(`SELECT template_id, slot_key FROM psd_slots WHERE id = ?`).get(slotId) as
    { template_id: number; slot_key: string } | undefined
  if (!slot) throw new ServiceError('NOT_FOUND', '位置不存在')
  if (
    countOf(
      db,
      `SELECT COUNT(*) AS c FROM psd_job_items i JOIN psd_jobs j ON j.id = i.job_id
       WHERE j.template_id = ? AND j.status IN ('queued', 'running') AND i.slot_key = ?`,
      slot.template_id,
      slot.slot_key
    )
  ) {
    throw new ServiceError('VALIDATION', '这个位置还有等待中的导出任务')
  }
  db.prepare(`DELETE FROM psd_slots WHERE id = ?`).run(slotId)
}

/** 修改已存在位置的图层映射；只写模板配置，不碰 PSD 文件 */
export function updatePsdSlot(db: Db, input: PsdSlotUpdateInput): void {
  const data = psdSlotUpdateSchema.parse(input)
  const slot = db.prepare(`SELECT template_id FROM psd_slots WHERE id = ?`).get(data.id) as
    { template_id: number } | undefined
  if (!slot) throw new ServiceError('NOT_FOUND', '位置不存在')
  if (
    countOf(
      db,
      `SELECT COUNT(*) AS c FROM psd_jobs WHERE template_id = ? AND status IN ('queued', 'running')`,
      slot.template_id
    )
  ) {
    throw new ServiceError('VALIDATION', '还有等待中的导出任务，不能修改图层映射')
  }
  const rows = db
    .prepare(`SELECT id, dog_layer, name_layer FROM psd_slots WHERE template_id = ?`)
    .all(slot.template_id) as { id: number; dog_layer: string; name_layer: string }[]
  if (
    rows.some(
      (row) =>
        row.id !== data.id &&
        (row.dog_layer === data.dogLayer ||
          row.name_layer === data.dogLayer ||
          row.dog_layer === data.nameLayer ||
          row.name_layer === data.nameLayer)
    )
  ) {
    throw new ServiceError('VALIDATION', '图层名已经用在别的位置上')
  }
  db.prepare(`UPDATE psd_slots SET dog_layer = ?, name_layer = ? WHERE id = ?`).run(
    data.dogLayer,
    data.nameLayer,
    data.id
  )
  db.prepare(`UPDATE psd_templates SET updated_at = ? WHERE id = ?`).run(nowIso(), slot.template_id)
}

/** 重命名模板；只改配置里的名称，任务里的历史模板名保持不变 */
export function renamePsdTemplate(db: Db, input: PsdTemplateRenameInput): void {
  const data = psdTemplateRenameSchema.parse(input)
  const row = db.prepare(`SELECT id FROM psd_templates WHERE id = ?`).get(data.id)
  if (!row) throw new ServiceError('NOT_FOUND', '模板不存在')
  db.prepare(`UPDATE psd_templates SET name = ?, updated_at = ? WHERE id = ?`).run(data.name, nowIso(), data.id)
}

export function importPsdAsset(
  db: Db,
  paths: PsdPaths,
  kind: PsdAssetKind,
  sourcePath: string,
  labelOverride?: string
): number {
  const parsedKind = psdAssetKindSchema.parse(kind)
  if (!existsSync(sourcePath)) throw new ServiceError('NOT_FOUND', '素材文件不存在')
  const buf = readFileSync(sourcePath)
  if (buf.length === 0) throw new ServiceError('VALIDATION', '文件为空')
  if (buf.length > MAX_IMAGE_BYTES) throw new ServiceError('VALIDATION', '图片超过 32MB')
  const info = readImageInfo(buf)
  const rel = `${randomUUID()}.${info.extension}`
  mkdirSync(paths.assetsDir, { recursive: true })
  const dest = resolvePsdAssetPath(paths.assetsDir, rel)
  writeFileSync(dest, buf)
  try {
    const label = (
      labelOverride?.trim() ||
      basename(sourcePath)
        .replace(/\.(png|jpe?g)$/i, '')
        .trim() ||
      '未命名'
    ).slice(0, 64)
    const row = db
      .prepare(
        `INSERT INTO psd_assets (kind, label, rel_path, width, height, has_alpha, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(parsedKind, label, rel, info.width, info.height, info.hasAlpha ? 1 : 0, buf.length, nowIso()) as {
      id: number
    }
    return row.id
  } catch (err) {
    if (existsSync(dest)) unlinkSync(dest)
    throw err
  }
}

export function deletePsdAsset(db: Db, paths: PsdPaths, assetId: number): void {
  const row = db.prepare(`SELECT rel_path FROM psd_assets WHERE id = ?`).get(assetId) as
    { rel_path: string } | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '素材不存在')
  if (
    countOf(
      db,
      `SELECT COUNT(*) AS c FROM psd_cutout_jobs WHERE asset_id = ? AND status IN ('queued', 'running', 'ready')`,
      assetId
    )
  ) {
    throw new ServiceError('VALIDATION', '这个素材的抠图任务尚未确认或取消')
  }
  if (
    countOf(
      db,
      `SELECT COUNT(*) AS c FROM psd_job_items i JOIN psd_jobs j ON j.id = i.job_id
       WHERE j.status IN ('queued', 'running') AND (i.dog_asset_id = ? OR i.name_asset_id = ?)`,
      assetId,
      assetId
    )
  ) {
    throw new ServiceError('VALIDATION', '这个素材还有等待中的导出任务')
  }
  db.prepare(`DELETE FROM psd_assets WHERE id = ?`).run(assetId)
  const full = resolvePsdAssetPath(paths.assetsDir, row.rel_path)
  if (existsSync(full)) unlinkSync(full)
}

function takenOutputNames(db: Db, paths: PsdPaths): Set<string> {
  const taken = new Set<string>()
  const outputs = outputDir(paths)
  if (existsSync(outputs)) {
    for (const name of readdirSync(outputs)) taken.add(name)
  }
  const rows = db
    .prepare(
      `SELECT output_file FROM psd_jobs WHERE status IN ('queued', 'running', 'failed') AND output_file IS NOT NULL`
    )
    .all() as { output_file: string }[]
  for (const row of rows) taken.add(row.output_file)
  return taken
}

export function createPsdJob(db: Db, paths: PsdPaths, input: PsdJobCreateInput): number {
  const data = psdJobCreateSchema.parse(input)
  const template = db.prepare(`SELECT id, name, source_path FROM psd_templates WHERE id = ?`).get(data.templateId) as
    { id: number; name: string; source_path: string } | undefined
  if (!template) throw new ServiceError('NOT_FOUND', '模板不存在')
  assertTemplateFile(template.source_path)
  assertOutsideBridge(paths.bridgeDir, template.source_path)

  const slotRows = db
    .prepare(`SELECT * FROM psd_slots WHERE template_id = ? ORDER BY sort_order, id`)
    .all(template.id) as unknown as SlotRow[]
  const slotById = new Map(slotRows.map((slot) => [slot.id, slot]))
  const prepared = data.items.map((item) => {
    const slot = slotById.get(item.slotId)
    if (!slot) throw new ServiceError('VALIDATION', '位置不属于这个模板')
    const dog = db.prepare(`SELECT * FROM psd_assets WHERE id = ?`).get(item.dogAssetId) as AssetRow | undefined
    const name = db.prepare(`SELECT * FROM psd_assets WHERE id = ?`).get(item.nameAssetId) as AssetRow | undefined
    if (!dog || dog.kind !== 'dog') throw new ServiceError('VALIDATION', '请选择狗图')
    if (!name || name.kind !== 'name') throw new ServiceError('VALIDATION', '请选择名字图')
    const dogPath = resolvePsdAssetPath(paths.assetsDir, dog.rel_path)
    const namePath = resolvePsdAssetPath(paths.assetsDir, name.rel_path)
    if (!existsSync(dogPath) || !existsSync(namePath)) throw new ServiceError('NOT_FOUND', '素材文件丢失')
    return { slot, dog, name, dogPath, namePath }
  })
  prepared.sort((a, b) => a.slot.sort_order - b.slot.sort_order || a.slot.id - b.slot.id)

  ensureBridge(paths.bridgeDir)
  ensurePsdOutputDir(paths)
  const extension = data.format === 'tiff' ? 'tif' : 'psd'
  const outputFile = allocateOutputName(safeOutputBase(data.title), takenOutputNames(db, paths), extension)
  const createdAt = nowIso()
  const id = transaction(db, () => {
    const row = db
      .prepare(
        `INSERT INTO psd_jobs (template_id, template_name, title, status, output_file, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?) RETURNING id`
      )
      .get(template.id, template.name, data.title, outputFile, createdAt) as { id: number }
    const insertItem = db.prepare(
      `INSERT INTO psd_job_items
        (job_id, slot_key, dog_layer, name_layer, dog_label, name_label, dog_asset_id, name_asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const item of prepared) {
      insertItem.run(
        row.id,
        item.slot.slot_key,
        item.slot.dog_layer,
        item.slot.name_layer,
        item.dog.label,
        item.name.label,
        item.dog.id,
        item.name.id
      )
    }
    return row.id
  })

  const staging = join(paths.bridgeDir, 'staging', String(id))
  const inbox = join(paths.bridgeDir, 'inbox', `${id}.json`)
  // 任务 id 可能被重用（恢复了较早的备份）：先清掉桥接目录里同编号的旧文件，免得新任务读到旧结果
  rmSync(staging, { recursive: true, force: true })
  for (const folder of ['processing', 'done', 'failed']) {
    rmSync(join(paths.bridgeDir, folder, `${id}.json`), { force: true })
  }
  try {
    mkdirSync(staging, { recursive: true })
    copyFileSync(template.source_path, join(staging, 'template.psd'))
    const spec: PsdJobFile = {
      version: 1,
      id,
      title: data.title,
      templateFile: 'template.psd',
      format: data.format,
      outputDir: outputDir(paths),
      outputFile,
      replacements: prepared.flatMap((item) => {
        const dogExtension = extname(item.dog.rel_path).toLowerCase()
        const nameExtension = extname(item.name.rel_path).toLowerCase()
        if (!['.png', '.jpg', '.jpeg'].includes(dogExtension) || !['.png', '.jpg', '.jpeg'].includes(nameExtension)) {
          throw new ServiceError('VALIDATION', '素材格式无效')
        }
        return [
          { layerName: item.slot.dog_layer, file: `${item.slot.slot_key}_dog${dogExtension}` },
          { layerName: item.slot.name_layer, file: `${item.slot.slot_key}_name${nameExtension}` }
        ]
      })
    }
    for (const item of prepared) {
      copyFileSync(item.dogPath, join(staging, `${item.slot.slot_key}_dog${extname(item.dog.rel_path).toLowerCase()}`))
      copyFileSync(
        item.namePath,
        join(staging, `${item.slot.slot_key}_name${extname(item.name.rel_path).toLowerCase()}`)
      )
    }
    parseJobFile(spec)
    writeAtomic(inbox, JSON.stringify(spec, null, 2))
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(inbox)) unlinkSync(inbox)
    const tmp = `${inbox}.${process.pid}.tmp`
    if (existsSync(tmp)) unlinkSync(tmp)
    const message = err instanceof ServiceError ? err.message : err instanceof Error ? err.message : String(err)
    db.prepare(`UPDATE psd_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      message,
      nowIso(),
      id
    )
    throw err instanceof ServiceError ? err : new ServiceError('INTERNAL', message)
  }
  return id
}

function applyResult(db: Db, paths: PsdPaths, parsed: PsdJobFile, filePath: string, folder: string): void {
  const row = db.prepare(`SELECT status FROM psd_jobs WHERE id = ?`).get(parsed.id) as
    { status: PsdJobStatus } | undefined
  if (!row || row.status === 'cancelled') return
  if (row.status === 'done' || row.status === 'failed') {
    if (folder !== row.status) moveFile(filePath, join(paths.bridgeDir, row.status, `${parsed.id}.json`))
    return
  }
  if (!parsed.result) {
    if (folder === 'processing' && row.status === 'queued') {
      db.prepare(`UPDATE psd_jobs SET status = 'running' WHERE id = ?`).run(parsed.id)
    }
    return
  }

  let dest: 'done' | 'failed' = 'failed'
  if (parsed.result.ok) {
    const outputPath = outputPathFor(outputDirForTask(paths, parsed.outputDir), parsed.result.outputFile)
    if (!outputPath || !existsSync(outputPath)) {
      db.prepare(`UPDATE psd_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
        '插件报告成功，但输出文件不存在',
        nowIso(),
        parsed.id
      )
    } else {
      db.prepare(
        `UPDATE psd_jobs SET status = 'done', output_path = ?, error = NULL, finished_at = ? WHERE id = ?`
      ).run(outputPath, nowIso(), parsed.id)
      rmSync(join(paths.bridgeDir, 'staging', String(parsed.id)), { recursive: true, force: true })
      dest = 'done'
    }
  } else {
    db.prepare(`UPDATE psd_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      parsed.result.error || '导出失败',
      nowIso(),
      parsed.id
    )
  }
  if (folder !== dest) moveFile(filePath, join(paths.bridgeDir, dest, `${parsed.id}.json`))
}

export function syncPsdResults(db: Db, paths: PsdPaths): void {
  ensureBridge(paths.bridgeDir)
  for (const folder of ['processing', 'done', 'failed'] as const) {
    const dir = join(paths.bridgeDir, folder)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const full = join(dir, name)
      if (!existsSync(full)) continue
      let parsed: PsdJobFile
      try {
        parsed = parseJobFile(JSON.parse(readFileSync(full, 'utf8')))
      } catch {
        continue
      }
      applyResult(db, paths, parsed, full, folder)
    }
  }
}

function cutoutTaskKey(id: number): string {
  return `cutout-${id}`
}

export function createPsdCutoutJob(db: Db, paths: PsdPaths, assetId: number): number {
  const asset = db.prepare(`SELECT * FROM psd_assets WHERE id = ?`).get(assetId) as AssetRow | undefined
  if (!asset) throw new ServiceError('NOT_FOUND', '素材不存在')
  const sourcePath = resolvePsdAssetPath(paths.assetsDir, asset.rel_path)
  if (!existsSync(sourcePath)) throw new ServiceError('NOT_FOUND', '素材文件丢失')
  if (
    countOf(
      db,
      `SELECT COUNT(*) AS c FROM psd_cutout_jobs WHERE asset_id = ? AND status IN ('queued', 'running', 'ready')`,
      assetId
    )
  ) {
    throw new ServiceError('VALIDATION', '这个素材已有尚未确认的抠图任务')
  }

  ensureBridge(paths.bridgeDir)
  const id = transaction(db, () => {
    const inserted = db
      .prepare(
        `INSERT INTO psd_cutout_jobs
          (asset_id, asset_kind, asset_label, status, output_file, created_at)
         VALUES (?, ?, ?, 'queued', 'pending.png', ?) RETURNING id`
      )
      .get(asset.id, asset.kind, asset.label, nowIso()) as { id: number }
    db.prepare(`UPDATE psd_cutout_jobs SET output_file = ? WHERE id = ?`).run(
      `${cutoutTaskKey(inserted.id)}.png`,
      inserted.id
    )
    return inserted.id
  })
  const key = cutoutTaskKey(id)
  const staging = join(paths.bridgeDir, 'staging', key)
  const inbox = join(paths.bridgeDir, 'inbox', `${key}.json`)
  ensurePsdOutputDir(paths)
  const output = resolvePsdOutputPath(outputDir(paths), `${key}.png`)
  try {
    mkdirSync(staging, { recursive: true })
    copyFileSync(sourcePath, join(staging, `source${extname(asset.rel_path).toLowerCase()}`))
    if (existsSync(output)) unlinkSync(output)
    const task: PsdCutoutJobFile = {
      version: PSD_JOB_VERSION,
      type: 'cutout',
      id,
      kind: asset.kind,
      outputDir: outputDir(paths),
      sourceFile: `source${extname(asset.rel_path).toLowerCase()}`,
      outputFile: `${key}.png`
    }
    parseCutoutJobFile(task)
    writeAtomic(inbox, JSON.stringify(task, null, 2))
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (existsSync(inbox)) unlinkSync(inbox)
    if (existsSync(output)) unlinkSync(output)
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(`UPDATE psd_cutout_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      message,
      nowIso(),
      id
    )
    throw err instanceof ServiceError ? err : new ServiceError('INTERNAL', message)
  }
  return id
}

export function syncPsdCutoutResults(db: Db, paths: PsdPaths): void {
  ensureBridge(paths.bridgeDir)
  for (const folder of ['processing', 'done', 'failed'] as const) {
    const dir = join(paths.bridgeDir, folder)
    for (const name of readdirSync(dir)) {
      if (!/^cutout-\d+\.json$/.test(name)) continue
      const filePath = join(dir, name)
      if (!existsSync(filePath)) continue
      let task: PsdCutoutJobFile
      try {
        task = parseCutoutJobFile(JSON.parse(readFileSync(filePath, 'utf8')))
      } catch {
        continue
      }
      const row = db.prepare(`SELECT * FROM psd_cutout_jobs WHERE id = ?`).get(task.id) as CutoutRow | undefined
      if (!row) continue
      const key = cutoutTaskKey(task.id)
      if (row.status === 'cancelled' || row.status === 'confirmed') {
        rmSync(join(paths.bridgeDir, 'staging', key), { recursive: true, force: true })
        if (existsSync(filePath)) unlinkSync(filePath)
        continue
      }
      if (row.status === 'ready') {
        if (folder !== 'done') moveFile(filePath, join(paths.bridgeDir, 'done', `${key}.json`))
        continue
      }
      if (row.status === 'failed') {
        if (folder !== 'failed') moveFile(filePath, join(paths.bridgeDir, 'failed', `${key}.json`))
        continue
      }
      const outputPath = resolvePsdOutputPath(outputDirForTask(paths, task.outputDir), row.output_file)
      if (!task.result) {
        if (folder === 'processing' && row.status === 'queued') {
          db.prepare(`UPDATE psd_cutout_jobs SET status = 'running' WHERE id = ?`).run(task.id)
        }
        continue
      }

      let destination: 'done' | 'failed' = 'failed'
      if (task.result.ok && task.result.outputFile === row.output_file && existsSync(outputPath)) {
        try {
          inspectCutoutPng(readFileSync(outputPath))
          db.prepare(
            `UPDATE psd_cutout_jobs SET status = 'ready', output_path = ?, error = NULL, finished_at = ? WHERE id = ?`
          ).run(outputPath, nowIso(), task.id)
          destination = 'done'
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          db.prepare(`UPDATE psd_cutout_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
            message,
            nowIso(),
            task.id
          )
          if (existsSync(outputPath)) unlinkSync(outputPath)
        }
      } else {
        const message = task.result.error || 'Photoshop 没有生成有效的透明 PNG'
        db.prepare(`UPDATE psd_cutout_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
          message,
          nowIso(),
          task.id
        )
        if (existsSync(outputPath)) unlinkSync(outputPath)
      }
      rmSync(join(paths.bridgeDir, 'staging', key), { recursive: true, force: true })
      if (folder !== destination) moveFile(filePath, join(paths.bridgeDir, destination, `${key}.json`))
    }
  }
}

export function cancelPsdCutoutJob(db: Db, paths: PsdPaths, jobId: number): void {
  const row = db.prepare(`SELECT * FROM psd_cutout_jobs WHERE id = ?`).get(jobId) as CutoutRow | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '抠图任务不存在')
  // 排队 / 处理中也能取消：Photoshop 没接手或中途崩溃时，素材不会一直卡在「抠图中」。
  // 插件之后若仍交回结果，syncPsdCutoutResults 见到已取消的任务会把文件清掉。
  if (!['queued', 'running', 'ready'].includes(row.status)) {
    throw new ServiceError('VALIDATION', '这个抠图任务已经结束')
  }
  const outputPath = row.output_path || resolvePsdBridgeOutputPath(paths.bridgeDir, row.output_file)
  if (existsSync(outputPath)) unlinkSync(outputPath)
  rmSync(join(paths.bridgeDir, 'staging', cutoutTaskKey(jobId)), { recursive: true, force: true })
  for (const folder of ['inbox', 'processing', 'done', 'failed']) {
    const file = join(paths.bridgeDir, folder, `${cutoutTaskKey(jobId)}.json`)
    if (existsSync(file)) unlinkSync(file)
  }
  transaction(db, () => {
    db.prepare(`UPDATE psd_cutout_jobs SET status = 'cancelled', output_path = NULL, finished_at = ? WHERE id = ?`).run(
      nowIso(),
      jobId
    )
  })
}

export function confirmPsdCutoutJob(db: Db, paths: PsdPaths, jobId: number): number {
  const row = db.prepare(`SELECT * FROM psd_cutout_jobs WHERE id = ?`).get(jobId) as CutoutRow | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '抠图任务不存在')
  if (row.status !== 'ready' || !row.output_path) throw new ServiceError('VALIDATION', '抠图结果还不能确认')
  const outputPath = row.output_path || resolvePsdBridgeOutputPath(paths.bridgeDir, row.output_file)
  if (!existsSync(outputPath) || resolve(outputPath) !== resolve(row.output_path)) {
    throw new ServiceError('NOT_FOUND', '抠图临时结果已丢失')
  }
  inspectCutoutPng(readFileSync(outputPath))
  const assetId = importPsdAsset(db, paths, row.asset_kind, outputPath, `${row.asset_label}（抠图）`)
  try {
    const result = db
      .prepare(
        `UPDATE psd_cutout_jobs
         SET status = 'confirmed', confirmed_asset_id = ?, output_path = NULL, error = NULL, finished_at = ?
         WHERE id = ? AND status = 'ready'`
      )
      .run(assetId, nowIso(), jobId)
    if (result.changes !== 1) throw new ServiceError('VALIDATION', '抠图任务状态已变化，请刷新后重试')
  } catch (err) {
    deletePsdAsset(db, paths, assetId)
    throw err
  }
  if (existsSync(outputPath)) unlinkSync(outputPath)
  const doneFile = join(paths.bridgeDir, 'done', `${cutoutTaskKey(jobId)}.json`)
  if (existsSync(doneFile)) unlinkSync(doneFile)
  return assetId
}

export function cancelPsdJob(db: Db, paths: PsdPaths, jobId: number): void {
  const row = db.prepare(`SELECT status FROM psd_jobs WHERE id = ?`).get(jobId) as { status: PsdJobStatus } | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '任务不存在')
  if (row.status !== 'queued') {
    throw new ServiceError(
      'VALIDATION',
      row.status === 'running' ? '插件正在处理这个任务，不能取消' : '这个任务已经结束'
    )
  }
  if (existsSync(join(paths.bridgeDir, 'processing', `${jobId}.json`))) {
    throw new ServiceError('VALIDATION', '插件正在处理这个任务，不能取消')
  }
  const inbox = join(paths.bridgeDir, 'inbox', `${jobId}.json`)
  if (existsSync(inbox)) unlinkSync(inbox)
  rmSync(join(paths.bridgeDir, 'staging', String(jobId)), { recursive: true, force: true })
  db.prepare(`UPDATE psd_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`).run(
    nowIso(),
    jobId
  )
}

export function retryPsdJob(db: Db, paths: PsdPaths, jobId: number): void {
  const row = db.prepare(`SELECT status FROM psd_jobs WHERE id = ?`).get(jobId) as { status: PsdJobStatus } | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '任务不存在')
  if (row.status !== 'failed') throw new ServiceError('VALIDATION', '只有失败的任务可以重试')
  const staging = join(paths.bridgeDir, 'staging', String(jobId))
  if (!existsSync(staging)) throw new ServiceError('VALIDATION', '任务素材已清理，请重新生成导出任务')
  const failedFile = join(paths.bridgeDir, 'failed', `${jobId}.json`)
  if (!existsSync(failedFile)) throw new ServiceError('VALIDATION', '找不到失败记录，请重新生成导出任务')
  const parsed = parseJobFile(JSON.parse(readFileSync(failedFile, 'utf8')))
  const spec: PsdJobFile = {
    version: parsed.version,
    id: parsed.id,
    title: parsed.title,
    templateFile: parsed.templateFile,
    format: parsed.format ?? (/\.tiff?$/i.test(parsed.outputFile) ? 'tiff' : 'psd'),
    outputDir: outputDir(paths),
    outputFile: parsed.outputFile,
    replacements: parsed.replacements
  }
  ensureBridge(paths.bridgeDir)
  writeAtomic(join(paths.bridgeDir, 'inbox', `${jobId}.json`), JSON.stringify(spec, null, 2))
  unlinkSync(failedFile)
  db.prepare(`UPDATE psd_jobs SET status = 'queued', error = NULL, finished_at = NULL WHERE id = ?`).run(jobId)
}

export function requeueStuckPsdJobs(db: Db, paths: PsdPaths): number {
  syncPsdResults(db, paths)
  const dir = join(paths.bridgeDir, 'processing')
  if (!existsSync(dir)) return 0
  let count = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const full = join(dir, name)
    let parsed: PsdJobFile
    try {
      parsed = parseJobFile(JSON.parse(readFileSync(full, 'utf8')))
    } catch {
      continue
    }
    if (parsed.result) continue
    ensureBridge(paths.bridgeDir)
    moveFile(full, join(paths.bridgeDir, 'inbox', `${parsed.id}.json`))
    const before = db.prepare(`SELECT status FROM psd_jobs WHERE id = ?`).get(parsed.id) as
      { status: PsdJobStatus } | undefined
    if (before?.status === 'running') {
      db.prepare(`UPDATE psd_jobs SET status = 'queued', error = NULL, finished_at = NULL WHERE id = ?`).run(parsed.id)
      count += 1
    }
  }
  return count
}

function toSlot(row: SlotRow): PsdSlot {
  return {
    id: row.id,
    templateId: row.template_id,
    slotKey: row.slot_key,
    dogLayer: row.dog_layer,
    nameLayer: row.name_layer,
    sortOrder: row.sort_order
  }
}

function toAsset(row: AssetRow): PsdAsset {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    width: row.width,
    height: row.height,
    hasAlpha: row.has_alpha === 1,
    bytes: row.bytes,
    fileUrl: `moyu-file://psd-assets/${encodeURIComponent(row.rel_path)}`,
    createdAt: row.created_at
  }
}

function toItem(row: ItemRow): PsdJobItem {
  return {
    slotKey: row.slot_key,
    dogLayer: row.dog_layer,
    nameLayer: row.name_layer,
    dogLabel: row.dog_label,
    nameLabel: row.name_label,
    dogAssetId: row.dog_asset_id,
    nameAssetId: row.name_asset_id
  }
}

export function getPsdBoard(db: Db, paths: PsdPaths, context: PsdBoardContext): PsdBoard {
  ensureBridge(paths.bridgeDir)
  mkdirSync(paths.assetsDir, { recursive: true })
  syncPsdResults(db, paths)
  syncPsdCutoutResults(db, paths)
  const templates = (
    db
      .prepare(`SELECT id, name, source_path, created_at FROM psd_templates ORDER BY id`)
      .all() as unknown as TemplateRow[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    sourcePath: row.source_path,
    sourceExists: existsSync(row.source_path),
    slots: (
      db
        .prepare(`SELECT * FROM psd_slots WHERE template_id = ? ORDER BY sort_order, id`)
        .all(row.id) as unknown as SlotRow[]
    ).map(toSlot),
    createdAt: row.created_at
  })) satisfies PsdTemplate[]
  const assets = (db.prepare(`SELECT * FROM psd_assets ORDER BY id DESC`).all() as unknown as AssetRow[]).map(toAsset)
  const items = db.prepare(`SELECT * FROM psd_job_items ORDER BY id`).all() as unknown as ItemRow[]
  const itemsByJob = new Map<number, PsdJobItem[]>()
  for (const item of items) {
    const list = itemsByJob.get(item.job_id) ?? []
    list.push(toItem(item))
    itemsByJob.set(item.job_id, list)
  }
  const jobs = (db.prepare(`SELECT * FROM psd_jobs ORDER BY id DESC`).all() as unknown as JobRow[]).map(
    (row): PsdJob => ({
      id: row.id,
      templateId: row.template_id,
      templateName: row.template_name,
      title: row.title,
      status: row.status,
      outputFile: row.output_file,
      outputPath: row.output_path,
      error: row.error,
      items: itemsByJob.get(row.id) ?? [],
      createdAt: row.created_at,
      finishedAt: row.finished_at
    })
  )
  const cutouts = (
    db.prepare(`SELECT * FROM psd_cutout_jobs ORDER BY id DESC LIMIT 50`).all() as unknown as CutoutRow[]
  ).map((row): PsdCutoutJob => ({
    id: row.id,
    assetId: row.asset_id,
    kind: row.asset_kind,
    assetLabel: row.asset_label,
    status: row.status,
    resultUrl: row.status === 'ready' && row.output_file ? `moyu-file://psd-cutout/${row.id}` : null,
    error: row.error,
    confirmedAssetId: row.confirmed_asset_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  }))
  return {
    bridgeDir: paths.bridgeDir,
    outputDir: outputDir(paths),
    pluginDir: context.pluginDir,
    photoshopPath: context.photoshopPath,
    templates,
    assets,
    jobs,
    cutouts
  }
}
