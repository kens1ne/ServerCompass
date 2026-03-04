"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add deployment_source and working_directory columns to deployments table
    db.exec(`
    ALTER TABLE deployments ADD COLUMN deployment_source TEXT DEFAULT 'manual';
    ALTER TABLE deployments ADD COLUMN working_directory TEXT;
  `);
    // Create auto_deploy_config table
    db.exec(`
    CREATE TABLE IF NOT EXISTS auto_deploy_config (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_commit TEXT,
      last_checked_at INTEGER,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK(poll_interval_seconds >= 5),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      UNIQUE(server_id, app_name)
    );
  `);
    // Create auto_deploy_settings table
    db.exec(`
    CREATE TABLE IF NOT EXISTS auto_deploy_settings (
      server_id TEXT PRIMARY KEY,
      tick_interval_seconds INTEGER NOT NULL DEFAULT 15 CHECK(tick_interval_seconds >= 5),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
    // Create indices for better query performance
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_deploy_config_server ON auto_deploy_config(server_id);
    CREATE INDEX IF NOT EXISTS idx_auto_deploy_config_enabled ON auto_deploy_config(enabled);
    CREATE INDEX IF NOT EXISTS idx_deployments_source ON deployments(deployment_source);
  `);
    console.log('Auto-deploy schema created successfully');
}
//# sourceMappingURL=006_auto_deploy.js.map