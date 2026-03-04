"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 062: Add 'migration' to docker_stacks source_type CHECK constraint
 *
 * The migration feature imports services from other providers (Coolify, RunCloud, etc.)
 * and creates docker_stacks records with source_type = 'migration'.
 */
function migrate(db) {
    const tableInfo = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_stacks'`)
        .get();
    if (!tableInfo)
        return;
    const currentDDL = tableInfo.sql;
    if (currentDDL.includes("'migration'"))
        return;
    // Add 'migration' after 'upload' in the source_type CHECK constraint
    const newDDL = currentDDL.replace(/('upload')\s*\)/, "'upload', 'migration')");
    if (newDDL === currentDDL) {
        console.warn('[Migration 062] Could not find source_type CHECK to update. Skipping.');
        return;
    }
    const createNewTable = newDDL
        .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"docker_stacks"/, 'CREATE TABLE docker_stacks_new')
        .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?docker_stacks\b/, 'CREATE TABLE docker_stacks_new');
    const columns = db.pragma('table_info(docker_stacks)');
    const columnList = columns.map((c) => c.name).join(', ');
    db.exec(`DROP TABLE IF EXISTS docker_stacks_new;`);
    db.exec(createNewTable);
    db.exec(`INSERT INTO docker_stacks_new (${columnList}) SELECT ${columnList} FROM docker_stacks;`);
    db.exec(`DROP TABLE docker_stacks;`);
    db.exec(`ALTER TABLE docker_stacks_new RENAME TO docker_stacks;`);
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
//# sourceMappingURL=062_migration_source_type.js.map