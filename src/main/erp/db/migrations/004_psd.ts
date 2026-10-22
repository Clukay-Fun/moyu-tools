import type { Migration } from '../migrations'

/** PSD 定制：模板、可替换位置、狗图/名字图素材、导出任务。 */
export const m004Psd: Migration = {
  version: 4,
  name: 'psd_export',
  up(db) {
    db.exec(`
      CREATE TABLE psd_templates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE psd_slots (
        id INTEGER PRIMARY KEY,
        template_id INTEGER NOT NULL REFERENCES psd_templates(id) ON DELETE CASCADE,
        slot_key TEXT NOT NULL,
        dog_layer TEXT NOT NULL,
        name_layer TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        UNIQUE (template_id, slot_key)
      );

      CREATE TABLE psd_assets (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('dog', 'name')),
        label TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        has_alpha INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE psd_jobs (
        id INTEGER PRIMARY KEY,
        template_id INTEGER REFERENCES psd_templates(id) ON DELETE SET NULL,
        template_name TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
        output_file TEXT,
        output_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE psd_job_items (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES psd_jobs(id) ON DELETE CASCADE,
        slot_key TEXT NOT NULL,
        dog_layer TEXT NOT NULL,
        name_layer TEXT NOT NULL,
        dog_label TEXT NOT NULL,
        name_label TEXT NOT NULL,
        dog_asset_id INTEGER,
        name_asset_id INTEGER,
        UNIQUE (job_id, slot_key)
      );
    `)
  }
}
