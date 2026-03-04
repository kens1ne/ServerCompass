"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnmanagedAppDetectionService = void 0;
const db_1 = require("../db");
class UnmanagedAppDetectionService {
    sshService;
    // System services to exclude (these are infrastructure, not user applications)
    EXCLUDED_PROCESSES = [
        'sshd', // SSH daemon
        'systemd', // System and service manager
        'systemd-r', // systemd-resolved (DNS)
        'init', // System initialization
        'exim4', // Mail transfer agent
        'dovecot', // Mail server (IMAP/POP3)
        'proftpd', // FTP server
        'postfix', // Postfix mail stack
        'traefik', // Reverse proxy managed outside app list
        'treafik', // Common misspelling of Traefik
    ];
    constructor(sshService) {
        this.sshService = sshService;
    }
    /**
     * Detects all unmanaged applications running on the specified server
     *
     * @param serverId - The server ID to scan
     * @returns Promise<UnmanagedAppDetectionResult> - Detection results with list of unmanaged apps
     */
    async detectUnmanagedApps(serverId) {
        try {
            // Step 1: Scan all listening ports on the server
            const portsByProcess = await this.scanListeningPorts(serverId);
            // Step 2: Get list of apps managed by Server Compass
            const managedApps = await this.getManagedApps(serverId);
            // Step 3: Process each detected application and classify it
            const unmanagedApps = [];
            for (const [, info] of portsByProcess) {
                const { processName, pid, ports: processPorts } = info;
                const processLower = processName.toLowerCase();
                // Skip excluded system services
                if (this.isExcludedProcess(processLower)) {
                    continue;
                }
                // Detect and classify the application
                const app = await this.classifyAndCheckApp(serverId, processName, pid, processPorts, managedApps);
                if (app) {
                    unmanagedApps.push(app);
                }
            }
            return {
                hasUnmanaged: unmanagedApps.length > 0,
                unmanagedApps,
            };
        }
        catch (error) {
            console.error('[UnmanagedAppDetectionService] Detection failed:', error);
            throw error;
        }
    }
    /**
     * Step 1: Scan all listening ports using ss or netstat
     *
     * @param serverId - Server to scan
     * @returns Map of process key -> process info with ports
     */
    async scanListeningPorts(serverId) {
        // Multi-tool detection script: tries ss first (modern), falls back to netstat (universal)
        const scanCommand = `
# Try multiple detection methods
if command -v ss >/dev/null 2>&1; then
  ss -tulnp 2>/dev/null | awk 'NR>1 && ($1 ~ /^tcp/ || $1 ~ /^udp/) {
    # Extract port from local address
    if (match($5, /:([0-9]+)$/, m)) {
      port = m[1]
      proto = $1
      # Extract process info
      process = $7
      if (match(process, /"([^"]+)".*pid=([0-9]+)/, p)) {
        print proto "|" port "|" p[1] "|" p[2]
      } else {
        print proto "|" port "|unknown|0"
      }
    }
  }'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tulnp 2>/dev/null | awk '($1 ~ /^tcp/ || $1 ~ /^udp/) && ($6=="LISTEN" || $1~/udp/) {
    # Extract port
    if (match($4, /:([0-9]+)$/, m)) {
      port = m[1]
      proto = $1
      # Extract PID and process
      if (match($7, /([0-9]+)\\/([^ ]+)/, p)) {
        print proto "|" port "|" p[2] "|" p[1]
      } else {
        print proto "|" port "|unknown|0"
      }
    }
  }'
else
  echo ""
fi
`;
        const result = await this.sshService.executeCommand(serverId, scanCommand);
        if (!result.stdout || result.stdout.trim() === '') {
            return new Map();
        }
        // Parse output and group ports by process
        const portsByProcess = new Map();
        const lines = result.stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
            const [protoRaw, portStr, processNameRaw, pidStr] = line.split('|');
            const protocol = this.normalizeProtocol(protoRaw);
            const port = parseInt(portStr, 10);
            const pid = parseInt(pidStr, 10);
            const processName = (processNameRaw || '').trim();
            if (isNaN(port) || port <= 0)
                continue;
            const hasProcessName = !!processName && processName !== 'unknown';
            const resolvedProcessName = hasProcessName ? processName : `unknown-${protocol}-${port}`;
            const resolvedPid = Number.isFinite(pid) && pid > 0 ? pid : -1;
            // Group ports by process (process name + PID or port fallback)
            const key = `${resolvedProcessName}-${resolvedPid > 0 ? resolvedPid : `${protocol}-${port}`}`;
            if (!portsByProcess.has(key)) {
                portsByProcess.set(key, {
                    ports: [{ port, protocol }],
                    pid: resolvedPid,
                    processName: resolvedProcessName,
                    isUnknownProcess: !hasProcessName,
                });
            }
            else {
                portsByProcess.get(key).ports.push({ port, protocol });
            }
        }
        // Normalize ports per process (unique + sorted) to avoid noisy duplicates
        for (const [, info] of portsByProcess) {
            const uniquePorts = new Map();
            info.ports.forEach((p) => {
                uniquePorts.set(`${p.protocol}-${p.port}`, p);
            });
            info.ports = Array.from(uniquePorts.values()).sort((a, b) => {
                if (a.port === b.port) {
                    return a.protocol.localeCompare(b.protocol);
                }
                return a.port - b.port;
            });
        }
        return portsByProcess;
    }
    /**
     * Step 2: Get all apps managed by Server Compass
     *
     * @param serverId - Server ID
     * @returns Object with managed Docker project names and PM2 app names
     */
    async getManagedApps(serverId) {
        // Get managed Docker stacks
        const managedStacks = db_1.queries.getDockerStacks(serverId);
        const dockerProjects = new Set(managedStacks.map((stack) => stack.project_name.toLowerCase()));
        // Get managed PM2 apps
        const pm2Apps = new Set();
        try {
            const deployments = db_1.queries.getDeploymentsByServer(serverId);
            deployments.forEach((dep) => {
                if (dep.app_name) {
                    pm2Apps.add(dep.app_name.toLowerCase());
                }
            });
        }
        catch (err) {
            console.log('[UnmanagedAppDetectionService] No PM2 deployments found');
        }
        return { dockerProjects, pm2Apps };
    }
    /**
     * Step 3: Classify application type and check if it's managed
     *
     * @param serverId - Server ID
     * @param processName - Process name from netstat/ss
     * @param pid - Process ID
     * @param ports - Array of ports this process is listening on
     * @param managedApps - Set of apps managed by Server Compass
     * @returns UnmanagedApp if unmanaged, null if managed or should be excluded
     */
    async classifyAndCheckApp(serverId, processName, pid, ports, managedApps) {
        const processLower = processName.toLowerCase();
        // If we cannot resolve a process name, still surface it as unmanaged
        if (processName.startsWith('unknown-')) {
            return this.detectGenericProcess(processName, pid, ports);
        }
        // Docker Container Detection
        if (processLower.includes('docker-prox') || processLower.includes('docker-pr')) {
            return await this.detectDockerContainer(serverId, pid, ports, managedApps.dockerProjects);
        }
        // Node.js/Next.js Application Detection
        if (processLower.includes('node') || processLower.includes('next-server')) {
            return this.detectNodeApp(processName, pid, ports, managedApps.pm2Apps);
        }
        // Database Detection
        if (this.isDatabaseProcess(processLower)) {
            return this.detectDatabase(processName, pid, ports);
        }
        // Web Server Detection
        if (processLower.includes('nginx') || processLower.includes('apache')) {
            return this.detectWebServer(processName, pid, ports);
        }
        // Other Application Runtime Detection
        if (this.isApplicationRuntime(processLower)) {
            return this.detectApplicationRuntime(processName, pid, ports);
        }
        // Fallback: surface any remaining process as unmanaged so the user can review it
        return this.detectGenericProcess(processName, pid, ports);
    }
    /**
     * Detect Docker container details
     */
    async detectDockerContainer(serverId, pid, ports, managedProjects) {
        try {
            // Query Docker for container info using the first port
            const dockerPort = ports[0]?.port;
            if (!dockerPort) {
                return null;
            }
            const dockerCmd = `docker ps --filter "publish=${dockerPort}" --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Label \\"com.docker.compose.project\\"}}" 2>/dev/null | head -1`;
            const dockerResult = await this.sshService.executeCommand(serverId, dockerCmd);
            if (!dockerResult.stdout || !dockerResult.stdout.trim()) {
                return null;
            }
            const [containerId, rawContainerName, image, rawProjectLabel] = dockerResult.stdout.trim().split('|');
            const containerName = (rawContainerName || '').trim();
            if (!containerName) {
                return null;
            }
            let projectName = (rawProjectLabel || '').trim();
            if (!projectName) {
                const composeV2Pattern = containerName.match(/^(.*)-[a-z0-9_.-]+-\d+$/i);
                if (composeV2Pattern?.[1]) {
                    projectName = composeV2Pattern[1];
                }
            }
            if (!projectName && containerName.toLowerCase().endsWith('-app')) {
                projectName = containerName.slice(0, -4);
            }
            if (!projectName) {
                projectName = containerName;
            }
            const containerNameLower = containerName.toLowerCase();
            const projectNameLower = projectName.toLowerCase();
            // Check if container name should be excluded (e.g., traefik)
            if (this.isExcludedProcess(containerNameLower) || this.isExcludedProcess(projectNameLower)) {
                return null;
            }
            // Check if managed by Server Compass
            const isManaged = managedProjects.has(projectNameLower) ||
                managedProjects.has(containerNameLower);
            if (isManaged) {
                return null;
            }
            const containerIdFallback = this.buildContainerId('docker', pid, ports);
            return {
                containerId: containerId || containerIdFallback,
                name: containerName || 'Docker Container',
                image: image || 'Docker Container',
                status: 'running',
                ports: ports.map(p => ({ hostPort: p.port, containerPort: p.port, protocol: p.protocol })),
                created: '',
                projectName,
            };
        }
        catch (error) {
            console.error('[UnmanagedAppDetectionService] Docker detection failed:', error);
            return null;
        }
    }
    /**
     * Detect Node.js/Next.js application
     */
    detectNodeApp(processName, pid, ports, managedPM2Apps) {
        const processLower = processName.toLowerCase();
        const appType = processLower.includes('next-server') ? 'Next.js App' : 'Node.js App';
        // Check if managed by PM2
        const isManaged = managedPM2Apps.has(processName.toLowerCase());
        if (isManaged) {
            return null;
        }
        return {
            containerId: this.buildContainerId('proc', pid, ports),
            name: processName,
            image: appType,
            status: 'running',
            ports: ports.map(p => ({ hostPort: p.port, containerPort: p.port, protocol: p.protocol })),
            created: '',
            projectName: processName,
        };
    }
    /**
     * Detect database service
     */
    detectDatabase(processName, pid, ports) {
        const processLower = processName.toLowerCase();
        let dbType = 'Database';
        if (processLower.includes('postgres'))
            dbType = 'PostgreSQL';
        else if (processLower.includes('mysql'))
            dbType = 'MySQL';
        else if (processLower.includes('redis'))
            dbType = 'Redis';
        else if (processLower.includes('mongo'))
            dbType = 'MongoDB';
        return {
            containerId: this.buildContainerId(`db-${dbType.toLowerCase()}`, pid, ports),
            name: dbType,
            image: `Database (${dbType})`,
            status: 'running',
            ports: ports.map(p => ({ hostPort: p.port, containerPort: p.port, protocol: p.protocol })),
            created: '',
            projectName: dbType.toLowerCase(),
        };
    }
    /**
     * Detect web server (Nginx, Apache)
     */
    detectWebServer(processName, pid, ports) {
        const processLower = processName.toLowerCase();
        const serverType = processLower.includes('nginx') ? 'Nginx' : 'Apache';
        return {
            containerId: this.buildContainerId('web', pid, ports),
            name: serverType,
            image: `Web Server (${serverType})`,
            status: 'running',
            ports: ports.map(p => ({ hostPort: p.port, containerPort: p.port, protocol: p.protocol })),
            created: '',
            projectName: serverType.toLowerCase(),
        };
    }
    /**
     * Detect other application runtime
     */
    detectApplicationRuntime(processName, pid, ports) {
        return {
            containerId: this.buildContainerId('app', pid, ports),
            name: processName,
            image: 'Application',
            status: 'running',
            ports: ports.map(p => ({ hostPort: p.port, containerPort: p.port, protocol: p.protocol })),
            created: '',
            projectName: processName,
        };
    }
    /**
     * Fallback for unclassified processes (still surfaced to the user)
     */
    detectGenericProcess(processName, pid, ports) {
        return {
            containerId: this.buildContainerId('proc', pid, ports),
            name: processName,
            image: 'Unclassified Process',
            status: 'running',
            ports: ports.map((p) => ({ hostPort: p.port, containerPort: p.port, protocol: p.protocol })),
            created: '',
            projectName: processName,
        };
    }
    /**
     * Helper: Check if process should be excluded
     */
    isExcludedProcess(processNameLower) {
        return this.EXCLUDED_PROCESSES.some(excluded => processNameLower.includes(excluded));
    }
    /**
     * Helper: Normalize protocol to preserve tcp/tcp6/udp/udp6 for display
     */
    normalizeProtocol(protoRaw) {
        const proto = (protoRaw || '').toLowerCase();
        if (proto.startsWith('tcp6'))
            return 'tcp6';
        if (proto.startsWith('udp6'))
            return 'udp6';
        if (proto.startsWith('tcp'))
            return 'tcp';
        if (proto.startsWith('udp'))
            return 'udp';
        return proto || 'tcp';
    }
    /**
     * Helper: Build a stable containerId even when PID is unavailable
     */
    buildContainerId(prefix, pid, ports) {
        const fallback = ports[0]?.port ?? 'unknown';
        const suffix = pid > 0 ? pid : fallback;
        return `${prefix}-${suffix}`;
    }
    /**
     * Helper: Check if process is a database
     */
    isDatabaseProcess(processNameLower) {
        return processNameLower.includes('postgres') ||
            processNameLower.includes('mysql') ||
            processNameLower.includes('redis') ||
            processNameLower.includes('mongo');
    }
    /**
     * Helper: Check if process is an application runtime
     */
    isApplicationRuntime(processNameLower) {
        const runtimes = ['python', 'java', 'php-fpm', 'php', 'ruby', 'node', 'next'];
        return runtimes.some(runtime => processNameLower.includes(runtime));
    }
    /**
     * Remove an unmanaged application
     *
     * Supports removing:
     * - Docker containers (containerId format: actual Docker container ID or "docker-xxx")
     * - Processes (containerId format: "proc-xxx", "db-xxx", "web-xxx", "app-xxx")
     *
     * @param serverId - The server ID
     * @param containerId - The container/process ID to remove
     * @param force - Force removal (for Docker: rm -f, for processes: kill -9)
     * @returns Promise with removal result
     */
    async removeUnmanagedApp(serverId, containerId, force = true) {
        try {
            // Determine the type based on containerId prefix
            const isDocker = containerId.startsWith('docker-') ||
                // Docker container IDs are 12+ hex characters
                /^[a-f0-9]{12,}$/i.test(containerId);
            const isProcess = containerId.startsWith('proc-') ||
                containerId.startsWith('db-') ||
                containerId.startsWith('web-') ||
                containerId.startsWith('app-');
            if (isDocker) {
                return await this.removeDockerContainer(serverId, containerId, force);
            }
            else if (isProcess) {
                return await this.removeProcess(serverId, containerId, force);
            }
            else {
                // Try Docker first (most common case for unmanaged apps)
                const dockerResult = await this.removeDockerContainer(serverId, containerId, force);
                if (dockerResult.success) {
                    return dockerResult;
                }
                // Fall back to treating it as a process ID
                return await this.removeProcess(serverId, containerId, force);
            }
        }
        catch (error) {
            console.error('[UnmanagedAppDetectionService] Removal failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Remove a Docker container
     */
    async removeDockerContainer(serverId, containerId, force) {
        // Extract actual container ID if prefixed
        const actualId = containerId.startsWith('docker-')
            ? containerId.slice(7)
            : containerId;
        const forceFlag = force ? '-f' : '';
        const command = `docker rm ${forceFlag} ${actualId} 2>&1`;
        const result = await this.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0) {
            // Check if container is running and needs to be stopped first
            if (result.stderr?.includes('running') && !force) {
                return {
                    success: false,
                    error: 'Container is running. Use force removal to stop and remove it.',
                };
            }
            return {
                success: false,
                error: result.stderr || result.stdout || 'Failed to remove container',
            };
        }
        return { success: true };
    }
    /**
     * Remove a process by killing it
     */
    async removeProcess(serverId, containerId, force) {
        // Extract PID from containerId (e.g., "proc-1234" -> "1234")
        const pidMatch = containerId.match(/-(\d+)$/);
        if (!pidMatch) {
            return {
                success: false,
                error: `Invalid process ID format: ${containerId}`,
            };
        }
        const pid = pidMatch[1];
        const signal = force ? '-9' : '-15';
        const command = `kill ${signal} ${pid} 2>&1`;
        const result = await this.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0) {
            // Check if process doesn't exist
            if (result.stderr?.includes('No such process')) {
                return {
                    success: true, // Process is already gone
                };
            }
            return {
                success: false,
                error: result.stderr || result.stdout || 'Failed to kill process',
            };
        }
        return { success: true };
    }
}
exports.UnmanagedAppDetectionService = UnmanagedAppDetectionService;
//# sourceMappingURL=UnmanagedAppDetectionService.js.map