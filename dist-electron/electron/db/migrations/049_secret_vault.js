"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 049: Add secret_collections table
 *
 * Encrypted .env vault for managing secrets across projects.
 * Secrets are stored as a single AES-256-GCM encrypted blob per collection.
 * Key names are never stored in plaintext.
 */
function migrate(db) {
    console.log('[Migration 049] Creating secret_collections table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS secret_collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      encrypted_data BLOB NOT NULL,
      secret_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_secret_collections_name
      ON secret_collections(name)
  `);
    console.log('[Migration 049] Secret vault tables created successfully');
}
//# sourceMappingURL=049_secret_vault.js.map