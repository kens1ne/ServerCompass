"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 050: Add one_click_installations table
 *
 * Tracks 1-Click Install services (OpenClaw, Ollama, Tailscale, etc.)
 * installed on remote servers via the Stack Wizard's 1-Click Install path.
 */
function migrate(db) {
    console.log('[Migration 050] Creating one_click_installations table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS one_click_installations (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      name TEXT NOT NULL,
      install_command_redacted TEXT NOT NULL,
      install_url TEXT NOT NULL,
      service_manager TEXT NOT NULL CHECK(service_manager IN ('docker', 'systemd', 'systemd-user', 'custom')),
      lifecycle_commands TEXT,
      discovery_config TEXT,
      systemd_main_unit TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','installing','installed','running','stopped','error','uninstalled')),
      installed_version TEXT,
      install_path TEXT,
      install_error TEXT,
      installed_at INTEGER,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_one_click_server
      ON one_click_installations(server_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_one_click_status
      ON one_click_installations(status)
  `);
    console.log('[Migration 050] One-click installations table created successfully');
}
//# sourceMappingURL=050_one_click_installations.js.map