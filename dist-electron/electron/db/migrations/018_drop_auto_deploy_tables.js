"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Drop auto-deploy related tables (replaced by GitHub Actions)
    db.exec(`
    DROP TABLE IF EXISTS auto_deploy_settings;
    DROP TABLE IF EXISTS auto_deploy_config;
  `);
    // Drop auto-deploy indices if they exist
    db.exec(`
    DROP INDEX IF EXISTS idx_auto_deploy_config_server;
    DROP INDEX IF EXISTS idx_auto_deploy_config_enabled;
  `);
    console.log('Dropped deprecated auto-deploy tables (replaced by GitHub Actions)');
}
//# sourceMappingURL=018_drop_auto_deploy_tables.js.map