"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    console.log('[Migration 044] Creating local_builds table for local Docker build tracking');
    db.exec(`
    CREATE TABLE IF NOT EXISTS local_builds (
      id TEXT PRIMARY KEY,
      deployment_id TEXT,
      server_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      image_name TEXT NOT NULL,
      image_tag TEXT NOT NULL,
      image_size INTEGER,

      -- Build info
      build_started_at TEXT,
      build_completed_at TEXT,
      build_duration INTEGER,

      -- Upload info
      upload_started_at TEXT,
      upload_completed_at TEXT,
      upload_duration INTEGER,

      -- Status: 'pending', 'building', 'uploading', 'deploying', 'completed', 'failed', 'cancelled'
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,

      -- Options used
      dockerfile_generated INTEGER DEFAULT 0,
      dockerfile_path TEXT,
      platform TEXT DEFAULT 'linux/amd64',
      build_args TEXT,
      use_compression INTEGER DEFAULT 0,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_local_builds_server ON local_builds(server_id);
    CREATE INDEX IF NOT EXISTS idx_local_builds_status ON local_builds(status);
    CREATE INDEX IF NOT EXISTS idx_local_builds_created_at ON local_builds(created_at);
  `);
    console.log('[Migration 044] Created local_builds table successfully');
}
//# sourceMappingURL=044_local_builds.js.map