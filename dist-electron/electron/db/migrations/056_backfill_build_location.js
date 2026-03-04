"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 056: Backfill build_location for existing stacks
 *
 * Migration 055 added build_location with DEFAULT 'vps', but existing
 * Local Build and GitHub Actions apps were incorrectly set to 'vps'.
 *
 * This migration detects and fixes them:
 * 1. GitHub Actions: ci_enabled = 1 → 'github-actions'
 * 2. Local Build: compose_content has image like "servercompass/app:1234567890" → 'local-build'
 * 3. Everything else: keep 'vps'
 */
function migrate(db) {
    console.log('[Migration 056] Backfilling build_location for existing stacks');
    // Get all stacks that might need updating
    const stacks = db.prepare(`
    SELECT id, ci_enabled, compose_content
    FROM docker_stacks
    WHERE build_location = 'vps' OR build_location IS NULL
  `).all();
    let githubActionsCount = 0;
    let localBuildCount = 0;
    for (const stack of stacks) {
        // Check for GitHub Actions (ci_enabled = 1)
        if (stack.ci_enabled === 1) {
            db.prepare(`UPDATE docker_stacks SET build_location = 'github-actions' WHERE id = ?`).run(stack.id);
            githubActionsCount++;
            continue;
        }
        // Check for Local Build (image pattern: servercompass/name:timestamp)
        // Pattern: "image: servercompass/something:1234567890" where tag is numeric (timestamp)
        if (stack.compose_content) {
            const localBuildPattern = /image:\s*["']?servercompass\/[^:]+:(\d{10,})["']?/i;
            if (localBuildPattern.test(stack.compose_content)) {
                db.prepare(`UPDATE docker_stacks SET build_location = 'local-build' WHERE id = ?`).run(stack.id);
                localBuildCount++;
                continue;
            }
        }
        // Everything else stays 'vps' (already default)
    }
    console.log(`[Migration 056] Backfill complete:`);
    console.log(`  - GitHub Actions: ${githubActionsCount} stacks`);
    console.log(`  - Local Build: ${localBuildCount} stacks`);
    console.log(`  - VPS (unchanged): ${stacks.length - githubActionsCount - localBuildCount} stacks`);
}
//# sourceMappingURL=056_backfill_build_location.js.map