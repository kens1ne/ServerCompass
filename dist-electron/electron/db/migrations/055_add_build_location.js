"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 055: Add build_location column to docker_stacks
 *
 * Tracks how the stack was built/deployed:
 * - 'vps': Built directly on the VPS (default, includes template/paste deployments)
 * - 'github-actions': Built via GitHub Actions CI/CD, pushed to GHCR
 * - 'local-build': Built locally on user's machine, streamed to VPS
 *
 * This is critical for redeploy logic:
 * - vps/github-actions: Can run `docker compose pull` to get latest images
 * - local-build: Must skip pull (image only exists on VPS, not in any registry)
 */
function migrate(db) {
    console.log('[Migration 055] Adding build_location column to docker_stacks');
    // Helper to check if column exists
    const columnExists = (table, column) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        return columns.some((col) => col.name === column);
    };
    // Add build_location column to docker_stacks
    if (!columnExists('docker_stacks', 'build_location')) {
        db.exec(`
      ALTER TABLE docker_stacks
      ADD COLUMN build_location TEXT DEFAULT 'vps'
        CHECK(build_location IN ('vps', 'github-actions', 'local-build'))
    `);
        console.log('[Migration 055] Added build_location column');
    }
    // Create index for querying by build location
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_build_location
      ON docker_stacks(build_location)
  `);
    console.log('[Migration 055] build_location column added successfully');
}
//# sourceMappingURL=055_add_build_location.js.map