"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add logs column to docker_stack_deployments table to store full deployment logs
    // This captures all emitLog() messages during deployment
    db.exec(`
    ALTER TABLE docker_stack_deployments ADD COLUMN logs TEXT;
  `);
    // Create index for faster lookups by server (via stack_id join)
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_finished
    ON docker_stack_deployments(finished_at DESC);
  `);
}
//# sourceMappingURL=027_add_deployment_logs_column.js.map