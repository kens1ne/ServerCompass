"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add stdout and stderr columns to commands table
    db.exec(`
    ALTER TABLE commands ADD COLUMN stdout TEXT;
    ALTER TABLE commands ADD COLUMN stderr TEXT;
  `);
    // Create settings table for application configuration
    db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
    // Insert default log size limit (50 MB)
    db.exec(`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('max_log_size_mb', '50', ${Date.now()});
  `);
    console.log('Command logs output migration completed successfully');
}
//# sourceMappingURL=003_command_logs_output.js.map