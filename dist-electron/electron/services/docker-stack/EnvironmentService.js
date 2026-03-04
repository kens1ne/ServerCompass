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
exports.EnvironmentService = void 0;
exports.createEnvironmentService = createEnvironmentService;
exports.getEnvironmentService = getEnvironmentService;
const crypto_1 = require("crypto");
const events_1 = require("events");
const yaml = __importStar(require("yaml"));
const GitHubActionsDockerService_1 = require("../GitHubActionsDockerService");
const db_1 = require("../../db");
const pathUtils_1 = require("./pathUtils");
/**
 * EnvironmentService - Manages staging/preview environments for Docker stacks
 *
 * Features:
 * - Create staging/preview environments from production stacks
 * - Generate unique subdomains using Traefik file provider
 * - Promote staging to production with zero-downtime deployment
 * - TTL-based auto-cleanup for preview environments
 * - Reconcile server-side environments with local database
 */
class EnvironmentService extends events_1.EventEmitter {
    sshService;
    traefikRouter;
    traefikService;
    mainWindow = null;
    constructor(sshService, traefikRouter, traefikService) {
        super();
        this.sshService = sshService;
        this.traefikRouter = traefikRouter;
        this.traefikService = traefikService;
    }
    setMainWindow(window) {
        this.mainWindow = window;
    }
    /**
     * Emit a log message for frontend display
     */
    emitLog(message, type = 'info', stackId) {
        const logEntry = {
            timestamp: Date.now(),
            message,
            type,
            stackId,
        };
        this.emit('log', logEntry);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('docker:stack:log', logEntry);
        }
    }
    /**
     * Get the primary domain for a stack
     * Falls back to the oldest domain if no primary is set
     */
    getPrimaryDomainForStack(stackId) {
        // First try to find the primary domain
        const primaryDomain = db_1.db.prepare(`
      SELECT * FROM domains
      WHERE stack_id = ? AND is_primary = 1
      ORDER BY created_at ASC
      LIMIT 1
    `).get(stackId);
        if (primaryDomain) {
            return primaryDomain;
        }
        // Fall back to the oldest domain
        const oldestDomain = db_1.db.prepare(`
      SELECT * FROM domains
      WHERE stack_id = ?
      ORDER BY created_at ASC
      LIMIT 1
    `).get(stackId);
        return oldestDomain || null;
    }
    /**
     * Sanitize a subdomain prefix to be DNS-safe
     */
    sanitizeSubdomainPrefix(prefix) {
        // Convert to lowercase
        let sanitized = prefix.toLowerCase();
        // Replace underscores and spaces with dashes
        sanitized = sanitized.replace(/[_\s]+/g, '-');
        // Remove invalid characters (keep only alphanumeric and dashes)
        sanitized = sanitized.replace(/[^a-z0-9-]/g, '');
        // Remove leading/trailing dashes
        sanitized = sanitized.replace(/^-+|-+$/g, '');
        // Truncate to 40 chars and add hash if needed for uniqueness
        if (sanitized.length > 40) {
            const hash = (0, crypto_1.randomUUID)().slice(0, 6);
            sanitized = sanitized.slice(0, 33) + '-' + hash;
        }
        return sanitized || 'env';
    }
    /**
     * Generate project name for an environment
     * Uses -env- infix to avoid collision with ZDT's -staging suffix
     */
    generateProjectName(parentProjectName, subdomainPrefix) {
        const sanitized = this.sanitizeSubdomainPrefix(subdomainPrefix);
        return `${parentProjectName}-env-${sanitized}`;
    }
    /**
     * Check if project name collides with ZDT reserved names
     */
    isZdtReservedName(projectName, parentProjectName) {
        // ZDT uses ${projectName}-staging for temporary staging containers
        return projectName === `${parentProjectName}-staging`;
    }
    /**
     * Generate subdomain for an environment
     */
    generateSubdomain(baseDomain, subdomainPrefix) {
        const sanitized = this.sanitizeSubdomainPrefix(subdomainPrefix);
        // Extract the base domain (remove any leading subdomain)
        const parts = baseDomain.split('.');
        if (parts.length > 2) {
            // Already has subdomain, prepend to it
            parts[0] = `${sanitized}.${parts[0]}`;
            return parts.join('.');
        }
        // No subdomain, just prepend
        return `${sanitized}.${baseDomain}`;
    }
    /**
     * Check if compose content has a build context that requires source code
     */
    composeNeedsBuildContext(composeContent) {
        try {
            const parsed = yaml.parse(composeContent);
            if (!parsed.services) {
                return false;
            }
            for (const service of Object.values(parsed.services)) {
                if (service.build) {
                    // Build can be a string (context path) or an object with context property
                    if (typeof service.build === 'string') {
                        return true;
                    }
                    if (typeof service.build === 'object' && service.build.context) {
                        return true;
                    }
                }
            }
            return false;
        }
        catch {
            return false;
        }
    }
    extractContainerPortFromCompose(composeContent) {
        try {
            const parsed = yaml.parse(composeContent);
            const services = parsed.services;
            if (!services)
                return null;
            const serviceName = services.app ? 'app' : Object.keys(services)[0];
            if (!serviceName)
                return null;
            const service = services[serviceName];
            const portDefs = service?.ports;
            if (Array.isArray(portDefs)) {
                for (const portDef of portDefs) {
                    if (typeof portDef === 'object' && portDef && typeof portDef.target === 'number') {
                        return portDef.target;
                    }
                    const match = String(portDef).match(/(?:(?:\d+\.){3}\d+:)?(?:\d+:)?(\d+)/);
                    if (match) {
                        const parsedPort = Number.parseInt(match[1], 10);
                        if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
                            return parsedPort;
                        }
                    }
                }
            }
            const exposeDefs = service?.expose;
            if (Array.isArray(exposeDefs)) {
                for (const exposeDef of exposeDefs) {
                    const parsedPort = Number.parseInt(String(exposeDef), 10);
                    if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
                        return parsedPort;
                    }
                }
            }
            return null;
        }
        catch {
            return null;
        }
    }
    parseGitHubRepoFullName(repoRef) {
        const trimmed = (repoRef || '').trim();
        if (!trimmed)
            return null;
        if (trimmed.includes('github.com')) {
            const match = trimmed.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
            if (match?.[1] && match?.[2]) {
                return { owner: match[1], repo: match[2] };
            }
        }
        if (trimmed.includes('/')) {
            const [owner, repo] = trimmed.split('/');
            if (owner && repo) {
                return { owner, repo };
            }
        }
        return null;
    }
    sanitizeDockerTag(value) {
        const normalized = (value || '')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_.-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!normalized)
            return 'latest';
        return normalized.length > 128 ? normalized.slice(0, 128) : normalized;
    }
    /**
     * Resolve external Docker network names declared in compose content.
     * Supports:
     * - networks.<name>.external: true
     * - networks.<name>.external.name
     * - networks.<name>.name (with external true)
     */
    getExternalNetworkNames(composeContent) {
        try {
            const parsed = yaml.parse(composeContent);
            if (!parsed.networks)
                return [];
            const names = new Set();
            for (const [logicalName, definition] of Object.entries(parsed.networks)) {
                if (!definition || typeof definition !== 'object')
                    continue;
                const externalField = definition.external;
                const isExternal = externalField === true ||
                    (typeof externalField === 'object' && externalField !== null);
                if (!isExternal)
                    continue;
                const externalObjectName = typeof externalField === 'object' && externalField?.name
                    ? externalField.name.trim()
                    : '';
                const directName = typeof definition.name === 'string' ? definition.name.trim() : '';
                const resolvedName = externalObjectName || directName || logicalName;
                if (resolvedName) {
                    names.add(resolvedName);
                }
            }
            return [...names];
        }
        catch (error) {
            this.emitLog(`Warning: Failed to parse compose networks for external network validation: ${error instanceof Error ? error.message : String(error)}`, 'warning');
            return [];
        }
    }
    /**
     * Ensure external Docker networks exist before `docker compose up`.
     * This prevents compose failures like:
     * "network <name> declared as external, but could not be found".
     */
    async ensureExternalNetworksExist(serverId, composeContent, stackId) {
        const externalNetworks = this.getExternalNetworkNames(composeContent);
        if (externalNetworks.length === 0)
            return;
        for (const networkName of externalNetworks) {
            const escapedNetworkName = networkName.replace(/'/g, `'\"'\"'`);
            const ensureCmd = `docker network inspect '${escapedNetworkName}' >/dev/null 2>&1 || ` +
                `docker network create '${escapedNetworkName}' >/dev/null 2>&1`;
            const result = await this.sshService.executeCommand(serverId, ensureCmd);
            if (result.exitCode !== 0) {
                throw new Error(`Failed to ensure external Docker network "${networkName}": ${result.stderr || result.stdout || 'unknown error'}`);
            }
            this.emitLog(`External network ready: ${networkName}`, 'info', stackId);
        }
    }
    isRecoverableFailedEnvironment(existingStack, productionStackId) {
        if (existingStack.environment_type === 'production') {
            return false;
        }
        if (existingStack.parent_stack_id !== productionStackId) {
            return false;
        }
        if (existingStack.status === 'error') {
            return true;
        }
        if (existingStack.status === 'pending') {
            const staleThresholdMs = 5 * 60 * 1000;
            return Date.now() - existingStack.updated_at > staleThresholdMs;
        }
        return false;
    }
    async getProjectRunningContainerState(serverId, projectName, stackId) {
        const escapedProjectName = projectName.replace(/"/g, '\\"');
        const result = await this.sshService.executeCommand(serverId, `docker ps --filter "label=com.docker.compose.project=${escapedProjectName}" --format "{{.ID}}"`);
        if (result.exitCode !== 0) {
            this.emitLog(`Warning: Unable to verify running containers for "${projectName}". Skipping auto-recovery.`, 'warning', stackId);
            return 'unknown';
        }
        return result.stdout.trim().length > 0 ? 'running' : 'none';
    }
    /**
     * Clone compose content for environment deployment
     * - If hostPort is provided, remaps the first service's port to the custom host port
     * - Otherwise, removes host port mappings (use Traefik routing instead)
     * - Removes existing Traefik labels
     * - Ensures traefik-public network is present
     */
    cloneComposeForEnvironment(composeContent, projectName, _domain, _port, hostPort) {
        try {
            const parsed = yaml.parse(composeContent);
            if (!parsed.services) {
                return composeContent;
            }
            const primaryServiceName = parsed.services.app ? 'app' : Object.keys(parsed.services)[0];
            let hostPortAssigned = false;
            // Process each service
            for (const [serviceName, service] of Object.entries(parsed.services)) {
                // Stabilize the primary container name for Traefik file-provider routing.
                if (primaryServiceName && serviceName === primaryServiceName) {
                    service.container_name = `${projectName}-app`;
                }
                else if (service.container_name) {
                    // Remove fixed container names to avoid cross-environment conflicts.
                    delete service.container_name;
                }
                // Handle port mappings
                if (service.ports) {
                    if (hostPort && !hostPortAssigned) {
                        // If hostPort is provided, remap the first port to use the custom host port
                        const newPorts = [];
                        for (const portDef of service.ports) {
                            // Extract container port from "hostPort:containerPort" or just "containerPort"
                            const match = String(portDef).match(/(?:\d+:)?(\d+)/);
                            if (match && !hostPortAssigned) {
                                const containerPort = match[1];
                                newPorts.push(`${hostPort}:${containerPort}`);
                                hostPortAssigned = true;
                            }
                            else {
                                // Keep other ports as internal-only (no host mapping)
                                const otherMatch = String(portDef).match(/(?:\d+:)?(\d+)/);
                                if (otherMatch) {
                                    // Remove host port for secondary ports
                                    // These can be accessed via Docker network if needed
                                }
                            }
                        }
                        service.ports = newPorts.length > 0 ? newPorts : undefined;
                        if (!service.ports) {
                            delete service.ports;
                        }
                    }
                    else {
                        // No hostPort provided - remove ports entirely (Traefik routes via Docker network)
                        delete service.ports;
                    }
                }
                // Remove existing Traefik labels
                if (service.labels) {
                    if (Array.isArray(service.labels)) {
                        service.labels = service.labels.filter((label) => !label.startsWith('traefik.'));
                    }
                    else {
                        for (const key of Object.keys(service.labels)) {
                            if (key.startsWith('traefik.')) {
                                delete service.labels[key];
                            }
                        }
                    }
                }
                // Ensure service is on traefik-public network (for future domain routing)
                if (!service.networks) {
                    service.networks = [];
                }
                if (Array.isArray(service.networks)) {
                    if (!service.networks.includes('traefik-public')) {
                        service.networks.push('traefik-public');
                    }
                }
                else {
                    if (!service.networks['traefik-public']) {
                        service.networks['traefik-public'] = { external: true };
                    }
                }
            }
            // Ensure traefik-public network is defined
            if (!parsed.networks) {
                parsed.networks = {};
            }
            if (!parsed.networks['traefik-public']) {
                parsed.networks['traefik-public'] = { external: true };
            }
            return yaml.stringify(parsed);
        }
        catch (error) {
            console.error('[EnvironmentService] Failed to parse compose:', error);
            return composeContent;
        }
    }
    buildComposeForPromotion(stagingComposeContent, productionComposeContent) {
        try {
            const stagingParsed = yaml.parse(stagingComposeContent);
            const productionParsed = yaml.parse(productionComposeContent);
            if (!stagingParsed.services || !productionParsed.services) {
                return stagingComposeContent;
            }
            const productionServiceEntries = Object.entries(productionParsed.services);
            const stagingServiceEntries = Object.entries(stagingParsed.services);
            const singleServiceFallback = productionServiceEntries.length === 1 && stagingServiceEntries.length === 1
                ? productionServiceEntries[0][1]
                : null;
            for (const [serviceName, stagingService] of Object.entries(stagingParsed.services)) {
                const productionService = productionParsed.services[serviceName] || singleServiceFallback;
                if (!productionService || !stagingService)
                    continue;
                if (productionService.ports !== undefined) {
                    if (productionService.ports === null) {
                        delete stagingService.ports;
                    }
                    else {
                        stagingService.ports = productionService.ports;
                    }
                }
                else {
                    delete stagingService.ports;
                }
                if (productionService.labels !== undefined) {
                    if (productionService.labels === null) {
                        delete stagingService.labels;
                    }
                    else {
                        stagingService.labels = productionService.labels;
                    }
                }
                else {
                    delete stagingService.labels;
                }
                if (productionService.container_name !== undefined) {
                    if (productionService.container_name === null) {
                        delete stagingService.container_name;
                    }
                    else {
                        stagingService.container_name = productionService.container_name;
                    }
                }
                else {
                    delete stagingService.container_name;
                }
                if (productionService.networks !== undefined) {
                    if (productionService.networks === null) {
                        delete stagingService.networks;
                    }
                    else {
                        stagingService.networks = productionService.networks;
                    }
                }
            }
            if (productionParsed.networks || stagingParsed.networks) {
                stagingParsed.networks = {
                    ...(productionParsed.networks || {}),
                    ...(stagingParsed.networks || {}),
                };
            }
            if (productionParsed.volumes || stagingParsed.volumes) {
                stagingParsed.volumes = {
                    ...(productionParsed.volumes || {}),
                    ...(stagingParsed.volumes || {}),
                };
            }
            return yaml.stringify(stagingParsed);
        }
        catch (error) {
            console.error('[EnvironmentService] Failed to merge compose for promotion:', error);
            return stagingComposeContent;
        }
    }
    /**
     * Create a new environment (staging or preview) from a production stack
     */
    async createEnvironment(options) {
        const { serverId, productionStackId, environmentType, environmentName, subdomainPrefix, customDomain, branchName, buildLocation, copyEnvVars = true, customEnvVars, hostPort, } = options;
        // Use environmentName for subdomain if not explicitly provided
        const effectiveSubdomainPrefix = subdomainPrefix || environmentName;
        // 1. Validate production stack exists
        const productionStack = db_1.queries.getDockerStack(productionStackId);
        if (!productionStack) {
            return { success: false, error: 'Production stack not found' };
        }
        if (productionStack.server_id !== serverId) {
            return { success: false, error: 'Stack does not belong to this server' };
        }
        if (productionStack.environment_type !== 'production') {
            return { success: false, error: 'Can only create environments from production stacks' };
        }
        const requestedBranch = branchName?.trim();
        const productionBranch = productionStack.git_branch?.trim();
        const selectedBranch = requestedBranch || productionBranch || null;
        const resolvedBuildLocation = buildLocation ||
            (productionStack.build_location === 'github-actions' ? 'github-actions' : 'vps');
        const wantsGitHubActionsBuild = resolvedBuildLocation === 'github-actions';
        if (productionStack.source_type === 'github' &&
            productionStack.ci_enabled === 1 &&
            requestedBranch &&
            requestedBranch !== productionBranch &&
            !wantsGitHubActionsBuild &&
            !this.composeNeedsBuildContext(productionStack.compose_content)) {
            return {
                success: false,
                error: `This stack uses GitHub Actions image deploy (${productionBranch || 'main'} → :latest). ` +
                    `Branch-specific environments require a build step. ` +
                    `Choose "Build on GitHub Actions" for this environment, or use a VPS build stack with build context.`,
            };
        }
        // 2. Get primary domain for production stack (optional if hostPort is provided)
        const primaryDomain = this.getPrimaryDomainForStack(productionStackId);
        if (!primaryDomain && !customDomain && !hostPort) {
            return {
                success: false,
                error: 'Production stack has no domain configured. Please add a domain first, provide a custom domain, or specify a host port.',
            };
        }
        if (wantsGitHubActionsBuild) {
            if (productionStack.source_type !== 'github') {
                return {
                    success: false,
                    error: 'GitHub Actions environments are only supported for Git source stacks.',
                };
            }
            if (!productionStack.github_repo) {
                return {
                    success: false,
                    error: 'GitHub repository is missing on the production stack. Link a repository first.',
                };
            }
            if (!productionStack.git_account_id) {
                return {
                    success: false,
                    error: 'GitHub account is missing for this stack. Link a GitHub account to the server (or set a default) and retry.',
                };
            }
            if (!hostPort) {
                return {
                    success: false,
                    error: 'GitHub Actions environments currently require a host port. Please choose a port and retry.',
                };
            }
        }
        // 3. Generate project name and subdomain
        const sanitizedName = this.sanitizeSubdomainPrefix(environmentName);
        const projectName = this.generateProjectName(productionStack.project_name, sanitizedName);
        const sanitizedSubdomainPrefix = this.sanitizeSubdomainPrefix(effectiveSubdomainPrefix);
        // Check for ZDT collision
        if (this.isZdtReservedName(projectName, productionStack.project_name)) {
            return {
                success: false,
                error: `Subdomain prefix "${subdomainPrefix}" conflicts with zero-downtime deployment. Please choose a different prefix.`,
            };
        }
        // Check if project name already exists
        const existingStack = db_1.queries.getDockerStackByProjectName(serverId, projectName);
        if (existingStack) {
            const sameParentEnvironment = existingStack.environment_type !== 'production' &&
                existingStack.parent_stack_id === productionStackId;
            const canAttemptStaleRecovery = sameParentEnvironment &&
                (this.isRecoverableFailedEnvironment(existingStack, productionStackId) ||
                    existingStack.status !== 'running');
            if (canAttemptStaleRecovery) {
                this.emitLog(`Found existing environment "${projectName}". Checking if it can be recreated safely...`, 'warning', existingStack.id);
                const runningContainerState = await this.getProjectRunningContainerState(serverId, projectName, existingStack.id);
                if (runningContainerState === 'running') {
                    return {
                        success: false,
                        error: `Environment "${projectName}" already exists and still has running containers`,
                        stackId: existingStack.id,
                        projectName: existingStack.project_name,
                    };
                }
                if (runningContainerState === 'unknown' && existingStack.status === 'running') {
                    return {
                        success: false,
                        error: `Environment "${projectName}" already exists and container state could not be verified. ` +
                            `Please retry when SSH connection is stable, or open the existing environment.`,
                        stackId: existingStack.id,
                        projectName: existingStack.project_name,
                    };
                }
                if (runningContainerState === 'unknown') {
                    this.emitLog(`Container check unavailable for "${projectName}", but stack is non-running. Attempting cleanup anyway...`, 'warning', existingStack.id);
                }
                this.emitLog(`No running containers found for "${projectName}". Cleaning up stale environment before recreate...`, 'info', existingStack.id);
                const cleanupResult = await this.deleteEnvironment(serverId, existingStack.id);
                if (!cleanupResult.success) {
                    return {
                        success: false,
                        error: `Environment "${projectName}" already exists and automatic cleanup failed: ` +
                            `${cleanupResult.error || 'unknown error'}`,
                        stackId: existingStack.id,
                        projectName: existingStack.project_name,
                    };
                }
                this.emitLog(`Stale environment "${projectName}" removed. Continuing with fresh create...`, 'success');
            }
            else {
                return {
                    success: false,
                    error: `Environment "${projectName}" already exists`,
                    stackId: existingStack.id,
                    projectName: existingStack.project_name,
                };
            }
        }
        // 4. Generate subdomain (optional if using hostPort-only approach)
        const baseDomain = primaryDomain?.domain || customDomain;
        const envDomain = baseDomain
            ? (customDomain || this.generateSubdomain(baseDomain, sanitizedSubdomainPrefix))
            : null;
        this.emitLog(`Creating ${environmentType} environment: ${projectName}`, 'info');
        if (envDomain) {
            this.emitLog(`Environment domain: ${envDomain}`, 'info');
        }
        if (hostPort) {
            this.emitLog(`Environment host port: ${hostPort}`, 'info');
        }
        // 5. Clone and modify compose content
        const containerPort = this.extractContainerPortFromCompose(productionStack.compose_content)
            || primaryDomain?.port
            || 3000;
        const parsedRepo = wantsGitHubActionsBuild
            ? this.parseGitHubRepoFullName(productionStack.github_repo || '')
            : null;
        if (wantsGitHubActionsBuild && !parsedRepo) {
            return {
                success: false,
                error: `Invalid GitHub repository format: "${productionStack.github_repo || ''}"`,
            };
        }
        const imageTag = wantsGitHubActionsBuild ? this.sanitizeDockerTag(projectName) : null;
        const clonedCompose = wantsGitHubActionsBuild && parsedRepo && imageTag
            ? yaml.stringify({
                services: {
                    [projectName]: {
                        image: `ghcr.io/${parsedRepo.owner}/${parsedRepo.repo}:${imageTag}`,
                        container_name: `${projectName}-app`,
                        ports: hostPort ? [`${hostPort}:${containerPort}`] : undefined,
                        environment: {
                            PORT: `\${PORT:-${containerPort}}`,
                        },
                        env_file: ['.env'],
                        restart: 'unless-stopped',
                        networks: ['default', 'traefik-public'],
                    },
                },
                networks: {
                    'traefik-public': { external: true },
                },
            })
            : this.cloneComposeForEnvironment(productionStack.compose_content, projectName, envDomain || '', containerPort, hostPort // Pass custom host port
            );
        const needsBuildContext = wantsGitHubActionsBuild ? false : this.composeNeedsBuildContext(clonedCompose);
        // 6. Copy or customize env vars
        const resolvedEnvVars = {};
        if (copyEnvVars && productionStack.env_vars) {
            try {
                const parsedProductionEnv = JSON.parse(productionStack.env_vars);
                for (const [key, value] of Object.entries(parsedProductionEnv)) {
                    if (!key.trim())
                        continue;
                    resolvedEnvVars[key] = value === undefined || value === null ? '' : String(value);
                }
            }
            catch (error) {
                this.emitLog(`Warning: Failed to parse production environment variables, continuing without copied values: ${error instanceof Error ? error.message : String(error)}`, 'warning');
            }
        }
        if (customEnvVars) {
            for (const [key, value] of Object.entries(customEnvVars)) {
                const sanitizedKey = key.trim();
                if (!sanitizedKey)
                    continue;
                resolvedEnvVars[sanitizedKey] = value === undefined || value === null ? '' : String(value);
            }
        }
        const envVars = Object.keys(resolvedEnvVars).length > 0
            ? JSON.stringify(resolvedEnvVars)
            : null;
        // 7. Create stack record
        const stackId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        const productionPathInfo = (0, pathUtils_1.resolveStackWorkingDir)({
            stack_path: productionStack.stack_path,
            project_name: productionStack.project_name,
        });
        const stackBasePath = productionPathInfo.normalizedStackPath || '/root/server-compass/apps';
        const stackWorkingDir = stackBasePath === '/' ? `/${projectName}` : `${stackBasePath}/${projectName}`;
        const gitClonePath = productionStack.github_repo && needsBuildContext
            ? `${stackWorkingDir}/repo`
            : null;
        if (productionPathInfo.needsNormalization) {
            db_1.queries.updateDockerStack(productionStack.id, {
                stack_path: productionPathInfo.normalizedStackPath,
            });
        }
        try {
            db_1.queries.createDockerStack({
                id: stackId,
                server_id: serverId,
                project_name: projectName,
                source_type: productionStack.source_type,
                template_id: productionStack.template_id,
                compose_content: clonedCompose,
                dockerfile_content: productionStack.dockerfile_content,
                env_vars: envVars,
                stack_path: stackBasePath,
                registry_credential_id: productionStack.registry_credential_id,
                build_on_deploy: productionStack.build_on_deploy,
                pull_policy: productionStack.pull_policy,
                status: 'pending',
                last_deployed_at: null,
                last_error: null,
                services_count: productionStack.services_count,
                ci_enabled: wantsGitHubActionsBuild ? 1 : 0,
                webhook_secret: null,
                webhook_url: null,
                current_image_digest: null,
                last_webhook_at: null,
                github_repo: productionStack.github_repo,
                git_account_id: productionStack.git_account_id,
                git_branch: selectedBranch,
                git_clone_path: gitClonePath,
                git_pull_on_redeploy: productionStack.git_pull_on_redeploy,
                git_last_commit: null,
                generation_method: productionStack.generation_method,
                generation_config: productionStack.generation_config,
                nixpacks_version: productionStack.nixpacks_version,
                has_pending_failure: null,
                last_successful_deployment_id: null,
                failed_compose_content: null,
                // Environment-specific fields
                environment_type: environmentType,
                parent_stack_id: productionStackId,
                subdomain_prefix: sanitizedSubdomainPrefix,
                auto_deploy_rules: null,
                ttl_days: null, // TTL feature disabled
                last_activity_at: now,
                build_location: wantsGitHubActionsBuild ? 'github-actions' : 'vps',
            });
        }
        catch (error) {
            return {
                success: false,
                error: `Failed to create environment record: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        // 8. Ensure Traefik file provider is enabled
        try {
            await this.traefikService.ensureFileProviderEnabled(serverId);
        }
        catch (error) {
            this.emitLog(`Warning: Could not verify Traefik file provider: ${error}`, 'warning', stackId);
        }
        // 9. Create stack directory and write compose file
        try {
            await this.sshService.executeCommand(serverId, `mkdir -p '${stackWorkingDir}'`);
            // Write compose file
            const composeCmd = `cat > '${stackWorkingDir}/docker-compose.yml' << 'COMPOSEEOF'
${clonedCompose}
COMPOSEEOF`;
            await this.sshService.executeCommand(serverId, composeCmd);
            // Write .env file if we have env vars
            if (envVars) {
                const envContent = Object.entries(resolvedEnvVars)
                    .map(([key, value]) => `${key}=${value}`)
                    .join('\n');
                const envCmd = `cat > '${stackWorkingDir}/.env' << 'ENVEOF'
${envContent}
ENVEOF`;
                await this.sshService.executeCommand(serverId, envCmd);
            }
            else {
                await this.sshService.executeCommand(serverId, `touch '${stackWorkingDir}/.env'`);
            }
            // Clone repository for GitHub-linked stacks that build from source
            if (productionStack.github_repo && needsBuildContext && gitClonePath) {
                const targetBranch = selectedBranch || 'main';
                this.emitLog(`Cloning repository for build: ${productionStack.github_repo} (branch: ${targetBranch})`, 'info', stackId);
                // Format: owner/repo or full GitHub URL
                let repoUrl = productionStack.github_repo;
                if (!repoUrl.includes('github.com')) {
                    repoUrl = `https://github.com/${productionStack.github_repo}.git`;
                }
                else if (!repoUrl.endsWith('.git')) {
                    repoUrl = `${repoUrl}.git`;
                }
                // Clone the repository to the repo subdirectory
                const cloneCmd = `git clone --depth 1 --branch '${targetBranch}' '${repoUrl}' '${gitClonePath}' 2>&1`;
                const cloneResult = await this.sshService.executeCommand(serverId, cloneCmd);
                if (cloneResult.exitCode !== 0) {
                    throw new Error(`Failed to clone repository: ${cloneResult.stderr || cloneResult.stdout}`);
                }
                this.emitLog('Repository cloned successfully', 'success', stackId);
                // Write Dockerfile if provided
                if (productionStack.dockerfile_content) {
                    const dockerfileCmd = `cat > '${gitClonePath}/Dockerfile' << 'DOCKERFILEEOF'
${productionStack.dockerfile_content}
DOCKERFILEEOF`;
                    await this.sshService.executeCommand(serverId, dockerfileCmd);
                }
            }
        }
        catch (error) {
            db_1.queries.deleteDockerStack(stackId);
            return {
                success: false,
                error: `Failed to write compose files: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        // 10. Deploy the stack
        this.emitLog(wantsGitHubActionsBuild ? 'Triggering GitHub Actions build + deploy...' : 'Deploying environment containers...', 'info', stackId);
        try {
            await this.ensureExternalNetworksExist(serverId, clonedCompose, stackId);
            if (wantsGitHubActionsBuild) {
                if (!parsedRepo || !imageTag) {
                    throw new Error('GitHub Actions build setup is missing repository information.');
                }
                const envFileContent = Object.entries(resolvedEnvVars)
                    .map(([key, value]) => `${key}=${value}`)
                    .join('\n');
                const githubActionsDockerService = new GitHubActionsDockerService_1.GitHubActionsDockerService(this.sshService);
                const setupResult = await githubActionsDockerService.setupDockerDeployment({
                    serverId,
                    projectName,
                    repoOwner: parsedRepo.owner,
                    repoName: parsedRepo.repo,
                    branch: selectedBranch || 'main',
                    appPath: stackWorkingDir,
                    port: hostPort || 3000,
                    imageTag,
                    includeTraefikPublicNetwork: true,
                    framework: 'docker',
                    gitAccountId: productionStack.git_account_id || '',
                    envFileContent,
                    dockerfileContent: productionStack.dockerfile_content || undefined,
                });
                if (!setupResult.success || !setupResult.data) {
                    throw new Error(setupResult.error || 'Failed to trigger GitHub Actions deployment');
                }
                db_1.queries.updateDockerStack(stackId, {
                    status: 'deploying',
                    last_error: null,
                    last_activity_at: Date.now(),
                });
            }
            else {
                const deployResult = await this.sshService.executeCommand(serverId, `cd '${stackWorkingDir}' && docker compose -p ${projectName} up -d --build`);
                if (deployResult.exitCode !== 0) {
                    throw new Error(deployResult.stderr || 'Docker compose up failed');
                }
                db_1.queries.updateDockerStack(stackId, {
                    status: 'running',
                    last_deployed_at: Date.now(),
                    last_activity_at: Date.now(),
                });
            }
        }
        catch (error) {
            db_1.queries.updateDockerStack(stackId, {
                status: 'error',
                last_error: error instanceof Error ? error.message : String(error),
            });
            return {
                success: false,
                error: `Failed to deploy containers: ${error instanceof Error ? error.message : String(error)}`,
                stackId,
            };
        }
        // 11. Create domain record (only if a domain is configured)
        if (envDomain) {
            const domainId = (0, crypto_1.randomUUID)();
            try {
                db_1.queries.createDomain({
                    id: domainId,
                    server_id: serverId,
                    deployment_id: null,
                    stack_id: stackId,
                    domain: envDomain,
                    port: containerPort,
                    ssl_enabled: 1,
                    https_redirect: 1,
                    www_redirect: 0,
                    certificate_resolver: 'letsencrypt',
                    router_name: envDomain.replace(/\./g, '-'),
                    entrypoints: 'websecure',
                    middlewares: null,
                    custom_headers: null,
                    dns_verified: 0,
                    certificate_status: null,
                    last_certificate_check: null,
                    proxy_type: 'traefik',
                    is_primary: 1,
                });
            }
            catch (error) {
                this.emitLog(`Warning: Could not create domain record: ${error}`, 'warning', stackId);
            }
            // 12. Write Traefik dynamic config
            try {
                await this.traefikRouter.switchTraffic(serverId, envDomain, `${projectName}-app`, containerPort, true // SSL enabled
                );
                this.emitLog('Traefik routing configured', 'success', stackId);
            }
            catch (error) {
                this.emitLog(`Warning: Could not configure Traefik routing: ${error}`, 'warning', stackId);
            }
        }
        const successMessage = wantsGitHubActionsBuild
            ? (envDomain
                ? `Environment created. GitHub Actions build started: ${envDomain}`
                : `Environment created. GitHub Actions build started on port ${hostPort}`)
            : (envDomain
                ? `Environment created successfully: ${envDomain}`
                : `Environment created successfully on port ${hostPort}`);
        this.emitLog(successMessage, 'success', stackId);
        return {
            success: true,
            stackId,
            projectName,
            hostPort,
        };
    }
    /**
     * List all environments for a production stack
     */
    listEnvironments(productionStackId) {
        const environments = db_1.db.prepare(`
      SELECT
        ds.id,
        ds.project_name,
        ds.environment_type,
        ds.subdomain_prefix,
        ds.status,
        ds.git_branch,
        ds.last_deployed_at,
        ds.last_activity_at,
        ds.ttl_days,
        ds.created_at,
        ds.compose_content,
        d.domain,
        d.port as domain_port
      FROM docker_stacks ds
      LEFT JOIN domains d ON d.stack_id = ds.id AND d.is_primary = 1
      WHERE ds.parent_stack_id = ? OR ds.id = ?
      ORDER BY
        CASE ds.environment_type
          WHEN 'production' THEN 0
          WHEN 'staging' THEN 1
          WHEN 'preview' THEN 2
        END,
        ds.created_at DESC
    `).all(productionStackId, productionStackId);
        return environments.map(env => {
            // Extract port from compose content if not in domains table
            let port = env.domain_port;
            if (!port && env.compose_content) {
                const portMatch = env.compose_content.match(/ports:\s*\n\s*-\s*["']?(\d+):/);
                if (portMatch) {
                    port = parseInt(portMatch[1], 10);
                }
            }
            return {
                id: env.id,
                stackId: env.id,
                projectName: env.project_name,
                environmentType: env.environment_type,
                subdomainPrefix: env.subdomain_prefix,
                domain: env.domain,
                status: env.status,
                branchName: env.git_branch,
                lastDeployedAt: env.last_deployed_at,
                lastActivityAt: env.last_activity_at,
                createdAt: env.created_at,
                port,
            };
        });
    }
    /**
     * Delete an environment
     */
    async deleteEnvironment(serverId, stackId) {
        const stack = db_1.queries.getDockerStack(stackId);
        if (!stack) {
            return { success: false, error: 'Stack not found' };
        }
        if (stack.server_id !== serverId) {
            return { success: false, error: 'Stack does not belong to this server' };
        }
        if (stack.environment_type === 'production') {
            return {
                success: false,
                error: 'Cannot delete production environment. Delete environments first, then delete the production stack.',
            };
        }
        const stackPathInfo = (0, pathUtils_1.resolveStackWorkingDir)({
            stack_path: stack.stack_path,
            project_name: stack.project_name,
        });
        const stackWorkingDir = stackPathInfo.workingDir;
        if (stackPathInfo.needsNormalization) {
            db_1.queries.updateDockerStack(stack.id, {
                stack_path: stackPathInfo.normalizedStackPath,
            });
        }
        this.emitLog(`Deleting ${stack.environment_type} environment: ${stack.project_name}`, 'info', stackId);
        // 1. Stop and remove containers
        try {
            await this.sshService.executeCommand(serverId, `cd '${stackWorkingDir}' && docker compose -p ${stack.project_name} down -v --remove-orphans 2>/dev/null || true`);
        }
        catch (error) {
            this.emitLog(`Warning: Could not stop containers: ${error}`, 'warning', stackId);
        }
        // 2. Remove Traefik dynamic config
        const domain = this.getPrimaryDomainForStack(stackId);
        if (domain) {
            try {
                await this.traefikRouter.removeDynamicConfig(serverId, domain.domain);
            }
            catch (error) {
                this.emitLog(`Warning: Could not remove Traefik config: ${error}`, 'warning', stackId);
            }
        }
        // 3. Remove stack directory
        try {
            await this.sshService.executeCommand(serverId, `rm -rf '${stackWorkingDir}'`);
        }
        catch (error) {
            this.emitLog(`Warning: Could not remove stack directory: ${error}`, 'warning', stackId);
        }
        // 4. Delete database records
        // Domains are deleted via CASCADE or manually
        db_1.db.prepare('DELETE FROM domains WHERE stack_id = ?').run(stackId);
        db_1.queries.deleteDockerStack(stackId);
        this.emitLog(`Environment deleted: ${stack.project_name}`, 'success');
        return { success: true };
    }
    /**
     * Promote staging to production
     * Uses zero-downtime deployment to update production with staging's config
     */
    async promoteToProduction(options) {
        const { serverId, stagingStackId, deploymentStrategy: _deploymentStrategy = 'zero_downtime', keepStaging = false, createBackup = true, } = options;
        // 1. Get staging stack
        const stagingStack = db_1.queries.getDockerStack(stagingStackId);
        if (!stagingStack) {
            return { success: false, error: 'Staging stack not found' };
        }
        if (stagingStack.server_id !== serverId) {
            return { success: false, error: 'Stack does not belong to this server' };
        }
        if (stagingStack.environment_type !== 'staging') {
            return {
                success: false,
                error: 'Can only promote staging environments to production',
            };
        }
        if (!stagingStack.parent_stack_id) {
            return { success: false, error: 'Staging stack has no parent production stack' };
        }
        // 2. Get production stack
        const productionStack = db_1.queries.getDockerStack(stagingStack.parent_stack_id);
        if (!productionStack) {
            return { success: false, error: 'Parent production stack not found' };
        }
        const productionPathInfo = (0, pathUtils_1.resolveStackWorkingDir)({
            stack_path: productionStack.stack_path,
            project_name: productionStack.project_name,
        });
        const stagingPathInfo = (0, pathUtils_1.resolveStackWorkingDir)({
            stack_path: stagingStack.stack_path,
            project_name: stagingStack.project_name,
        });
        const productionPath = productionPathInfo.workingDir;
        const stagingPath = stagingPathInfo.workingDir;
        if (productionPathInfo.needsNormalization) {
            db_1.queries.updateDockerStack(productionStack.id, {
                stack_path: productionPathInfo.normalizedStackPath,
            });
        }
        if (stagingPathInfo.needsNormalization) {
            db_1.queries.updateDockerStack(stagingStack.id, {
                stack_path: stagingPathInfo.normalizedStackPath,
            });
        }
        const promotedComposeContent = this.buildComposeForPromotion(stagingStack.compose_content, productionStack.compose_content);
        const promotedNeedsBuildContext = this.composeNeedsBuildContext(promotedComposeContent);
        const promotionDeploymentId = (0, crypto_1.randomUUID)();
        const promotionStartedAt = Date.now();
        const promotionBuildOutputs = [];
        const promotionUpOutputs = [
            `Promotion from staging "${stagingStack.project_name}" to production "${productionStack.project_name}"`,
        ];
        const promotionLogEntries = [];
        const appendPromotionLog = (message, type = 'info', stackId = productionStack.id) => {
            this.emitLog(message, type, stackId);
            promotionLogEntries.push(`[${new Date().toISOString()}] [${type.toUpperCase()}] ${message}`);
        };
        const appendCommandOutput = (target, output) => {
            const trimmed = output?.trim();
            if (trimmed) {
                target.push(trimmed);
            }
        };
        db_1.queries.createDockerStackDeployment({
            id: promotionDeploymentId,
            stack_id: productionStack.id,
            triggered_by: 'manual',
            started_at: promotionStartedAt,
            finished_at: null,
            status: 'starting',
            pull_output: null,
            build_output: null,
            up_output: promotionUpOutputs[0],
            error_message: null,
            deployed_images: null,
            previous_compose_content: productionStack.compose_content,
            logs: null,
            git_commit_hash: stagingStack.git_last_commit || null,
            build_location: productionStack.build_location,
        });
        db_1.queries.updateDockerStackDeployment(promotionDeploymentId, {
            git_commit_hash: stagingStack.git_last_commit || null,
        });
        appendPromotionLog(`Promoting staging "${stagingStack.project_name}" to production "${productionStack.project_name}"`, 'info');
        // 3. Create backup of current production config if requested
        if (createBackup) {
            const backupCompose = productionStack.compose_content;
            // Note: backupEnv could be stored in a separate field if needed
            // const backupEnv = productionStack.env_vars;
            // Store backup in deployment history
            const backupDeploymentId = (0, crypto_1.randomUUID)();
            db_1.queries.createDockerStackDeployment({
                id: backupDeploymentId,
                stack_id: productionStack.id,
                triggered_by: 'manual',
                started_at: Date.now(),
                finished_at: Date.now(),
                status: 'success',
                pull_output: null,
                build_output: null,
                up_output: 'Pre-promote backup',
                error_message: null,
                deployed_images: null,
                previous_compose_content: backupCompose,
                logs: null,
                git_commit_hash: productionStack.git_last_commit,
                build_location: productionStack.build_location,
            });
            appendPromotionLog('Created backup of current production config', 'info');
        }
        // 4. Mark production as deploying before applying promoted config.
        db_1.queries.updateDockerStack(productionStack.id, {
            status: 'deploying',
            last_error: null,
            last_activity_at: Date.now(),
        });
        // 5. Deploy to production using the appropriate strategy
        // This is a simplified version - in practice, you'd call the full redeploy
        appendPromotionLog('Deploying to production...', 'info', productionStack.id);
        try {
            await this.sshService.executeCommand(serverId, `mkdir -p '${productionPath}'`);
            if (promotedNeedsBuildContext) {
                const productionRepoPath = `${productionPath}/repo`;
                const stagingRepoPath = `${stagingPath}/repo`;
                const hasStagingRepo = await this.sshService.executeCommand(serverId, `[ -d '${stagingRepoPath}' ] && echo "yes" || echo "no"`);
                if (hasStagingRepo.stdout.trim() === 'yes') {
                    appendPromotionLog('Syncing build context from staging to production...', 'info', productionStack.id);
                    await this.sshService.executeCommand(serverId, `rm -rf '${productionRepoPath}' && cp -R '${stagingRepoPath}' '${productionRepoPath}'`);
                }
                else {
                    const repoRef = stagingStack.github_repo || productionStack.github_repo;
                    if (!repoRef) {
                        throw new Error('Build context requires repository source but no GitHub repository is linked to this stack.');
                    }
                    let repoUrl = repoRef;
                    if (!repoUrl.includes('github.com')) {
                        repoUrl = `https://github.com/${repoUrl}.git`;
                    }
                    else if (!repoUrl.endsWith('.git')) {
                        repoUrl = `${repoUrl}.git`;
                    }
                    const targetBranch = stagingStack.git_branch || productionStack.git_branch || 'main';
                    appendPromotionLog(`Cloning repository for production build context (${targetBranch})...`, 'info', productionStack.id);
                    const cloneResult = await this.sshService.executeCommand(serverId, `rm -rf '${productionRepoPath}' && git clone --depth 1 --branch '${targetBranch}' '${repoUrl}' '${productionRepoPath}' 2>&1`);
                    appendCommandOutput(promotionBuildOutputs, cloneResult.stdout);
                    appendCommandOutput(promotionBuildOutputs, cloneResult.stderr);
                    if (cloneResult.exitCode !== 0) {
                        throw new Error(cloneResult.stderr || cloneResult.stdout || 'Failed to clone repository');
                    }
                }
                if (stagingStack.dockerfile_content) {
                    const dockerfileCmd = `cat > '${productionPath}/repo/Dockerfile' << 'DOCKERFILEEOF'
${stagingStack.dockerfile_content}
DOCKERFILEEOF`;
                    await this.sshService.executeCommand(serverId, dockerfileCmd);
                }
            }
            // Write new compose file
            const composeCmd = `cat > '${productionPath}/docker-compose.yml' << 'COMPOSEEOF'
${promotedComposeContent}
COMPOSEEOF`;
            await this.sshService.executeCommand(serverId, composeCmd);
            // Write .env file
            if (stagingStack.env_vars) {
                const envContent = Object.entries(JSON.parse(stagingStack.env_vars))
                    .map(([key, value]) => `${key}=${value}`)
                    .join('\n');
                const envCmd = `cat > '${productionPath}/.env' << 'ENVEOF'
${envContent}
ENVEOF`;
                await this.sshService.executeCommand(serverId, envCmd);
            }
            // Deploy
            await this.ensureExternalNetworksExist(serverId, promotedComposeContent, productionStack.id);
            const deployResult = await this.sshService.executeCommand(serverId, `cd '${productionPath}' && docker compose -p ${productionStack.project_name} up -d --build`);
            appendCommandOutput(promotionUpOutputs, deployResult.stdout);
            appendCommandOutput(promotionUpOutputs, deployResult.stderr);
            if (deployResult.exitCode !== 0) {
                throw new Error(deployResult.stderr || 'Docker compose up failed');
            }
            db_1.queries.updateDockerStack(productionStack.id, {
                compose_content: promotedComposeContent,
                env_vars: stagingStack.env_vars,
                git_branch: stagingStack.git_branch,
                git_last_commit: stagingStack.git_last_commit,
                dockerfile_content: stagingStack.dockerfile_content,
                git_clone_path: promotedNeedsBuildContext ? `${productionPath}/repo` : productionStack.git_clone_path,
                status: 'running',
                last_deployed_at: Date.now(),
                last_error: null,
                last_activity_at: Date.now(),
                last_successful_deployment_id: promotionDeploymentId,
                has_pending_failure: 0,
            });
            appendPromotionLog('Production deployment complete', 'success', productionStack.id);
        }
        catch (error) {
            const rollbackMessage = error instanceof Error ? error.message : String(error);
            // Restore DB state so retries are based on the last known production config.
            db_1.queries.updateDockerStack(productionStack.id, {
                compose_content: productionStack.compose_content,
                env_vars: productionStack.env_vars,
                git_branch: productionStack.git_branch,
                git_last_commit: productionStack.git_last_commit,
                dockerfile_content: productionStack.dockerfile_content,
                git_clone_path: productionStack.git_clone_path,
                status: productionStack.status || 'error',
                last_error: rollbackMessage,
                last_activity_at: Date.now(),
            });
            // Best-effort runtime rollback on server.
            try {
                appendPromotionLog('Promotion failed. Restoring previous production configuration...', 'warning', productionStack.id);
                const rollbackComposeCmd = `cat > '${productionPath}/docker-compose.yml' << 'COMPOSEEOF'
${productionStack.compose_content}
COMPOSEEOF`;
                await this.sshService.executeCommand(serverId, rollbackComposeCmd);
                const previousEnvVars = productionStack.env_vars
                    ? Object.entries(JSON.parse(productionStack.env_vars))
                        .map(([key, value]) => `${key}=${value}`)
                        .join('\n')
                    : '';
                const rollbackEnvCmd = `cat > '${productionPath}/.env' << 'ENVEOF'
${previousEnvVars}
ENVEOF`;
                await this.sshService.executeCommand(serverId, rollbackEnvCmd);
                await this.ensureExternalNetworksExist(serverId, productionStack.compose_content, productionStack.id);
                const rollbackDeployResult = await this.sshService.executeCommand(serverId, `cd '${productionPath}' && docker compose -p ${productionStack.project_name} up -d --build`);
                appendCommandOutput(promotionUpOutputs, rollbackDeployResult.stdout);
                appendCommandOutput(promotionUpOutputs, rollbackDeployResult.stderr);
                appendPromotionLog('Previous production configuration restored', 'warning', productionStack.id);
            }
            catch (rollbackError) {
                appendPromotionLog(`Rollback after failed promote also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, 'error', productionStack.id);
            }
            db_1.queries.updateDockerStackDeployment(promotionDeploymentId, {
                status: 'failed',
                finished_at: Date.now(),
                build_output: promotionBuildOutputs.length > 0 ? promotionBuildOutputs.join('\n\n') : null,
                up_output: promotionUpOutputs.length > 0 ? promotionUpOutputs.join('\n\n') : null,
                error_message: `Failed to deploy to production: ${rollbackMessage}`,
                logs: promotionLogEntries.length > 0 ? promotionLogEntries.join('\n') : null,
                previous_compose_content: productionStack.compose_content,
                git_commit_hash: stagingStack.git_last_commit || null,
            });
            return {
                success: false,
                error: `Failed to deploy to production: ${rollbackMessage}`,
                stackId: productionStack.id,
            };
        }
        // 6. Optionally delete staging
        if (!keepStaging) {
            appendPromotionLog('Removing staging environment...', 'info', productionStack.id);
            const deleteResult = await this.deleteEnvironment(serverId, stagingStackId);
            if (!deleteResult.success) {
                appendPromotionLog(`Failed to remove staging environment after promote: ${deleteResult.error || 'Unknown error'}`, 'warning', productionStack.id);
            }
        }
        db_1.queries.updateDockerStackDeployment(promotionDeploymentId, {
            status: 'success',
            finished_at: Date.now(),
            build_output: promotionBuildOutputs.length > 0 ? promotionBuildOutputs.join('\n\n') : null,
            up_output: promotionUpOutputs.length > 0 ? promotionUpOutputs.join('\n\n') : null,
            error_message: null,
            logs: promotionLogEntries.length > 0 ? promotionLogEntries.join('\n') : null,
            previous_compose_content: productionStack.compose_content,
            git_commit_hash: stagingStack.git_last_commit || null,
        });
        return {
            success: true,
            stackId: productionStack.id,
            projectName: productionStack.project_name,
        };
    }
    /**
     * Clean up expired preview environments based on TTL
     */
    async cleanupExpiredPreviews(serverId) {
        const now = Date.now();
        const oneDayMs = 24 * 60 * 60 * 1000;
        // Find previews that have exceeded their TTL
        const expiredPreviews = db_1.db.prepare(`
      SELECT id, project_name, ttl_days, last_activity_at
      FROM docker_stacks
      WHERE server_id = ?
        AND environment_type = 'preview'
        AND ttl_days IS NOT NULL
        AND last_activity_at IS NOT NULL
        AND (? - last_activity_at) > (ttl_days * ?)
    `).all(serverId, now, oneDayMs);
        let cleaned = 0;
        const errors = [];
        for (const preview of expiredPreviews) {
            this.emitLog(`Cleaning up expired preview: ${preview.project_name}`, 'info');
            const result = await this.deleteEnvironment(serverId, preview.id);
            if (result.success) {
                cleaned++;
            }
            else {
                errors.push(`${preview.project_name}: ${result.error}`);
            }
        }
        return { cleaned, errors };
    }
    /**
     * Reconcile environments from server
     * Imports server-side environments that exist but aren't in the database
     */
    async reconcileEnvironments(serverId, productionStackId) {
        const productionStack = db_1.queries.getDockerStack(productionStackId);
        if (!productionStack) {
            return { imported: [], orphaned: [] };
        }
        const envPrefix = `${productionStack.project_name}-env-`;
        const imported = [];
        const orphaned = [];
        // List Docker compose projects on server
        const result = await this.sshService.executeCommand(serverId, `docker compose ls --format json 2>/dev/null || echo '[]'`);
        try {
            const projects = JSON.parse(result.stdout);
            for (const project of projects) {
                // Check if this looks like an environment for our production stack
                if (project.Name.startsWith(envPrefix)) {
                    // Extract subdomain prefix for future use
                    // const subdomainPrefix = project.Name.slice(envPrefix.length);
                    // Check if we already have this in the database
                    const existingStack = db_1.queries.getDockerStackByProjectName(serverId, project.Name);
                    if (!existingStack) {
                        // Import this environment
                        this.emitLog(`Found untracked environment: ${project.Name}`, 'info');
                        // For now, just track it as orphaned - full import would require
                        // reading the compose file and determining environment type
                        orphaned.push(project.Name);
                    }
                }
            }
            // Also check for database entries without server-side containers
            const dbEnvironments = this.listEnvironments(productionStackId).filter(env => env.environmentType !== 'production');
            const serverProjects = new Set(projects.map(p => p.Name));
            for (const env of dbEnvironments) {
                if (!serverProjects.has(env.projectName)) {
                    this.emitLog(`Environment ${env.projectName} not found on server`, 'warning');
                    orphaned.push(env.projectName);
                }
            }
        }
        catch (error) {
            console.error('[EnvironmentService] Failed to reconcile:', error);
        }
        return { imported, orphaned };
    }
    /**
     * Deploy a branch to an environment
     * Creates or updates an environment for the given branch
     */
    async deployBranch(serverId, productionStackId, branchName, environmentType = 'preview') {
        // Generate environment name from branch name
        const environmentName = branchName
            .replace(/^refs\/heads\//, '')
            .replace(/\//g, '-')
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50) || 'branch';
        // Check if environment already exists for this branch
        const existingEnv = db_1.db.prepare(`
      SELECT id FROM docker_stacks
      WHERE parent_stack_id = ?
        AND git_branch = ?
        AND environment_type = ?
    `).get(productionStackId, branchName, environmentType);
        if (existingEnv) {
            // Update existing environment - trigger redeploy
            this.emitLog(`Redeploying existing environment for branch: ${branchName}`, 'info');
            // TODO: Trigger redeploy for existing environment
            return {
                success: true,
                stackId: existingEnv.id,
            };
        }
        // Create new environment
        return this.createEnvironment({
            serverId,
            productionStackId,
            environmentType,
            environmentName,
            branchName,
            copyEnvVars: true,
        });
    }
    /**
     * Update auto-deploy rules for a production stack
     */
    updateAutoDeployRules(stackId, rules) {
        db_1.queries.updateDockerStack(stackId, {
            auto_deploy_rules: JSON.stringify(rules),
        });
    }
    /**
     * Get auto-deploy rules for a production stack
     */
    getAutoDeployRules(stackId) {
        const stack = db_1.queries.getDockerStack(stackId);
        if (!stack?.auto_deploy_rules) {
            return [];
        }
        try {
            return JSON.parse(stack.auto_deploy_rules);
        }
        catch {
            return [];
        }
    }
}
exports.EnvironmentService = EnvironmentService;
// Singleton instance
let environmentServiceInstance = null;
function createEnvironmentService(sshService, traefikRouter, traefikService) {
    if (!environmentServiceInstance) {
        environmentServiceInstance = new EnvironmentService(sshService, traefikRouter, traefikService);
    }
    return environmentServiceInstance;
}
function getEnvironmentService() {
    return environmentServiceInstance;
}
//# sourceMappingURL=EnvironmentService.js.map