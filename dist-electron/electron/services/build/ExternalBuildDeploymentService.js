"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExternalBuildDeploymentService = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const pathUtils_1 = require("../docker-stack/pathUtils");
class ExternalBuildDeploymentService {
    ensureDeploymentRecord(input) {
        const now = Date.now();
        const { normalizedStackPath } = (0, pathUtils_1.resolveStackWorkingDir)({
            stack_path: input.appPath,
            project_name: input.projectName,
        });
        const existingStack = db_1.db.prepare(`
      SELECT id, compose_content, dockerfile_content
      FROM docker_stacks
      WHERE server_id = ? AND project_name = ?
      LIMIT 1
    `).get(input.serverId, input.projectName);
        let stackId = existingStack?.id;
        const previousComposeContent = existingStack?.compose_content || null;
        // Map provider to build_location
        const buildLocation = input.provider === 'github-actions' ? 'github-actions'
            : input.provider === 'local-machine' ? 'local-build'
                : 'vps';
        if (!stackId) {
            stackId = (0, crypto_1.randomUUID)();
            db_1.db.prepare(`
        INSERT INTO docker_stacks (
          id, server_id, project_name, source_type, template_id,
          compose_content, dockerfile_content, env_vars, stack_path,
          registry_credential_id, build_on_deploy, pull_policy, status,
          last_deployed_at, last_error, services_count, ci_enabled,
          webhook_secret, webhook_url, current_image_digest, last_webhook_at,
          github_repo, git_account_id, git_branch, build_location, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(stackId, input.serverId, input.projectName, input.sourceType, null, input.composeContent, input.dockerfileContent, input.envVarsJson ?? null, normalizedStackPath, null, 0, 'missing', 'deploying', null, null, 1, input.provider === 'github-actions' ? 1 : 0, null, null, null, null, input.githubRepo || null, input.gitAccountId || null, input.gitBranch || 'main', buildLocation, now, now);
        }
        else {
            db_1.db.prepare(`
        UPDATE docker_stacks
        SET source_type = ?,
            compose_content = ?,
            dockerfile_content = ?,
            env_vars = COALESCE(?, env_vars),
            stack_path = ?,
            build_on_deploy = 0,
            pull_policy = 'missing',
            status = 'deploying',
            last_error = NULL,
            github_repo = ?,
            git_account_id = COALESCE(?, git_account_id),
            git_branch = COALESCE(?, git_branch),
            ci_enabled = ?,
            build_location = ?,
            updated_at = ?
        WHERE id = ?
      `).run(input.sourceType, input.composeContent, input.dockerfileContent || existingStack?.dockerfile_content || null, input.envVarsJson ?? null, normalizedStackPath, input.githubRepo || null, input.gitAccountId ?? null, input.gitBranch ?? null, input.provider === 'github-actions' ? 1 : 0, buildLocation, now, stackId);
        }
        const deploymentId = (0, crypto_1.randomUUID)();
        db_1.db.prepare(`
      INSERT INTO docker_stack_deployments (
        id, stack_id, triggered_by, started_at, finished_at, status,
        pull_output, build_output, up_output, error_message,
        deployed_images, previous_compose_content, build_location, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(deploymentId, stackId, input.triggerType, now, null, 'pending', null, null, null, null, null, previousComposeContent, buildLocation, now);
        return { stackId, deploymentId };
    }
    syncDeploymentStatus(input) {
        const stack = db_1.db.prepare(`
      SELECT id
      FROM docker_stacks
      WHERE server_id = ? AND project_name = ?
      LIMIT 1
    `).get(input.serverId, input.projectName);
        if (!stack)
            return;
        let deployment = db_1.db.prepare(`
      SELECT id, status, finished_at, up_output
      FROM docker_stack_deployments
      WHERE stack_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(stack.id);
        const now = Date.now();
        const stackStatus = input.phase === 'deployed'
            ? 'running'
            : input.phase === 'failed'
                ? 'error'
                : 'deploying';
        db_1.db.prepare(`
      UPDATE docker_stacks
      SET status = ?,
          last_deployed_at = COALESCE(?, last_deployed_at),
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(stackStatus, input.phase === 'deployed' ? now : null, input.phase === 'failed' ? (input.failureMessage || 'Deployment failed') : null, now, stack.id);
        // Detect if the incoming run is different from the stored deployment.
        // up_output stores "Build run: <url>" so we can compare run URLs.
        const isCompletedDeployment = deployment &&
            (deployment.status === 'success' || deployment.status === 'failed');
        const isDifferentRun = isCompletedDeployment && input.runUrl &&
            (!deployment.up_output || !deployment.up_output.includes(input.runUrl));
        // Create deployment record if:
        // 1. No deployment exists (first external trigger)
        // 2. Latest deployment is completed + new in-progress workflow (caught mid-build)
        // 3. Latest deployment is completed + incoming is also completed but different run (already finished)
        const needsNewDeployment = !deployment || (isCompletedDeployment && (
        // In-progress phase for new workflow
        (input.phase !== 'deployed' && input.phase !== 'failed') ||
            // Completed phase but different workflow run
            isDifferentRun));
        if (needsNewDeployment) {
            const deploymentId = (0, crypto_1.randomUUID)();
            console.log(`[ExternalBuildDeploymentService] Creating deployment record for externally triggered workflow (stackId=${stack.id}, phase=${input.phase}, isDifferentRun=${isDifferentRun})`);
            db_1.db.prepare(`
        INSERT INTO docker_stack_deployments (
          id, stack_id, triggered_by, started_at, finished_at, status,
          pull_output, build_output, up_output, error_message,
          deployed_images, previous_compose_content, build_location,
          git_commit_hash, git_commit_title, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(deploymentId, stack.id, 'git_push', // Externally triggered (git push / GitHub UI)
            now, null, 'pending', null, null, null, null, null, null, 'github-actions', input.gitCommitHash || null, input.gitCommitTitle || null, now);
            deployment = { id: deploymentId, status: 'pending', finished_at: null, up_output: null };
        }
        // At this point deployment is guaranteed to exist
        if (!deployment)
            return;
        const runPointer = input.runUrl ? `Build run: ${input.runUrl}` : null;
        if (input.phase === 'deployed') {
            db_1.db.prepare(`
        UPDATE docker_stack_deployments
        SET status = 'success',
            finished_at = COALESCE(finished_at, ?),
            error_message = NULL,
            up_output = COALESCE(up_output, ?),
            logs = COALESCE(?, logs),
            git_commit_hash = COALESCE(git_commit_hash, ?),
            git_commit_title = COALESCE(git_commit_title, ?)
        WHERE id = ?
      `).run(now, runPointer, input.logs || null, input.gitCommitHash || null, input.gitCommitTitle || null, deployment.id);
            return;
        }
        if (input.phase === 'failed') {
            db_1.db.prepare(`
        UPDATE docker_stack_deployments
        SET status = 'failed',
            finished_at = COALESCE(finished_at, ?),
            error_message = ?,
            up_output = COALESCE(up_output, ?),
            logs = COALESCE(?, logs)
        WHERE id = ?
      `).run(now, input.failureMessage || 'Deployment failed', runPointer, input.logs || null, deployment.id);
            return;
        }
        const deploymentStatus = input.phase === 'building'
            ? 'building'
            : input.phase === 'queued'
                ? 'pending'
                : 'starting';
        db_1.db.prepare(`
      UPDATE docker_stack_deployments
      SET status = ?,
          error_message = NULL
      WHERE id = ?
    `).run(deploymentStatus, deployment.id);
    }
}
exports.ExternalBuildDeploymentService = ExternalBuildDeploymentService;
//# sourceMappingURL=ExternalBuildDeploymentService.js.map