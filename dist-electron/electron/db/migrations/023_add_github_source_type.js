"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints
    // We need to recreate the table with the updated constraint
    // Check if table exists
    const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='docker_stacks'
  `).get();
    if (!tableExists) {
        return; // Table doesn't exist, nothing to migrate
    }
    // 1. Create new table with updated CHECK constraint (includes 'github')
    db.exec(`
    CREATE TABLE docker_stacks_new (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('template', 'paste', 'registry', 'pm2_migration', 'github')),
      template_id TEXT,
      compose_content TEXT NOT NULL,
      dockerfile_content TEXT,
      env_vars TEXT,
      stack_path TEXT DEFAULT '/root/server-compass/apps',
      registry_credential_id TEXT,
      build_on_deploy INTEGER DEFAULT 0,
      pull_policy TEXT DEFAULT 'missing' CHECK(pull_policy IN ('always', 'missing', 'never')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'deploying', 'running', 'partial', 'stopped', 'error')),
      last_deployed_at INTEGER,
      last_error TEXT,
      services_count INTEGER DEFAULT 0,

      -- CI/CD fields
      ci_enabled INTEGER DEFAULT 0,
      webhook_secret TEXT,
      webhook_url TEXT,
      current_image_digest TEXT,
      last_webhook_at INTEGER,
      github_repo TEXT,

      -- Git integration fields (from migration 022)
      git_account_id TEXT,
      git_branch TEXT DEFAULT 'main',
      git_clone_path TEXT,
      git_pull_on_redeploy INTEGER DEFAULT 1,
      git_last_commit TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (registry_credential_id) REFERENCES docker_registry_credentials(id) ON DELETE SET NULL,
      UNIQUE(server_id, project_name)
    );
  `);
    // 2. Copy existing data to new table
    // Get list of columns that exist in the old table
    const oldColumns = db.pragma('table_info(docker_stacks)');
    const oldColumnNames = oldColumns.map((c) => c.name);
    // Define all columns we want to copy (only copy what exists in old table)
    const allColumns = [
        'id', 'server_id', 'project_name', 'source_type', 'template_id',
        'compose_content', 'dockerfile_content', 'env_vars', 'stack_path',
        'registry_credential_id', 'build_on_deploy', 'pull_policy', 'status',
        'last_deployed_at', 'last_error', 'services_count', 'ci_enabled',
        'webhook_secret', 'webhook_url', 'current_image_digest', 'last_webhook_at',
        'github_repo', 'git_account_id', 'git_branch', 'git_clone_path',
        'git_pull_on_redeploy', 'git_last_commit', 'created_at', 'updated_at'
    ];
    const columnsToMigrate = allColumns.filter((col) => oldColumnNames.includes(col));
    const columnList = columnsToMigrate.join(', ');
    db.exec(`
    INSERT INTO docker_stacks_new (${columnList})
    SELECT ${columnList} FROM docker_stacks;
  `);
    // 3. Drop old table
    db.exec(`DROP TABLE docker_stacks;`);
    // 4. Rename new table to original name
    db.exec(`ALTER TABLE docker_stacks_new RENAME TO docker_stacks;`);
    // 5. Recreate indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_server ON docker_stacks(server_id);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_status ON docker_stacks(status);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_source ON docker_stacks(source_type);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_git_account ON docker_stacks(git_account_id);
  `);
    // Also update docker_stack_deployments triggered_by to include 'git_push'
    // Check current constraint
    const deploymentsExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='docker_stack_deployments'
  `).get();
    if (deploymentsExists) {
        // Recreate deployments table with updated triggered_by constraint
        db.exec(`
      CREATE TABLE docker_stack_deployments_new (
        id TEXT PRIMARY KEY,
        stack_id TEXT NOT NULL,
        triggered_by TEXT CHECK(triggered_by IN ('manual', 'redeploy', 'webhook', 'pm2_migration', 'git_push')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT CHECK(status IN ('pending', 'pulling', 'building', 'starting', 'success', 'failed')),
        pull_output TEXT,
        build_output TEXT,
        up_output TEXT,
        error_message TEXT,
        deployed_images TEXT,
        previous_compose_content TEXT,
        created_at INTEGER NOT NULL,

        FOREIGN KEY (stack_id) REFERENCES docker_stacks(id) ON DELETE CASCADE
      );
    `);
        db.exec(`
      INSERT INTO docker_stack_deployments_new
      SELECT * FROM docker_stack_deployments;
    `);
        db.exec(`DROP TABLE docker_stack_deployments;`);
        db.exec(`ALTER TABLE docker_stack_deployments_new RENAME TO docker_stack_deployments;`);
        db.exec(`
      CREATE INDEX IF NOT EXISTS idx_stack_deployments_stack ON docker_stack_deployments(stack_id);
      CREATE INDEX IF NOT EXISTS idx_stack_deployments_started ON docker_stack_deployments(started_at DESC);
    `);
    }
}
//# sourceMappingURL=023_add_github_source_type.js.map