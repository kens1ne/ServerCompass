"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Create github_actions_config table
    db.exec(`
    CREATE TABLE IF NOT EXISTS github_actions_config (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      working_directory TEXT NOT NULL,
      install_command TEXT NOT NULL,
      build_command TEXT NOT NULL,
      ssh_key_path TEXT NOT NULL,
      workflow_file_sha TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      UNIQUE(server_id, app_name)
    );
  `);
    // Create indices for better query performance
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_github_actions_server ON github_actions_config(server_id);
    CREATE INDEX IF NOT EXISTS idx_github_actions_active ON github_actions_config(is_active);
    CREATE INDEX IF NOT EXISTS idx_github_actions_repo ON github_actions_config(repo_owner, repo_name);
  `);
    console.log('GitHub Actions schema created successfully');
}
//# sourceMappingURL=017_github_actions.js.map