"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS cron_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      job_signature TEXT NOT NULL,
      name TEXT,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(server_id, job_signature),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cron_metadata_server_signature
      ON cron_metadata(server_id, job_signature);
  `);
}
//# sourceMappingURL=002_cron_metadata.js.map