"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add git_commit_hash column to docker_stack_deployments table
    // This allows rollback to restore exact source files from a specific commit
    const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='docker_stack_deployments'
  `).get();
    if (!tableExists) {
        return;
    }
    // Check if column already exists
    const columns = db.pragma('table_info(docker_stack_deployments)');
    const hasGitCommitHash = columns.some(c => c.name === 'git_commit_hash');
    if (!hasGitCommitHash) {
        db.exec(`
      ALTER TABLE docker_stack_deployments ADD COLUMN git_commit_hash TEXT;
    `);
    }
    // Create index for faster lookups by commit hash
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_commit
    ON docker_stack_deployments(git_commit_hash);
  `);
}
//# sourceMappingURL=033_deployment_git_commit.js.map