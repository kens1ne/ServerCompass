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
exports.redeployZeroDowntime = redeployZeroDowntime;
exports.rollbackZeroDowntime = rollbackZeroDowntime;
exports.updateDeploymentStrategy = updateDeploymentStrategy;
const yaml = __importStar(require("yaml"));
const db_1 = require("../../db");
const DeployQueue_1 = require("../DeployQueue");
const redeploy_1 = require("./redeploy");
const rollback_1 = require("./rollback");
/**
 * Get the primary domain for a stack from the domains table.
 * Prefers domains marked as is_primary, then falls back to the most recently created.
 */
function getPrimaryDomainForStack(stackId) {
    // First try to get the primary domain
    const primaryDomain = db_1.db.prepare(`
    SELECT domain FROM domains
    WHERE stack_id = ? AND is_primary = 1
    LIMIT 1
  `).get(stackId);
    if (primaryDomain) {
        return primaryDomain.domain;
    }
    // Fall back to the first domain for this stack
    const anyDomain = db_1.db.prepare(`
    SELECT domain FROM domains
    WHERE stack_id = ?
    ORDER BY created_at ASC
    LIMIT 1
  `).get(stackId);
    return anyDomain?.domain || null;
}
/**
 * Redeploy with zero-downtime strategy
 */
async function redeployZeroDowntime(ctx, serverId, stackId, options = {}) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack) {
        return { success: false, error: 'Stack not found' };
    }
    if (stack.server_id !== serverId) {
        return { success: false, error: 'Stack does not belong to this server' };
    }
    if (stack.deployment_strategy !== 'zero_downtime') {
        ctx.emitLog('Zero-downtime not enabled for this stack, using standard deployment', 'info', stackId);
        return (0, redeploy_1.redeployStack)(ctx, serverId, stackId, options);
    }
    // Resolve domain from domains table (Phase 6: ZDT domain resolution fix)
    const domain = getPrimaryDomainForStack(stackId) || stack.domain;
    if (!domain) {
        ctx.emitLog('No domain configured - falling back to standard deployment', 'info', stackId);
        return (0, redeploy_1.redeployStack)(ctx, serverId, stackId, options);
    }
    if (options.updateEnvOnly && stack.env_vars) {
        try {
            const currentEnvVars = JSON.parse(stack.env_vars);
            const hasDbPasswordChange = hasDbCredentialChange(currentEnvVars);
            if (hasDbPasswordChange) {
                ctx.emitLog('Database credentials detected - using standard deployment', 'info', stackId);
                return (0, redeploy_1.redeployStack)(ctx, serverId, stackId, options);
            }
        }
        catch {
            // Ignore parse errors
        }
    }
    const resourceCheck = await checkResourcesForZeroDowntime(ctx, serverId);
    if (!resourceCheck.canProceed) {
        ctx.emitLog(`${resourceCheck.reason} - falling back to standard deployment`, 'warning', stackId);
        return (0, redeploy_1.redeployStack)(ctx, serverId, stackId, options);
    }
    const composeContent = stack.compose_content;
    if (!composeContent) {
        return { success: false, error: 'No compose content found' };
    }
    const deployParams = deriveDeployParams(stack, composeContent);
    try {
        await ctx.traefikService.ensureFileProviderEnabled(serverId);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        ctx.emitLog(`Failed to enable Traefik file provider: ${errorMsg}`, 'warning', stackId);
        return (0, redeploy_1.redeployStack)(ctx, serverId, stackId, options);
    }
    return (0, DeployQueue_1.getDeployQueue)().queueDeploy(serverId, stackId, async () => {
        return ctx.zeroDowntimeDeployer.deploy({
            serverId,
            stackId,
            composeContent,
            domain,
            appServiceName: deployParams.appServiceName,
            appPort: deployParams.appPort,
            gracePeriod: options.gracePeriod || 30000,
            readinessTimeout: options.readinessTimeout || 60000,
            ssl: true,
        });
    });
}
/**
 * Rollback with zero-downtime strategy
 */
async function rollbackZeroDowntime(ctx, serverId, stackId, targetDeploymentId) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack) {
        return { success: false, error: 'Stack not found' };
    }
    if (stack.deployment_strategy !== 'zero_downtime') {
        return (0, rollback_1.rollbackStack)(ctx, serverId, stackId, targetDeploymentId);
    }
    // Resolve domain from domains table (Phase 6: ZDT domain resolution fix)
    const domain = getPrimaryDomainForStack(stackId) || stack.domain;
    if (!domain) {
        return (0, rollback_1.rollbackStack)(ctx, serverId, stackId, targetDeploymentId);
    }
    const targetDeployment = db_1.db.prepare(`
      SELECT * FROM docker_stack_deployments
      WHERE id = ? AND stack_id = ? AND status = 'success'
    `).get(targetDeploymentId, stackId);
    if (!targetDeployment) {
        return { success: false, error: 'Target deployment not found or was not successful' };
    }
    const targetCompose = targetDeployment.compose_content || targetDeployment.previous_compose_content;
    if (!targetCompose) {
        return { success: false, error: 'Target deployment has no compose content for rollback' };
    }
    const deployParams = deriveDeployParams(stack, targetCompose);
    return (0, DeployQueue_1.getDeployQueue)().queueDeploy(serverId, stackId, async () => {
        return ctx.zeroDowntimeDeployer.deploy({
            serverId,
            stackId,
            composeContent: targetCompose,
            domain,
            appServiceName: deployParams.appServiceName,
            appPort: deployParams.appPort,
            isRollback: true,
            targetDeploymentId,
            ssl: true,
        });
    });
}
/**
 * Update deployment strategy for a stack
 */
async function updateDeploymentStrategy(ctx, serverId, stackId, strategy) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    db_1.db.prepare(`
      UPDATE docker_stacks SET deployment_strategy = ?, updated_at = ? WHERE id = ?
    `).run(strategy, Date.now(), stackId);
    ctx.emitLog(`Deployment strategy updated to: ${strategy}`, 'info', stackId);
}
async function checkResourcesForZeroDowntime(ctx, serverId) {
    try {
        const memResult = await ctx.sshService.executeCommand(serverId, "free | awk '/Mem:/ {printf \"%.0f\", $4/$2 * 100}'");
        const memFreePercent = parseInt(memResult.stdout.trim()) || 0;
        const diskResult = await ctx.sshService.executeCommand(serverId, "df / | awk 'NR==2 {print 100-$5}' | tr -d '%'");
        const diskFreePercent = parseInt(diskResult.stdout.trim()) || 0;
        if (memFreePercent < 25) {
            return { canProceed: false, reason: 'Insufficient memory (<25% free)' };
        }
        if (diskFreePercent < 10) {
            return { canProceed: false, reason: 'Insufficient disk space (<10% free)' };
        }
        return { canProceed: true };
    }
    catch (error) {
        console.warn('Resource check failed, proceeding anyway:', error);
        return { canProceed: true };
    }
}
function deriveDeployParams(stack, composeContent) {
    try {
        const parsed = yaml.parse(composeContent);
        if (!parsed.services) {
            return { appServiceName: 'app', appPort: stack.app_port || 3000 };
        }
        let appServiceName = null;
        let appPort = stack.app_port || 3000;
        for (const [serviceName, service] of Object.entries(parsed.services)) {
            if (service.volumes && service.volumes.length > 0) {
                continue;
            }
            if (service.ports && service.ports.length > 0) {
                appServiceName = serviceName;
                const portStr = service.ports[0];
                const portMatch = portStr.match(/:(\\d+)$/) || portStr.match(/^(\\d+)$/);
                if (portMatch) {
                    appPort = parseInt(portMatch[1], 10);
                }
                break;
            }
            if (service.labels) {
                const labels = Array.isArray(service.labels)
                    ? service.labels
                    : Object.entries(service.labels).map(([k, v]) => `${k}=${v}`);
                for (const label of labels) {
                    const portMatch = label.match(/loadbalancer\\.server\\.port=(\\d+)/);
                    if (portMatch) {
                        appServiceName = serviceName;
                        appPort = parseInt(portMatch[1], 10);
                        break;
                    }
                }
                if (appServiceName)
                    break;
            }
        }
        if (!appServiceName) {
            appServiceName = Object.keys(parsed.services)[0] || 'app';
        }
        return { appServiceName, appPort };
    }
    catch {
        return { appServiceName: 'app', appPort: stack.app_port || 3000 };
    }
}
function hasDbCredentialChange(envVars) {
    const dbPasswordVars = [
        'MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD',
        'POSTGRES_PASSWORD', 'PGPASSWORD',
        'REDIS_PASSWORD', 'MONGO_INITDB_ROOT_PASSWORD',
    ];
    return Object.keys(envVars).some(key => dbPasswordVars.includes(key));
}
//# sourceMappingURL=zeroDowntime.js.map