import type { Migration } from '../migrations'

/** 白底抠图任务独立于 PSD 导出队列，确认后记录新素材 ID。 */
export const m005PsdCutout: Migration = {
  version: 5,
  name: 'psd_cutout',
  up(db) {
    db.exec(`
      CREATE TABLE psd_cutout_jobs (
        id INTEGER PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES psd_assets(id) ON DELETE CASCADE,
        asset_kind TEXT NOT NULL CHECK (asset_kind IN ('dog', 'name')),
        asset_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'confirmed', 'cancelled')),
        output_file TEXT NOT NULL,
        output_path TEXT,
        confirmed_asset_id INTEGER REFERENCES psd_assets(id) ON DELETE SET NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX psd_cutout_jobs_asset_status ON psd_cutout_jobs(asset_id, status);
    `)
  }
}
