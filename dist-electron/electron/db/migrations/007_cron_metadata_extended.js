"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    db.exec(`
    ALTER TABLE cron_metadata ADD COLUMN type TEXT DEFAULT 'unknown';
  `);
    db.exec(`
    ALTER TABLE cron_metadata ADD COLUMN created_by TEXT DEFAULT 'unknown';
  `);
    console.log('✓ Migration 007: Added type and created_by columns to cron_metadata');
}
//# sourceMappingURL=007_cron_metadata_extended.js.map