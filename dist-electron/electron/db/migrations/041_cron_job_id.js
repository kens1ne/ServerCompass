"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add cron_id column for unique job identification
    db.exec(`
    ALTER TABLE cron_metadata ADD COLUMN cron_id TEXT;
  `);
    // Create index for faster lookups by cron_id
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cron_metadata_cron_id
      ON cron_metadata(server_id, cron_id);
  `);
    // Generate cron_id for existing records that don't have one
    const rows = db.prepare('SELECT id FROM cron_metadata WHERE cron_id IS NULL').all();
    const updateStmt = db.prepare('UPDATE cron_metadata SET cron_id = ? WHERE id = ?');
    for (const row of rows) {
        const cronId = generateShortId();
        updateStmt.run(cronId, row.id);
    }
    console.log(`✓ Migration 041: Added cron_id column to cron_metadata (updated ${rows.length} existing records)`);
}
/**
 * Generate a short alphanumeric ID (8 characters)
 */
function generateShortId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
//# sourceMappingURL=041_cron_job_id.js.map