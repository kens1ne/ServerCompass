"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Check if columns already exist before adding
    const tableInfo = db.pragma('table_info(docker_stacks)');
    const existingColumns = tableInfo.map((c) => c.name);
    // Add git_account_id column if not exists
    if (!existingColumns.includes('git_account_id')) {
        db.exec(`ALTER TABLE docker_stacks ADD COLUMN git_account_id TEXT`);
    }
    // Add git_branch column if not exists
    if (!existingColumns.includes('git_branch')) {
        db.exec(`ALTER TABLE docker_stacks ADD COLUMN git_branch TEXT DEFAULT 'main'`);
    }
    // Add git_clone_path column if not exists (path where repo is cloned on server)
    if (!existingColumns.includes('git_clone_path')) {
        db.exec(`ALTER TABLE docker_stacks ADD COLUMN git_clone_path TEXT`);
    }
    // Add git_pull_on_redeploy column if not exists
    if (!existingColumns.includes('git_pull_on_redeploy')) {
        db.exec(`ALTER TABLE docker_stacks ADD COLUMN git_pull_on_redeploy INTEGER DEFAULT 1`);
    }
    // Add git_last_commit column if not exists (to track deployed commit)
    if (!existingColumns.includes('git_last_commit')) {
        db.exec(`ALTER TABLE docker_stacks ADD COLUMN git_last_commit TEXT`);
    }
    // Update source_type check constraint to include 'github'
    // Note: SQLite doesn't support ALTER TABLE to modify constraints directly
    // The constraint will be enforced at application level instead
    // New source_type values: 'template', 'paste', 'registry', 'pm2_migration', 'github'
    // Create index for git_account_id if not exists
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_git_account
    ON docker_stacks(git_account_id);
  `);
    // Add triggered_by value 'git_push' for deployments triggered by git operations
    // (constraint is at application level, so no migration needed)
}
//# sourceMappingURL=022_docker_git_integration.js.map