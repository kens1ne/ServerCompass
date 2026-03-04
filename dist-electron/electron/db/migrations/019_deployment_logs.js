"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add columns for storing deployment logs and error messages
    db.exec(`
    ALTER TABLE deployments ADD COLUMN logs TEXT;
    ALTER TABLE deployments ADD COLUMN error_message TEXT;
    ALTER TABLE deployments ADD COLUMN log_line_count INTEGER DEFAULT 0;
  `);
    console.log('Deployment logs schema updated successfully');
}
//# sourceMappingURL=019_deployment_logs.js.map