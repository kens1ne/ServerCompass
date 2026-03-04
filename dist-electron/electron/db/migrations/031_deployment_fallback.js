"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function columnExists(db, table, column) {
    const rows = db.prepare(`PRAGMA table_info('${table}')`).all();
    return rows.some((row) => row.name === column);
}
function migrate(db) {
    // Add fallback-related fields to docker_stacks table
    // These fields support automatic fallback when deployment fails
    // has_pending_failure: Boolean flag indicating a deployment failed but previous version is running
    if (!columnExists(db, 'docker_stacks', 'has_pending_failure')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN has_pending_failure INTEGER DEFAULT 0;
    `);
    }
    // last_successful_deployment_id: References the last successful deployment for quick access
    if (!columnExists(db, 'docker_stacks', 'last_successful_deployment_id')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN last_successful_deployment_id TEXT REFERENCES docker_stack_deployments(id) ON DELETE SET NULL;
    `);
    }
    // failed_compose_content: Stores the compose content that failed (for retry/debugging)
    if (!columnExists(db, 'docker_stacks', 'failed_compose_content')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN failed_compose_content TEXT;
    `);
    }
    // Note: We also want to add 'rollback' to the triggered_by CHECK constraint in docker_stack_deployments
    // However, SQLite doesn't support modifying CHECK constraints via ALTER TABLE
    // SQLite in non-strict mode allows inserting values that don't match CHECK constraints
    // So 'rollback' will work as a triggered_by value even without modifying the constraint
    console.log('Added deployment fallback fields to docker_stacks table');
}
//# sourceMappingURL=031_deployment_fallback.js.map