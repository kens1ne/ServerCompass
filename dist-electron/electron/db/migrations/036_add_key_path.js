"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Check if column already exists (guards against re-running on reused dev DB)
    const columns = db.prepare('PRAGMA table_info(servers)').all();
    const hasKeyPath = columns.some((col) => col.name === 'key_path');
    if (hasKeyPath) {
        console.log('key_path column already exists, skipping');
        return;
    }
    // Add key_path column to servers table
    // Stores path to script-generated private key for cleanup on server delete
    // NULL for password auth or pre-existing keys
    db.exec(`
    ALTER TABLE servers ADD COLUMN key_path TEXT DEFAULT NULL;
  `);
    console.log('Added key_path column to servers table');
}
//# sourceMappingURL=036_add_key_path.js.map