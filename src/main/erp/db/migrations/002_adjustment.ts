import type { Migration } from '../migrations'

/**
 * 新增「库存调整」单据类型。
 * SQLite 不能修改 CHECK 约束，documents 与 stock_movements 需要重建。
 * runMigrations 在执行前已关闭 foreign_keys，重建后会做 foreign_key_check。
 */
export const m002Adjustment: Migration = {
  version: 2,
  name: 'adjustment',
  up(db) {
    db.exec(`
      CREATE TABLE documents_new (
        id INTEGER PRIMARY KEY,
        doc_no TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('inbound', 'outbound', 'opening', 'adjustment')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'voided')),
        doc_date TEXT NOT NULL,
        channel_id INTEGER REFERENCES sales_channels(id),
        external_order_no TEXT,
        note TEXT NOT NULL DEFAULT '',
        -- 调整方向：盘盈增加 / 盘亏减少；非调整单为 NULL
        adjust_direction TEXT CHECK (adjust_direction IN ('increase', 'decrease')),
        confirmed_at TEXT,
        voided_at TEXT,
        void_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO documents_new (id, doc_no, type, status, doc_date, channel_id, external_order_no, note,
                                 confirmed_at, voided_at, void_reason, created_at, updated_at)
        SELECT id, doc_no, type, status, doc_date, channel_id, external_order_no, note,
               confirmed_at, voided_at, void_reason, created_at, updated_at FROM documents;
      DROP TABLE documents;
      ALTER TABLE documents_new RENAME TO documents;
      CREATE INDEX idx_documents_type_date ON documents(type, doc_date);
      CREATE INDEX idx_documents_status ON documents(status);
      CREATE INDEX idx_documents_ext_order ON documents(channel_id, external_order_no);

      CREATE TABLE stock_movements_new (
        id INTEGER PRIMARY KEY,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        document_id INTEGER NOT NULL REFERENCES documents(id),
        document_item_id INTEGER REFERENCES document_items(id),
        kind TEXT NOT NULL CHECK (kind IN ('opening', 'inbound', 'outbound', 'adjustment', 'void')),
        quantity_delta INTEGER NOT NULL,
        quantity_before INTEGER NOT NULL,
        quantity_after INTEGER NOT NULL,
        unit_cost_e4 INTEGER NOT NULL,
        cost_value_delta_e4 INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO stock_movements_new SELECT * FROM stock_movements;
      DROP TABLE stock_movements;
      ALTER TABLE stock_movements_new RENAME TO stock_movements;
      CREATE INDEX idx_movements_sku_time ON stock_movements(sku_id, occurred_at, id);
      CREATE INDEX idx_movements_document ON stock_movements(document_id);
    `)
  }
}
