"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDeploymentRecord = createDeploymentRecord;
exports.updateDeploymentStatus = updateDeploymentStatus;
exports.updateDeploymentOutput = updateDeploymentOutput;
exports.updateDeploymentError = updateDeploymentError;
exports.updateDeploymentFinished = updateDeploymentFinished;
exports.getLastSuccessfulDeployment = getLastSuccessfulDeployment;
exports.getComposeContentForDeployment = getComposeContentForDeployment;
exports.updateStackWithFallback = updateStackWithFallback;
exports.clearPendingFailure = clearPendingFailure;
const db_1 = require("../../db");
function createDeploymentRecord(deploymentId, stackId, triggeredBy, startedAt, gitCommitHash, buildLocation) {
    const stmt = db_1.db.prepare(`
      INSERT INTO docker_stack_deployments (
        id, stack_id, triggered_by, started_at, status, created_at, git_commit_hash, build_location
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `);
    stmt.run(deploymentId, stackId, triggeredBy, startedAt, startedAt, gitCommitHash || null, buildLocation || null);
}
function updateDeploymentStatus(deploymentId, status) {
    const stmt = db_1.db.prepare(`
      UPDATE docker_stack_deployments SET status = ? WHERE id = ?
    `);
    stmt.run(status, deploymentId);
}
function updateDeploymentOutput(deploymentId, field, output) {
    const stmt = db_1.db.prepare(`
      UPDATE docker_stack_deployments SET ${field} = ? WHERE id = ?
    `);
    stmt.run(output, deploymentId);
}
function updateDeploymentError(deploymentId, error) {
    const stmt = db_1.db.prepare(`
      UPDATE docker_stack_deployments SET error_message = ? WHERE id = ?
    `);
    stmt.run(error, deploymentId);
}
function updateDeploymentFinished(deploymentId, finishedAt) {
    const stmt = db_1.db.prepare(`
      UPDATE docker_stack_deployments SET finished_at = ? WHERE id = ?
    `);
    stmt.run(finishedAt, deploymentId);
}
/**
 * Get the last successful deployment for a stack
 */
function getLastSuccessfulDeployment(stackId) {
    const stmt = db_1.db.prepare(`
      SELECT * FROM docker_stack_deployments
      WHERE stack_id = ? AND status = 'success'
      ORDER BY finished_at DESC
      LIMIT 1
    `);
    return stmt.get(stackId);
}
/**
 * Get the compose content that was active during a specific deployment.
 * This is the content to use when rolling back to that deployment.
 */
function getComposeContentForDeployment(deploymentId) {
    const deployment = db_1.db.prepare(`
      SELECT d.*, s.compose_content as current_compose, d.started_at
      FROM docker_stack_deployments d
      JOIN docker_stacks s ON d.stack_id = s.id
      WHERE d.id = ?
    `).get(deploymentId);
    if (!deployment)
        return null;
    const nextDeployment = db_1.db.prepare(`
      SELECT previous_compose_content
      FROM docker_stack_deployments
      WHERE stack_id = ? AND started_at > ?
      ORDER BY started_at ASC
      LIMIT 1
    `).get(deployment.stack_id, deployment.started_at);
    if (nextDeployment?.previous_compose_content) {
        return nextDeployment.previous_compose_content;
    }
    return deployment.current_compose;
}
/**
 * Update stack with fallback state when deployment fails
 */
function updateStackWithFallback(stackId, errorMessage, failedComposeContent, lastSuccessfulDeploymentId) {
    if (lastSuccessfulDeploymentId) {
        db_1.db.prepare(`
        UPDATE docker_stacks
        SET status = 'running',
            has_pending_failure = 1,
            last_error = ?,
            failed_compose_content = ?,
            last_successful_deployment_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(errorMessage, failedComposeContent || null, lastSuccessfulDeploymentId, Date.now(), stackId);
    }
    else {
        db_1.db.prepare(`
        UPDATE docker_stacks
        SET status = 'error',
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `).run(errorMessage, Date.now(), stackId);
    }
}
/**
 * Clear the pending failure flag on a stack (after successful deploy or user dismissal)
 */
function clearPendingFailure(stackId) {
    db_1.db.prepare(`
      UPDATE docker_stacks
      SET has_pending_failure = 0,
          failed_compose_content = NULL,
          last_error = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(Date.now(), stackId);
}
//# sourceMappingURL=deploymentDb.js.map