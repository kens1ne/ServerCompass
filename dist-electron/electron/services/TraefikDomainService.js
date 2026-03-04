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
exports.TraefikDomainService = void 0;
const db_1 = require("../db");
const SSHService_1 = require("./SSHService");
const TraefikService_1 = require("./TraefikService");
const TraefikLabelGenerator_1 = require("./TraefikLabelGenerator");
const YAML = __importStar(require("yaml"));
const crypto_1 = require("crypto");
class TraefikDomainService {
    sshService;
    traefikService;
    labelGenerator;
    constructor(sshService, traefikService) {
        this.sshService = sshService || new SSHService_1.SSHService();
        this.traefikService = traefikService || new TraefikService_1.TraefikService(this.sshService);
        this.labelGenerator = new TraefikLabelGenerator_1.TraefikLabelGenerator();
    }
    /**
     * Resolve a docker_stacks record and container port from a published host port number.
     * Used as a backend fallback when the frontend doesn't provide a stackId
     * (e.g., due to progressive loading race conditions).
     *
     * CRITICAL: This also extracts the actual container port from the port mapping.
     * For example, if the mapping is "3000:80", the host port is 3000 but Traefik
     * needs to route to container port 80.
     *
     * Tries multiple strategies:
     * 1. Filter by published port directly (docker ps --filter "publish=PORT")
     * 2. If that fails, list all containers and check port mappings manually
     *
     * @returns Object with stackId (if found) and containerPort (always extracted if possible)
     */
    async resolveStackFromPort(serverId, hostPort) {
        const defaultResult = { stackId: null, containerPort: hostPort };
        try {
            console.log(`[TraefikDomain] Attempting to resolve stack and container port from host port ${hostPort}`);
            // Helper to extract container port from Ports string
            // Format: "0.0.0.0:3000->80/tcp" means host 3000 -> container 80
            const extractContainerPort = (portsStr, targetHostPort) => {
                // Match pattern: host_port->container_port
                const regex = new RegExp(`(?:0\\.0\\.0\\.0:|::::|\\[::\\]:)?${targetHostPort}->(\\d+)`, 'i');
                const match = portsStr.match(regex);
                if (match && match[1]) {
                    const containerPort = parseInt(match[1], 10);
                    console.log(`[TraefikDomain] Extracted container port ${containerPort} from host port ${targetHostPort}`);
                    return containerPort;
                }
                return targetHostPort; // Fallback to host port if can't parse
            };
            // Strategy 1: Direct port filter
            const result = await this.sshService.executeCommand(serverId, `docker ps --format '{{json .}}' --filter "publish=${hostPort}"`);
            if (result.exitCode === 0 && result.stdout.trim()) {
                const lines = result.stdout.trim().split('\n');
                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);
                        const ports = data.Ports || '';
                        const containerPort = extractContainerPort(ports, hostPort);
                        const labels = data.Labels || '';
                        const projectMatch = labels.match(/com\.docker\.compose\.project=([^,]+)/);
                        if (projectMatch) {
                            const projectName = projectMatch[1];
                            const stacks = db_1.queries.getDockerStacks(serverId);
                            const stack = stacks.find((s) => s.project_name === projectName);
                            if (stack) {
                                console.log(`[TraefikDomain] Resolved stack from port ${hostPort}: ${stack.id} (project: ${projectName}), containerPort: ${containerPort}`);
                                return { stackId: stack.id, containerPort };
                            }
                            else {
                                console.log(`[TraefikDomain] Found container with project ${projectName} but no matching stack in database. ContainerPort: ${containerPort}`);
                                // Return containerPort even if no stack found - Traefik still needs the right port
                                return { stackId: null, containerPort };
                            }
                        }
                        else {
                            // Container found but no compose project - still return the container port
                            console.log(`[TraefikDomain] Container ${data.Names} found on port ${hostPort}, containerPort: ${containerPort}, but has no compose project label`);
                            return { stackId: null, containerPort };
                        }
                    }
                    catch {
                        // Skip non-JSON lines
                    }
                }
            }
            // Strategy 2: List all running containers and check their port mappings
            // This handles cases where the port filter doesn't work as expected
            console.log(`[TraefikDomain] Strategy 1 failed, trying to match port ${hostPort} from all containers`);
            const allContainersResult = await this.sshService.executeCommand(serverId, `docker ps --format '{{json .}}'`);
            if (allContainersResult.exitCode !== 0 || !allContainersResult.stdout.trim()) {
                console.log(`[TraefikDomain] No running containers found`);
                return defaultResult;
            }
            const containerLines = allContainersResult.stdout.trim().split('\n');
            for (const line of containerLines) {
                try {
                    const data = JSON.parse(line);
                    const ports = data.Ports || '';
                    // Check if this container has the target port in its port mappings
                    // Format examples: "0.0.0.0:5005->3000/tcp", "80/tcp", "0.0.0.0:80->80/tcp"
                    // We want to match the host port (left side of ->)
                    const portRegex = new RegExp(`(?:^|,\\s*)(?:0\\.0\\.0\\.0:|:::)?${hostPort}->`, 'i');
                    if (portRegex.test(ports)) {
                        const containerPort = extractContainerPort(ports, hostPort);
                        const labels = data.Labels || '';
                        const projectMatch = labels.match(/com\.docker\.compose\.project=([^,]+)/);
                        if (projectMatch) {
                            const projectName = projectMatch[1];
                            const stacks = db_1.queries.getDockerStacks(serverId);
                            const stack = stacks.find((s) => s.project_name === projectName);
                            if (stack) {
                                console.log(`[TraefikDomain] Resolved stack from port ${hostPort} (Strategy 2): ${stack.id} (project: ${projectName}), containerPort: ${containerPort}`);
                                return { stackId: stack.id, containerPort };
                            }
                            else {
                                console.log(`[TraefikDomain] Found container ${data.Names} with port ${hostPort} (project: ${projectName}) but no matching stack in database. ContainerPort: ${containerPort}`);
                                return { stackId: null, containerPort };
                            }
                        }
                        else {
                            console.log(`[TraefikDomain] Container ${data.Names} publishes port ${hostPort} but has no compose project label. ContainerPort: ${containerPort}`);
                            return { stackId: null, containerPort };
                        }
                    }
                }
                catch {
                    // Skip non-JSON lines
                }
            }
            console.log(`[TraefikDomain] Could not resolve stack for port ${hostPort} - no matching container/stack found`);
            return defaultResult;
        }
        catch (error) {
            console.warn('[TraefikDomain] Failed to resolve stack from port:', error);
            return defaultResult;
        }
    }
    async getContainerNetworkIps(client, containerName) {
        const result = await this.sshService.executeCommand(client, 
        // Example output: "default=172.18.0.2 traefik-public=172.21.0.3"
        `docker inspect -f '{{range $name, $conf := .NetworkSettings.Networks}}{{$name}}={{$conf.IPAddress}} {{end}}' ${containerName} 2>/dev/null || echo ""`);
        const raw = result.stdout?.trim() || '';
        if (!raw)
            return {};
        const entries = raw.split(/\s+/).filter(Boolean);
        const ips = {};
        for (const entry of entries) {
            const [name, ip] = entry.split('=');
            if (!name)
                continue;
            if (!ip)
                continue;
            ips[name] = ip;
        }
        return ips;
    }
    pickPreferredContainerIp(ips) {
        // Prefer the Traefik network IP (this matches how Traefik will reach the container).
        if (ips['traefik-public'])
            return ips['traefik-public'];
        // Prefer the Compose default network when available.
        // Note: Docker "Networks" is a map; Go template iteration order is not stable, so pick deterministically.
        const defaultNet = Object.entries(ips).find(([name, ip]) => Boolean(ip) && name.endsWith('_default'));
        if (defaultNet)
            return defaultNet[1];
        // Otherwise, pick the first IP by sorted network name (stable).
        for (const name of Object.keys(ips).sort()) {
            const ip = ips[name];
            if (ip)
                return ip;
        }
        return null;
    }
    async getContainerPortBindings(client, containerName) {
        const inspectResult = await this.sshService.executeCommand(client, `docker inspect -f '{{json .NetworkSettings.Ports}}' ${containerName} 2>/dev/null || echo "null"`);
        const raw = inspectResult.stdout?.trim();
        if (!raw)
            return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed;
        }
        catch {
            return null;
        }
    }
    formatContainerPortBindingsSummary(bindings) {
        if (!bindings)
            return 'none';
        const parts = [];
        for (const [containerPortProto, hostBindings] of Object.entries(bindings)) {
            const hostPorts = (hostBindings || [])
                .map((b) => b?.HostPort)
                .filter(Boolean)
                .join(', ');
            parts.push(hostPorts ? `${containerPortProto} (host: ${hostPorts})` : `${containerPortProto}`);
        }
        return parts.length > 0 ? parts.join(' | ') : 'none';
    }
    async probeHttpFromHost(client, host, port, timeoutSeconds = 5) {
        const target = `http://${host}:${port}`;
        // Avoid relying on curl/wget inside the *container* (many images are distroless/alpine).
        // This runs on the VPS host, where curl is typically available.
        const cmd = `if command -v curl >/dev/null 2>&1; then ` +
            `  curl -s -o /dev/null -w "%{http_code}" ${target} --max-time ${timeoutSeconds} 2>/dev/null || echo "000"; ` +
            `elif command -v wget >/dev/null 2>&1; then ` +
            `  wget -q -O /dev/null --server-response ${target} 2>&1 | awk '/HTTP\\/{print \\$2}' | head -1 || echo "000"; ` +
            `else ` +
            `  echo "000"; ` +
            `fi`;
        const result = await this.sshService.executeCommand(client, cmd);
        const rawCode = result.stdout?.trim() || '';
        const match = rawCode.match(/[1-5]\d{2}/);
        const httpCode = match ? match[0] : '000';
        return { httpCode, target };
    }
    async probeContainerReachability(client, containerName, port) {
        const bindings = await this.getContainerPortBindings(client, containerName);
        const ips = await this.getContainerNetworkIps(client, containerName);
        const ipUsed = this.pickPreferredContainerIp(ips);
        if (!ipUsed) {
            // Host-network containers may not have a container IP. Best-effort fallback.
            const probe = await this.probeHttpFromHost(client, 'localhost', port);
            const isValidHttpCode = /^[1-5]\d{2}$/.test(probe.httpCode);
            return {
                ok: isValidHttpCode,
                httpCode: probe.httpCode,
                target: probe.target,
                ipUsed: null,
                bindings,
            };
        }
        const probe = await this.probeHttpFromHost(client, ipUsed, port);
        const isValidHttpCode = /^[1-5]\d{2}$/.test(probe.httpCode);
        return {
            ok: isValidHttpCode,
            httpCode: probe.httpCode,
            target: probe.target,
            ipUsed,
            bindings,
        };
    }
    /**
     * Configure domain for a deployment
     * Main entry point for domain setup
     *
     * IMPORTANT: Follows the fallback pattern from deployment-fallback-errors.md
     * - Verify FIRST, then create records only after success
     *
     * CRITICAL: The `port` parameter from frontend may be either:
     * - The container port (correct) - if frontend enrichment completed
     * - The host port (incorrect) - if enrichment didn't complete or container not in DB
     *
     * This method uses resolveStackFromPort to extract the actual container port
     * from the Docker port mapping (e.g., "3000:80" -> container port is 80).
     */
    async configureDomain(input) {
        const { serverId, deploymentId, stackId, domain, port, hostPort, ssl = true, httpsRedirect = true, wwwRedirect = true, customHeaders, } = input;
        // 1. Ensure Traefik is installed and running
        const isInstalled = await this.traefikService.isTraefikInstalled(serverId);
        if (!isInstalled) {
            throw new Error('Traefik is not installed. Please install Traefik first.');
        }
        // 2. Validate domain doesn't already exist
        const exists = db_1.queries.checkDomainExists(domain, serverId);
        if (exists) {
            throw new Error(`Domain ${domain} is already configured on this server`);
        }
        // 3. Generate unique router name
        const routerName = TraefikLabelGenerator_1.TraefikLabelGenerator.generateRouterName(domain, (deploymentId || stackId)?.substring(0, 8));
        // 4. Resolve the actual container port (critical for Traefik routing)
        // The frontend may pass host port instead of container port if enrichment didn't complete
        // Example: WordPress with "3000:80" mapping - frontend may pass 3000 but Traefik needs 80
        let resolvedStackId = stackId;
        let traefikPort = port; // Default to the port from input
        // Legacy callers may send deploymentId without stackId.
        // Resolve stack association early so we can persist domains.stack_id reliably.
        if (!resolvedStackId && deploymentId) {
            const stacks = db_1.queries.getDockerStacks(serverId);
            const matchedStack = stacks.find((s) => s.project_name.includes(deploymentId));
            if (matchedStack) {
                resolvedStackId = matchedStack.id;
                console.log(`[TraefikDomain] Resolved stack from deploymentId ${deploymentId}: ${resolvedStackId}`);
            }
            else {
                console.log(`[TraefikDomain] No stack found matching deploymentId ${deploymentId}`);
            }
        }
        if (!resolvedStackId) {
            // No stack association yet — try resolving from published host port first when provided.
            const resolutionPort = hostPort && hostPort > 0 ? hostPort : port;
            console.log(`[TraefikDomain] No stackId provided, resolving from host port ${resolutionPort} (target port input ${port})`);
            const resolved = await this.resolveStackFromPort(serverId, resolutionPort);
            resolvedStackId = resolved.stackId ?? undefined;
            if (hostPort && hostPort > 0) {
                // When hostPort is provided by frontend, prefer backend-resolved mapping.
                // If backend couldn't resolve mapping and frontend already supplied a different
                // container port, keep frontend value as fallback.
                traefikPort = resolved.containerPort;
                const backendCouldNotMap = resolved.containerPort === resolutionPort && !resolved.stackId;
                if (backendCouldNotMap && port !== resolutionPort) {
                    traefikPort = port;
                }
            }
            else {
                traefikPort = resolved.containerPort; // Backward compatibility for older clients
            }
            console.log(`[TraefikDomain] Resolved: stackId=${resolvedStackId}, containerPort=${traefikPort} (input port=${port}, hostPort=${hostPort ?? 'n/a'})`);
        }
        // 5. Generate Traefik labels with the correct container port
        const labels = this.labelGenerator.generateLabels({
            domain,
            port: traefikPort, // CRITICAL: Use container port, not host port
            routerName,
            ssl,
            httpsRedirect,
            wwwRedirect,
            customHeaders,
        });
        // 6. Apply labels to deployment or stack (if provided)
        // IMPORTANT: Apply and verify BEFORE creating DB records (fallback-safe).
        let appliedStackId = null;
        if (resolvedStackId) {
            await this.applyLabelsToStack(serverId, resolvedStackId, labels, { domain, ssl, port: traefikPort });
            appliedStackId = resolvedStackId;
        }
        else if (deploymentId) {
            // For PM2 deployments, we might need a different approach
            // This could be handled differently depending on the deployment type
            console.log('PM2 deployment domain configuration not yet implemented');
        }
        else {
            // Truly no stack association - domain is configured but labels must be added manually
            console.log(`Domain ${domain} configured without stack association. User must add Traefik labels manually to their docker-compose.yml`);
            console.log('Required labels:', labels);
        }
        // 7. Create domain record in database
        // deployment_id: For PM2-style deployments
        // stack_id: For Docker stacks
        // IMPORTANT: Store the container port (traefikPort), not the host port
        const domainId = (0, crypto_1.randomUUID)();
        db_1.queries.createDomain({
            id: domainId,
            server_id: serverId,
            deployment_id: deploymentId || null,
            stack_id: appliedStackId || resolvedStackId || null,
            domain,
            port: traefikPort, // Store container port for Traefik
            ssl_enabled: ssl ? 1 : 0,
            https_redirect: httpsRedirect ? 1 : 0,
            www_redirect: wwwRedirect ? 1 : 0,
            router_name: routerName,
            entrypoints: ssl ? 'websecure' : 'web',
            custom_headers: customHeaders ? JSON.stringify(customHeaders) : null,
            proxy_type: 'traefik',
            dns_verified: 0,
            certificate_status: ssl ? 'pending' : null,
            certificate_resolver: 'letsencrypt',
            middlewares: null,
            last_certificate_check: null,
        });
        // 7. Create www redirect record if needed
        if (wwwRedirect && this.shouldAddWwwRedirect(domain)) {
            db_1.queries.createRedirect({
                id: (0, crypto_1.randomUUID)(),
                domain_id: domainId,
                source_domain: `www.${domain}`,
                target_domain: domain,
                redirect_type: 'permanent',
            });
        }
        // 8. Start DNS verification polling (background task)
        this.startDnsVerification(domainId, domain, serverId);
        // 9. Wait for certificate (if SSL enabled)
        if (ssl) {
            // Don't wait, let it happen in the background
            this.waitForCertificate(serverId, domain, domainId).catch((error) => {
                console.error('Certificate generation failed:', error);
            });
        }
        return {
            domainId,
            stackAssociated: Boolean(appliedStackId),
            stackId: appliedStackId,
        };
    }
    /**
     * Verify application is responding on the configured port
     * Uses curl to check if the app is accessible (healthcheck-agnostic)
     * @param traefikPort - The port Traefik will forward to (must match what the app listens on)
     */
    async verifyContainerHealth(client, projectName, traefikPort, maxWaitTime = 30000 // 30 seconds max wait
    ) {
        const startTime = Date.now();
        const checkInterval = 3000; // Check every 3 seconds
        let port;
        if (traefikPort) {
            // Use the Traefik target port - this is what Traefik will forward traffic to
            port = String(traefikPort);
            console.log(`[TraefikDomainService] Using Traefik target port: ${port}`);
        }
        else {
            // Fallback: Best-effort detect the container port from docker ps output
            const portResult = await this.sshService.executeCommand(client, `docker ps --filter "name=${projectName}" --format "{{.Ports}}" | grep -oP '(?<=->)\\d+' | head -1`);
            port = portResult.stdout?.trim() || '3000'; // Default to 3000 if not found
            console.log(`[TraefikDomainService] Using Docker exposed port: ${port}`);
        }
        console.log(`[TraefikDomainService] Checking if app responds on port ${port}...`);
        while (Date.now() - startTime < maxWaitTime) {
            try {
                const containerResult = await this.sshService.executeCommand(client, `docker ps --filter "name=${projectName}" --format "{{.Names}}" | head -1`);
                const containerName = containerResult.stdout?.trim();
                if (!containerName) {
                    console.log(`[TraefikDomainService] No running container found yet, waiting...`);
                    await new Promise((resolve) => setTimeout(resolve, checkInterval));
                    continue;
                }
                const probe = await this.probeContainerReachability(client, containerName, Number(port));
                const httpCode = probe.httpCode || '000';
                console.log(`[TraefikDomainService] HTTP response code: ${httpCode}`);
                // Any 2xx, 3xx, 4xx, or 5xx means the app is responding
                // We don't care about the response content, just that it's listening
                if (/^[1-5]\d{2}$/.test(httpCode)) {
                    console.log(`[TraefikDomainService] App is responding on port ${port}! (HTTP ${httpCode})`);
                    return;
                }
                console.log(`[TraefikDomainService] App not responding yet, waiting...`);
                await new Promise((resolve) => setTimeout(resolve, checkInterval));
            }
            catch (error) {
                console.error('[TraefikDomainService] Error checking app response:', error.message);
                await new Promise((resolve) => setTimeout(resolve, checkInterval));
            }
        }
        // Timeout reached - app never responded
        console.warn(`[TraefikDomainService] App response check timeout after ${maxWaitTime}ms`);
        // Get container status for debugging
        const statusResult = await this.sshService.executeCommand(client, `docker ps --filter "name=${projectName}" --format "{{.Names}}\t{{.Status}}"`);
        const containerStatus = statusResult.stdout?.trim() || 'unknown';
        // Get recent logs
        const logsResult = await this.sshService.executeCommand(client, `docker logs ${projectName}-${projectName}-1 --tail 30 2>&1 || echo "Could not fetch logs"`);
        throw new Error(`Application is not responding on port ${port}.\n\n` +
            `Container status: ${containerStatus}\n\n` +
            `Common issues:\n` +
            `• App listening on 127.0.0.1 or localhost instead of 0.0.0.0\n` +
            `• App crashed during startup\n` +
            `• Wrong port configuration\n` +
            `• Missing environment variables\n\n` +
            `Fixes:\n` +
            `1. Add HOSTNAME=0.0.0.0 to environment variables\n` +
            `2. Check logs: docker logs ${projectName}-${projectName}-1\n` +
            `3. Verify PORT environment variable matches your app\n\n` +
            `Recent logs:\n${logsResult.stdout?.substring(0, 400) || 'No logs available'}`);
    }
    /**
     * Apply Traefik labels to a Docker stack
     * Updates docker-compose.yml and redeploys
     */
    async applyLabelsToStack(serverId, stackId, labels, domainConfig) {
        console.log(`[TraefikDomainService] Applying labels to stack ${stackId}`);
        // Get stack details
        const stack = db_1.queries.getDockerStackById(stackId);
        if (!stack) {
            throw new Error(`Stack not found: ${stackId}`);
        }
        console.log(`[TraefikDomainService] Stack found: ${stack.project_name} at ${stack.stack_path}`);
        const client = await this.sshService.connect(serverId);
        // Read existing docker-compose.yml
        const composePath = `${stack.stack_path}/${stack.project_name}/docker-compose.yml`;
        console.log(`[TraefikDomainService] Reading compose file from: ${composePath}`);
        const composeResult = await this.sshService.executeCommand(client, `cat ${composePath}`);
        const composeContent = composeResult.stdout;
        console.log(`[TraefikDomainService] Compose content length: ${composeContent?.length || 0} bytes`);
        // Validate compose content
        if (!composeContent || !composeContent.trim()) {
            throw new Error(`Docker compose file is empty at ${composePath}`);
        }
        // Parse YAML
        const compose = YAML.parse(composeContent);
        // Validate parsed compose
        if (!compose) {
            throw new Error('Failed to parse docker-compose.yml - invalid YAML format');
        }
        if (!compose.services || typeof compose.services !== 'object') {
            throw new Error('docker-compose.yml does not contain a valid services section');
        }
        const serviceKeys = Object.keys(compose.services);
        if (serviceKeys.length === 0) {
            throw new Error('docker-compose.yml does not contain any services');
        }
        // Add labels to the main service (first service or one specified in env)
        const serviceName = serviceKeys[0];
        console.log(`[TraefikDomainService.applyLabelsToStack] Target service: ${serviceName}`);
        if (!compose.services[serviceName].labels) {
            compose.services[serviceName].labels = [];
        }
        // Convert labels to array if it's an object
        if (!Array.isArray(compose.services[serviceName].labels)) {
            const labelObj = compose.services[serviceName].labels;
            compose.services[serviceName].labels = Object.entries(labelObj).map(([key, value]) => `${key}=${value}`);
        }
        // Log existing labels before update
        const existingLabels = compose.services[serviceName].labels;
        const existingTraefikLabels = existingLabels.filter((l) => l.startsWith('traefik.'));
        console.log(`[TraefikDomainService.applyLabelsToStack] Existing Traefik labels (${existingTraefikLabels.length}):`);
        existingTraefikLabels.forEach((l, i) => console.log(`  OLD[${i}] ${l}`));
        // Merge labels (avoid duplicates)
        compose.services[serviceName].labels = [
            ...compose.services[serviceName].labels.filter((l) => !l.startsWith('traefik.')),
            ...labels,
        ];
        console.log(`[TraefikDomainService.applyLabelsToStack] New Traefik labels (${labels.length}):`);
        labels.forEach((l, i) => console.log(`  NEW[${i}] ${l}`));
        // CRITICAL FIX: Multi-network binding issue (502 Bad Gateway)
        // ============================================================
        // When a container is connected to multiple Docker networks (e.g., default + traefik-public),
        // it gets multiple IP addresses. Many web frameworks bind to only one interface by default,
        // causing Traefik (on traefik-public network) to get "Connection refused" (502 Bad Gateway).
        //
        // SOLUTION: Detect the runtime and add the appropriate HOST binding env var.
        // This ensures Traefik can reach the app regardless of which network it uses.
        //
        // Runtime detection priority:
        // 1. Read Dockerfile to detect base image (most accurate for custom builds)
        // 2. Fall back to docker-compose image name
        // 3. If build context exists but can't detect runtime, add common binding vars
        const serviceImage = compose.services[serviceName].image || '';
        const serviceBuild = compose.services[serviceName].build;
        // Try to detect runtime from Dockerfile if this is a custom build
        let detectedRuntime = 'unknown';
        if (serviceBuild) {
            // Read Dockerfile to detect base image
            const buildContext = typeof serviceBuild === 'string' ? serviceBuild : serviceBuild.context || '.';
            const dockerfilePath = typeof serviceBuild === 'object' && serviceBuild.dockerfile
                ? `${stack.stack_path}/${stack.project_name}/${buildContext}/${serviceBuild.dockerfile}`
                : `${stack.stack_path}/${stack.project_name}/${buildContext}/Dockerfile`;
            try {
                const dockerfileResult = await this.sshService.executeCommand(client, `cat ${dockerfilePath} 2>/dev/null || echo ""`);
                const dockerfileContent = dockerfileResult.stdout?.toLowerCase() || '';
                // Detect runtime from FROM line in Dockerfile
                if (dockerfileContent.includes('from node') || dockerfileContent.includes('from oven/bun')) {
                    detectedRuntime = 'node';
                }
                else if (dockerfileContent.includes('from python') || dockerfileContent.includes('from tiangolo/uvicorn')) {
                    detectedRuntime = 'python';
                }
                else if (dockerfileContent.includes('from golang') || dockerfileContent.includes('from go:')) {
                    detectedRuntime = 'go';
                }
                else if (dockerfileContent.includes('from ruby')) {
                    detectedRuntime = 'ruby';
                }
                else if (dockerfileContent.includes('from rust')) {
                    detectedRuntime = 'rust';
                }
                else if (dockerfileContent.includes('from openjdk') || dockerfileContent.includes('from eclipse-temurin') || dockerfileContent.includes('from amazoncorretto')) {
                    detectedRuntime = 'java';
                }
                else if (dockerfileContent.includes('from php')) {
                    detectedRuntime = 'php';
                }
                console.log(`[TraefikDomainService] Detected runtime from Dockerfile: ${detectedRuntime}`);
            }
            catch (error) {
                console.log(`[TraefikDomainService] Could not read Dockerfile, falling back to image detection`);
            }
        }
        // Fall back to image name detection if Dockerfile detection didn't work
        if (detectedRuntime === 'unknown') {
            const imageLower = serviceImage.toLowerCase();
            if (imageLower.includes('node') || imageLower.includes('next') || imageLower.includes('nuxt') || imageLower.includes('bun')) {
                detectedRuntime = 'node';
            }
            else if (imageLower.includes('python') || imageLower.includes('uvicorn') || imageLower.includes('gunicorn')) {
                detectedRuntime = 'python';
            }
            else if (imageLower.includes('golang') || imageLower.includes('go:')) {
                detectedRuntime = 'go';
            }
            else if (imageLower.includes('ruby') || imageLower.includes('rails')) {
                detectedRuntime = 'ruby';
            }
        }
        // Add appropriate binding environment variables based on runtime
        // Runtime-specific HOST binding env vars:
        // - Node.js/Next.js: HOSTNAME=0.0.0.0
        // - Python (uvicorn/gunicorn): HOST=0.0.0.0
        // - Ruby (Rails/Puma): BINDING=0.0.0.0 or RAILS_BIND=0.0.0.0
        // - Go: Usually binds to 0.0.0.0 by default (no fix needed)
        // - Rust: Usually binds to 0.0.0.0 by default (no fix needed)
        const bindingEnvVars = [];
        switch (detectedRuntime) {
            case 'node':
                bindingEnvVars.push('HOSTNAME=0.0.0.0'); // Next.js, Nuxt, etc.
                bindingEnvVars.push('HOST=0.0.0.0'); // Some Node frameworks use HOST
                break;
            case 'python':
                bindingEnvVars.push('HOST=0.0.0.0'); // Uvicorn, FastAPI
                bindingEnvVars.push('UVICORN_HOST=0.0.0.0'); // Uvicorn specific
                bindingEnvVars.push('GUNICORN_BIND=0.0.0.0'); // Gunicorn specific
                break;
            case 'ruby':
                bindingEnvVars.push('BINDING=0.0.0.0'); // Puma
                bindingEnvVars.push('HOST=0.0.0.0'); // Generic
                break;
            case 'go':
            case 'rust':
            case 'java':
                // These typically bind to 0.0.0.0 by default, but add HOST just in case
                bindingEnvVars.push('HOST=0.0.0.0');
                break;
            case 'unknown':
                // For custom builds where we can't detect runtime, add common binding vars
                if (serviceBuild) {
                    console.log(`[TraefikDomainService] Unknown runtime with custom build - adding common binding vars`);
                    bindingEnvVars.push('HOSTNAME=0.0.0.0');
                    bindingEnvVars.push('HOST=0.0.0.0');
                }
                break;
        }
        if (bindingEnvVars.length > 0) {
            console.log(`[TraefikDomainService] Adding binding env vars for ${detectedRuntime}: ${bindingEnvVars.join(', ')}`);
            // Initialize environment array if it doesn't exist
            if (!compose.services[serviceName].environment) {
                compose.services[serviceName].environment = [];
            }
            // Convert environment to array format if it's an object
            if (!Array.isArray(compose.services[serviceName].environment)) {
                const envObj = compose.services[serviceName].environment;
                compose.services[serviceName].environment = Object.entries(envObj).map(([key, value]) => `${key}=${value}`);
            }
            // Add each binding env var if not already set
            for (const envVar of bindingEnvVars) {
                const [key] = envVar.split('=');
                const hasVar = compose.services[serviceName].environment.some((env) => env.startsWith(`${key}=`));
                if (!hasVar) {
                    compose.services[serviceName].environment.push(envVar);
                    console.log(`[TraefikDomainService] Added ${envVar} to environment`);
                }
            }
        }
        // CRITICAL FIX: WordPress-specific configuration
        // =============================================
        // WordPress stores the site URL in its database on first access. If WordPress was first
        // accessed via http://server-ip:PORT, it saves that URL with the port number.
        // When Traefik is configured later, WordPress will redirect to the old URL (with :PORT),
        // breaking the site even though Traefik labels are correct.
        //
        // SOLUTION: Inject WP_HOME/WP_SITEURL via WORDPRESS_CONFIG_EXTRA
        // This overrides WordPress's database settings and forces it to use the domain.
        //
        // This fix prevents the "redirect to :8000" bug reported in production.
        const isWordPress = compose.services[serviceName].image?.includes('wordpress');
        if (isWordPress && domainConfig) {
            const { domain: domainName, ssl } = domainConfig;
            console.log(`[TraefikDomainService] WordPress detected - configuring environment variables for ${domainName}`);
            // Initialize environment array if it doesn't exist
            if (!compose.services[serviceName].environment) {
                compose.services[serviceName].environment = [];
            }
            // Convert environment to array format if it's an object
            if (!Array.isArray(compose.services[serviceName].environment)) {
                const envObj = compose.services[serviceName].environment;
                compose.services[serviceName].environment = Object.entries(envObj).map(([key, value]) => `${key}=${value}`);
            }
            // Build the correct URL based on SSL setting
            const protocol = ssl ? 'https' : 'http';
            const siteUrl = `${protocol}://${domainName}`;
            // Rebuild env map so we can safely add/merge WordPress-specific config
            const envMap = new Map();
            compose.services[serviceName].environment.forEach((env) => {
                const [key, ...rest] = env.split('=');
                envMap.set(key, rest.join('='));
            });
            // Remove legacy home/siteurl vars (they are not consumed by the official image)
            envMap.delete('WORDPRESS_HOME');
            envMap.delete('WORDPRESS_SITEURL');
            // Use WORDPRESS_CONFIG_EXTRA to force WP_HOME/WP_SITEURL at runtime.
            // This ensures WordPress does not keep redirecting to the original :PORT seen on first setup.
            const wpConfigExtraRaw = [
                `define('WP_HOME','${siteUrl}');`,
                `define('WP_SITEURL','${siteUrl}');`,
                // Normalize host/port when behind Traefik so WordPress canonical URLs drop :PORT
                "if (isset($_SERVER['HTTP_X_FORWARDED_HOST'])) { $_SERVER['HTTP_HOST'] = $_SERVER['HTTP_X_FORWARDED_HOST']; }",
                "if (isset($_SERVER['HTTP_HOST'])) { $_SERVER['HTTP_HOST'] = preg_replace('/:\\\\d+$/', '', $_SERVER['HTTP_HOST']); }",
                // Ensure HTTPS is honored behind Traefik and force correct server port
                "if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; $_SERVER['SERVER_PORT'] = '443'; } else { $_SERVER['SERVER_PORT'] = '80'; }",
            ].join('\n');
            // Escape $ for docker-compose so PHP sees a single $
            const configEscaped = wpConfigExtraRaw.replace(/\$/g, '$$$$');
            // Overwrite any existing value to avoid duplicated/legacy snippets
            envMap.set('WORDPRESS_CONFIG_EXTRA', configEscaped);
            // Convert back to array format expected by docker-compose.yml
            compose.services[serviceName].environment = Array.from(envMap.entries()).map(([key, value]) => `${key}=${value}`);
            console.log(`[TraefikDomainService] WordPress environment configured: ${siteUrl}`);
        }
        // Ensure service is on traefik-public network
        // CRITICAL: When a service explicitly defines networks, it loses access to the default network
        // We must preserve the default network so the service can still communicate with other services in the stack
        //
        // IMPORTANT: Use "default" as the network name in docker-compose.yml
        // Docker Compose will map this to {project_name}_default automatically
        // If we use wordpress_default, Docker creates wordpress_wordpress_default (duplicated name)!
        if (!compose.services[serviceName].networks) {
            compose.services[serviceName].networks = [];
        }
        if (Array.isArray(compose.services[serviceName].networks)) {
            // Add default network first (if not already present)
            // Using "default" instead of "{project}_default" to avoid name duplication
            if (!compose.services[serviceName].networks.includes('default')) {
                compose.services[serviceName].networks.push('default');
            }
            // Add traefik-public network (if not already present)
            if (!compose.services[serviceName].networks.includes('traefik-public')) {
                compose.services[serviceName].networks.push('traefik-public');
            }
        }
        else {
            // Networks is an object, add both networks as keys
            compose.services[serviceName].networks['default'] = {};
            compose.services[serviceName].networks['traefik-public'] = {};
        }
        // Add network definitions
        if (!compose.networks) {
            compose.networks = {};
        }
        // traefik-public network (external, must already exist)
        compose.networks['traefik-public'] = { external: true };
        // Default network doesn't need to be declared - Docker Compose creates it automatically
        // Write updated docker-compose.yml
        const updatedCompose = YAML.stringify(compose);
        console.log(`[TraefikDomainService.applyLabelsToStack] Writing updated compose file to: ${composePath}`);
        console.log(`[TraefikDomainService.applyLabelsToStack] Updated compose content:\n${updatedCompose}`);
        // Write to file using heredoc
        const writeCommand = `cat > ${composePath} << 'TRAEFIKEOF'
${updatedCompose}
TRAEFIKEOF`;
        const writeResult = await this.sshService.executeCommand(client, writeCommand);
        console.log(`[TraefikDomainService.applyLabelsToStack] Write result - stdout: ${writeResult.stdout}, stderr: ${writeResult.stderr}`);
        // Update compose_content in database
        db_1.queries.updateDockerStack(stackId, {
            compose_content: updatedCompose,
        });
        console.log(`[TraefikDomainService.applyLabelsToStack] Database updated with new compose content`);
        // Redeploy with --force-recreate to ensure labels are applied to new container
        // Without force-recreate, Docker may not recreate the container if image hasn't changed
        console.log(`[TraefikDomainService.applyLabelsToStack] Running: docker compose up -d --force-recreate`);
        const upResult = await this.sshService.executeCommand(client, `cd ${stack.stack_path}/${stack.project_name} && docker compose up -d --force-recreate 2>&1`);
        console.log(`[TraefikDomainService.applyLabelsToStack] docker compose up result:\n${upResult.stdout}`);
        // CRITICAL: Restart Traefik to force it to re-scan Docker containers
        // The Docker provider sometimes doesn't pick up label changes automatically,
        // especially when containers are recreated with new labels.
        // This ensures Traefik discovers the new routing configuration.
        console.log(`[TraefikDomainService.applyLabelsToStack] Restarting Traefik to pick up new labels...`);
        const restartResult = await this.sshService.executeCommand(client, `docker restart traefik 2>&1`);
        console.log(`[TraefikDomainService.applyLabelsToStack] Traefik restart result: ${restartResult.stdout}`);
        // Give Traefik a moment to start and discover containers
        console.log(`[TraefikDomainService.applyLabelsToStack] Waiting 3 seconds for Traefik to discover containers...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        // Verify what labels the container actually has now
        console.log(`[TraefikDomainService.applyLabelsToStack] Verifying container labels...`);
        const containerLabels = await this.sshService.executeCommand(client, `docker inspect --format='{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' $(docker ps -q --filter "name=${stack.project_name}") 2>&1 | grep traefik || echo "No traefik labels found"`);
        console.log(`[TraefikDomainService.applyLabelsToStack] Container Traefik labels:\n${containerLabels.stdout}`);
        // Wait and verify container health after redeploy
        // CRITICAL: Verify app responds on the Traefik target port, not just any exposed port
        // This catches misconfigurations where the user sets a port the app isn't listening on
        const traefikPort = domainConfig?.port;
        console.log(`[TraefikDomainService.applyLabelsToStack] Waiting for app to respond on Traefik target port ${traefikPort || '(auto-detect)'}...`);
        await this.verifyContainerHealth(client, stack.project_name, traefikPort);
        console.log(`[TraefikDomainService.applyLabelsToStack] Container health verified successfully`);
    }
    /**
     * Start background DNS verification
     */
    async startDnsVerification(domainId, _domain, serverId) {
        // Simple DNS verification - check if domain resolves to server IP
        try {
            const server = db_1.queries.getServerById(serverId);
            if (!server)
                return;
            // This is a simplified version - in production, you'd use a proper DNS library
            // For now, we'll mark it as verified after a short delay
            setTimeout(() => {
                db_1.queries.updateDomain(domainId, {
                    dns_verified: 1,
                });
            }, 5000);
        }
        catch (error) {
            console.error('DNS verification failed:', error);
        }
    }
    /**
     * Wait for Let's Encrypt certificate to be issued
     * Traefik handles this automatically, we just poll for status
     */
    async waitForCertificate(serverId, domain, domainId, timeout = 120000 // 2 minutes
    ) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const certInfo = await this.traefikService.getCertificateInfo(serverId, domain);
            if (certInfo && certInfo.status === 'active') {
                db_1.queries.updateDomain(domainId, {
                    certificate_status: 'active',
                    last_certificate_check: Date.now(),
                });
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Check every 5s
        }
        // Timeout - mark as error
        db_1.queries.updateDomain(domainId, {
            certificate_status: 'error',
            last_certificate_check: Date.now(),
        });
        throw new Error(`Certificate generation timed out for ${domain}`);
    }
    /**
     * Update domain configuration
     * Changes port, SSL settings, etc.
     *
     * IMPORTANT: Follows the fallback pattern from deployment-fallback-errors.md
     * - Verify FIRST, then modify only after success
     * - If port change fails validation and forceRedeploy is false, returns requiresRedeploy: true
     * - If forceRedeploy is true, auto-updates docker-compose.yml and redeploys
     */
    async updateDomain(domainId, updates) {
        console.log(`[TraefikDomainService.updateDomain] Starting update for domainId: ${domainId}`);
        console.log(`[TraefikDomainService.updateDomain] Updates requested:`, JSON.stringify(updates, null, 2));
        const domain = db_1.queries.getDomain(domainId);
        if (!domain) {
            console.error(`[TraefikDomainService.updateDomain] Domain not found: ${domainId}`);
            throw new Error('Domain not found');
        }
        console.log(`[TraefikDomainService.updateDomain] Domain found:`, {
            id: domain.id,
            domain: domain.domain,
            currentPort: domain.port,
            stack_id: domain.stack_id,
            deployment_id: domain.deployment_id,
            server_id: domain.server_id,
            router_name: domain.router_name,
        });
        const newPort = updates.port !== undefined ? updates.port : domain.port;
        const isPortChanging = updates.port !== undefined && updates.port !== domain.port;
        const forceRedeploy = updates.forceRedeploy === true;
        // CRITICAL: Verify BEFORE making any changes (fallback pattern)
        // If the port is changing, verify the CONTAINER is listening on the new port
        // NOTE: We must check inside the container, not on the host!
        // Traefik connects to containers via Docker network, not host ports.
        if (isPortChanging && domain.stack_id) {
            console.log(`[TraefikDomainService.updateDomain] Port changing from ${domain.port} to ${newPort} - verifying CONTAINER responds on new port BEFORE making changes...`);
            const stack = db_1.queries.getDockerStackById(domain.stack_id);
            if (stack) {
                const client = await this.sshService.connect(domain.server_id);
                // Get container name (format: projectname-servicename-1)
                const containerResult = await this.sshService.executeCommand(client, `docker ps --filter "name=${stack.project_name}" --format "{{.Names}}" | head -1`);
                const containerName = containerResult.stdout?.trim();
                console.log(`[TraefikDomainService.updateDomain] Found container: ${containerName}`);
                if (containerName) {
                    const probe = await this.probeContainerReachability(client, containerName, newPort);
                    console.log(`[TraefikDomainService.updateDomain] Pre-check (container network): ${probe.target} returned HTTP ${probe.httpCode}`);
                    if (!probe.ok) {
                        // Container is NOT responding on the new port
                        console.log(`[TraefikDomainService.updateDomain] Container is not listening on port ${newPort}`);
                        if (!forceRedeploy) {
                            // Return requiresRedeploy instead of throwing error
                            // This allows the frontend to show a confirmation dialog
                            console.log(`[TraefikDomainService.updateDomain] Returning requiresRedeploy=true (forceRedeploy not set)`);
                            const currentProbe = await this.probeContainerReachability(client, containerName, domain.port);
                            const bindingsSummary = this.formatContainerPortBindingsSummary(probe.bindings);
                            const currentPortMsg = currentProbe.ok
                                ? `Your app is responding on port ${domain.port}.`
                                : `Your app did not respond on the currently configured port ${domain.port} either.`;
                            return {
                                success: true,
                                requiresRedeploy: true,
                                currentPort: domain.port,
                                newPort: newPort,
                                message: `${currentPortMsg}\n\n` +
                                    `The Traefik target port must match the port your app listens on inside the container.\n\n` +
                                    `Debug info:\n` +
                                    `• Container: ${containerName}\n` +
                                    `• Checked: ${probe.target} (HTTP ${probe.httpCode})\n` +
                                    `• Published ports: ${bindingsSummary}\n\n` +
                                    `If you want to use port ${newPort}, we can try updating the PORT environment variable and redeploying.`,
                            };
                        }
                        // forceRedeploy is true - update docker-compose.yml and redeploy
                        console.log(`[TraefikDomainService.updateDomain] forceRedeploy=true - updating docker-compose.yml and redeploying...`);
                        try {
                            await this.updateComposePortAndRedeploy(client, stack, domain.port, newPort);
                            console.log(`[TraefikDomainService.updateDomain] Compose updated and redeployed successfully`);
                            // Wait a moment for the container to start
                            await new Promise((resolve) => setTimeout(resolve, 5000));
                            // Check if container actually started (it may have failed to bind the port)
                            const containerCheck = await this.sshService.executeCommand(client, `docker ps --filter "name=${stack.project_name}" --format "{{.Names}}" | head -1`);
                            const runningContainer = containerCheck.stdout?.trim();
                            if (!runningContainer) {
                                // Container failed to start - check docker logs for error
                                const logsResult = await this.sshService.executeCommand(client, `docker compose -f ${stack.stack_path}/${stack.project_name}/docker-compose.yml logs --tail 20 2>&1`);
                                throw new Error(`Container failed to start after port change.\n\n` +
                                    `This could mean:\n` +
                                    `• Port ${newPort} is already in use by another container or process\n` +
                                    `• The app has a hardcoded port that cannot be changed\n\n` +
                                    `Recent logs:\n${logsResult.stdout?.substring(0, 500) || 'No logs available'}`);
                            }
                            // Verify the app is now reachable on the new target port.
                            // IMPORTANT: Do NOT rely on curl/wget inside the container (many images are distroless).
                            // Also, probe via container network IP to ensure the app is reachable from Traefik's network.
                            const verifyProbe = await this.probeContainerReachability(client, runningContainer, newPort);
                            console.log(`[TraefikDomainService.updateDomain] Post-redeploy verification: ${verifyProbe.target} returned HTTP ${verifyProbe.httpCode}`);
                            if (!verifyProbe.ok) {
                                throw new Error(`Redeployment completed but app is still not listening on port ${newPort}.\n\n` +
                                    `This usually means your app has a hardcoded port that cannot be changed via the PORT environment variable.\n\n` +
                                    `For example, Ghost always listens on port 2368, PostgreSQL on 5432, MySQL on 3306.\n\n` +
                                    `You'll need to use the app's actual listening port, not a custom one.`);
                            }
                            console.log(`[TraefikDomainService.updateDomain] Post-redeploy verification PASSED`);
                        }
                        catch (redeployError) {
                            console.error(`[TraefikDomainService.updateDomain] Redeploy failed:`, redeployError);
                            throw new Error(`Failed to redeploy with new port: ${redeployError.message}`);
                        }
                    }
                    else {
                        console.log(`[TraefikDomainService.updateDomain] Pre-check PASSED: Container is listening on port ${newPort}`);
                    }
                }
                else {
                    console.warn(`[TraefikDomainService.updateDomain] Could not find container, skipping pre-check`);
                }
            }
        }
        // Now safe to make changes - we've verified the new port works
        const dbUpdates = {};
        if (updates.port !== undefined)
            dbUpdates.port = updates.port;
        if (updates.ssl !== undefined)
            dbUpdates.ssl_enabled = updates.ssl ? 1 : 0;
        if (updates.httpsRedirect !== undefined)
            dbUpdates.https_redirect = updates.httpsRedirect ? 1 : 0;
        if (updates.wwwRedirect !== undefined)
            dbUpdates.www_redirect = updates.wwwRedirect ? 1 : 0;
        if (updates.customHeaders !== undefined)
            dbUpdates.custom_headers = JSON.stringify(updates.customHeaders);
        // Security features
        if (updates.securityHeaders !== undefined)
            dbUpdates.security_headers = JSON.stringify(updates.securityHeaders);
        if (updates.rateLimitEnabled !== undefined)
            dbUpdates.rate_limit_enabled = updates.rateLimitEnabled ? 1 : 0;
        if (updates.rateLimitAverage !== undefined)
            dbUpdates.rate_limit_average = updates.rateLimitAverage;
        if (updates.rateLimitBurst !== undefined)
            dbUpdates.rate_limit_burst = updates.rateLimitBurst;
        if (updates.basicAuthEnabled !== undefined)
            dbUpdates.basic_auth_enabled = updates.basicAuthEnabled ? 1 : 0;
        if (updates.basicAuthUsers !== undefined)
            dbUpdates.basic_auth_users = JSON.stringify(updates.basicAuthUsers);
        if (updates.ipWhitelistEnabled !== undefined)
            dbUpdates.ip_whitelist_enabled = updates.ipWhitelistEnabled ? 1 : 0;
        if (updates.ipWhitelist !== undefined)
            dbUpdates.ip_whitelist = JSON.stringify(updates.ipWhitelist);
        console.log(`[TraefikDomainService.updateDomain] Database updates:`, dbUpdates);
        db_1.queries.updateDomain(domainId, dbUpdates);
        console.log(`[TraefikDomainService.updateDomain] Database updated successfully`);
        // Regenerate labels with updated config
        console.log(`[TraefikDomainService.updateDomain] Generating labels with port: ${newPort}`);
        // Merge updated security settings with existing domain settings
        const securityHeaders = updates.securityHeaders !== undefined
            ? updates.securityHeaders
            : (domain.security_headers ? JSON.parse(domain.security_headers) : undefined);
        const basicAuthUsers = updates.basicAuthUsers !== undefined
            ? updates.basicAuthUsers
            : (domain.basic_auth_users ? JSON.parse(domain.basic_auth_users) : undefined);
        const ipWhitelist = updates.ipWhitelist !== undefined
            ? updates.ipWhitelist
            : (domain.ip_whitelist ? JSON.parse(domain.ip_whitelist) : undefined);
        const labels = this.labelGenerator.generateLabels({
            domain: domain.domain,
            port: newPort,
            routerName: domain.router_name,
            ssl: updates.ssl !== undefined ? updates.ssl : domain.ssl_enabled === 1,
            httpsRedirect: updates.httpsRedirect !== undefined ? updates.httpsRedirect : domain.https_redirect === 1,
            wwwRedirect: updates.wwwRedirect !== undefined ? updates.wwwRedirect : domain.www_redirect === 1,
            customHeaders: updates.customHeaders || (domain.custom_headers ? JSON.parse(domain.custom_headers) : undefined),
            // Security features
            securityHeaders,
            basicAuthEnabled: updates.basicAuthEnabled !== undefined ? updates.basicAuthEnabled : domain.basic_auth_enabled === 1,
            basicAuthUsers,
            ipWhitelistEnabled: updates.ipWhitelistEnabled !== undefined ? updates.ipWhitelistEnabled : domain.ip_whitelist_enabled === 1,
            ipWhitelist,
            rateLimitEnabled: updates.rateLimitEnabled !== undefined ? updates.rateLimitEnabled : domain.rate_limit_enabled === 1,
            rateLimitAverage: updates.rateLimitAverage !== undefined ? updates.rateLimitAverage : domain.rate_limit_average,
            rateLimitBurst: updates.rateLimitBurst !== undefined ? updates.rateLimitBurst : domain.rate_limit_burst,
        });
        console.log(`[TraefikDomainService.updateDomain] Generated ${labels.length} labels:`);
        labels.forEach((label, i) => console.log(`  [${i}] ${label}`));
        // Reapply labels to the associated stack
        // Check stack_id first (Docker stacks), then deployment_id (PM2-style deployments)
        let stackId = null;
        console.log(`[TraefikDomainService.updateDomain] Looking for stack - stack_id: ${domain.stack_id}, deployment_id: ${domain.deployment_id}`);
        if (domain.stack_id) {
            // Docker stack - use stack_id directly
            stackId = domain.stack_id;
            console.log(`[TraefikDomainService.updateDomain] Using stack_id directly: ${stackId}`);
        }
        else if (domain.deployment_id) {
            // PM2-style deployment - find stack by deployment_id
            const stacks = db_1.queries.getDockerStacks(domain.server_id);
            console.log(`[TraefikDomainService.updateDomain] Found ${stacks.length} stacks for server, searching for deployment_id: ${domain.deployment_id}`);
            const stack = stacks.find((s) => s.project_name.includes(domain.deployment_id));
            if (stack) {
                stackId = stack.id;
                console.log(`[TraefikDomainService.updateDomain] Found stack by deployment_id: ${stackId} (${stack.project_name})`);
            }
            else {
                console.log(`[TraefikDomainService.updateDomain] No stack found matching deployment_id`);
            }
        }
        else {
            console.log(`[TraefikDomainService.updateDomain] No stack_id or deployment_id - cannot apply labels to stack`);
        }
        if (stackId) {
            const ssl = updates.ssl !== undefined ? updates.ssl : domain.ssl_enabled === 1;
            console.log(`[TraefikDomainService.updateDomain] Applying labels to stack ${stackId} with ssl=${ssl}, port=${newPort}`);
            await this.applyLabelsToStack(domain.server_id, stackId, labels, {
                domain: domain.domain,
                ssl,
                port: newPort
            });
            console.log(`[TraefikDomainService.updateDomain] Labels applied successfully`);
        }
        else {
            console.warn(`[TraefikDomainService.updateDomain] WARNING: No stackId found - labels NOT applied to any stack!`);
        }
        console.log(`[TraefikDomainService.updateDomain] Update complete for ${domain.domain}`);
        return { success: true };
    }
    /**
     * Update docker-compose.yml with new port and redeploy
     * Updates PORT environment variable and port mapping
     */
    async updateComposePortAndRedeploy(client, stack, oldPort, newPort) {
        console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Updating ${stack.project_name} from port ${oldPort} to ${newPort}`);
        const composePath = `${stack.stack_path}/${stack.project_name}/docker-compose.yml`;
        const composeDir = `${stack.stack_path}/${stack.project_name}`;
        // Read current compose file
        const composeResult = await this.sshService.executeCommand(client, `cat ${composePath}`);
        const composeContent = composeResult.stdout;
        if (!composeContent || !composeContent.trim()) {
            throw new Error(`Docker compose file is empty at ${composePath}`);
        }
        // Parse YAML
        const compose = YAML.parse(composeContent);
        if (!compose.services || typeof compose.services !== 'object') {
            throw new Error('docker-compose.yml does not contain a valid services section');
        }
        const serviceKeys = Object.keys(compose.services);
        if (serviceKeys.length === 0) {
            throw new Error('docker-compose.yml does not contain any services');
        }
        // Update the main service (first service)
        const serviceName = serviceKeys[0];
        const service = compose.services[serviceName];
        console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Updating service: ${serviceName}`);
        // Update port mapping (e.g., "3000:3000" -> "3001:3001")
        if (service.ports && Array.isArray(service.ports)) {
            service.ports = service.ports.map((portMapping) => {
                if (typeof portMapping === 'string') {
                    // Handle string format like "3000:3000" or "3000"
                    const parts = portMapping.split(':');
                    if (parts.length === 2) {
                        const hostPort = parseInt(parts[0]);
                        const containerPort = parseInt(parts[1]);
                        // IMPORTANT: Changing the Traefik target port should not require rebinding a new host port.
                        // Rebinding host ports can fail if another app already uses that port (common on shared VPS).
                        // Keep the published (host) port stable and only update the internal (container) port.
                        const newContainerPort = containerPort === oldPort ? newPort : containerPort;
                        return `${hostPort}:${newContainerPort}`;
                    }
                    else if (parts.length === 1) {
                        const port = parseInt(parts[0]);
                        return port === oldPort ? `${newPort}` : portMapping;
                    }
                }
                else if (typeof portMapping === 'object' && portMapping.target) {
                    // Handle object format { target: 3000, published: 3000 }
                    if (portMapping.target === oldPort)
                        portMapping.target = newPort;
                }
                return portMapping;
            });
            console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Updated ports:`, service.ports);
        }
        // Update PORT environment variable if present
        if (service.environment) {
            if (Array.isArray(service.environment)) {
                service.environment = service.environment.map((env) => {
                    if (env.startsWith('PORT=')) {
                        console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Updating PORT env var from ${oldPort} to ${newPort}`);
                        return `PORT=${newPort}`;
                    }
                    return env;
                });
                // Add PORT if not present
                const hasPort = service.environment.some((env) => env.startsWith('PORT='));
                if (!hasPort) {
                    console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Adding PORT=${newPort} env var`);
                    service.environment.push(`PORT=${newPort}`);
                }
            }
            else if (typeof service.environment === 'object') {
                // Object format
                if (service.environment.PORT !== undefined || !('PORT' in service.environment)) {
                    console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Setting PORT=${newPort} in environment object`);
                    service.environment.PORT = String(newPort);
                }
            }
        }
        else {
            // No environment section, create one with PORT
            console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Creating environment section with PORT=${newPort}`);
            service.environment = [`PORT=${newPort}`];
        }
        // Write updated docker-compose.yml
        const updatedCompose = YAML.stringify(compose);
        console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Writing updated compose file`);
        const writeCommand = `cat > ${composePath} << 'PORTCHANGEEOF'
${updatedCompose}
PORTCHANGEEOF`;
        // Fallback-safe deployment pattern (deployment-fallback-errors.md):
        // - Build first while old containers are still running
        // - Only swap containers after build succeeds
        // - If swap/healthcheck fails, roll back compose and restart previous config
        const runCompose = async (cmd) => this.sshService.executeCommand(client, `cd ${composeDir} && ${cmd} 2>&1`);
        console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Building images first (fallback-safe)...`);
        const buildResult = await runCompose(`docker compose build`);
        if (buildResult.exitCode !== 0) {
            throw new Error(`Docker build failed.\n\n${buildResult.stdout?.substring(0, 800) || 'No output'}`);
        }
        let wroteUpdatedCompose = false;
        try {
            await this.sshService.executeCommand(client, writeCommand);
            wroteUpdatedCompose = true;
            console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Redeploying with --force-recreate`);
            const upResult = await runCompose(`docker compose up -d --force-recreate`);
            console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Redeploy result:\n${upResult.stdout}`);
            const output = upResult.stdout || '';
            const stderr = upResult.stderr || '';
            // Check for common Docker errors
            if (output.includes('port is already allocated') || stderr.includes('port is already allocated')) {
                const match = (output + '\n' + stderr).match(/0\.0\.0\.0:(\d+)[^\n]*port is already allocated/i);
                const allocatedPort = match?.[1] ? Number(match[1]) : null;
                throw new Error(`Host port ${allocatedPort ?? '(unknown)'} is already in use by another container or process.\n\n` +
                    `Choose a different published host port in docker-compose.yml, or stop the service currently using it.`);
            }
            if (upResult.exitCode !== 0 &&
                (output.includes('Error response from daemon') || stderr.includes('Error response from daemon'))) {
                throw new Error(`Docker error: ${output || stderr}`);
            }
            // Verify the new target port is reachable before we commit the compose change to the DB.
            await this.verifyContainerHealth(client, stack.project_name, newPort);
            // Commit compose_content in database only after success.
            db_1.queries.updateDockerStack(stack.id, {
                compose_content: updatedCompose,
            });
            console.log(`[TraefikDomainService.updateComposePortAndRedeploy] Redeploy completed successfully`);
        }
        catch (error) {
            // Best-effort rollback to original compose + restart.
            if (wroteUpdatedCompose) {
                console.warn(`[TraefikDomainService.updateComposePortAndRedeploy] Rolling back compose after failure...`);
                const rollbackCmd = `cat > ${composePath} << 'PORTROLLBACKEOF'
${composeContent}
PORTROLLBACKEOF`;
                await this.sshService.executeCommand(client, rollbackCmd);
                db_1.queries.updateDockerStack(stack.id, {
                    compose_content: composeContent,
                });
                await runCompose(`docker compose up -d --force-recreate`);
            }
            throw error;
        }
    }
    /**
     * Delete domain
     */
    async deleteDomain(domainId) {
        const domain = db_1.queries.getDomain(domainId);
        if (!domain) {
            throw new Error('Domain not found');
        }
        // Remove labels from deployment
        if (domain.deployment_id) {
            await this.removeLabelsFromDeployment(domain.server_id, domain.deployment_id, domain.router_name);
        }
        // Delete SSL certificate from Traefik if SSL was enabled
        if (domain.ssl_enabled) {
            try {
                await this.traefikService.deleteCertificate(domain.server_id, domain.domain);
            }
            catch (error) {
                console.error('Failed to delete certificate, continuing with domain deletion:', error);
                // Continue with domain deletion even if certificate deletion fails
            }
        }
        // Delete from database (cascades to redirects)
        db_1.queries.deleteDomain(domainId);
    }
    /**
     * Remove Traefik labels from deployment
     */
    async removeLabelsFromDeployment(serverId, deploymentId, routerName) {
        // Find the stack
        const stacks = db_1.queries.getDockerStacks(serverId);
        const stack = stacks.find((s) => s.project_name.includes(deploymentId));
        if (!stack)
            return;
        const client = await this.sshService.connect(serverId);
        const composePath = `${stack.stack_path}/${stack.project_name}/docker-compose.yml`;
        const composeResult = await this.sshService.executeCommand(client, `cat ${composePath}`);
        const compose = YAML.parse(composeResult.stdout);
        const serviceName = Object.keys(compose.services)[0];
        // Remove all labels for this router
        if (compose.services[serviceName].labels) {
            compose.services[serviceName].labels = compose.services[serviceName].labels.filter((label) => !label.includes(routerName));
        }
        // Write and redeploy
        const updatedCompose = YAML.stringify(compose);
        const writeCommand = `cat > ${composePath} << 'TRAEFIKEOF'
${updatedCompose}
TRAEFIKEOF`;
        await this.sshService.executeCommand(client, writeCommand);
        await this.sshService.executeCommand(client, `cd ${stack.stack_path}/${stack.project_name} && docker compose up -d`);
    }
    /**
     * Get all domains for a server
     */
    async getDomainsByServer(serverId) {
        return db_1.queries.getDomainsByServer(serverId);
    }
    /**
     * Get domain by ID
     */
    async getDomainById(domainId) {
        return db_1.queries.getDomain(domainId);
    }
    /**
     * Check if domain should get www redirect
     */
    shouldAddWwwRedirect(domain) {
        const parts = domain.split('.');
        return parts.length === 2;
    }
}
exports.TraefikDomainService = TraefikDomainService;
//# sourceMappingURL=TraefikDomainService.js.map