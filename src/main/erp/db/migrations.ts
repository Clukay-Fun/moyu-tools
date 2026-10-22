import type { Db } from './connection'
import { transaction, nowIso } from './connection'
import { m001Init } from './migrations/001_init'
import { m002Adjustment } from './migrations/002_adjustment'
import { m003ProductsActive } from './migrations/003_products_active'
import { m004Psd } from './migrations/004_psd'
import { m005PsdCutout } from './migrations/005_psd_cutout'

export interface Migration {
  version: number
  name: string
  up(db: Db): void
}

export const MIGRATIONS: Migration[] = [m001Init, m002Adjustment, m003ProductsActive, m004Psd, m005PsdCutout]

/** 应用所有未执行的 migration。每个版本在独立事务内执行；重复调用无副作用。 */
export function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version)
  )
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  const ran: number[] = []
  for (const m of sorted) {
    if (applied.has(m.version)) continue
    // 重建表的 migration 需要在事务外关闭外键检查；结束后做一次完整性检查再打开。
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      transaction(db, () => {
        m.up(db)
        const violations = db.prepare('PRAGMA foreign_key_check').all()
        if (violations.length) throw new Error(`migration ${m.version} 产生了 ${violations.length} 条外键违规`)
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          nowIso()
        )
      })
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
    ran.push(m.version)
  }
  return ran
}

export function currentSchemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  return row.v ?? 0
}
