"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 054: Add staging environments support
 *
 * Adds columns to docker_stacks for environment management:
 * - environment_type: 'production', 'staging', 'preview'
 * - parent_stack_id: Links environment to production stack
 * - subdomain_prefix: e.g., 'staging', 'pr-47', 'feature-auth'
 * - auto_deploy_rules: JSON array of branch→environment rules
 * - ttl_days: Auto-cleanup for previews
 * - last_activity_at: Updated on deploy/redeploy
 *
 * Adds column to domains:
 * - is_primary: For promote flow domain resolution
 */
function migrate(db) {
    console.log('[Migration 054] Adding staging environments support');
    // Helper to check if column exists
    const columnExists = (table, column) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        return columns.some((col) => col.name === column);
    };
    // Add environment_type column to docker_stacks
    if (!columnExists('docker_stacks', 'environment_type')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN environment_type TEXT DEFAULT 'production'
        CHECK(environment_type IN ('production', 'staging', 'preview'))
    `);
        console.log('[Migration 054] Added environment_type column');
    }
    // Add parent_stack_id column to docker_stacks
    if (!columnExists('docker_stacks', 'parent_stack_id')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN parent_stack_id TEXT REFERENCES docker_stacks(id) ON DELETE SET NULL
    `);
        console.log('[Migration 054] Added parent_stack_id column');
    }
    // Add subdomain_prefix column to docker_stacks
    if (!columnExists('docker_stacks', 'subdomain_prefix')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN subdomain_prefix TEXT
    `);
        console.log('[Migration 054] Added subdomain_prefix column');
    }
    // Add auto_deploy_rules column to docker_stacks (JSON array)
    if (!columnExists('docker_stacks', 'auto_deploy_rules')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN auto_deploy_rules TEXT
    `);
        console.log('[Migration 054] Added auto_deploy_rules column');
    }
    // Add ttl_days column to docker_stacks
    if (!columnExists('docker_stacks', 'ttl_days')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN ttl_days INTEGER
    `);
        console.log('[Migration 054] Added ttl_days column');
    }
    // Add last_activity_at column to docker_stacks
    if (!columnExists('docker_stacks', 'last_activity_at')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN last_activity_at INTEGER
    `);
        console.log('[Migration 054] Added last_activity_at column');
    }
    // Add is_primary column to domains
    if (!columnExists('domains', 'is_primary')) {
        db.exec(`
      ALTER TABLE domains
      ADD COLUMN is_primary INTEGER DEFAULT 0
    `);
        console.log('[Migration 054] Added is_primary column to domains');
    }
    // Create index for finding environments by parent
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_parent
      ON docker_stacks(parent_stack_id)
      WHERE parent_stack_id IS NOT NULL
  `);
    // Create index for finding environments by type
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_env_type
      ON docker_stacks(environment_type)
      WHERE environment_type != 'production'
  `);
    // Create index for TTL-based cleanup queries
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_ttl_cleanup
      ON docker_stacks(last_activity_at, ttl_days)
      WHERE environment_type = 'preview' AND ttl_days IS NOT NULL
  `);
    console.log('[Migration 054] Staging environments support added successfully');
}
//# sourceMappingURL=054_add_staging_environments.js.map