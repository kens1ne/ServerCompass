"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 053: Add S3 backup configuration tables
 *
 * Creates tables for:
 * - backup_storage_configs: S3 provider credentials (encrypted)
 * - app_backup_schedules: App config backup schedule
 * - server_backup_configs: Per-server backup configuration
 * - server_backup_exclusions: Stack/volume exclusions
 * - backup_jobs: Backup history and job tracking
 */
function migrate(db) {
    console.log('[Migration 053] Creating S3 backup configuration tables');
    // Table: backup_storage_configs
    // Stores S3-compatible storage provider credentials
    db.exec(`
    CREATE TABLE IF NOT EXISTS backup_storage_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN (
        'aws', 'backblaze', 'wasabi', 'minio', 'r2',
        'do_spaces', 'vultr', 'hetzner', 'custom'
      )),
      bucket TEXT NOT NULL,
      region TEXT,
      endpoint TEXT,
      path_prefix TEXT NOT NULL DEFAULT 'servercompass-backups',
      encrypted_credentials BLOB NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      last_tested_at INTEGER,
      last_test_success INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_storage_default
      ON backup_storage_configs(is_default)
  `);
    // Table: app_backup_schedules
    // Stores the app config backup schedule (singleton - only one row)
    db.exec(`
    CREATE TABLE IF NOT EXISTS app_backup_schedules (
      id TEXT PRIMARY KEY DEFAULT 'app-config',
      storage_config_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly', 'monthly')),
      time TEXT NOT NULL DEFAULT '02:00',
      day_of_week INTEGER CHECK(day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
      day_of_month INTEGER CHECK(day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      retention_count INTEGER NOT NULL DEFAULT 30,
      last_run_at INTEGER,
      last_run_status TEXT CHECK(last_run_status IS NULL OR last_run_status IN ('success', 'failed', 'partial', 'cancelled', 'blocked')),
      last_run_error TEXT,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (storage_config_id) REFERENCES backup_storage_configs(id) ON DELETE SET NULL
    )
  `);
    // Insert default app backup schedule (disabled)
    db.exec(`
    INSERT OR IGNORE INTO app_backup_schedules (id, created_at, updated_at)
    VALUES ('app-config', ${Date.now()}, ${Date.now()})
  `);
    // Table: server_backup_configs
    // Per-server backup configuration
    db.exec(`
    CREATE TABLE IF NOT EXISTS server_backup_configs (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL UNIQUE,
      storage_config_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly', 'monthly')),
      time TEXT NOT NULL DEFAULT '03:00',
      day_of_week INTEGER CHECK(day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
      day_of_month INTEGER CHECK(day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      retention_count INTEGER NOT NULL DEFAULT 7,
      backup_volumes INTEGER NOT NULL DEFAULT 1,
      backup_databases INTEGER NOT NULL DEFAULT 1,
      backup_compose_files INTEGER NOT NULL DEFAULT 1,
      backup_env_files INTEGER NOT NULL DEFAULT 1,
      backup_ssl_certs INTEGER NOT NULL DEFAULT 0,
      backup_cron_jobs INTEGER NOT NULL DEFAULT 0,
      stop_containers_for_consistency INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      last_run_status TEXT CHECK(last_run_status IS NULL OR last_run_status IN ('success', 'failed', 'partial', 'cancelled', 'blocked')),
      last_run_error TEXT,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (storage_config_id) REFERENCES backup_storage_configs(id) ON DELETE SET NULL
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_backup_server
      ON server_backup_configs(server_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_backup_next_run
      ON server_backup_configs(next_run_at)
      WHERE enabled = 1
  `);
    // Table: server_backup_exclusions
    // Per-server stack/volume exclusions
    db.exec(`
    CREATE TABLE IF NOT EXISTS server_backup_exclusions (
      id TEXT PRIMARY KEY,
      server_backup_config_id TEXT NOT NULL,
      exclusion_type TEXT NOT NULL CHECK(exclusion_type IN ('stack', 'volume', 'database')),
      exclusion_value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (server_backup_config_id) REFERENCES server_backup_configs(id) ON DELETE CASCADE
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_exclusions_config
      ON server_backup_exclusions(server_backup_config_id)
  `);
    // Table: backup_jobs
    // Backup history and job tracking
    db.exec(`
    CREATE TABLE IF NOT EXISTS backup_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL CHECK(job_type IN ('app_config', 'server_data')),
      server_id TEXT,
      storage_config_id TEXT,
      storage_config_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending', 'running', 'success', 'failed', 'partial', 'cancelled'
      )),
      triggered_by TEXT NOT NULL DEFAULT 'manual' CHECK(triggered_by IN ('manual', 'scheduled')),
      started_at INTEGER,
      completed_at INTEGER,
      s3_key TEXT,
      s3_keys TEXT,
      file_size_bytes INTEGER,
      total_size_bytes INTEGER,
      manifest TEXT,
      error_message TEXT,
      warnings TEXT,
      progress_percent INTEGER DEFAULT 0,
      current_phase TEXT,
      current_item TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
      FOREIGN KEY (storage_config_id) REFERENCES backup_storage_configs(id) ON DELETE SET NULL
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_type
      ON backup_jobs(job_type)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_server
      ON backup_jobs(server_id)
      WHERE server_id IS NOT NULL
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_status
      ON backup_jobs(status)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_created
      ON backup_jobs(created_at DESC)
  `);
    console.log('[Migration 053] S3 backup configuration tables created successfully');
}
//# sourceMappingURL=053_s3_backup_configuration.js.map