import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

/** 打开数据库并设置基础 pragma。path 为 ':memory:' 时用于测试。 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  return db
}

const depth = new WeakMap<DatabaseSync, number>()

/**
 * 在一个事务内执行 fn；抛错则回滚。node:sqlite 没有内置 transaction 包装，这里手写。
 * 支持嵌套：最外层用 BEGIN / COMMIT，内层用 SAVEPOINT，内层失败只回滚到自己的保存点。
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0
  const sp = `sp_${level}`
  if (level === 0) db.exec('BEGIN IMMEDIATE')
  else db.exec(`SAVEPOINT ${sp}`)
  depth.set(db, level + 1)
  try {
    const result = fn()
    if (level === 0) db.exec('COMMIT')
    else db.exec(`RELEASE ${sp}`)
    return result
  } catch (err) {
    if (level === 0) db.exec('ROLLBACK')
    else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`)
    throw err
  } finally {
    depth.set(db, level)
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 业务时间（occurred_at / doc_date）统一用本地时间、无时区后缀：YYYY-MM-DDTHH:mm:ss。
 * 审计时间戳（created_at / confirmed_at 等）用 ISO UTC。两者不要混用于排序或筛选。
 */
export function localDateTime(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
}
