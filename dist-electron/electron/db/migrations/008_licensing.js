"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT UNIQUE NOT NULL,
      email TEXT,
      device_limit INTEGER NOT NULL DEFAULT 1,
      updates_until TEXT NOT NULL,
      activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_verified DATETIME,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS device_activations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL UNIQUE,
      device_name TEXT,
      activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME,
      UNIQUE(license_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS license_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_licensed BOOLEAN NOT NULL DEFAULT 0,
      license_id INTEGER REFERENCES licenses(id),
      current_device_id TEXT,
      trial_started DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS usage_limits (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_servers INTEGER NOT NULL DEFAULT 1,
      max_deployments INTEGER NOT NULL DEFAULT 1,
      max_domains INTEGER NOT NULL DEFAULT 1,
      max_cron_jobs INTEGER NOT NULL DEFAULT 5,
      max_command_logs INTEGER NOT NULL DEFAULT 10,
      allow_databases BOOLEAN NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
    CREATE INDEX IF NOT EXISTS idx_device_activations_license ON device_activations(license_id);
  `);
    db.prepare(`
    INSERT OR IGNORE INTO license_status (id, is_licensed, license_id, current_device_id, trial_started)
    VALUES (1, 0, NULL, NULL, CURRENT_TIMESTAMP)
  `).run();
    db.prepare(`
    INSERT OR IGNORE INTO usage_limits (
      id,
      max_servers,
      max_deployments,
      max_domains,
      max_cron_jobs,
      max_command_logs,
      allow_databases
    ) VALUES (1, 1, 1, 1, 5, 10, 1)
  `).run();
}
//# sourceMappingURL=008_licensing.js.map