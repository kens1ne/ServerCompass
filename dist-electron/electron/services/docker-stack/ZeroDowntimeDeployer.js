"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZeroDowntimeDeployer = void 0;
exports.createZeroDowntimeDeployer = createZeroDowntimeDeployer;
const crypto_1 = require("crypto");
const events_1 = require("events");
const yaml = __importStar(require("yaml"));
const db_1 = require("../../db");
/**
 * ZeroDowntimeDeployer - Handles zero-downtime deployments
 *
 * Lifecycle:
 * 1. Build staging containers while primary serves traffic
 * 2. Start staging containers
 * 3. Verify staging is ready (TCP probe)
 * 4. Switch Traefik routing to staging (~100ms)
 * 5. Post-switch verification (30s grace period with probes)
 * 6. Stop primary containers
 * 7. Promote staging to primary
 */
class ZeroDowntimeDeployer extends events_1.EventEmitter {
    sshService;
    traefikRouter;
    mainWindow = null;
    constructor(sshService, traefikRouter) {
        super();
        this.sshService = sshService;
        this.traefikRouter = traefikRouter;
    }
    setMainWindow(window) {
        this.mainWindow = window;
    }
    /**
     * Emit a log message
     */
    emitLog(message, type = 'info', stackId, deploymentId) {
        const logEntry = {
            timestamp: Date.now(),
            message,
            type,
            stackId,
            deploymentId,
        };
        this.emit('log', logEntry);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('docker:stack:log', logEntry);
        }
    }
    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Wait for container to be ready (running + TCP port accepting connections)
     */
    async waitForContainerReady(serverId, containerName, port, timeoutMs = 60000) {
        const startTime = Date.now();
        const retryInterval = 2000; // 2 seconds between checks
        while (Date.now() - startTime < timeoutMs) {
            // 1. Check container is running (not exited/restarting)
            const stateResult = await this.sshService.executeCommand(serverId, `docker inspect ${containerName} --format='{{.State.Status}} {{.State.Running}}' 2>/dev/null || echo "notfound false"`);
            const [status, running] = stateResult.stdout.trim().split(' ');
            if (status === 'notfound') {
                await this.sleep(retryInterval);
                continue;
            }
            if (status === 'exited' || status === 'dead') {
                // Container crashed - get logs for error message
                const logs = await this.sshService.executeCommand(serverId, `docker logs ${containerName} --tail 20 2>&1`);
                return { ready: false, reason: `Container exited: ${logs.stdout}` };
            }
            if (status !== 'running' || running !== 'true') {
                await this.sleep(retryInterval);
                continue;
            }
            // 2. TCP port probe - verify port is accepting connections
            // Try netcat first, fall back to /proc/net/tcp check
            const portCheck = await this.sshService.executeCommand(serverId, `docker exec ${containerName} sh -c 'nc -z localhost ${port} 2>/dev/null && echo "open" || echo "closed"' 2>/dev/null || echo "closed"`);
            if (portCheck.stdout.trim() === 'open') {
                return { ready: true };
            }
            // Fallback: Check if process is listening via /proc/net/tcp
            const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
            const procCheck = await this.sshService.executeCommand(serverId, `docker exec ${containerName} sh -c 'cat /proc/net/tcp 2>/dev/null | grep -i ":${hexPort}" | grep -q "0A" && echo "open" || echo "closed"' 2>/dev/null || echo "closed"`);
            if (procCheck.stdout.trim() === 'open') {
                return { ready: true };
            }
            // Port not ready yet, wait and retry
            await this.sleep(retryInterval);
        }
        return { ready: false, reason: `Timeout: port ${port} not accepting connections after ${timeoutMs}ms` };
    }
    /**
     * TCP probe for post-switch verification
     */
    async tcpProbe(serverId, containerName, port) {
        // Check container is still running
        const stateResult = await this.sshService.executeCommand(serverId, `docker inspect ${containerName} --format='{{.State.Status}}' 2>/dev/null || echo "notfound"`);
        if (stateResult.stdout.trim() !== 'running') {
            return { success: false, reason: `Container not running: ${stateResult.stdout}` };
        }
        // TCP port probe
        const portCheck = await this.sshService.executeCommand(serverId, `docker exec ${containerName} sh -c 'nc -z localhost ${port} 2>/dev/null && echo "open" || echo "closed"' 2>/dev/null || echo "closed"`);
        if (portCheck.stdout.trim() === 'open') {
            return { success: true };
        }
        return { success: false, reason: 'Port not accepting connections' };
    }
    /**
     * Post-switch verification with probes during grace period
     */
    async postSwitchVerification(serverId, stagingContainer, stagingProjectName, primaryContainer, port, domain, gracePeriodMs = 30000, ssl = true, stackId, deploymentId) {
        const probeInterval = 5000; // 5 seconds
        const probeCount = Math.floor(gracePeriodMs / probeInterval);
        let consecutiveFailures = 0;
        const maxConsecutiveFailures = 2; // Rollback after 2 consecutive failures
        const log = (message, type = 'info') => {
            this.emitLog(message, type, stackId, deploymentId);
        };
        for (let i = 0; i < probeCount; i++) {
            await this.sleep(probeInterval);
            // TCP probe on staging container
            const probeResult = await this.tcpProbe(serverId, stagingContainer, port);
            if (probeResult.success) {
                consecutiveFailures = 0;
                log(`Post-switch probe ${i + 1}/${probeCount}: OK`);
            }
            else {
                consecutiveFailures++;
                log(`Post-switch probe ${i + 1}/${probeCount}: FAILED - ${probeResult.reason}`, 'warning');
                if (consecutiveFailures >= maxConsecutiveFailures) {
                    // AUTO-ROLLBACK: Switch traffic back to primary
                    log('Auto-rollback triggered: staging unhealthy after traffic switch', 'error');
                    await this.traefikRouter.switchTraffic(serverId, domain, primaryContainer, port, ssl);
                    // Clean up staging containers and directory
                    await this.cleanupStaging(serverId, stagingProjectName);
                    return {
                        success: false,
                        rolledBack: true,
                        reason: `Staging became unhealthy after traffic switch: ${probeResult.reason}`,
                    };
                }
            }
        }
        // All probes passed - safe to stop primary
        log('Post-switch verification passed');
        return { success: true, rolledBack: false };
    }
    /**
     * Generate staging compose content from primary compose
     * Only includes app services, not databases
     */
    generateStagingCompose(primaryCompose, primaryProjectName) {
        const staging = {
            services: {},
            networks: {
                'traefik-public': { external: true },
            },
        };
        // Only include app services, not databases
        for (const [serviceName, service] of Object.entries(primaryCompose.services)) {
            if (this.isStatefulService(service)) {
                continue; // Skip DB services
            }
            // Clone service config
            const stagingService = {
                ...service,
                networks: ['traefik-public'],
            };
            // Remove Traefik labels from staging (we use file provider)
            if (stagingService.labels) {
                if (Array.isArray(stagingService.labels)) {
                    stagingService.labels = stagingService.labels.filter((l) => !l.includes('traefik'));
                }
                else {
                    stagingService.labels = Object.fromEntries(Object.entries(stagingService.labels).filter(([k]) => !k.includes('traefik')));
                }
            }
            // If primary has internal network, add it as external reference for DB access
            const originalNetworks = service.networks;
            if (originalNetworks) {
                const networksList = Array.isArray(originalNetworks) ? originalNetworks : Object.keys(originalNetworks);
                if (networksList.some(n => typeof n === 'string' && (n.includes('internal') || n === 'default'))) {
                    staging.networks['primary-internal'] = {
                        external: true,
                        name: `${primaryProjectName}_default`,
                    };
                    if (!stagingService.networks) {
                        stagingService.networks = [];
                    }
                    if (Array.isArray(stagingService.networks)) {
                        stagingService.networks.push('primary-internal');
                    }
                }
            }
            staging.services[serviceName] = stagingService;
        }
        return yaml.stringify(staging);
    }
    /**
     * Check if a service is stateful (has volumes)
     */
    isStatefulService(service) {
        // Service is stateful if it has volumes
        return service.volumes !== undefined && service.volumes.length > 0;
    }
    /**
     * Prepare staging directory
     */
    async prepareStagingDirectory(serverId, stagingProjectName) {
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        await this.sshService.executeCommand(serverId, `mkdir -p "${stagingDir}"`);
    }
    /**
     * Write staging compose file
     */
    async writeStagingCompose(serverId, stagingProjectName, composeContent) {
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        await this.sshService.executeCommand(serverId, `cat > "${stagingDir}/docker-compose.yml" << 'COMPOSEEOF'
${composeContent}
COMPOSEEOF`);
    }
    /**
     * Build staging containers
     */
    async buildStagingContainers(serverId, stagingProjectName, stackId, deploymentId) {
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        const log = (message, type = 'info') => {
            this.emitLog(message, type, stackId, deploymentId);
        };
        log('Building staging containers...');
        const result = await this.sshService.executeCommand(serverId, `cd "${stagingDir}" && docker compose -p ${stagingProjectName} build --no-cache 2>&1`);
        if (result.exitCode !== 0) {
            throw new Error(`Build failed: ${result.stderr || result.stdout}`);
        }
        log('Staging build completed');
    }
    /**
     * Start staging containers
     */
    async startStagingContainers(serverId, stagingProjectName, stackId, deploymentId) {
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        const log = (message, type = 'info') => {
            this.emitLog(message, type, stackId, deploymentId);
        };
        log('Starting staging containers...');
        const result = await this.sshService.executeCommand(serverId, `cd "${stagingDir}" && docker compose -p ${stagingProjectName} up -d 2>&1`);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to start staging: ${result.stderr || result.stdout}`);
        }
        log('Staging containers started');
    }
    /**
     * Stop old primary containers
     */
    async stopOldContainers(serverId, projectName, stackId, deploymentId) {
        const workingDir = `/root/server-compass/apps/${projectName}`;
        const log = (message, type = 'info') => {
            this.emitLog(message, type, stackId, deploymentId);
        };
        log('Stopping primary containers...');
        await this.sshService.executeCommand(serverId, `cd "${workingDir}" && docker compose -p ${projectName} down 2>&1 || true`);
        log('Primary containers stopped');
    }
    /**
     * Promote staging to primary (rename directory and containers)
     */
    async promoteStagingToPrimary(serverId, stagingProjectName, primaryProjectName, stackId, deploymentId) {
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        const primaryDir = `/root/server-compass/apps/${primaryProjectName}`;
        const log = (message, type = 'info') => {
            this.emitLog(message, type, stackId, deploymentId);
        };
        log('Promoting staging to primary...');
        // Stop staging containers (we'll restart with primary name)
        await this.sshService.executeCommand(serverId, `cd "${stagingDir}" && docker compose -p ${stagingProjectName} down 2>&1 || true`);
        // Remove old primary directory (already stopped)
        await this.sshService.executeCommand(serverId, `rm -rf "${primaryDir}"`);
        // Rename staging to primary
        await this.sshService.executeCommand(serverId, `mv "${stagingDir}" "${primaryDir}"`);
        // Start with primary project name
        const result = await this.sshService.executeCommand(serverId, `cd "${primaryDir}" && docker compose -p ${primaryProjectName} up -d 2>&1`);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to start promoted containers: ${result.stderr || result.stdout}`);
        }
        log('Staging promoted to primary');
    }
    /**
     * Clean up staging containers and directory
     */
    async cleanupStaging(serverId, stagingProjectName) {
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        // Stop and remove staging containers
        await this.sshService.executeCommand(serverId, `cd "${stagingDir}" && docker compose -p ${stagingProjectName} down --remove-orphans 2>/dev/null || true`);
        // Remove staging directory
        await this.sshService.executeCommand(serverId, `rm -rf "${stagingDir}"`);
    }
    /**
     * Clean up orphaned staging from previous failed deployment
     */
    async cleanupOrphanedStaging(serverId, projectName, domain) {
        const stagingProjectName = `${projectName}-staging`;
        const stagingDir = `/root/server-compass/apps/${stagingProjectName}`;
        // Check if orphaned staging exists
        const exists = await this.sshService.executeCommand(serverId, `test -d "${stagingDir}" && echo "exists" || echo "none"`);
        if (exists.stdout.trim() === 'exists') {
            // Stop and remove staging containers
            await this.sshService.executeCommand(serverId, `cd "${stagingDir}" && docker compose -p ${stagingProjectName} down --remove-orphans 2>/dev/null || true`);
            // Remove staging directory
            await this.sshService.executeCommand(serverId, `rm -rf "${stagingDir}"`);
            // Remove stale Traefik dynamic config if domain exists
            if (domain) {
                await this.traefikRouter.removeDynamicConfig(serverId, domain);
            }
        }
    }
    /**
     * Main deployment method
     */
    async deploy(options) {
        const { serverId, stackId, composeContent, domain, appServiceName, appPort, gracePeriod = 30000, readinessTimeout = 60000, isRollback = false, targetDeploymentId: _targetDeploymentId, ssl = true, } = options;
        const stack = db_1.queries.getDockerStack(stackId);
        if (!stack) {
            return { success: false, error: 'Stack not found' };
        }
        const projectName = stack.project_name;
        const deploymentId = `deploy-${(0, crypto_1.randomUUID)()}`;
        const now = Date.now();
        // Derive container names from project name and service name
        const primaryContainer = `${projectName}-${appServiceName}-1`;
        const stagingProjectName = `${projectName}-staging`;
        const stagingContainer = `${stagingProjectName}-${appServiceName}-1`;
        // Parse compose for staging generation
        const primaryCompose = yaml.parse(composeContent);
        const log = (message, type = 'info') => {
            this.emitLog(message, type, stackId, deploymentId);
        };
        // Create deployment record
        const triggerType = isRollback ? 'rollback' : 'redeploy';
        this.createDeploymentRecord(deploymentId, stackId, triggerType, now);
        // Store both compose contents
        db_1.db.prepare(`
      UPDATE docker_stack_deployments
      SET previous_compose_content = ?,
          compose_content = ?
      WHERE id = ?
    `).run(stack.compose_content, composeContent, deploymentId);
        // If GitHub source, store git commit hash
        const stackWithGit = stack;
        if (stack.source_type === 'github' && stackWithGit.git_last_commit) {
            db_1.db.prepare(`
        UPDATE docker_stack_deployments
        SET git_commit_hash = ?, git_commit_title = ?
        WHERE id = ?
      `).run(stackWithGit.git_last_commit, stackWithGit.git_commit_title || null, deploymentId);
        }
        try {
            // Update stack status to deploying
            db_1.queries.updateDockerStack(stackId, { status: 'deploying' });
            this.updateDeploymentStatus(deploymentId, 'pulling');
            log(`Starting zero-downtime deployment for ${projectName}`);
            log(`Primary still serving traffic at ${domain}`);
            // Step 1: Cleanup any orphaned staging from previous failed deploy
            log('Cleaning up any orphaned staging...');
            await this.cleanupOrphanedStaging(serverId, projectName, domain);
            // Step 2: Prepare staging environment
            log('Preparing staging environment...');
            await this.prepareStagingDirectory(serverId, stagingProjectName);
            const stagingComposeContent = this.generateStagingCompose(primaryCompose, projectName);
            await this.writeStagingCompose(serverId, stagingProjectName, stagingComposeContent);
            // Step 3: Build staging containers (OLD VERSION STILL SERVING)
            this.updateDeploymentStatus(deploymentId, 'building');
            await this.buildStagingContainers(serverId, stagingProjectName, stackId, deploymentId);
            // Step 4: Start staging containers
            this.updateDeploymentStatus(deploymentId, 'starting');
            await this.startStagingContainers(serverId, stagingProjectName, stackId, deploymentId);
            // Step 5: Pre-switch readiness check (TCP port probe with timeout)
            log(`Verifying staging container is ready (port ${appPort})...`);
            const readiness = await this.waitForContainerReady(serverId, stagingContainer, appPort, readinessTimeout);
            if (!readiness.ready) {
                await this.cleanupStaging(serverId, stagingProjectName);
                throw new Error(`Container not ready: ${readiness.reason}`);
            }
            log('Staging container is ready');
            // Step 6: Switch Traefik to staging (~100ms)
            log('Switching traffic to staging...');
            await this.traefikRouter.switchTraffic(serverId, domain, stagingContainer, appPort, ssl);
            log('Traffic switched to staging', 'success');
            // Record traffic switch time
            db_1.db.prepare(`
        UPDATE docker_stack_deployments SET traffic_switched_at = ? WHERE id = ?
      `).run(Date.now(), deploymentId);
            // Step 7: Post-switch verification (PRIMARY STILL RUNNING AS SAFETY NET)
            log(`Starting ${gracePeriod / 1000}s verification period...`);
            const verification = await this.postSwitchVerification(serverId, stagingContainer, stagingProjectName, primaryContainer, appPort, domain, gracePeriod, ssl, stackId, deploymentId);
            if (verification.rolledBack) {
                // Auto-rollback happened - traffic back on primary
                this.updateStackWithFallback(stackId, verification.reason || 'Auto-rollback triggered', stack.compose_content);
                throw new Error(verification.reason);
            }
            // Step 8: Verification passed - NOW safe to stop primary
            await this.stopOldContainers(serverId, projectName, stackId, deploymentId);
            // Step 9: Promote staging to primary
            await this.promoteStagingToPrimary(serverId, stagingProjectName, projectName, stackId, deploymentId);
            // Step 10: Update Traefik to point to final container names
            const finalContainer = `${projectName}-${appServiceName}-1`;
            await this.traefikRouter.switchTraffic(serverId, domain, finalContainer, appPort, ssl);
            // SUCCESS: UPDATE DEPLOYMENT RECORDS
            this.updateDeploymentStatus(deploymentId, 'success');
            this.updateDeploymentFinished(deploymentId, Date.now());
            // Update stack with new compose content
            db_1.db.prepare(`
        UPDATE docker_stacks
        SET compose_content = ?,
            status = 'running',
            last_deployed_at = ?,
            has_pending_failure = 0,
            failed_compose_content = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(composeContent, Date.now(), Date.now(), stackId);
            // CRITICAL: Only update last_successful_deployment_id AFTER verification passes
            db_1.db.prepare(`
        UPDATE docker_stacks SET last_successful_deployment_id = ? WHERE id = ?
      `).run(deploymentId, stackId);
            log('Zero-downtime deployment completed successfully!', 'success');
            return { success: true, stackId, deploymentId, projectName };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.updateDeploymentStatus(deploymentId, 'failed');
            this.updateDeploymentError(deploymentId, errorMessage);
            this.updateDeploymentFinished(deploymentId, Date.now());
            // Cleanup staging on any failure
            await this.cleanupStaging(serverId, stagingProjectName).catch(() => { });
            // Use existing fallback - old version still running
            this.updateStackWithFallback(stackId, errorMessage, stack.compose_content);
            log(`Zero-downtime deployment failed: ${errorMessage}`, 'error');
            log('Primary version is still running - no downtime occurred', 'info');
            return { success: false, error: errorMessage };
        }
    }
    /**
     * Create deployment record in database
     */
    createDeploymentRecord(deploymentId, stackId, triggerType, now) {
        db_1.db.prepare(`
      INSERT INTO docker_stack_deployments (id, stack_id, trigger_type, status, started_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(deploymentId, stackId, triggerType, now, now, now);
    }
    /**
     * Update deployment status
     */
    updateDeploymentStatus(deploymentId, status) {
        db_1.db.prepare(`
      UPDATE docker_stack_deployments SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, Date.now(), deploymentId);
    }
    /**
     * Update deployment finished time
     */
    updateDeploymentFinished(deploymentId, finishedAt) {
        db_1.db.prepare(`
      UPDATE docker_stack_deployments SET finished_at = ?, updated_at = ? WHERE id = ?
    `).run(finishedAt, Date.now(), deploymentId);
    }
    /**
     * Update deployment error
     */
    updateDeploymentError(deploymentId, error) {
        db_1.db.prepare(`
      UPDATE docker_stack_deployments SET error = ?, updated_at = ? WHERE id = ?
    `).run(error, Date.now(), deploymentId);
    }
    /**
     * Update stack with fallback state (deployment failed, old version still running)
     */
    updateStackWithFallback(stackId, errorMessage, failedComposeContent) {
        // Get the last successful deployment
        const lastSuccess = db_1.db.prepare(`
      SELECT id FROM docker_stack_deployments
      WHERE stack_id = ? AND status = 'success'
      ORDER BY finished_at DESC
      LIMIT 1
    `).get(stackId);
        db_1.db.prepare(`
      UPDATE docker_stacks
      SET status = 'running',
          has_pending_failure = 1,
          last_error = ?,
          failed_compose_content = ?,
          last_successful_deployment_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(errorMessage, failedComposeContent, lastSuccess?.id || null, Date.now(), stackId);
    }
}
exports.ZeroDowntimeDeployer = ZeroDowntimeDeployer;
// Factory function
function createZeroDowntimeDeployer(sshService, traefikRouter) {
    return new ZeroDowntimeDeployer(sshService, traefikRouter);
}
//# sourceMappingURL=ZeroDowntimeDeployer.js.map