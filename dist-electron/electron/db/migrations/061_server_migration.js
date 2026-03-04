"use strict";
/**
 * Migration 061: Server Migration tables
 *
 * Creates the core tables for the migration feature:
 * - server_migrations: Tracks migration sessions (scan → import → verify)
 * - server_migration_discovered_items: Individual discovered services/apps
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      id TEXT PRIMARY KEY,
      source_server_id TEXT NOT NULL,
      target_server_id TEXT,

      -- Provider detection
      provider TEXT NOT NULL DEFAULT 'raw_vps'
        CHECK(provider IN (
          'runcloud', 'forge', 'coolify', 'dokploy',
          'raw_vps', 'ansible', 'render', 'heroku'
        )),
      provider_version TEXT,
      provider_metadata TEXT,

      -- Migration configuration
      migration_mode TEXT NOT NULL DEFAULT 'same_server'
        CHECK(migration_mode IN ('same_server', 'cross_server_staging', 'cross_server_bluegreen')),

      -- Status tracking
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN (
          'pending', 'scanning', 'scanned', 'configuring',
          'importing', 'transferring', 'verifying',
          'switching', 'completed', 'failed', 'cancelled',
          'rolling_back', 'rolled_back'
        )),
      current_phase TEXT,

      -- Timing
      scan_started_at INTEGER,
      scan_completed_at INTEGER,
      import_started_at INTEGER,
      import_completed_at INTEGER,
      verification_started_at INTEGER,
      verification_completed_at INTEGER,
      cutover_started_at INTEGER,
      cutover_completed_at INTEGER,

      -- Counts
      total_discovered INTEGER NOT NULL DEFAULT 0,
      total_selected INTEGER NOT NULL DEFAULT 0,
      total_imported INTEGER NOT NULL DEFAULT 0,
      total_failed INTEGER NOT NULL DEFAULT 0,
      total_verified INTEGER NOT NULL DEFAULT 0,

      -- Cleanup configuration
      source_cleanup_mode TEXT DEFAULT 'keep'
        CHECK(source_cleanup_mode IN ('keep', 'stop', 'remove')),

      -- Error & log
      scan_log TEXT,
      last_error TEXT,
      rollback_log TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (source_server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (target_server_id) REFERENCES servers(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_server_migrations_source ON server_migrations(source_server_id);
    CREATE INDEX IF NOT EXISTS idx_server_migrations_target ON server_migrations(target_server_id);
    CREATE INDEX IF NOT EXISTS idx_server_migrations_status ON server_migrations(status);
    CREATE INDEX IF NOT EXISTS idx_server_migrations_provider ON server_migrations(provider);

    CREATE TABLE IF NOT EXISTS server_migration_discovered_items (
      id TEXT PRIMARY KEY,
      migration_id TEXT NOT NULL,
      source_server_id TEXT NOT NULL,

      -- Item identification
      item_type TEXT NOT NULL
        CHECK(item_type IN (
          'docker_stack', 'docker_container', 'database',
          'cron_job', 'domain', 'env_file', 'nginx_site',
          'systemd_service', 'pm2_app', 'ssl_certificate',
          'ansible_role', 'coolify_project', 'dokploy_project'
        )),
      remote_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,

      -- Provider-specific data
      payload_json TEXT NOT NULL,
      provider_source TEXT,

      -- Selection & priority
      selected INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,

      -- Dependencies
      depends_on TEXT,

      -- Import status
      import_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(import_status IN (
          'pending', 'queued', 'importing', 'imported',
          'skipped', 'failed', 'rolled_back'
        )),
      local_record_type TEXT,
      local_record_id TEXT,

      -- Transfer status (cross-server)
      transfer_status TEXT DEFAULT 'pending'
        CHECK(transfer_status IN (
          'pending', 'exporting', 'transferring',
          'importing_remote', 'deployed', 'failed', 'skipped'
        )),
      transfer_log TEXT,
      transfer_bytes INTEGER,

      -- Verification
      verification_status TEXT DEFAULT 'pending'
        CHECK(verification_status IN ('pending', 'checking', 'healthy', 'unhealthy', 'skipped')),
      verification_message TEXT,

      -- Rollback
      rollback_data TEXT,

      -- Error
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (migration_id) REFERENCES server_migrations(id) ON DELETE CASCADE,
      FOREIGN KEY (source_server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_migration_items_migration ON server_migration_discovered_items(migration_id);
    CREATE INDEX IF NOT EXISTS idx_migration_items_source ON server_migration_discovered_items(source_server_id);
    CREATE INDEX IF NOT EXISTS idx_migration_items_type ON server_migration_discovered_items(item_type);
    CREATE INDEX IF NOT EXISTS idx_migration_items_import_status ON server_migration_discovered_items(import_status);
    CREATE INDEX IF NOT EXISTS idx_migration_items_transfer_status ON server_migration_discovered_items(transfer_status);
  `);
}
//# sourceMappingURL=061_server_migration.js.map