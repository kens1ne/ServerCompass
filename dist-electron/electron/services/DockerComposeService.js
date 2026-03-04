"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dockerComposeService = exports.DockerComposeService = void 0;
const events_1 = require("events");
const crypto_1 = require("crypto");
const SSHService_1 = require("./SSHService");
const CredentialVault_1 = require("./CredentialVault");
const db_1 = require("../db");
class DockerComposeService extends events_1.EventEmitter {
    sshService;
    credentialVault;
    mainWindow = null;
    constructor(sshService, credentialVault) {
        super();
        this.sshService = sshService;
        this.credentialVault = credentialVault;
    }
    setMainWindow(window) {
        this.mainWindow = window;
    }
    emitLog(message, type = 'info', step) {
        const logEntry = {
            message,
            type,
            timestamp: Date.now(),
            step,
        };
        console.log(`[DockerCompose] ${type.toUpperCase()}: ${message}`);
        if (this.mainWindow?.webContents) {
            this.mainWindow.webContents.send('docker:log', logEntry);
        }
        this.emit('log', logEntry);
    }
    /**
     * Execute command with timeout
     */
    async executeCommandWithTimeout(serverId, command, timeoutMs = 300000 // 5 minutes default
    ) {
        return Promise.race([
            this.sshService.executeCommand(serverId, command),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
        ]);
    }
    /**
     * Main deployment method - runs docker compose
     */
    async deploy(input) {
        const deploymentId = `docker-${(0, crypto_1.randomUUID)()}`;
        const { serverId, projectName, composeFileContent } = input;
        const workingDir = `/opt/servercompass/${projectName}`;
        this.emitLog(`Deploying ${projectName}...`, 'info', 'init');
        try {
            // 1. Ensure Docker and Docker Compose are installed
            this.emitLog('Checking Docker installation...', 'info', 'check-docker');
            await this.ensureDockerInstalled(serverId);
            // 2. Create working directory
            this.emitLog(`Creating working directory...`, 'info', 'create-dir');
            await this.executeCommandWithTimeout(serverId, `mkdir -p ${workingDir}`, 30000);
            // 3. Create .env file if env vars provided
            if (input.envVars && Object.keys(input.envVars).length > 0) {
                this.emitLog('Creating environment variables...', 'info', 'create-env');
                await this.createEnvFile(serverId, workingDir, input.envVars);
            }
            // 4. Upload docker-compose.yml
            this.emitLog('Uploading docker-compose.yml...', 'info', 'upload-compose');
            await this.uploadComposeFile(serverId, workingDir, composeFileContent);
            // 5. Login to registry (if credentials provided)
            if (input.registryUsername && input.registryPassword) {
                this.emitLog(`Logging in to ${input.registryType || 'docker'} registry...`, 'info', 'registry-login');
                await this.loginToRegistry(serverId, {
                    type: input.registryType,
                    url: input.registryUrl,
                    username: input.registryUsername,
                    password: input.registryPassword,
                });
            }
            // 6. Pull images (with longer timeout for large images)
            this.emitLog('Pulling Docker images (this may take a few minutes)...', 'info', 'pull-images');
            const pullResult = await this.executeCommandWithTimeout(serverId, `cd ${workingDir} && docker compose -p ${projectName} pull`, 600000 // 10 minutes for pulling images
            );
            if (pullResult.exitCode !== 0) {
                throw new Error(`Failed to pull images: ${pullResult.stderr || pullResult.stdout}`);
            }
            // 7. Start containers
            this.emitLog('Starting containers...', 'info', 'start-containers');
            const upResult = await this.executeCommandWithTimeout(serverId, `cd ${workingDir} && docker compose -p ${projectName} up -d`, 180000 // 3 minutes for starting containers
            );
            if (upResult.exitCode !== 0) {
                throw new Error(`Failed to start containers: ${upResult.stderr || upResult.stdout}`);
            }
            // 8. Get container status
            this.emitLog('Verifying container status...', 'info', 'verify-status');
            const containers = await this.getContainerStatus(serverId, workingDir, projectName);
            // 9. Create deployment record
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                project_name: projectName,
                compose_file_content: composeFileContent,
                compose_file_path: `${workingDir}/docker-compose.yml`,
                registry_type: input.registryType,
                registry_url: input.registryUrl,
                registry_username: input.registryUsername,
                encrypted_registry_password: input.registryPassword
                    ? await this.credentialVault.encrypt(input.registryPassword)
                    : undefined,
                auto_deploy: input.autoUpdate ? 1 : 0,
                last_deployed_at: Date.now(),
                deployment_status: 'running',
            };
            // Store deployment in database
            await this.createDeploymentRecord(deployment);
            // Save container info to database
            await this.saveContainerInfo(deploymentId, containers);
            this.emitLog(`✅ Deployment successful! ${containers.length} container(s) running.`, 'success', 'complete');
            return {
                success: true,
                deploymentId,
                projectName,
                services: containers.map(c => c.service),
                containers,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isTimeout = errorMessage.includes('timed out');
            if (isTimeout) {
                this.emitLog(`❌ Deployment timed out: ${errorMessage}. This usually happens with large images or slow networks. Try again or check your server's network connection.`, 'error', 'timeout');
            }
            else {
                this.emitLog(`❌ Deployment failed: ${errorMessage}`, 'error', 'failed');
            }
            // Update deployment status to failed
            try {
                await this.updateDeploymentStatus(deploymentId, 'failed');
            }
            catch (dbError) {
                console.error('Failed to update deployment status:', dbError);
            }
            return {
                success: false,
                error: errorMessage,
            };
        }
    }
    /**
     * Ensure Docker and Docker Compose are installed
     */
    async waitForAptLock(serverId, maxWaitSeconds = 120) {
        const checkLockCmd = `
      SECONDS=0
      while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || fuser /var/lib/dpkg/lock >/dev/null 2>&1; do
        if [ $SECONDS -ge ${maxWaitSeconds} ]; then
          echo "Timeout waiting for apt lock"
          exit 1
        fi
        sleep 2
      done
    `;
        this.emitLog('Waiting for apt locks to be released...', 'info');
        const result = await this.sshService.executeCommand(serverId, checkLockCmd);
        if (result.exitCode !== 0) {
            this.emitLog('Warning: apt lock wait timed out, proceeding anyway...', 'warning');
        }
        else {
            this.emitLog('Apt locks released', 'info');
        }
    }
    async ensureDockerInstalled(serverId) {
        // Check if docker is installed
        const dockerCheck = await this.sshService.executeCommand(serverId, 'docker --version');
        if (dockerCheck.exitCode !== 0) {
            this.emitLog('Docker not found, installing...', 'info');
            // Wait for any existing apt processes to finish
            await this.waitForAptLock(serverId);
            // Update package list
            await this.sshService.executeCommand(serverId, 'apt-get update');
            // Install Docker using official script
            const installResult = await this.sshService.executeCommand(serverId, 'curl -fsSL https://get.docker.com | sh');
            if (installResult.exitCode !== 0) {
                throw new Error(`Failed to install Docker: ${installResult.stderr}`);
            }
            // Start and enable Docker service
            await this.sshService.executeCommand(serverId, 'systemctl start docker');
            await this.sshService.executeCommand(serverId, 'systemctl enable docker');
            this.emitLog('Docker installed successfully', 'success');
        }
        // Check if docker compose v2 is available
        const composeCheck = await this.sshService.executeCommand(serverId, 'docker compose version');
        if (composeCheck.exitCode !== 0) {
            this.emitLog('Docker Compose not found, installing...', 'info');
            // Wait for any existing apt processes to finish
            await this.waitForAptLock(serverId);
            // Install docker-compose-plugin
            const installComposeResult = await this.sshService.executeCommand(serverId, 'apt-get install -y docker-compose-plugin');
            if (installComposeResult.exitCode !== 0) {
                throw new Error(`Failed to install Docker Compose: ${installComposeResult.stderr}`);
            }
            this.emitLog('Docker Compose installed successfully', 'success');
        }
    }
    /**
     * Create .env file with environment variables
     */
    async createEnvFile(serverId, workingDir, envVars) {
        const envContent = Object.entries(envVars)
            .map(([key, value]) => {
            // Escape special characters and wrap in quotes if needed
            const needsQuotes = value.includes(' ') || value.includes('\n') || value.includes('"');
            const escapedValue = value.replace(/"/g, '\\"');
            return needsQuotes ? `${key}="${escapedValue}"` : `${key}=${value}`;
        })
            .join('\n');
        const command = `cat > ${workingDir}/.env << 'ENV_EOF'
${envContent}
ENV_EOF`;
        await this.sshService.executeCommand(serverId, command);
    }
    /**
     * Upload docker-compose.yml to server
     */
    async uploadComposeFile(serverId, workingDir, content) {
        // Use heredoc to avoid escaping issues
        const command = `cat > ${workingDir}/docker-compose.yml << 'COMPOSE_EOF'
${content}
COMPOSE_EOF`;
        const result = await this.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to upload compose file: ${result.stderr}`);
        }
    }
    /**
     * Login to container registry
     */
    async loginToRegistry(serverId, registry) {
        let registryUrl = '';
        switch (registry.type) {
            case 'ghcr':
                registryUrl = 'ghcr.io';
                break;
            case 'gitlab':
                registryUrl = 'registry.gitlab.com';
                break;
            case 'dockerhub':
                registryUrl = ''; // Default registry
                break;
            case 'custom':
            case 'self_hosted':
                registryUrl = registry.url || '';
                break;
        }
        const loginCmd = registryUrl
            ? `echo "${registry.password}" | docker login ${registryUrl} -u ${registry.username} --password-stdin`
            : `echo "${registry.password}" | docker login -u ${registry.username} --password-stdin`;
        const result = await this.sshService.executeCommand(serverId, loginCmd);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to login to registry: ${result.stderr}`);
        }
    }
    /**
     * Get status of all containers in a project
     */
    async getContainerStatus(serverId, workingDir, projectName) {
        // Use docker ps with label filter instead of docker compose ps
        // This is more reliable as it filters by the actual project label Docker Compose sets
        // Docker Compose sets the label com.docker.compose.project on all containers
        if (!projectName) {
            // Fallback to docker compose ps if no project name provided
            const psResult = await this.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose ps --format json`);
            if (psResult.exitCode !== 0) {
                console.warn('Failed to get container status:', psResult.stderr);
                return [];
            }
            return this.parseContainerOutput(serverId, psResult.stdout);
        }
        // Use docker ps with label filter for precise project filtering
        const psResult = await this.sshService.executeCommand(serverId, `docker ps -a --filter "label=com.docker.compose.project=${projectName}" --format "{{json .}}"`);
        if (psResult.exitCode !== 0) {
            console.warn('Failed to get container status:', psResult.stderr);
            return [];
        }
        // Parse docker ps JSON output (one JSON object per line)
        // docker ps --format "{{json .}}" returns different fields than docker compose ps
        const containers = [];
        const lines = psResult.stdout.split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const container = JSON.parse(line);
                // Extract service name from Labels field
                // Docker Compose sets label: com.docker.compose.service=<service-name>
                const labels = container.Labels || '';
                let serviceName = '';
                if (labels) {
                    const match = labels.match(/com\.docker\.compose\.service=([^,]+)/);
                    if (match) {
                        serviceName = match[1];
                    }
                }
                containers.push({
                    id: container.ID || '',
                    name: container.Names || container.Name || '',
                    service: serviceName,
                    state: container.State || '',
                    status: container.Status || '',
                    image: container.Image || '',
                    ports: this.parseDockerPsPorts(container.Ports || ''),
                    health: undefined, // Will be enriched later if needed
                });
            }
            catch (e) {
                console.warn('Failed to parse container info:', e);
            }
        }
        // Get resource usage if containers exist
        if (containers.length > 0) {
            try {
                const containerIds = containers.map(c => c.id).filter(Boolean).join(' ');
                const statsResult = await this.sshService.executeCommand(serverId, `docker stats ${containerIds} --no-stream --format "{{json .}}"`);
                if (statsResult.exitCode === 0) {
                    const statsLines = statsResult.stdout.split('\n').filter(Boolean);
                    for (const line of statsLines) {
                        try {
                            const stats = JSON.parse(line);
                            const container = containers.find(c => c.id === stats.Container || c.name === stats.Name);
                            if (container) {
                                container.cpuPercent = stats.CPUPerc || '0%';
                                container.memUsage = stats.MemUsage || '0B';
                                container.memPercent = stats.MemPerc || '0%';
                            }
                        }
                        catch (e) {
                            console.warn('Failed to parse stats:', e);
                        }
                    }
                }
            }
            catch (e) {
                console.warn('Failed to get container stats:', e);
            }
        }
        return containers;
    }
    /**
     * Parse port mappings from Docker output
     */
    parsePorts(publishers) {
        const ports = [];
        for (const pub of publishers) {
            if (typeof pub === 'string') {
                // Parse string format like "8080:80/tcp"
                const match = pub.match(/(?:(\d+):)?(\d+)\/?(tcp|udp)?/);
                if (match) {
                    ports.push({
                        host: match[1] ? parseInt(match[1]) : undefined,
                        container: parseInt(match[2]),
                        protocol: match[3] || 'tcp',
                    });
                }
            }
            else if (typeof pub === 'object') {
                // Parse object format from docker compose ps --format json
                ports.push({
                    host: pub.PublishedPort || pub.HostPort,
                    container: pub.TargetPort || pub.ContainerPort,
                    protocol: pub.Protocol || 'tcp',
                });
            }
        }
        return ports;
    }
    /**
     * Parse port string from docker ps output
     * Format: "0.0.0.0:8080->80/tcp, 443/tcp"
     */
    parseDockerPsPorts(portsStr) {
        const ports = [];
        if (!portsStr)
            return ports;
        // Split by comma for multiple port mappings
        const portMappings = portsStr.split(',').map(s => s.trim());
        for (const mapping of portMappings) {
            // Match formats:
            // "0.0.0.0:8080->80/tcp" (published)
            // "80/tcp" (exposed but not published)
            const publishedMatch = mapping.match(/(?:[\d.]+:)?(\d+)->(\d+)\/(tcp|udp)/);
            const exposedMatch = mapping.match(/^(\d+)\/(tcp|udp)$/);
            if (publishedMatch) {
                ports.push({
                    host: parseInt(publishedMatch[1]),
                    container: parseInt(publishedMatch[2]),
                    protocol: publishedMatch[3],
                });
            }
            else if (exposedMatch) {
                ports.push({
                    host: undefined,
                    container: parseInt(exposedMatch[1]),
                    protocol: exposedMatch[2],
                });
            }
        }
        return ports;
    }
    /**
     * Parse container output from docker compose ps --format json
     */
    async parseContainerOutput(serverId, stdout) {
        const containers = [];
        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const container = JSON.parse(line);
                containers.push({
                    id: container.ID || container.Container || '',
                    name: container.Name || '',
                    service: container.Service || '',
                    state: container.State || '',
                    status: container.Status || '',
                    image: container.Image || '',
                    ports: this.parsePorts(container.Publishers || container.Ports || []),
                    health: container.Health || undefined,
                });
            }
            catch (e) {
                console.warn('Failed to parse container info:', e);
            }
        }
        // Get resource usage if containers exist
        if (containers.length > 0) {
            try {
                const containerIds = containers.map(c => c.id).filter(Boolean).join(' ');
                const statsResult = await this.sshService.executeCommand(serverId, `docker stats ${containerIds} --no-stream --format "{{json .}}"`);
                if (statsResult.exitCode === 0) {
                    const statsLines = statsResult.stdout.split('\n').filter(Boolean);
                    for (const line of statsLines) {
                        try {
                            const stats = JSON.parse(line);
                            const container = containers.find(c => c.id === stats.Container || c.name === stats.Name);
                            if (container) {
                                container.cpuPercent = stats.CPUPerc || '0%';
                                container.memUsage = stats.MemUsage || '0B';
                                container.memPercent = stats.MemPerc || '0%';
                            }
                        }
                        catch (e) {
                            console.warn('Failed to parse stats:', e);
                        }
                    }
                }
            }
            catch (e) {
                console.warn('Failed to get container stats:', e);
            }
        }
        return containers;
    }
    /**
     * Stream logs from a service
     */
    async *streamLogs(serverId, projectName, serviceName, tail = 100) {
        const workingDir = `/opt/servercompass/${projectName}`;
        const serviceArg = serviceName || '';
        const command = `cd ${workingDir} && docker compose logs -f --tail=${tail} ${serviceArg}`;
        // Create a promise-based stream wrapper
        const chunks = [];
        let resolveNext = null;
        let isComplete = false;
        // Start streaming command
        this.sshService.executeCommandStreaming(serverId, command, (data, _isError) => {
            chunks.push(data);
            if (resolveNext) {
                const resolve = resolveNext;
                resolveNext = null;
                resolve({ value: chunks.shift(), done: false });
            }
        }).then(() => {
            isComplete = true;
            if (resolveNext) {
                resolveNext({ value: undefined, done: true });
            }
        }).catch((error) => {
            console.error('Stream error:', error);
            isComplete = true;
            if (resolveNext) {
                resolveNext({ value: undefined, done: true });
            }
        });
        // Yield chunks as they become available
        while (!isComplete || chunks.length > 0) {
            if (chunks.length > 0) {
                yield chunks.shift();
            }
            else if (!isComplete) {
                // Wait for next chunk
                await new Promise((resolve) => {
                    resolveNext = resolve;
                }).then((result) => {
                    if (!result.done) {
                        return result.value;
                    }
                });
            }
        }
    }
    /**
     * Restart a specific service or all services
     */
    async restartService(serverId, projectName, serviceName) {
        const workingDir = `/opt/servercompass/${projectName}`;
        const serviceArg = serviceName || '';
        this.emitLog(serviceName
            ? `Restarting service ${serviceName}...`
            : 'Restarting all services...', 'info');
        const result = await this.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose restart ${serviceArg}`);
        if (result.exitCode === 0) {
            this.emitLog(serviceName
                ? `Service ${serviceName} restarted successfully`
                : 'All services restarted successfully', 'success');
        }
        return result;
    }
    /**
     * Stop all services
     */
    async stopAll(serverId, projectName) {
        const workingDir = `/opt/servercompass/${projectName}`;
        this.emitLog('Stopping all containers...', 'info');
        const result = await this.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose down`);
        if (result.exitCode === 0) {
            this.emitLog('All containers stopped successfully', 'success');
            await this.updateDeploymentStatusByProject(serverId, projectName, 'stopped');
        }
        return result;
    }
    /**
     * Redeploy - pull latest images and restart
     */
    async redeploy(serverId, projectName) {
        const workingDir = `/opt/servercompass/${projectName}`;
        this.emitLog(`Redeploying ${projectName}...`, 'info');
        try {
            // 1. Pull latest images
            this.emitLog('Pulling latest images...', 'info');
            const pullResult = await this.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose -p ${projectName} pull`);
            if (pullResult.exitCode !== 0) {
                throw new Error(`Failed to pull images: ${pullResult.stderr}`);
            }
            // 2. Recreate containers with new images
            this.emitLog('Recreating containers with new images...', 'info');
            const upResult = await this.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose -p ${projectName} up -d`);
            if (upResult.exitCode !== 0) {
                throw new Error(`Failed to recreate containers: ${upResult.stderr}`);
            }
            // 3. Get updated container status
            const containers = await this.getContainerStatus(serverId, workingDir, projectName);
            // Update deployment timestamp
            await this.updateDeploymentTimestamp(serverId, projectName);
            this.emitLog(`Redeployment successful! ${containers.length} container(s) running.`, 'success');
            return {
                success: true,
                projectName,
                services: containers.map(c => c.service),
                containers,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.emitLog(`Redeployment failed: ${errorMessage}`, 'error');
            return {
                success: false,
                error: errorMessage,
            };
        }
    }
    /**
     * Get deployment info from database
     */
    async getDeployment(deploymentId) {
        const stmt = db_1.db.prepare(`
      SELECT * FROM docker_compose_deployments
      WHERE id = ?
    `);
        return stmt.get(deploymentId);
    }
    /**
     * Get deployments by server
     */
    async getDeploymentsByServer(serverId) {
        const stmt = db_1.db.prepare(`
      SELECT * FROM docker_compose_deployments
      WHERE server_id = ?
      ORDER BY created_at DESC
    `);
        return stmt.all(serverId);
    }
    /**
     * Create deployment record in database
     */
    async createDeploymentRecord(deployment) {
        const stmt = db_1.db.prepare(`
      INSERT INTO docker_compose_deployments (
        id, server_id, project_name, compose_file_content, compose_file_path,
        registry_type, registry_url, registry_username, encrypted_registry_password,
        auto_deploy, webhook_secret, last_deployed_at, deployment_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const now = Date.now();
        stmt.run(deployment.id, deployment.server_id, deployment.project_name, deployment.compose_file_content, deployment.compose_file_path || null, deployment.registry_type || null, deployment.registry_url || null, deployment.registry_username || null, deployment.encrypted_registry_password || null, deployment.auto_deploy || 0, deployment.webhook_secret || null, deployment.last_deployed_at || now, deployment.deployment_status || 'pending', now, now);
    }
    /**
     * Update deployment status
     */
    async updateDeploymentStatus(deploymentId, status) {
        const stmt = db_1.db.prepare(`
      UPDATE docker_compose_deployments
      SET deployment_status = ?, updated_at = ?
      WHERE id = ?
    `);
        stmt.run(status, Date.now(), deploymentId);
    }
    /**
     * Update deployment status by project name
     */
    async updateDeploymentStatusByProject(serverId, projectName, status) {
        const stmt = db_1.db.prepare(`
      UPDATE docker_compose_deployments
      SET deployment_status = ?, updated_at = ?
      WHERE server_id = ? AND project_name = ?
    `);
        stmt.run(status, Date.now(), serverId, projectName);
    }
    /**
     * Update deployment timestamp
     */
    async updateDeploymentTimestamp(serverId, projectName) {
        const stmt = db_1.db.prepare(`
      UPDATE docker_compose_deployments
      SET last_deployed_at = ?, updated_at = ?
      WHERE server_id = ? AND project_name = ?
    `);
        const now = Date.now();
        stmt.run(now, now, serverId, projectName);
    }
    /**
     * Save container info to database
     */
    async saveContainerInfo(deploymentId, containers) {
        // Clear existing container info
        const deleteStmt = db_1.db.prepare(`
      DELETE FROM docker_compose_containers WHERE deployment_id = ?
    `);
        deleteStmt.run(deploymentId);
        // Insert new container info
        const insertStmt = db_1.db.prepare(`
      INSERT INTO docker_compose_containers (
        id, deployment_id, service_name, container_id, container_name,
        image, state, status, health, ports, cpu_percent, memory_usage,
        memory_limit, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (const container of containers) {
            const containerId = `container-${(0, crypto_1.randomUUID)()}`;
            insertStmt.run(containerId, deploymentId, container.service, container.id, container.name, container.image, container.state, container.status, container.health || null, JSON.stringify(container.ports), container.cpuPercent || null, container.memUsage || null, container.memPercent || null, Date.now());
        }
    }
    /**
     * Get containers for a deployment
     */
    async getContainers(deploymentId) {
        const stmt = db_1.db.prepare(`
      SELECT * FROM docker_compose_containers
      WHERE deployment_id = ?
      ORDER BY service_name
    `);
        const rows = stmt.all(deploymentId);
        return rows.map(row => ({
            id: row.container_id,
            name: row.container_name,
            service: row.service_name,
            state: row.state,
            status: row.status,
            image: row.image,
            ports: JSON.parse(row.ports || '[]'),
            health: row.health || undefined,
            cpuPercent: row.cpu_percent || undefined,
            memUsage: row.memory_usage || undefined,
            memPercent: row.memory_limit || undefined,
        }));
    }
}
exports.DockerComposeService = DockerComposeService;
// Export a singleton instance
exports.dockerComposeService = new DockerComposeService(new SSHService_1.SSHService(), new CredentialVault_1.CredentialVault());
//# sourceMappingURL=DockerComposeService.js.map