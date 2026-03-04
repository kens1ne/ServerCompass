"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Create git_connection_status table to cache GitHub connection information
    db.exec(`
    CREATE TABLE IF NOT EXISTS git_connection_status (
      server_id TEXT PRIMARY KEY,
      is_configured BOOLEAN NOT NULL DEFAULT 0,
      username TEXT,
      key_path TEXT,
      raw_output TEXT,
      last_checked_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    // Create index for faster lookups
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_status_server_id ON git_connection_status(server_id);
  `);
    console.log('Git connection status table created successfully');
}
//# sourceMappingURL=011_git_connection_status.js.map