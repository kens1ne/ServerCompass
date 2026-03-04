"use strict";
/**
 * Migration 060: Expand environment_type to support more badge types
 *
 * Adds support for: alpha, beta, qa, demo, development, test
 * in addition to existing: production, staging, preview
 *
 * Also removes TTL columns as TTL feature is being redesigned.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // SQLite doesn't allow modifying CHECK constraints directly
    // We need to recreate the table without the constraint
    // Check if we need to migrate (if the old constraint exists)
    // We'll use a test insert to check
    let needsMigration = false;
    try {
        // Try to update a non-existent row with a new type - if constraint exists, this will fail
        const testStmt = db.prepare(`
      UPDATE docker_stacks
      SET environment_type = 'alpha'
      WHERE id = 'non-existent-test-id-12345'
    `);
        testStmt.run();
        // If we get here, the constraint either doesn't exist or allows 'alpha'
        // Check by trying to see if alpha is in the allowed values
    }
    catch (err) {
        // Constraint violation means we need to migrate
        needsMigration = true;
    }
    if (!needsMigration) {
        console.log('[Migration 060] Environment types already expanded or no constraint exists');
        return;
    }
    console.log('[Migration 060] Expanding environment_type constraint...');
    // Get all existing columns
    const columns = db.prepare(`PRAGMA table_info(docker_stacks)`).all();
    // Build column list (excluding environment_type which we'll handle specially)
    const columnNames = columns.map(c => c.name);
    const columnList = columnNames.join(', ');
    // Create new table without the CHECK constraint on environment_type
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_stacks_new (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      compose_content TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      app_path TEXT,
      template_id TEXT,
      source_type TEXT DEFAULT 'template',
      env_vars TEXT,
      dockerfile_content TEXT,
      github_repo TEXT,
      git_branch TEXT,
      ci_enabled INTEGER DEFAULT 0,
      deploy_on_push INTEGER DEFAULT 0,
      git_connection_id TEXT,
      git_account_id TEXT,
      last_error TEXT,
      has_pending_failure INTEGER DEFAULT 0,
      last_successful_compose TEXT,
      domain_port INTEGER,
      is_zero_downtime INTEGER DEFAULT 0,
      environment_type TEXT DEFAULT 'production',
      parent_stack_id TEXT,
      subdomain_prefix TEXT,
      auto_deploy_rules TEXT,
      ttl_days INTEGER,
      last_activity_at INTEGER,
      build_location TEXT DEFAULT 'vps',
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_stack_id) REFERENCES docker_stacks(id) ON DELETE SET NULL
    )
  `);
    // Copy data from old table to new table
    db.exec(`
    INSERT INTO docker_stacks_new (${columnList})
    SELECT ${columnList} FROM docker_stacks
  `);
    // Drop old table
    db.exec(`DROP TABLE docker_stacks`);
    // Rename new table
    db.exec(`ALTER TABLE docker_stacks_new RENAME TO docker_stacks`);
    // Recreate indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_server
    ON docker_stacks(server_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_project
    ON docker_stacks(server_id, project_name)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_env_type
    ON docker_stacks(environment_type)
    WHERE environment_type != 'production'
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_parent
    ON docker_stacks(parent_stack_id)
    WHERE parent_stack_id IS NOT NULL
  `);
    console.log('[Migration 060] Environment types expanded successfully');
}
//# sourceMappingURL=060_expand_environment_types.js.map