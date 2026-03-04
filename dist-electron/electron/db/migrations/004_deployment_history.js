"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add new columns to deployments table for better deployment tracking
    db.exec(`
    ALTER TABLE deployments ADD COLUMN app_name TEXT;
    ALTER TABLE deployments ADD COLUMN build_command TEXT;
    ALTER TABLE deployments ADD COLUMN start_command TEXT;
    ALTER TABLE deployments ADD COLUMN port INTEGER;
    ALTER TABLE deployments ADD COLUMN runtime TEXT DEFAULT 'node';
  `);
    // Create index on app_name for faster lookups by app
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deployments_app_name ON deployments(app_name);
  `);
    console.log('Deployment history schema updated successfully');
}
//# sourceMappingURL=004_deployment_history.js.map