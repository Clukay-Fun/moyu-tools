import type { Migration } from '../migrations'

export const m001Init: Migration = {
  version: 1,
  name: 'init',
  up(db) {
    db.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '件',
        image_path TEXT,
        default_cost_cents INTEGER NOT NULL DEFAULT 0,
        default_price_cents INTEGER NOT NULL DEFAULT 0,
        low_stock_threshold INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE skus (
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id),
        code TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL DEFAULT 0,
        spec_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_skus_product ON skus(product_id);

      -- 当前库存快照。cost_value_e4 为库存成本总额（1/10000 元），
      -- 平均成本 = cost_value_e4 / quantity，避免反复除法带来的漂移。
      CREATE TABLE sku_stock (
        sku_id INTEGER PRIMARY KEY REFERENCES skus(id),
        quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        cost_value_e4 INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sales_channels (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        doc_no TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('inbound', 'outbound', 'opening')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'voided')),
        doc_date TEXT NOT NULL,
        channel_id INTEGER REFERENCES sales_channels(id),
        external_order_no TEXT,
        note TEXT NOT NULL DEFAULT '',
        confirmed_at TEXT,
        voided_at TEXT,
        void_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_documents_type_date ON documents(type, doc_date);
      CREATE INDEX idx_documents_status ON documents(status);
      CREATE INDEX idx_documents_ext_order ON documents(channel_id, external_order_no);

      CREATE TABLE document_items (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        line_no INTEGER NOT NULL,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        -- 出库时记录当时的平均成本，供毛利与对账使用
        cost_snapshot_e4 INTEGER,
        UNIQUE (document_id, line_no)
      );
      CREATE INDEX idx_document_items_sku ON document_items(sku_id);

      -- 不可变流水：每一条记录变动前后数量，可完整重放库存账。
      CREATE TABLE stock_movements (
        id INTEGER PRIMARY KEY,
        sku_id INTEGER NOT NULL REFERENCES skus(id),
        document_id INTEGER NOT NULL REFERENCES documents(id),
        document_item_id INTEGER REFERENCES document_items(id),
        kind TEXT NOT NULL CHECK (kind IN ('opening', 'inbound', 'outbound', 'void')),
        quantity_delta INTEGER NOT NULL,
        quantity_before INTEGER NOT NULL,
        quantity_after INTEGER NOT NULL,
        unit_cost_e4 INTEGER NOT NULL,
        cost_value_delta_e4 INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_movements_sku_time ON stock_movements(sku_id, occurred_at, id);
      CREATE INDEX idx_movements_document ON stock_movements(document_id);

      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        file_name TEXT NOT NULL,
        rel_path TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_attachments_document ON attachments(document_id);
    `)

    // 首版唯一商品与默认 SKU；默认销售渠道。
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO products (id, code, name, unit, created_at, updated_at) VALUES (1, 'FG001', '电动车发光小饰品', '件', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT INTO skus (id, product_id, code, is_default, created_at) VALUES (1, 1, 'FG001-DEFAULT', 1, ?)`
    ).run(now)
    db.prepare(`INSERT INTO sku_stock (sku_id, quantity, cost_value_e4, updated_at) VALUES (1, 0, 0, ?)`).run(now)

    const insertChannel = db.prepare(`INSERT INTO sales_channels (name, sort_order) VALUES (?, ?)`)
    ;['抖音小店', '淘宝', '拼多多', '微信', '线下', '其他'].forEach((name, i) => insertChannel.run(name, i))
  }
}
