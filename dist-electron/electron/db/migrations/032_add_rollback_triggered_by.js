"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add 'rollback' to the triggered_by CHECK constraint in docker_stack_deployments
    // This allows the rollback feature to create deployment records
    const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='docker_stack_deployments'
  `).get();
    if (!tableExists) {
        return; // Table doesn't exist, nothing to migrate
    }
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints
    // We need to recreate the table with the updated constraint
    // 1. Create new table with updated CHECK constraint (includes 'rollback')
    db.exec(`
    CREATE TABLE docker_stack_deployments_new (
      id TEXT PRIMARY KEY,
      stack_id TEXT NOT NULL,
      triggered_by TEXT CHECK(triggered_by IN ('manual', 'redeploy', 'webhook', 'pm2_migration', 'git_push', 'rollback')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT CHECK(status IN ('pending', 'pulling', 'building', 'starting', 'success', 'failed')),
      pull_output TEXT,
      build_output TEXT,
      up_output TEXT,
      error_message TEXT,
      deployed_images TEXT,
      previous_compose_content TEXT,
      logs TEXT,
      created_at INTEGER NOT NULL,

      FOREIGN KEY (stack_id) REFERENCES docker_stacks(id) ON DELETE CASCADE
    );
  `);
    // 2. Copy existing data to new table
    db.exec(`
    INSERT INTO docker_stack_deployments_new
    SELECT id, stack_id, triggered_by, started_at, finished_at, status,
           pull_output, build_output, up_output, error_message, deployed_images,
           previous_compose_content, logs, created_at
    FROM docker_stack_deployments;
  `);
    // 3. Drop old table
    db.exec(`DROP TABLE docker_stack_deployments;`);
    // 4. Rename new table to original name
    db.exec(`ALTER TABLE docker_stack_deployments_new RENAME TO docker_stack_deployments;`);
    // 5. Recreate indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_stack ON docker_stack_deployments(stack_id);
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_started ON docker_stack_deployments(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_finished ON docker_stack_deployments(finished_at DESC);
  `);
}
//# sourceMappingURL=032_add_rollback_triggered_by.js.map