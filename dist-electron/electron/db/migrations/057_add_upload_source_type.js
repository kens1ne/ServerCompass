"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration: Add 'upload' to source_type CHECK constraint
 *
 * The 'upload' source type allows users to upload a folder from their local machine
 * to deploy as a Docker stack. This migration updates the CHECK constraint to allow
 * this new source type.
 *
 * Instead of hardcoding the full table schema (which drifts as other migrations add
 * columns), we read the current CREATE TABLE DDL from sqlite_master and do a targeted
 * string replacement on the source_type CHECK constraint.
 */
function migrate(db) {
    // Check if table exists
    const tableInfo = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_stacks'`)
        .get();
    if (!tableInfo) {
        return; // Table doesn't exist, nothing to migrate
    }
    const currentDDL = tableInfo.sql;
    // If 'upload' is already in the CHECK constraint, nothing to do
    if (currentDDL.includes("'upload'")) {
        return;
    }
    // Replace the source_type CHECK constraint to include 'upload'
    const newDDL = currentDDL.replace(/source_type\s+IN\s*\(\s*'template'\s*,\s*'paste'\s*,\s*'registry'\s*,\s*'pm2_migration'\s*,\s*'github'\s*\)/, "source_type IN ('template', 'paste', 'registry', 'pm2_migration', 'github', 'upload')");
    if (newDDL === currentDDL) {
        // Regex didn't match — constraint may have a different format. Skip to avoid data loss.
        console.warn('[Migration 057] Could not find source_type CHECK constraint to update. Skipping.');
        return;
    }
    // Rename the DDL to create docker_stacks_new
    const createNewTable = newDDL
        .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"docker_stacks"/, 'CREATE TABLE docker_stacks_new')
        .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?docker_stacks\b/, 'CREATE TABLE docker_stacks_new');
    // Get current columns to copy data
    const columns = db.pragma('table_info(docker_stacks)');
    const columnList = columns.map((c) => c.name).join(', ');
    // Clean up any leftover temp table from a previously interrupted migration
    db.exec(`DROP TABLE IF EXISTS docker_stacks_new;`);
    // 1. Create new table with updated CHECK constraint
    db.exec(createNewTable);
    // 2. Copy existing data
    db.exec(`INSERT INTO docker_stacks_new (${columnList}) SELECT ${columnList} FROM docker_stacks;`);
    // 3. Drop old table
    db.exec(`DROP TABLE docker_stacks;`);
    // 4. Rename new table
    db.exec(`ALTER TABLE docker_stacks_new RENAME TO docker_stacks;`);
    // 5. Recreate indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_server ON docker_stacks(server_id);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_status ON docker_stacks(status);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_source ON docker_stacks(source_type);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_git_account ON docker_stacks(git_account_id);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_build_location ON docker_stacks(build_location);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_generation_method ON docker_stacks(generation_method);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_parent ON docker_stacks(parent_stack_id) WHERE parent_stack_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_env_type ON docker_stacks(environment_type) WHERE environment_type != 'production';
  `);
}
//# sourceMappingURL=057_add_upload_source_type.js.map