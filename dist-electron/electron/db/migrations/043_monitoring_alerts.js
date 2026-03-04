"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 043: Add monitoring and alerting tables
 *
 * This adds support for the real-time monitoring and alerts feature:
 * - monitoring_config: Per-server monitoring configuration
 * - metrics_history: Time-series metrics data
 * - alert_rules: Alert rule definitions
 * - alerts: Active and historical alert instances
 * - notification_channels: Notification destinations (Slack, Discord, Email, Webhook)
 * - quiet_hours: Schedule for suppressing notifications
 * - notification_log: Log of sent notifications
 */
function migrate(db) {
    console.log('[Migration 043] Creating monitoring and alerting tables');
    // Monitoring configuration per server
    db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_config (
      server_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      interval_seconds INTEGER DEFAULT 60,
      retention_days INTEGER DEFAULT 7,
      agent_installed INTEGER DEFAULT 0,
      agent_version TEXT,
      agent_last_seen INTEGER,
      log_max_lines INTEGER DEFAULT 1000,
      log_max_size_mb INTEGER DEFAULT 10,
      log_retention_days INTEGER DEFAULT 7,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    // Metrics history (time-series data)
    db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      cpu_usage REAL,
      memory_used INTEGER,
      memory_total INTEGER,
      disk_used INTEGER,
      disk_total INTEGER,
      load_1m REAL,
      load_5m REAL,
      load_15m REAL,
      uptime INTEGER,
      network_rx INTEGER,
      network_tx INTEGER,
      process_count INTEGER,
      connection_status TEXT DEFAULT 'ok',
      collection_duration_ms INTEGER,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_metrics_server_time
      ON metrics_history(server_id, timestamp DESC)
  `);
    // Alert rules
    db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      metric TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      duration_seconds INTEGER DEFAULT 0,
      cooldown_seconds INTEGER DEFAULT 300,
      severity TEXT NOT NULL DEFAULT 'warning',
      notify_on_firing INTEGER DEFAULT 1,
      notify_on_resolved INTEGER DEFAULT 1,
      notification_channels TEXT,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    // Active and historical alerts
    db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      metric TEXT NOT NULL,
      threshold REAL NOT NULL,
      current_value REAL NOT NULL,
      message TEXT NOT NULL,
      pending_at INTEGER,
      firing_at INTEGER,
      resolved_at INTEGER,
      last_notification_at INTEGER,
      notifications_sent INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_server ON alerts(server_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_firing ON alerts(status, firing_at DESC)
  `);
    // Notification channels
    db.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT NOT NULL,
      last_test_at INTEGER,
      last_test_status TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    // Quiet hours configuration
    db.exec(`
    CREATE TABLE IF NOT EXISTS quiet_hours (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      days_of_week TEXT NOT NULL,
      timezone TEXT DEFAULT 'UTC',
      suppress_warning INTEGER DEFAULT 1,
      suppress_info INTEGER DEFAULT 1,
      suppress_critical INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    // Notification log
    db.exec(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      sent_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE
    )
  `);
    console.log('[Migration 043] Monitoring and alerting tables created successfully');
}
//# sourceMappingURL=043_monitoring_alerts.js.map