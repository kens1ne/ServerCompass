"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 051: Add favorite_paths table
 *
 * Stores user-bookmarked directory paths per server for quick navigation
 * in the ServerFolders file browser.
 */
function migrate(db) {
    console.log('[Migration 051] Creating favorite_paths table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS favorite_paths (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_favorite_paths_server
      ON favorite_paths(server_id)
  `);
    console.log('[Migration 051] Favorite paths table created successfully');
}
//# sourceMappingURL=051_favorite_paths.js.map