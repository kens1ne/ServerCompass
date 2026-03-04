"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Providers table (GitHub enabled, GitLab placeholder)
    db.exec(`
    CREATE TABLE IF NOT EXISTS git_sources (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      type TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled', 'disabled', 'coming_soon')),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
  `);
    db.exec(`
    INSERT OR IGNORE INTO git_sources (type, display_name, status)
    VALUES
      ('github', 'GitHub', 'enabled'),
      ('gitlab', 'GitLab', 'coming_soon');
  `);
    // Accounts table (multi-provider)
    db.exec(`
    CREATE TABLE IF NOT EXISTS git_accounts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      source_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      username TEXT NOT NULL,
      email TEXT,
      avatar_url TEXT,
      scopes TEXT,
      host_alias TEXT UNIQUE,
      encrypted_token BLOB NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      last_used_at INTEGER,
      FOREIGN KEY (source_id) REFERENCES git_sources(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_accounts_source ON git_accounts(source_id);
  `);
    // Server ↔ account join table
    db.exec(`
    CREATE TABLE IF NOT EXISTS server_git_accounts (
      server_id TEXT NOT NULL,
      git_account_id TEXT NOT NULL,
      ssh_key_path TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      PRIMARY KEY (server_id, git_account_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (git_account_id) REFERENCES git_accounts(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_git_accounts_server ON server_git_accounts(server_id);
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_git_accounts_account ON server_git_accounts(git_account_id);
  `);
    // App bindings scoped by server + PM2 app name
    db.exec(`
    CREATE TABLE IF NOT EXISTS app_git_bindings (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      server_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      git_account_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT DEFAULT 'main',
      auto_deploy INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER,
      last_sync_status TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      UNIQUE (server_id, app_name),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (git_account_id) REFERENCES git_accounts(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_git_bindings_account ON app_git_bindings(git_account_id);
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_app_git_bindings_server ON app_git_bindings(server_id, app_name);
  `);
}
//# sourceMappingURL=014_git_multi_account.js.map