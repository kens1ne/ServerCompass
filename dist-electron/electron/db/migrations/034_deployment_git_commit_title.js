"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add git_commit_title column to docker_stack_deployments table
    // This stores the commit message/title for display in deployment history
    // Check if column exists
    const columns = db.prepare(`PRAGMA table_info(docker_stack_deployments)`).all();
    const hasGitCommitTitle = columns.some(c => c.name === 'git_commit_title');
    if (!hasGitCommitTitle) {
        db.exec(`
      ALTER TABLE docker_stack_deployments ADD COLUMN git_commit_title TEXT;
    `);
    }
}
//# sourceMappingURL=034_deployment_git_commit_title.js.map