"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 048: Add notification_events table
 *
 * This table logs all notification attempts including:
 * - Test notifications from channel testing
 * - Manual notifications sent via sendNotification
 * - Alert-triggered notifications (complements notification_log)
 */
function migrate(db) {
    console.log('[Migration 048] Creating notification_events table');
    // Notification events table - logs all notification attempts
    db.exec(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      channel_id TEXT,
      channel_name TEXT,
      channel_type TEXT,
      status TEXT NOT NULL,
      output TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE SET NULL
    )
  `);
    // Index for efficient querying by server and time
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notification_events_server_time
      ON notification_events(server_id, created_at DESC)
  `);
    // Index for filtering by type
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notification_events_type
      ON notification_events(type)
  `);
    console.log('[Migration 048] Notification events table created successfully');
}
//# sourceMappingURL=048_notification_events.js.map