"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add display_order column to servers table
    db.exec(`
    ALTER TABLE servers ADD COLUMN display_order INTEGER;
  `);
    // Initialize display_order for existing servers based on created_at
    // Servers created earlier should have lower (earlier) display_order values
    db.exec(`
    UPDATE servers
    SET display_order = (
      SELECT COUNT(*)
      FROM servers s2
      WHERE s2.created_at <= servers.created_at
    );
  `);
    // Create index for faster ordering
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_servers_display_order ON servers(display_order);
  `);
    console.log('Server display_order column added successfully');
}
//# sourceMappingURL=012_server_display_order.js.map