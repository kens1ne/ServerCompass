"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rollbackStack = rollbackStack;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const deploymentDb_1 = require("./deploymentDb");
const containers_1 = require("./containers");
const pathUtils_1 = require("./pathUtils");
/**
 * Rollback a stack to a previous successful deployment
 */
async function rollbackStack(ctx, serverId, stackId, targetDeploymentId) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack) {
        return { success: false, error: 'Stack not found' };
    }
    if (stack.server_id !== serverId) {
        return { success: false, error: 'Stack does not belong to this server' };
    }
    if (stack.status === 'deploying') {
        return { success: false, error: 'Stack is already being deployed. Please wait for the current deployment to complete.' };
    }
    const targetDeployment = db_1.db.prepare(`
      SELECT * FROM docker_stack_deployments
      WHERE id = ? AND stack_id = ? AND status = 'success'
    `).get(targetDeploymentId, stackId);
    if (!targetDeployment) {
        return { success: false, error: 'Target deployment not found or was not successful' };
    }
    const stackWithGit = stack;
    const rollbackComposeContent = (0, deploymentDb_1.getComposeContentForDeployment)(targetDeploymentId);
    if (!rollbackComposeContent) {
        return { success: false, error: 'Could not retrieve compose content for rollback' };
    }
    const deploymentId = `deploy-${(0, crypto_1.randomUUID)()}`;
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    const now = Date.now();
    (0, deploymentDb_1.createDeploymentRecord)(deploymentId, stackId, 'rollback', now, undefined, stack.build_location);
    (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pending');
    db_1.db.prepare(`
      UPDATE docker_stack_deployments SET previous_compose_content = ? WHERE id = ?
    `).run(stack.compose_content, deploymentId);
    ctx.initDeploymentLogs(deploymentId);
    const log = (message, type = 'info') => {
        ctx.emitLog(message, type, stackId, deploymentId);
    };
    log(`Rolling back to deployment ${targetDeploymentId.substring(0, 12)}...`);
    try {
        db_1.queries.updateDockerStack(stackId, { status: 'deploying' });
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pulling');
        log('Preparing rollback workspace and deployment files...');
        db_1.db.prepare(`
        UPDATE docker_stacks
        SET compose_content = ?,
            has_pending_failure = 0,
            failed_compose_content = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(rollbackComposeContent, now, stackId);
        let needsRebuild = false;
        if (targetDeployment.git_commit_hash && stackWithGit.git_clone_path && stack.source_type === 'github') {
            log(`Checking out commit ${targetDeployment.git_commit_hash.substring(0, 8)}...`);
            const checkoutResult = await ctx.sshService.executeCommand(serverId, `cd "${stackWithGit.git_clone_path}" && git fetch --all && git checkout ${targetDeployment.git_commit_hash}`);
            if (checkoutResult.exitCode === 0) {
                log(`Restored source files to commit ${targetDeployment.git_commit_hash.substring(0, 8)}`, 'success');
                const targetTitle = targetDeployment.git_commit_title;
                db_1.db.prepare(`
            UPDATE docker_stack_deployments SET git_commit_hash = ?, git_commit_title = ? WHERE id = ?
          `).run(targetDeployment.git_commit_hash, targetTitle || null, deploymentId);
                db_1.db.prepare(`
            UPDATE docker_stacks SET git_last_commit = ? WHERE id = ?
          `).run(targetDeployment.git_commit_hash, stackId);
                const hasBuildContext = await ctx.sshService.executeCommand(serverId, `grep -E "^\\s*build:" "${workingDir}/docker-compose.yml"`);
                needsRebuild = hasBuildContext.exitCode === 0;
            }
            else {
                log(`Warning: Could not checkout commit ${targetDeployment.git_commit_hash.substring(0, 8)}: ${checkoutResult.stderr || checkoutResult.stdout}`, 'warning');
                log('Proceeding with compose-only rollback...', 'warning');
            }
        }
        log('Stopping current containers...');
        await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && docker compose down 2>&1 || true`);
        log('Applying rollback compose file...');
        await ctx.sshService.executeCommand(serverId, `cat > "${workingDir}/docker-compose.yml" << 'COMPOSE_EOF'\n${rollbackComposeContent}\nCOMPOSE_EOF`);
        if (needsRebuild) {
            log('Rebuilding containers with restored source files...');
            (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'building');
            const buildResult = await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && docker compose build --no-cache 2>&1`);
            if (buildResult.exitCode !== 0) {
                throw new Error(`Failed to rebuild containers: ${buildResult.stderr || buildResult.stdout}`);
            }
            log('Rebuild completed successfully', 'success');
        }
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'starting');
        log('Starting containers with rollback configuration...');
        const upResult = await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && docker compose up -d 2>&1`);
        if (upResult.exitCode !== 0) {
            throw new Error(`Failed to start containers: ${upResult.stderr || upResult.stdout}`);
        }
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'success');
        (0, deploymentDb_1.updateDeploymentFinished)(deploymentId, Date.now());
        db_1.queries.updateDockerStack(stackId, {
            status: 'running',
            last_deployed_at: Date.now(),
        });
        db_1.db.prepare(`
        UPDATE docker_stacks SET last_successful_deployment_id = ? WHERE id = ?
      `).run(deploymentId, stackId);
        const containers = await (0, containers_1.getContainerInfo)(ctx, serverId, stack.project_name);
        log('Rollback completed successfully!', 'success');
        return {
            success: true,
            stackId,
            deploymentId,
            projectName: stack.project_name,
            containers,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Rollback failed: ${errorMessage}`, 'error');
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'failed');
        (0, deploymentDb_1.updateDeploymentError)(deploymentId, errorMessage);
        (0, deploymentDb_1.updateDeploymentFinished)(deploymentId, Date.now());
        db_1.queries.updateDockerStack(stackId, {
            status: 'error',
            last_error: errorMessage,
        });
        return {
            success: false,
            error: errorMessage,
        };
    }
    finally {
        ctx.saveDeploymentLogs(deploymentId);
    }
}
//# sourceMappingURL=rollback.js.map