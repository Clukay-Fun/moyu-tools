import { z } from 'zod'

/** 桥接任务文件版本。插件只接受这一版。 */
export const PSD_JOB_VERSION = 1

export const SLOT_KEY_PATTERN = /^slot_(0[1-9]|[1-9][0-9])$/

export type PsdAssetKind = 'dog' | 'name'
export type PsdExportFormat = 'psd' | 'tiff'
export type PsdJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type PsdCutoutStatus = 'queued' | 'running' | 'ready' | 'failed' | 'confirmed' | 'cancelled'

const baseName = z
  .string()
  .min(1)
  .max(180)
  .refine((name) => !name.includes('/') && !name.includes('\\') && !name.includes('..'), '文件名不能包含路径')

const absoluteDirectory = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'),
    '导出目录必须是绝对路径'
  )

export const psdJobFileSchema = z.object({
  version: z.literal(PSD_JOB_VERSION),
  id: z.number().int().positive(),
  title: z.string().min(1).max(60),
  templateFile: z.literal('template.psd'),
  outputDir: absoluteDirectory.optional(),
  format: z.enum(['psd', 'tiff']).optional(),
  outputFile: baseName.refine((name) => /\.(psd|tif|tiff)$/i.test(name), '输出文件必须是 PSD 或 TIFF'),
  replacements: z
    .array(
      z.object({
        layerName: z.string().min(1).max(80),
        file: baseName.refine((name) => /\.(png|jpe?g)$/i.test(name), '素材文件必须是 PNG 或 JPG')
      })
    )
    .min(1),
  result: z
    .object({
      ok: z.boolean(),
      replaced: z.array(z.string()),
      error: z.string().nullable(),
      outputFile: baseName.nullable()
    })
    .optional()
})

const safeBridgeName = z
  .string()
  .min(1)
  .max(180)
  .refine((name) => !name.includes('/') && !name.includes('\\') && !name.includes('..'), '文件名不能包含路径')

export const psdCutoutJobFileSchema = z.object({
  version: z.literal(PSD_JOB_VERSION),
  type: z.literal('cutout'),
  id: z.number().int().positive(),
  kind: z.enum(['dog', 'name']),
  outputDir: absoluteDirectory.optional(),
  sourceFile: safeBridgeName.refine((name) => /\.(png|jpe?g)$/i.test(name), '输入文件必须是 PNG 或 JPG'),
  outputFile: safeBridgeName.refine((name) => name.toLowerCase().endsWith('.png'), '输出文件必须是 PNG'),
  result: z
    .object({
      ok: z.boolean(),
      error: z.string().nullable(),
      outputFile: safeBridgeName.nullable()
    })
    .optional()
})

export type PsdJobFile = z.infer<typeof psdJobFileSchema>
export type PsdCutoutJobFile = z.infer<typeof psdCutoutJobFileSchema>

export function parseJobFile(raw: unknown): PsdJobFile {
  const parsed = psdJobFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error('任务文件无效')
  return parsed.data
}

export function parseCutoutJobFile(raw: unknown): PsdCutoutJobFile {
  const parsed = psdCutoutJobFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error('抠图任务文件无效')
  return parsed.data
}

const FORBIDDEN_NAME = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])

function scrubFileName(value: string): string {
  let cleaned = ''
  for (const char of value) {
    cleaned += char.charCodeAt(0) < 32 || FORBIDDEN_NAME.has(char) ? ' ' : char
  }
  return cleaned
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
}

/** 图层名不能包含路径字符或控制字符。 */
export function isSafeLayerName(name: string): boolean {
  if (!name || name.length > 80) return false
  for (const char of name) {
    if (char.charCodeAt(0) < 32 || FORBIDDEN_NAME.has(char)) return false
  }
  return true
}

/** 输出用的文件名主干。去掉路径字符，避免写出桥接目录。 */
export function safeOutputBase(title: string): string {
  return (scrubFileName(title) || 'export').slice(0, 60)
}

export function allocateOutputName(base: string, taken: Iterable<string>, extension: 'psd' | 'tif' = 'psd'): string {
  const used = new Set(Array.from(taken, (name) => name.toLowerCase()))
  if (!used.has(`${base}.${extension}`.toLowerCase())) return `${base}.${extension}`
  for (let i = 2; i < 1000; i++) {
    const name = `${base}-${i}.${extension}`
    if (!used.has(name.toLowerCase())) return name
  }
  throw new Error('输出文件名已用尽')
}

export interface PsdSlot {
  id: number
  templateId: number
  slotKey: string
  dogLayer: string
  nameLayer: string
  sortOrder: number
}

export interface PsdTemplate {
  id: number
  name: string
  sourcePath: string
  sourceExists: boolean
  slots: PsdSlot[]
  createdAt: string
}

export interface PsdAsset {
  id: number
  kind: PsdAssetKind
  label: string
  width: number
  height: number
  hasAlpha: boolean
  bytes: number
  fileUrl: string
  createdAt: string
}

export interface PsdJobItem {
  slotKey: string
  dogLayer: string
  nameLayer: string
  dogLabel: string
  nameLabel: string
  /** 用于检查正在排队/生成的任务是否还引用某个素材 */
  dogAssetId: number | null
  nameAssetId: number | null
}

export interface PsdJob {
  id: number
  templateId: number | null
  templateName: string
  title: string
  status: PsdJobStatus
  outputFile: string | null
  outputPath: string | null
  error: string | null
  items: PsdJobItem[]
  createdAt: string
  finishedAt: string | null
}

export interface PsdCutoutJob {
  id: number
  assetId: number
  kind: PsdAssetKind
  assetLabel: string
  status: PsdCutoutStatus
  resultUrl: string | null
  error: string | null
  confirmedAssetId: number | null
  createdAt: string
  finishedAt: string | null
}

export interface PsdBoard {
  bridgeDir: string
  outputDir: string
  pluginDir: string
  photoshopPath: string | null
  templates: PsdTemplate[]
  assets: PsdAsset[]
  jobs: PsdJob[]
  cutouts: PsdCutoutJob[]
}
