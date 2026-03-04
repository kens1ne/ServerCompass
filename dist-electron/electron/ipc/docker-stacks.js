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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSupabaseJWT = generateSupabaseJWT;
exports.registerDockerStackHandlers = registerDockerStackHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const SSHService_1 = require("../services/SSHService");
const CredentialVault_1 = require("../services/CredentialVault");
const DockerStackService_1 = require("../services/DockerStackService");
const RegistryService_1 = require("../services/RegistryService");
const ComposeService_1 = require("../services/ComposeService");
const UnmanagedAppDetectionService_1 = require("../services/UnmanagedAppDetectionService");
const docker_templates_1 = require("../docker-templates");
const db_1 = require("../db");
const GitAccountService_1 = require("../services/GitAccountService");
const supabase_1 = require("../services/docker-stack/supabase");
const pathUtils_1 = require("../services/docker-stack/pathUtils");
const EnvironmentService_1 = require("../services/docker-stack/EnvironmentService");
const TraefikDynamicRouter_1 = require("../services/TraefikDynamicRouter");
const TraefikService_1 = require("../services/TraefikService");
const crypto_1 = __importDefault(require("crypto"));
// Service instances
let sshService;
/**
 * Emit analysis log to frontend via IPC for real-time progress display.
 * Called during GitHub repo analysis to show user-friendly status updates.
 * Frontend listens via api.dockerStacks.onAnalysisLog() in GitHubSelector.tsx
 */
function emitAnalysisLog(message, type = 'info') {
    const targetWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0];
    if (targetWindow?.webContents && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send('docker:analysis:log', {
            message,
            type,
            timestamp: Date.now(),
        });
    }
}
let credentialVault;
/**
 * Generate a secure random string for secrets.
 *
 * IMPORTANT:
 * - Use URL-safe secrets by default (alphanumeric) because many templates embed
 *   secrets inside connection strings (postgres://user:pass@host/db) and a
 *   number of upstream apps do not percent-encode correctly.
 * - Use hex for keys that explicitly expect hex (OPENSSL_KEY, ENCRYPTION_KEY).
 *
 * 24 alphanumeric chars ≈ 143 bits of entropy, which is plenty for passwords.
 */
function generateSecret(length = 24) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const values = crypto_1.default.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        result += charset[values[i] % charset.length];
    }
    return result;
}
function generateSecretWithSymbol(length = 24) {
    // Avoid characters that trigger docker-compose interpolation ($) or common YAML pitfalls (spaces/quotes).
    const alphaNum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const symbols = '!@#%^&*_-+=';
    const all = `${alphaNum}${symbols}`;
    const safeLength = Math.max(length, 4);
    const values = crypto_1.default.randomBytes(safeLength);
    const chars = [];
    chars.push(symbols[values[0] % symbols.length]);
    for (let i = 1; i < safeLength; i++) {
        chars.push(all[values[i] % all.length]);
    }
    // Shuffle (Fisher–Yates)
    for (let i = chars.length - 1; i > 0; i--) {
        const j = values[i] % (i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}
function generateHexSecret(bytes = 16) {
    return crypto_1.default.randomBytes(bytes).toString('hex');
}
function generateBase64AppKey(bytes = 32) {
    // Laravel expects APP_KEY in format: base64:<base64-encoded-bytes>
    return `base64:${crypto_1.default.randomBytes(bytes).toString('base64')}`;
}
function generateSecretForHint(hint, templateId) {
    const upper = hint.key.toUpperCase();
    const desc = (hint.description || '').toLowerCase();
    if (upper === 'APP_KEY' || desc.includes('base64')) {
        return generateBase64AppKey();
    }
    const lengthMatch = desc.match(/\b(\d{2,3})\b/);
    const hintedLength = lengthMatch ? Number(lengthMatch[1]) : null;
    const length = hintedLength && hintedLength >= 16 && hintedLength <= 128 ? hintedLength : 24;
    const wantsHex = upper.includes('ENCRYPTION_KEY') || upper.includes('OPENSSL_KEY') || desc.includes('hex');
    if (wantsHex) {
        const wants64Hex = desc.includes('64') && desc.includes('hex');
        return generateHexSecret(wants64Hex ? 32 : 16);
    }
    if (templateId === 'builtin-supabase-full' && upper === 'JWT_SECRET') {
        return generateSecret(64);
    }
    const wantsSymbol = (templateId === 'builtin-zitadel' && upper === 'ADMIN_PASSWORD') ||
        desc.includes('symbol') ||
        desc.includes('special character') ||
        desc.includes('special chars') ||
        desc.includes('special characters') ||
        desc.includes('complex password');
    return wantsSymbol ? generateSecretWithSymbol(length) : generateSecret(length);
}
/**
 * Generate a Supabase JWT token for API authentication
 * Uses HS256 algorithm with the provided secret
 *
 * @param secret - The JWT secret (min 32 chars)
 * @param role - The role to embed in the token ('anon' or 'service_role')
 * @returns Base64url encoded JWT string
 */
function generateSupabaseJWT(secret, role) {
    // Header: HS256 algorithm
    const header = {
        alg: 'HS256',
        typ: 'JWT',
    };
    // Payload: Supabase standard claims
    const now = Math.floor(Date.now() / 1000);
    const tenYearsInSeconds = 10 * 365 * 24 * 60 * 60;
    const payload = {
        role,
        iss: 'supabase',
        iat: now,
        exp: now + tenYearsInSeconds,
    };
    // Base64url encode header and payload
    const base64UrlEncode = (obj) => {
        const json = JSON.stringify(obj);
        const base64 = Buffer.from(json).toString('base64');
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const encodedHeader = base64UrlEncode(header);
    const encodedPayload = base64UrlEncode(payload);
    const signatureInput = `${encodedHeader}.${encodedPayload}`;
    // Create HMAC-SHA256 signature
    const signature = crypto_1.default
        .createHmac('sha256', secret)
        .update(signatureInput)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `${signatureInput}.${signature}`;
}
let dockerStackService;
let registryService;
/**
 * Lightweight heuristic detection based on the generated Dockerfile content.
 * This is intentionally simple and only needs to provide a framework label for the UI.
 */
function detectFrameworkFromDockerfile(dockerfile) {
    const content = dockerfile.toLowerCase();
    if (content.includes('hugo'))
        return 'static';
    if ((content.includes('nginx') && !content.includes('node')) || content.includes('/usr/share/nginx/html')) {
        return 'static';
    }
    if (content.includes('django'))
        return 'django';
    if (content.includes('flask'))
        return 'flask';
    if (content.includes('fastapi'))
        return 'fastapi';
    if (content.includes('rails'))
        return 'rails';
    if (content.includes('laravel') || content.includes('composer'))
        return 'laravel';
    if (content.includes('php'))
        return 'php';
    if (content.includes('golang') || content.includes(' go ') || content.includes('go build'))
        return 'go';
    if (content.includes('next'))
        return 'nextjs';
    if (content.includes('nestjs'))
        return 'nestjs';
    if (content.includes('express'))
        return 'express';
    if (content.includes('node') || content.includes('npm') || content.includes('yarn'))
        return 'node';
    if (content.includes('python') || content.includes('pip'))
        return 'python';
    return undefined;
}
function registerDockerStackHandlers() {
    // Initialize services
    sshService = new SSHService_1.SSHService();
    credentialVault = new CredentialVault_1.CredentialVault();
    dockerStackService = (0, DockerStackService_1.createDockerStackService)(sshService, credentialVault);
    registryService = (0, RegistryService_1.createRegistryService)(credentialVault, sshService);
    // Initialize built-in templates
    try {
        (0, docker_templates_1.initializeBuiltinTemplates)();
    }
    catch (error) {
        console.error('Failed to initialize built-in templates:', error);
    }
    // Set main window for log emissions
    const windows = electron_1.BrowserWindow.getAllWindows();
    const mainWindow = windows.length > 0 ? windows[0] : null;
    if (mainWindow) {
        dockerStackService.setMainWindow(mainWindow);
    }
    // ============ Stack Operations ============
    // Deploy a new stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_DEPLOY, async (_event, input) => {
        try {
            const validated = types_1.DockerStackDeploySchema.parse(input);
            console.log(`[Deploy] Starting deployment:`);
            console.log(`[Deploy] - Project: ${validated.projectName}`);
            console.log(`[Deploy] - Source Type: ${validated.sourceType}`);
            console.log(`[Deploy] - Template ID: ${validated.templateId || 'none'}`);
            console.log(`[Deploy] - Compose Content length: ${validated.composeContent?.length || 0}`);
            console.log(`[Deploy] - Dockerfile Content length: ${validated.dockerfileContent?.length || 0}`);
            if (validated.composeContent) {
                console.log(`[Deploy] - Compose preview (first 300 chars):`, validated.composeContent.substring(0, 300));
            }
            if (validated.dockerfileContent) {
                console.log(`[Deploy] - Dockerfile preview (first 300 chars):`, validated.dockerfileContent.substring(0, 300));
            }
            const result = await dockerStackService.deploy({
                serverId: validated.serverId,
                projectName: validated.projectName,
                sourceType: validated.sourceType,
                templateId: validated.templateId,
                composeContent: validated.composeContent || '', // Optional for GitHub source
                dockerfileContent: validated.dockerfileContent,
                dockerfileOverridePath: validated.dockerfileOverridePath,
                envVars: validated.envVars,
                stackPath: validated.stackPath,
                registryCredentialId: validated.registryCredentialId,
                buildOnDeploy: validated.buildOnDeploy,
                notifyOnCompletion: validated.notifyOnCompletion,
                pullPolicy: validated.pullPolicy,
                // GitHub fields
                gitAccountId: validated.gitAccountId,
                gitRepository: validated.gitRepository,
                gitBranch: validated.gitBranch,
                gitPullOnRedeploy: validated.gitPullOnRedeploy,
                appPort: validated.appPort,
                // Build location tracking
                buildLocation: validated.buildLocation,
                // Upload source path
                uploadFolderPath: validated.uploadFolderPath,
            });
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: {
                    stackId: result.stackId,
                    deploymentId: result.deploymentId,
                    projectName: result.projectName,
                    notificationScheduled: result.notificationScheduled,
                },
            };
        }
        catch (error) {
            console.error('Docker stack deploy failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // List stacks for a server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_LIST, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const stacks = await dockerStackService.listStacks(id);
            return { success: true, data: stacks };
        }
        catch (error) {
            console.error('Failed to list Docker stacks:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get a single stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_GET, async (_event, input) => {
        try {
            const validated = types_1.DockerStackIdSchema.parse(input);
            const status = await dockerStackService.getStatus(validated.serverId, validated.stackId);
            if (!status) {
                return { success: false, error: 'Stack not found' };
            }
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Failed to get Docker stack:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get stack status
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_STATUS, async (_event, input) => {
        try {
            const validated = types_1.DockerStackIdSchema.parse(input);
            const status = await dockerStackService.getStatus(validated.serverId, validated.stackId);
            if (!status) {
                return { success: false, error: 'Stack not found' };
            }
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Failed to get Docker stack status:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get all containers for a server (batch operation - much faster than individual getStatus calls)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_ALL_CONTAINERS, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const containersByProject = await dockerStackService.getAllContainers(id);
            // Convert Map to plain object for IPC serialization
            const result = {};
            containersByProject.forEach((containers, projectName) => {
                result[projectName] = containers;
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to get all containers:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get container stats (CPU, memory) - separate call for progressive loading
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_CONTAINER_STATS, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const statsMap = await dockerStackService.getContainerStats(id);
            // Convert Map to plain object for IPC serialization
            const result = {};
            statsMap.forEach((stats, containerName) => {
                result[containerName] = stats;
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to get container stats:', error);
            return { success: false, error: String(error) };
        }
    });
    // Redeploy a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_REDEPLOY, async (_event, input) => {
        try {
            const validated = types_1.DockerStackRedeploySchema.parse(input);
            // Use zero-downtime deployment if requested or if stack has it enabled
            const options = {
                pullImages: validated.pullImages,
                force: validated.force,
                pullLatestCode: validated.pullLatestCode,
                updateEnvOnly: validated.updateEnvOnly,
                zeroDowntime: validated.zeroDowntime,
                gracePeriod: validated.gracePeriod,
                readinessTimeout: validated.readinessTimeout,
                buildLocation: validated.buildLocation,
            };
            // If zeroDowntime is explicitly requested, use zero-downtime deploy
            // Otherwise, check stack's deployment_strategy setting
            let result;
            if (validated.zeroDowntime) {
                result = await dockerStackService.redeployZeroDowntime(validated.serverId, validated.stackId, options);
            }
            else {
                // Let redeployZeroDowntime check the stack's deployment_strategy
                // and automatically fall back to standard if not enabled
                result = await dockerStackService.redeployZeroDowntime(validated.serverId, validated.stackId, options);
            }
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: {
                    stackId: result.stackId,
                    deploymentId: result.deploymentId,
                },
            };
        }
        catch (error) {
            console.error('Docker stack redeploy failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Rollback a stack to a previous deployment
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_ROLLBACK, async (_event, input) => {
        try {
            const validated = types_1.DockerStackRollbackSchema.parse(input);
            // Use zero-downtime rollback which automatically checks stack's deployment_strategy
            // and falls back to standard rollback if not enabled
            const result = await dockerStackService.rollbackZeroDowntime(validated.serverId, validated.stackId, validated.targetDeploymentId);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: {
                    stackId: result.stackId,
                    deploymentId: result.deploymentId,
                },
            };
        }
        catch (error) {
            console.error('Docker stack rollback failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update deployment strategy for a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_STRATEGY, async (_event, input) => {
        try {
            const { DockerStackUpdateStrategySchema } = await Promise.resolve().then(() => __importStar(require('./types')));
            const validated = DockerStackUpdateStrategySchema.parse(input);
            await dockerStackService.updateDeploymentStrategy(validated.serverId, validated.stackId, validated.deploymentStrategy);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack update strategy failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update build location for a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_BUILD_LOCATION, async (_event, input) => {
        try {
            const validated = types_1.DockerStackUpdateBuildLocationSchema.parse(input);
            await dockerStackService.updateBuildLocation(validated.serverId, validated.stackId, validated.buildLocation);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack update build location failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Clear pending failure flag on a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_CLEAR_PENDING_FAILURE, async (_event, input) => {
        try {
            const validated = types_1.DockerStackClearPendingFailureSchema.parse(input);
            dockerStackService.clearPendingFailure(validated.stackId);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Clear pending failure failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Start a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_START, async (_event, input) => {
        try {
            const validated = types_1.DockerStackIdSchema.parse(input);
            await dockerStackService.start(validated.serverId, validated.stackId);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack start failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Stop a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_STOP, async (_event, input) => {
        try {
            const validated = types_1.DockerStackStopSchema.parse(input);
            await dockerStackService.stop(validated.serverId, validated.stackId, validated.removeVolumes);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack stop failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Restart a stack or service
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_RESTART, async (_event, input) => {
        try {
            const validated = types_1.DockerStackRestartSchema.parse(input);
            await dockerStackService.restart(validated.serverId, validated.stackId, validated.serviceName);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack restart failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete a stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_DELETE, async (_event, input) => {
        try {
            const validated = types_1.DockerStackDeleteSchema.parse(input);
            await dockerStackService.delete(validated.serverId, validated.stackId, validated.removeVolumes, validated.force);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack delete failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update compose file
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_COMPOSE, async (_event, input) => {
        try {
            const validated = types_1.DockerStackUpdateComposeSchema.parse(input);
            await dockerStackService.updateComposeFile(validated.serverId, validated.stackId, validated.content);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack update compose failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update environment variables
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_ENV, async (_event, input) => {
        try {
            const validated = types_1.DockerStackUpdateEnvSchema.parse(input);
            await dockerStackService.updateEnvVars(validated.serverId, validated.stackId, validated.envVars);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Docker stack update env failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get stack logs
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_LOGS, async (_event, input) => {
        try {
            const validated = types_1.DockerStackLogsSchema.parse(input);
            const stack = db_1.queries.getDockerStack(validated.stackId);
            if (!stack || stack.server_id !== validated.serverId) {
                return { success: false, error: 'Stack not found' };
            }
            const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
            const serviceArg = validated.serviceName || '';
            const command = `cd ${workingDir} && docker compose logs --tail=${validated.tail} ${serviceArg}`;
            const result = await sshService.executeCommand(validated.serverId, command);
            if (result.exitCode !== 0) {
                return { success: false, error: result.stderr };
            }
            return { success: true, data: result.stdout };
        }
        catch (error) {
            console.error('Docker stack logs failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get deployment history for a specific stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_DEPLOYMENTS, async (_event, input) => {
        try {
            const validated = types_1.DockerStackDeploymentsSchema.parse(input);
            const deployments = dockerStackService.getDeploymentHistory(validated.stackId, validated.limit);
            return { success: true, data: deployments };
        }
        catch (error) {
            console.error('Failed to get deployment history:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get all deployments for a server (across all stacks)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_SERVER_DEPLOYMENTS, async (_event, input) => {
        try {
            const validated = types_1.DockerServerDeploymentsSchema.parse(input);
            const deployments = db_1.queries.getDockerDeploymentsByServer(validated.serverId, validated.limit);
            return { success: true, data: deployments };
        }
        catch (error) {
            console.error('Failed to get server deployment history:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get a single deployment by ID (with logs)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_DEPLOYMENT_BY_ID, async (_event, input) => {
        try {
            const validated = types_1.DockerDeploymentByIdSchema.parse(input);
            let deployment = db_1.queries.getDockerStackDeploymentById(validated.deploymentId);
            if (!deployment) {
                return { success: false, error: 'Deployment not found' };
            }
            // Reconcile GitHub/external deployments that may have completed while the wizard was closed.
            const activeStatuses = new Set(['pending', 'pulling', 'building', 'starting']);
            if (deployment.source_type === 'github' && deployment.status && activeStatuses.has(deployment.status)) {
                const stack = db_1.queries.getDockerStack(deployment.stack_id);
                if (stack) {
                    const runtimeStatus = await dockerStackService.getStatus(stack.server_id, stack.id);
                    if (runtimeStatus?.isHealthy) {
                        const now = Date.now();
                        db_1.queries.updateDockerStack(stack.id, {
                            status: 'running',
                            services_count: runtimeStatus.containers.length,
                            last_deployed_at: now,
                            last_error: null,
                        });
                        db_1.queries.updateDockerStackDeployment(deployment.id, {
                            status: 'success',
                            finished_at: now,
                            error_message: null,
                        });
                        deployment = db_1.queries.getDockerStackDeploymentById(validated.deploymentId) || deployment;
                    }
                }
            }
            return { success: true, data: deployment };
        }
        catch (error) {
            console.error('Failed to get deployment:', error);
            return { success: false, error: String(error) };
        }
    });
    // Check if project name is available
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_CHECK_PROJECT_NAME, async (_event, input) => {
        try {
            const validated = types_1.DockerStackCheckProjectNameSchema.parse(input);
            const existingStack = db_1.queries.getDockerStackByProjectName(validated.serverId, validated.projectName);
            return {
                success: true,
                data: {
                    available: !existingStack,
                    existingStackId: existingStack?.id,
                },
            };
        }
        catch (error) {
            console.error('Failed to check project name:', error);
            return { success: false, error: String(error) };
        }
    });
    // Detect unmanaged apps (apps not deployed by Server Compass)
    // See UnmanagedAppDetectionService for detailed documentation
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_DETECT_UNMANAGED, async (_event, input) => {
        try {
            const validated = types_1.DockerStackDetectUnmanagedSchema.parse(input);
            const serverId = validated.serverId;
            // Use the dedicated service for unmanaged app detection
            const detectionService = new UnmanagedAppDetectionService_1.UnmanagedAppDetectionService(sshService);
            const result = await detectionService.detectUnmanagedApps(serverId);
            return {
                success: true,
                data: result,
            };
        }
        catch (error) {
            console.error('Failed to detect unmanaged apps:', error);
            return { success: false, error: String(error) };
        }
    });
    // Remove unmanaged app (Docker container or process)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STACK_REMOVE_UNMANAGED, async (_event, input) => {
        try {
            const z = (await Promise.resolve().then(() => __importStar(require('zod')))).z;
            const validated = z.object({
                serverId: z.string(),
                containerId: z.string(),
                force: z.boolean().optional().default(true),
            }).parse(input);
            const detectionService = new UnmanagedAppDetectionService_1.UnmanagedAppDetectionService(sshService);
            const result = await detectionService.removeUnmanagedApp(validated.serverId, validated.containerId, validated.force);
            if (!result.success) {
                return { success: false, error: result.error || 'Failed to remove app' };
            }
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to remove unmanaged app:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Buildpack Operations ============
    // Check Nixpacks installation on VPS
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_CHECK, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const { NixpacksService } = await Promise.resolve().then(() => __importStar(require('../services/NixpacksService')));
            const nixpacksService = new NixpacksService(sshService);
            const result = await nixpacksService.checkInstallation(id);
            return { success: true, data: { nixpacks: result } };
        }
        catch (error) {
            console.error('Failed to check Nixpacks:', error);
            return { success: false, error: String(error) };
        }
    });
    // Install Nixpacks on VPS
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_INSTALL, async (_event, input) => {
        try {
            const { serverId } = (await Promise.resolve().then(() => __importStar(require('zod')))).z.object({
                serverId: (await Promise.resolve().then(() => __importStar(require('zod')))).z.string(),
            }).parse(input);
            const { NixpacksService } = await Promise.resolve().then(() => __importStar(require('../services/NixpacksService')));
            const nixpacksService = new NixpacksService(sshService);
            await nixpacksService.install(serverId);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to install Nixpacks:', error);
            return { success: false, error: String(error) };
        }
    });
    // Preview generated Dockerfile without deploying
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_PREVIEW, async (_event, input) => {
        try {
            const z = (await Promise.resolve().then(() => __importStar(require('zod')))).z;
            const validated = z.object({
                serverId: z.string(),
                repoPath: z.string(),
                mode: z.enum(['auto', 'template']).optional(),
                framework: z.string().optional(),
                projectName: z.string().optional(),
                overrides: z.object({
                    nodeVersion: z.string().optional(),
                    pythonVersion: z.string().optional(),
                    rubyVersion: z.string().optional(),
                    buildCommand: z.string().optional(),
                    startCommand: z.string().optional(),
                    installCommand: z.string().optional(),
                    port: z.number().optional(),
                }).optional(),
            }).parse(input);
            const { NixpacksService } = await Promise.resolve().then(() => __importStar(require('../services/NixpacksService')));
            const { BuildpackGenerationService } = await Promise.resolve().then(() => __importStar(require('../services/BuildpackGenerationService')));
            const nixpacksService = new NixpacksService(sshService);
            const buildpackGen = new BuildpackGenerationService(nixpacksService, sshService);
            const result = await buildpackGen.generateDockerfile({
                serverId: validated.serverId,
                repoPath: validated.repoPath,
                mode: validated.mode,
                framework: validated.framework,
                overrides: validated.overrides,
                projectName: validated.projectName || 'preview',
            });
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: {
                    dockerfile: result.dockerfile,
                    compose: result.compose,
                    method: result.method === 'manual' ? 'template' : result.method,
                    toolVersion: result.toolVersion,
                    framework: result.framework,
                },
            };
        }
        catch (error) {
            console.error('Failed to preview buildpack generation:', error);
            return { success: false, error: String(error) };
        }
    });
    // Preview GitHub repository with Nixpacks
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_PREVIEW_GITHUB, async (_event, input) => {
        try {
            const z = (await Promise.resolve().then(() => __importStar(require('zod')))).z;
            const validated = z.object({
                serverId: z.string(),
                gitAccountId: z.string(),
                repository: z.string(), // e.g., "owner/repo"
                branch: z.string().default('main'),
                projectName: z.string(),
                overrides: z.object({
                    nodeVersion: z.string().optional(),
                    pythonVersion: z.string().optional(),
                    rubyVersion: z.string().optional(),
                    buildCommand: z.string().optional(),
                    startCommand: z.string().optional(),
                    installCommand: z.string().optional(),
                    port: z.number().optional(),
                }).optional(),
            }).parse(input);
            // Create temporary directory for cloning
            const tempDir = `/tmp/servercompass-preview-${Date.now()}`;
            const repoUrl = `git@github.com:${validated.repository}.git`;
            const repoName = validated.repository.split('/').pop() || 'repository';
            // Map internal framework IDs to user-friendly display names
            const formatFramework = (fw) => {
                if (!fw)
                    return 'your application';
                const frameworkNames = {
                    nextjs: 'Next.js',
                    react: 'React',
                    vue: 'Vue.js',
                    nuxt: 'Nuxt',
                    express: 'Express',
                    nestjs: 'NestJS',
                    fastify: 'Fastify',
                    node: 'Node.js',
                    nodejs: 'Node.js',
                    django: 'Django',
                    flask: 'Flask',
                    fastapi: 'FastAPI',
                    python: 'Python',
                    rails: 'Ruby on Rails',
                    laravel: 'Laravel',
                    php: 'PHP',
                    go: 'Go',
                    rust: 'Rust',
                    static: 'Static Site',
                };
                return frameworkNames[fw.toLowerCase()] || fw;
            };
            try {
                // Get git account for SSH key path
                const gitAccounts = await GitAccountService_1.gitAccountService.listAccounts(validated.serverId);
                const gitAccount = gitAccounts.find(acc => acc.id === validated.gitAccountId);
                if (!gitAccount || !gitAccount.sshKeyPath) {
                    throw new Error('Git account not found or missing SSH key');
                }
                // Step 1: Clone repository
                emitAnalysisLog(`Fetching ${repoName} from GitHub...`, 'info');
                const cloneCmd = `GIT_SSH_COMMAND='ssh -i ${gitAccount.sshKeyPath} -o StrictHostKeyChecking=no' git clone --depth 1 --branch ${validated.branch} ${repoUrl} ${tempDir}`;
                const cloneResult = await sshService.executeCommand(validated.serverId, cloneCmd);
                if (cloneResult.exitCode !== 0) {
                    emitAnalysisLog('Failed to fetch repository', 'error');
                    throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
                }
                emitAnalysisLog('Repository fetched successfully', 'success');
                // Step 2: Analyze and detect framework
                emitAnalysisLog('Analyzing project structure...', 'info');
                const { NixpacksService } = await Promise.resolve().then(() => __importStar(require('../services/NixpacksService')));
                const { BuildpackGenerationService } = await Promise.resolve().then(() => __importStar(require('../services/BuildpackGenerationService')));
                const nixpacksService = new NixpacksService(sshService);
                // Log emitter transforms BuildpackGenerationService logs to user-friendly messages.
                // Maps technical terms (Nixpacks, Dockerfile) to plain language for end users.
                const logEmitter = (message, _type) => {
                    if (message.includes('Nixpacks not found')) {
                        emitAnalysisLog('Setting up build tools on server...', 'info');
                    }
                    else if (message.includes('Nixpacks installed')) {
                        emitAnalysisLog('Build tools ready', 'success');
                    }
                    else if (message.includes('Detecting framework')) {
                        emitAnalysisLog('Detecting your framework...', 'info');
                    }
                    else if (message.includes('Nixpacks detected:')) {
                        const framework = message.split(':').pop()?.trim();
                        emitAnalysisLog(`Detected: ${formatFramework(framework)}`, 'success');
                    }
                    else if (message.includes('Generating Dockerfile')) {
                        emitAnalysisLog('Creating optimized build configuration...', 'info');
                    }
                    else if (message.includes('Successfully generated')) {
                        emitAnalysisLog('Build configuration ready', 'success');
                    }
                    else if (message.includes('Falling back')) {
                        emitAnalysisLog('Using standard configuration template...', 'info');
                    }
                };
                const buildpackGen = new BuildpackGenerationService(nixpacksService, sshService, logEmitter);
                // Call generateDockerfile which now includes framework detection
                const result = await buildpackGen.generateDockerfile({
                    serverId: validated.serverId,
                    repoPath: tempDir,
                    overrides: validated.overrides,
                    projectName: validated.projectName,
                });
                // Clean up temp directory
                await sshService.executeCommand(validated.serverId, `rm -rf ${tempDir}`);
                if (!result.success) {
                    emitAnalysisLog('Failed to generate configuration', 'error');
                    return { success: false, error: result.error };
                }
                // Use framework from BuildpackGenerationService
                let detectedFramework = result.framework;
                if (!detectedFramework) {
                    detectedFramework = detectFrameworkFromDockerfile(result.dockerfile);
                }
                // Final success message
                emitAnalysisLog(`Ready to deploy ${formatFramework(detectedFramework)}`, 'success');
                return {
                    success: true,
                    data: {
                        dockerfile: result.dockerfile,
                        compose: result.compose,
                        method: result.method === 'manual' ? 'template' : result.method,
                        toolVersion: result.toolVersion,
                        framework: detectedFramework,
                    },
                };
            }
            catch (error) {
                // Clean up temp directory on error
                await sshService.executeCommand(validated.serverId, `rm -rf ${tempDir}`).catch(() => {
                    // Ignore cleanup errors
                });
                throw error;
            }
        }
        catch (error) {
            console.error('Failed to preview GitHub repository with buildpack:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Registry Operations ============
    // List registries for a server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REGISTRY_LIST, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const registries = registryService.listCredentials(id);
            return { success: true, data: registries };
        }
        catch (error) {
            console.error('Failed to list registries:', error);
            return { success: false, error: String(error) };
        }
    });
    // Add registry credentials
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REGISTRY_ADD, async (_event, input) => {
        try {
            const validated = types_1.DockerRegistryAddSchema.parse(input);
            const registryId = await registryService.saveCredentials(validated.serverId, {
                type: validated.type,
                name: validated.name,
                url: validated.url,
                username: validated.username,
                password: validated.password,
            });
            return { success: true, data: { registryId } };
        }
        catch (error) {
            console.error('Failed to add registry:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update registry credentials
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REGISTRY_UPDATE, async (_event, input) => {
        try {
            const validated = types_1.DockerRegistryUpdateSchema.parse(input);
            await registryService.updateCredentials(validated.serverId, validated.registryId, {
                name: validated.name,
                type: validated.type,
                url: validated.url,
                username: validated.username,
                password: validated.password,
            });
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to update registry:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete registry credentials
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REGISTRY_DELETE, async (_event, input) => {
        try {
            const validated = types_1.DockerRegistryIdSchema.parse(input);
            registryService.deleteCredentials(validated.serverId, validated.registryId);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to delete registry:', error);
            return { success: false, error: String(error) };
        }
    });
    // Test registry connection
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REGISTRY_TEST, async (_event, input) => {
        try {
            const validated = types_1.DockerRegistryTestSchema.parse(input);
            const result = await registryService.testConnection(validated.serverId, {
                type: validated.type,
                url: validated.url,
                username: validated.username,
                password: validated.password,
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to test registry:', error);
            return { success: false, error: String(error) };
        }
    });
    // Login to registry
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REGISTRY_LOGIN, async (_event, input) => {
        try {
            const validated = types_1.DockerRegistryIdSchema.parse(input);
            const success = await registryService.loginToRegistry(validated.serverId, validated.registryId);
            return { success: true, data: { success } };
        }
        catch (error) {
            console.error('Failed to login to registry:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Template Operations ============
    // List all templates
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_TEMPLATE_LIST, async () => {
        try {
            const templates = (0, docker_templates_1.getAllTemplates)();
            return { success: true, data: templates };
        }
        catch (error) {
            console.error('Failed to list templates:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get a single template
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_TEMPLATE_GET, async (_event, input) => {
        try {
            const validated = types_1.DockerTemplateIdSchema.parse(input);
            const template = (0, docker_templates_1.getTemplateById)(validated.templateId);
            if (!template) {
                return { success: false, error: 'Template not found' };
            }
            return { success: true, data: template };
        }
        catch (error) {
            console.error('Failed to get template:', error);
            return { success: false, error: String(error) };
        }
    });
    // Render a template with variables
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_TEMPLATE_RENDER, async (_event, input) => {
        try {
            const validated = types_1.DockerTemplateRenderSchema.parse(input);
            console.log(`[TemplateRender] Rendering template: ${validated.templateId}`);
            console.log(`[TemplateRender] Variables:`, JSON.stringify(validated.variables, null, 2));
            const rendered = (0, docker_templates_1.renderTemplate)(validated.templateId, validated.variables);
            console.log(`[TemplateRender] ✅ Rendered successfully`);
            console.log(`[TemplateRender] Compose preview (first 200 chars):`, rendered.compose.substring(0, 200));
            console.log(`[TemplateRender] Dockerfile preview (first 200 chars):`, rendered.dockerfile?.substring(0, 200) || 'No dockerfile');
            return { success: true, data: rendered };
        }
        catch (error) {
            console.error('[TemplateRender] ❌ Failed to render template:', error);
            return { success: false, error: String(error) };
        }
    });
    // Generate Supabase JWTs in the main process (renderer-safe fallback).
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_SUPABASE_JWT_GENERATE, async (_event, input) => {
        try {
            const validated = types_1.DockerSupabaseJwtGenerateSchema.parse(input);
            const token = (0, supabase_1.generateSupabaseJWT)(validated.secret, validated.role);
            return { success: true, data: token };
        }
        catch (error) {
            console.error('[SupabaseJWT] ❌ Failed to generate JWT:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Compose Validation Operations ============
    // Validate compose content
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_COMPOSE_VALIDATE, async (_event, input) => {
        try {
            const validated = types_1.DockerComposeValidateSchema.parse(input);
            const result = ComposeService_1.composeService.validateCompose(validated.content);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to validate compose:', error);
            return { success: false, error: String(error) };
        }
    });
    // Sanitize compose content
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_COMPOSE_SANITIZE, async (_event, input) => {
        try {
            const validated = types_1.DockerComposeSanitizeSchema.parse(input);
            const result = ComposeService_1.composeService.sanitizeCompose(validated.content);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to sanitize compose:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Host Operations ============
    // Check if Docker is installed
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_HOST_CHECK, async (_event, input) => {
        try {
            const validated = types_1.DockerHostCheckSchema.parse(input);
            const dockerResult = await sshService.executeCommand(validated.serverId, 'docker --version');
            const composeResult = await sshService.executeCommand(validated.serverId, 'docker compose version');
            const dockerInstalled = dockerResult.exitCode === 0;
            const composeInstalled = composeResult.exitCode === 0;
            let version;
            if (dockerInstalled) {
                const match = dockerResult.stdout.match(/Docker version ([\d.]+)/);
                version = match ? match[1] : undefined;
            }
            return {
                success: true,
                data: {
                    docker: dockerInstalled,
                    compose: composeInstalled,
                    version,
                },
            };
        }
        catch (error) {
            console.error('Failed to check Docker installation:', error);
            return { success: false, error: String(error) };
        }
    });
    // Install Docker on host
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_HOST_INSTALL, async (_event, input) => {
        try {
            const validated = types_1.DockerHostCheckSchema.parse(input);
            // Install Docker using official script
            const installResult = await sshService.executeCommand(validated.serverId, 'curl -fsSL https://get.docker.com | sh');
            if (installResult.exitCode !== 0) {
                return { success: false, error: `Failed to install Docker: ${installResult.stderr}` };
            }
            // Start and enable Docker service
            await sshService.executeCommand(validated.serverId, 'systemctl start docker && systemctl enable docker');
            // Install Docker Compose plugin
            await sshService.executeCommand(validated.serverId, 'apt-get install -y docker-compose-plugin');
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to install Docker:', error);
            return { success: false, error: String(error) };
        }
    });
    // Generate Docker compose from framework detection
    electron_1.ipcMain.handle('docker:generate-compose', async (_event, input) => {
        try {
            const { framework, projectName, port = 3000, packageManager } = input;
            console.log(`[Docker] Generating compose for framework: ${framework}`);
            // Try to use template system first via framework resolution
            const resolvedTemplate = (0, docker_templates_1.resolveTemplateByFramework)(framework);
            if (resolvedTemplate) {
                const templateId = resolvedTemplate.id;
                console.log(`[Docker] Using template: ${templateId} for framework: ${framework}`);
                const template = (0, docker_templates_1.getTemplateById)(templateId) || resolvedTemplate;
                // Prepare variables for template rendering
                const variables = {
                    PORT: String(port),
                };
                // Generate secrets for required env hints
                const envVars = {};
                if (template.envHints) {
                    for (const hint of template.envHints) {
                        if (hint.required && hint.type === 'secret') {
                            // Auto-generate secret
                            const secret = generateSecretForHint({ key: hint.key, description: hint.description }, templateId);
                            variables[hint.key] = secret;
                            envVars[hint.key] = secret;
                        }
                        else if (hint.default) {
                            // Use default value
                            variables[hint.key] = hint.default;
                            envVars[hint.key] = hint.default;
                        }
                    }
                }
                // Render template
                const rendered = (0, docker_templates_1.renderTemplate)(templateId, variables);
                return {
                    success: true,
                    data: {
                        compose: rendered.compose,
                        dockerfile: rendered.dockerfile || '',
                        envVars,
                    },
                };
            }
            // Fallback to legacy framework generation for Node.js frameworks
            console.log(`[Docker] Using legacy generation for framework: ${framework}`);
            const supportedFrameworks = ['nextjs', 'react', 'vue', 'express', 'fastify', 'nestjs', 'node', 'static', 'rust', 'go', 'python', 'django', 'flask', 'fastapi', 'rails', 'laravel'];
            const frameworkType = (supportedFrameworks.includes(framework)
                ? framework
                : 'unknown');
            const result = ComposeService_1.composeService.generateFromFramework({
                framework: frameworkType,
                projectName,
                port,
                packageManager,
            });
            return {
                success: true,
                data: result,
            };
        }
        catch (error) {
            console.error('Failed to generate compose:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Environment (Staging/Preview) Operations ============
    // Create environment service
    const traefikRouter = (0, TraefikDynamicRouter_1.createTraefikDynamicRouter)(sshService);
    const traefikService = new TraefikService_1.TraefikService(sshService);
    const environmentService = (0, EnvironmentService_1.createEnvironmentService)(sshService, traefikRouter, traefikService);
    // Set main window for environment service logs
    if (mainWindow) {
        environmentService.setMainWindow(mainWindow);
    }
    // Create a new environment (staging or preview)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_CREATE, async (_event, input) => {
        try {
            const validated = types_1.CreateEnvironmentSchema.parse(input);
            const result = await environmentService.createEnvironment({
                serverId: validated.serverId,
                productionStackId: validated.productionStackId,
                environmentType: validated.environmentType,
                environmentName: validated.environmentName,
                subdomainPrefix: validated.subdomainPrefix,
                customDomain: validated.customDomain,
                branchName: validated.branchName,
                buildLocation: validated.buildLocation,
                copyEnvVars: validated.copyEnvVars,
                customEnvVars: validated.customEnvVars,
                hostPort: validated.hostPort,
            });
            if (!result.success) {
                return {
                    success: false,
                    error: result.error,
                    data: result.stackId && result.projectName
                        ? {
                            stackId: result.stackId,
                            projectName: result.projectName,
                            hostPort: result.hostPort,
                        }
                        : undefined,
                };
            }
            return {
                success: true,
                data: {
                    stackId: result.stackId,
                    projectName: result.projectName,
                    hostPort: result.hostPort,
                },
            };
        }
        catch (error) {
            console.error('Failed to create environment:', error);
            return { success: false, error: String(error) };
        }
    });
    // List environments for a production stack
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_LIST, async (_event, input) => {
        try {
            const validated = types_1.ListEnvironmentsSchema.parse(input);
            const environments = environmentService.listEnvironments(validated.productionStackId);
            return { success: true, data: environments };
        }
        catch (error) {
            console.error('Failed to list environments:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete an environment
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_DELETE, async (_event, input) => {
        try {
            const validated = types_1.DeleteEnvironmentSchema.parse(input);
            const result = await environmentService.deleteEnvironment(validated.serverId, validated.stackId);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to delete environment:', error);
            return { success: false, error: String(error) };
        }
    });
    // Promote staging to production
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_PROMOTE, async (_event, input) => {
        try {
            const validated = types_1.PromoteEnvironmentSchema.parse(input);
            const result = await environmentService.promoteToProduction({
                serverId: validated.serverId,
                stagingStackId: validated.stagingStackId,
                deploymentStrategy: validated.deploymentStrategy,
                keepStaging: validated.keepStaging,
                createBackup: validated.createBackup,
            });
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: {
                    stackId: result.stackId,
                    projectName: result.projectName,
                },
            };
        }
        catch (error) {
            console.error('Failed to promote environment:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update environment settings (auto-deploy rules, TTL, etc.)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_UPDATE_SETTINGS, async (_event, input) => {
        try {
            const validated = types_1.UpdateEnvironmentSettingsSchema.parse(input);
            if (validated.autoDeployRules) {
                environmentService.updateAutoDeployRules(validated.stackId, validated.autoDeployRules);
            }
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Failed to update environment settings:', error);
            return { success: false, error: String(error) };
        }
    });
    // Deploy a branch to an environment
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_DEPLOY_BRANCH, async (_event, input) => {
        try {
            const validated = types_1.DeployBranchSchema.parse(input);
            const result = await environmentService.deployBranch(validated.serverId, validated.productionStackId, validated.branchName, validated.environmentType);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: { stackId: result.stackId },
            };
        }
        catch (error) {
            console.error('Failed to deploy branch:', error);
            return { success: false, error: String(error) };
        }
    });
    // Reconcile environments from server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_RECONCILE, async (_event, input) => {
        try {
            const validated = types_1.ReconcileEnvironmentsSchema.parse(input);
            const result = await environmentService.reconcileEnvironments(validated.serverId, validated.productionStackId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to reconcile environments:', error);
            return { success: false, error: String(error) };
        }
    });
    // Cleanup expired preview environments
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_CLEANUP_EXPIRED, async (_event, input) => {
        try {
            const validated = types_1.CleanupExpiredEnvironmentsSchema.parse(input);
            const result = await environmentService.cleanupExpiredPreviews(validated.serverId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Failed to cleanup expired environments:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=docker-stacks.js.map