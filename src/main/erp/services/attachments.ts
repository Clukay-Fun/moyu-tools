import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Db } from '../db/connection'
import { nowIso, transaction } from '../db/connection'
import type { Attachment, AttachmentUpload } from '@shared/erp/types'
import { ServiceError } from './errors'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_DOC = 9

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

interface Row {
  id: number
  document_id: number
  file_name: string
  rel_path: string
  mime: string
  size: number
  created_at: string
}

const toAttachment = (r: Row): Attachment => ({
  id: r.id,
  documentId: r.document_id,
  fileName: r.file_name,
  relPath: r.rel_path,
  mime: r.mime,
  size: r.size,
  createdAt: r.created_at
})

/** 把相对路径解析到附件目录内；越界一律拒绝。 */
export function resolveAttachmentPath(attachmentsDir: string, relPath: string): string {
  const root = resolve(attachmentsDir)
  const full = resolve(root, relPath)
  if (full !== root && !full.startsWith(root + sep)) throw new ServiceError('VALIDATION', '非法附件路径')
  return full
}

export function listAttachments(db: Db, documentId: number): Attachment[] {
  return (
    db.prepare(`SELECT * FROM attachments WHERE document_id = ? ORDER BY id`).all(documentId) as unknown as Row[]
  ).map(toAttachment)
}

/** 魔数校验，不信任 renderer 声明的 mime。 */
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')
    return 'image/gif'
  return null
}

export function addAttachment(
  db: Db,
  attachmentsDir: string,
  documentId: number,
  upload: AttachmentUpload
): Attachment {
  const doc = db.prepare(`SELECT status FROM documents WHERE id = ?`).get(documentId) as { status: string } | undefined
  if (!doc) throw new ServiceError('NOT_FOUND', '单据不存在')
  if (doc.status === 'voided') throw new ServiceError('VALIDATION', '已作废单据不能添加附件')
  const buf = Buffer.from(upload.data)
  if (buf.length === 0) throw new ServiceError('VALIDATION', '文件为空')
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new ServiceError('VALIDATION', '图片超过 10MB')
  const mime = sniffImage(buf)
  if (!mime) throw new ServiceError('VALIDATION', '只支持 PNG / JPG / WebP / GIF 图片')
  const { c } = db.prepare(`SELECT COUNT(*) AS c FROM attachments WHERE document_id = ?`).get(documentId) as {
    c: number
  }
  if (c >= MAX_ATTACHMENTS_PER_DOC)
    throw new ServiceError('VALIDATION', `每张单据最多 ${MAX_ATTACHMENTS_PER_DOC} 张图片`)

  const now = nowIso()
  const relPath = `${now.slice(0, 4)}/${now.slice(5, 7)}/${randomUUID()}.${MIME_EXT[mime]}`
  const full = resolveAttachmentPath(attachmentsDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, buf)
  try {
    const fileName = String(upload.fileName ?? '').slice(0, 120) || `image.${MIME_EXT[mime]}`
    const { id } = db
      .prepare(
        `INSERT INTO attachments (document_id, file_name, rel_path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(documentId, fileName, relPath, mime, buf.length, now) as { id: number }
    return toAttachment(db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as unknown as Row)
  } catch (err) {
    unlinkSync(full)
    throw err
  }
}

export function removeAttachment(db: Db, attachmentsDir: string, id: number): void {
  const row = db
    .prepare(`SELECT a.*, d.status FROM attachments a JOIN documents d ON d.id = a.document_id WHERE a.id = ?`)
    .get(id) as (Row & { status: string }) | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '附件不存在')
  if (row.status === 'voided') throw new ServiceError('VALIDATION', '已作废单据的附件不能删除')
  transaction(db, () => {
    db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id)
  })
  const full = resolveAttachmentPath(attachmentsDir, row.rel_path)
  if (existsSync(full)) unlinkSync(full)
}

/** 删除草稿时清理其附件文件（在删除单据的同一事务内先调用）。 */
export function removeAttachmentsOfDocument(db: Db, attachmentsDir: string, documentId: number): string[] {
  const rows = db.prepare(`SELECT rel_path FROM attachments WHERE document_id = ?`).all(documentId) as unknown as {
    rel_path: string
  }[]
  db.prepare(`DELETE FROM attachments WHERE document_id = ?`).run(documentId)
  return rows.map((r) => resolveAttachmentPath(attachmentsDir, r.rel_path))
}

/** 商品主图：存到 attachments/product/ 下，覆盖时删除旧图。 */
export function setProductImage(db: Db, attachmentsDir: string, productId: number, upload: AttachmentUpload): string {
  const row = db.prepare(`SELECT image_path FROM products WHERE id = ?`).get(productId) as
    { image_path: string | null } | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '商品不存在')
  const buf = Buffer.from(upload.data)
  if (buf.length === 0) throw new ServiceError('VALIDATION', '文件为空')
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new ServiceError('VALIDATION', '图片超过 10MB')
  const mime = sniffImage(buf)
  if (!mime) throw new ServiceError('VALIDATION', '只支持 PNG / JPG / WebP / GIF 图片')
  const relPath = `product/${productId}-${randomUUID()}.${MIME_EXT[mime]}`
  const full = resolveAttachmentPath(attachmentsDir, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, buf)
  db.prepare(`UPDATE products SET image_path = ?, updated_at = ? WHERE id = ?`).run(relPath, nowIso(), productId)
  if (row.image_path) {
    const old = resolveAttachmentPath(attachmentsDir, row.image_path)
    if (existsSync(old)) unlinkSync(old)
  }
  return relPath
}

export function clearProductImage(db: Db, attachmentsDir: string, productId: number): void {
  const row = db.prepare(`SELECT image_path FROM products WHERE id = ?`).get(productId) as
    { image_path: string | null } | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '商品不存在')
  db.prepare(`UPDATE products SET image_path = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), productId)
  if (row.image_path) {
    const old = resolveAttachmentPath(attachmentsDir, row.image_path)
    if (existsSync(old)) unlinkSync(old)
  }
}
