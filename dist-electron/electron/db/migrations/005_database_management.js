"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Databases table
    db.exec(`
    CREATE TABLE IF NOT EXISTS databases (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('postgres', 'mysql', 'supabase')),
      status TEXT NOT NULL CHECK(status IN ('creating', 'preflight', 'provisioning', 'active', 'needs_attention', 'removing', 'deleted')),
      access TEXT NOT NULL DEFAULT 'internal' CHECK(access IN ('internal', 'public')),
      version TEXT,
      encrypted_credentials BLOB,
      metadata TEXT,
      stats TEXT,
      last_error TEXT,
      provision_duration_ms INTEGER,
      last_operation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_databases_server_id ON databases(server_id);
    CREATE INDEX IF NOT EXISTS idx_databases_status ON databases(status);
    CREATE INDEX IF NOT EXISTS idx_databases_last_activity ON databases(last_activity_at);
  `);
    // Database operations table
    db.exec(`
    CREATE TABLE IF NOT EXISTS database_operations (
      id TEXT PRIMARY KEY,
      database_id TEXT,
      server_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('provision', 'rotate_password', 'toggle_access', 'delete', 'import', 'custom')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      progress INTEGER,
      summary TEXT,
      meta TEXT,
      error_message TEXT,
      log TEXT,
      FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_database_operations_database ON database_operations(database_id);
    CREATE INDEX IF NOT EXISTS idx_database_operations_server ON database_operations(server_id);
    CREATE INDEX IF NOT EXISTS idx_database_operations_status ON database_operations(status);
  `);
}
//# sourceMappingURL=005_database_management.js.map