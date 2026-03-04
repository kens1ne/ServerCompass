"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Create servers table
    db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      auth_type TEXT NOT NULL CHECK(auth_type IN ('password', 'private_key')),
      username TEXT NOT NULL,
      encrypted_secret BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'provisioning', 'ready', 'error')),
      last_check_in INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
    // Create deployments table
    db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      repo_url TEXT,
      branch TEXT,
      commit_hash TEXT,
      env_summary TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      log_path TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    // Create commands table
    db.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      command TEXT NOT NULL,
      executed_at INTEGER NOT NULL,
      exit_code INTEGER,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    // Create indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deployments_server_id ON deployments(server_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_started_at ON deployments(started_at);
    CREATE INDEX IF NOT EXISTS idx_commands_server_id ON commands(server_id);
    CREATE INDEX IF NOT EXISTS idx_commands_executed_at ON commands(executed_at);
  `);
    console.log('Initial schema created successfully');
}
//# sourceMappingURL=001_initial_schema.js.map