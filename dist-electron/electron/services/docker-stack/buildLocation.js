"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateBuildLocation = updateBuildLocation;
const db_1 = require("../../db");
/**
 * Update build location tracking for an existing stack.
 *
 * This controls redeploy behavior (e.g. skipping image pulls for local-build).
 */
async function updateBuildLocation(ctx, serverId, stackId, buildLocation) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    db_1.db.prepare(`
      UPDATE docker_stacks SET build_location = ?, updated_at = ? WHERE id = ?
    `).run(buildLocation, Date.now(), stackId);
    ctx.emitLog(`Build location updated to: ${buildLocation}`, 'info', stackId);
}
//# sourceMappingURL=buildLocation.js.map