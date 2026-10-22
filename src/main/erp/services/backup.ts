import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import {
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
import { join, relative, sep } from 'node:path'
import type { Db } from '../db/connection'
import { openDatabase } from '../db/connection'
import { currentSchemaVersion, MIGRATIONS, runMigrations } from '../db/migrations'
import type { BackupInspection, BackupManifest } from '@shared/erp/types'
import { ServiceError } from './errors'

export const BACKUP_APP_ID = 'moyu-tools-erp'
export const BACKUP_FORMAT_VERSION = 1
const DB_ENTRY = 'moyu-erp.db'
const MANIFEST_ENTRY = 'manifest.json'
/** 可选：界面偏好（外观配色等）。旧版应用会校验后忽略它，所以不提升 formatVersion */
const PREFERENCES_ENTRY = 'preferences.json'
const PREFERENCES_MAX_BYTES = 64 * 1024
const ATTACH_PREFIX = 'attachments/'

export interface DataPaths {
  dbPath: string
  attachmentsDir: string
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) out.push(...walk(p))
    else if (name.isFile()) out.push(p)
  }
  return out.sort()
}

/**
 * 生成备份 zip：manifest.json + 一致性数据库副本（VACUUM INTO）+ 附件目录。
 * 数据库副本在 WAL 模式下也能保证完整。
 */
export function createBackup(
  db: Db,
  paths: DataPaths,
  appVersion: string,
  outPath: string,
  preferences?: Record<string, unknown> | null
): BackupManifest {
  const tmpDb = `${outPath}.db-tmp`
  if (existsSync(tmpDb)) unlinkSync(tmpDb)
  db.exec(`VACUUM INTO '${tmpDb.replaceAll("'", "''")}'`)
  try {
    const zip = new AdmZip()
    const files: BackupManifest['files'] = []
    const dbBuf = readFileSync(tmpDb)
    zip.addFile(DB_ENTRY, dbBuf)
    files.push({ path: DB_ENTRY, size: dbBuf.length, sha256: sha256(dbBuf) })
    for (const full of walk(paths.attachmentsDir)) {
      const rel = relative(paths.attachmentsDir, full).split(sep).join('/')
      const buf = readFileSync(full)
      zip.addFile(ATTACH_PREFIX + rel, buf)
      files.push({ path: ATTACH_PREFIX + rel, size: buf.length, sha256: sha256(buf) })
    }
    if (preferences) {
      const buf = Buffer.from(JSON.stringify(preferences))
      if (buf.length <= PREFERENCES_MAX_BYTES) {
        zip.addFile(PREFERENCES_ENTRY, buf)
        files.push({ path: PREFERENCES_ENTRY, size: buf.length, sha256: sha256(buf) })
      }
    }
    const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c
    const manifest: BackupManifest = {
      app: BACKUP_APP_ID,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion,
      schemaVersion: currentSchemaVersion(db),
      createdAt: new Date().toISOString(),
      counts: {
        documents: count('SELECT COUNT(*) AS c FROM documents'),
        movements: count('SELECT COUNT(*) AS c FROM stock_movements'),
        attachments: count('SELECT COUNT(*) AS c FROM attachments')
      },
      files
    }
    zip.addFile(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2)))
    zip.writeZip(outPath)
    return manifest
  } finally {
    if (existsSync(tmpDb)) unlinkSync(tmpDb)
  }
}

function readZip(path: string): AdmZip {
  if (!existsSync(path)) throw new ServiceError('NOT_FOUND', '备份文件不存在')
  if (statSync(path).size > 2 * 1024 * 1024 * 1024) throw new ServiceError('VALIDATION', '备份文件过大')
  try {
    return new AdmZip(path)
  } catch {
    throw new ServiceError('BACKUP_INVALID', '不是有效的 zip 备份文件')
  }
}

/** 校验备份：manifest、版本、每个文件的哈希、数据库可打开。不修改任何数据。 */
export function inspectBackup(path: string): BackupInspection {
  const zip = readZip(path)
  const problems: string[] = []
  const manifestEntry = zip.getEntry(MANIFEST_ENTRY)
  if (!manifestEntry) throw new ServiceError('BACKUP_INVALID', '备份中缺少 manifest.json')
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as BackupManifest
  } catch {
    throw new ServiceError('BACKUP_INVALID', 'manifest.json 无法解析')
  }
  if (manifest.app !== BACKUP_APP_ID) problems.push(`不是本应用的备份（app=${manifest.app}）`)
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION)
    problems.push(`备份格式版本 ${manifest.formatVersion} 高于当前支持的 ${BACKUP_FORMAT_VERSION}，请升级应用后再恢复`)
  const latestSchema = MIGRATIONS.at(-1)!.version
  if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion > latestSchema)
    problems.push(`数据库版本 ${manifest.schemaVersion} 高于当前应用的 ${latestSchema}，请升级应用后再恢复`)
  if (!Array.isArray(manifest.files) || !manifest.files.some((f) => f.path === DB_ENTRY))
    problems.push('manifest 中缺少数据库文件')

  for (const f of manifest.files ?? []) {
    if (f.path.includes('..') || f.path.startsWith('/')) {
      problems.push(`非法路径：${f.path}`)
      continue
    }
    const entry = zip.getEntry(f.path)
    if (!entry) {
      problems.push(`缺少文件：${f.path}`)
      continue
    }
    const buf = entry.getData()
    if (buf.length !== f.size || sha256(buf) !== f.sha256) problems.push(`文件损坏或被修改：${f.path}`)
  }
  // zip 内多出的文件不算错误，但不会被恢复
  if (problems.length === 0) {
    const dbEntry = zip.getEntry(DB_ENTRY)!
    const probe = `${path}.probe-${process.pid}.db`
    try {
      writeFileSync(probe, dbEntry.getData())
      const test = openDatabase(probe)
      try {
        const r = test.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
        if (r.integrity_check !== 'ok') problems.push(`数据库完整性检查失败：${r.integrity_check}`)
        test.prepare('SELECT COUNT(*) FROM documents').get()
      } finally {
        test.close()
      }
    } catch (err) {
      problems.push(`数据库无法打开：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (existsSync(probe)) unlinkSync(probe)
    }
  }
  return { path, manifest, problems }
}

/** 读取备份里的界面偏好；没有或无法解析时返回 null（调用方应已通过 inspectBackup 校验哈希） */
export function readBackupPreferences(path: string): Record<string, unknown> | null {
  const entry = readZip(path).getEntry(PREFERENCES_ENTRY)
  if (!entry || entry.header.size > PREFERENCES_MAX_BYTES) return null
  try {
    const value: unknown = JSON.parse(entry.getData().toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * 恢复：调用方必须先关闭当前数据库连接。
 * 现有数据先整体移入 trashDir/<timestamp>，再解包；解包失败时把原数据移回。
 * 返回恢复后的数据库（已执行 migration）。
 */
export function restoreBackup(path: string, paths: DataPaths, trashDir: string): Db {
  const inspection = inspectBackup(path)
  if (inspection.problems.length) throw new ServiceError('BACKUP_INVALID', inspection.problems.join('；'))
  const zip = readZip(path)
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const trash = join(trashDir, stamp)
  mkdirSync(trash, { recursive: true })

  const moved: [string, string][] = []
  const moveAway = (src: string, name: string): void => {
    if (!existsSync(src)) return
    const dst = join(trash, name)
    renameSync(src, dst)
    moved.push([src, dst])
  }
  moveAway(paths.dbPath, 'moyu-erp.db')
  moveAway(`${paths.dbPath}-wal`, 'moyu-erp.db-wal')
  moveAway(`${paths.dbPath}-shm`, 'moyu-erp.db-shm')
  moveAway(paths.attachmentsDir, 'attachments')

  try {
    mkdirSync(join(paths.dbPath, '..'), { recursive: true })
    writeFileSync(paths.dbPath, zip.getEntry(DB_ENTRY)!.getData())
    mkdirSync(paths.attachmentsDir, { recursive: true })
    for (const f of inspection.manifest.files) {
      if (!f.path.startsWith(ATTACH_PREFIX)) continue
      const rel = f.path.slice(ATTACH_PREFIX.length)
      const dst = join(paths.attachmentsDir, ...rel.split('/'))
      mkdirSync(join(dst, '..'), { recursive: true })
      writeFileSync(dst, zip.getEntry(f.path)!.getData())
    }
    const db = openDatabase(paths.dbPath)
    runMigrations(db)
    return db
  } catch (err) {
    // 回滚：清掉半成品，把原数据移回
    rmSync(paths.dbPath, { force: true })
    rmSync(paths.attachmentsDir, { recursive: true, force: true })
    for (const [src, dst] of moved) renameSync(dst, src)
    throw err
  }
}
