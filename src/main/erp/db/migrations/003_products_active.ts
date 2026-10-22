import type { Migration } from '../migrations'

/** 多商品：商品可停用（不可删除，历史单据引用它）。 */
export const m003ProductsActive: Migration = {
  version: 3,
  name: 'products_active',
  up(db) {
    db.exec(`ALTER TABLE products ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`)
  }
}
