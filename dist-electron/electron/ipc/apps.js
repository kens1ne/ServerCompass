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
exports.registerAppHandlers = registerAppHandlers;
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const types_1 = require("./types");
const db_1 = require("../db");
const DeploymentService_1 = require("../services/DeploymentService");
const SSHService_1 = require("../services/SSHService");
const DeploymentQueueService_1 = require("../services/DeploymentQueueService");
const LicenseService_1 = require("../services/LicenseService");
const startCommand_1 = require("../utils/startCommand");
const deploymentService = new DeploymentService_1.DeploymentService();
function registerAppHandlers() {
    // Get apps (deployments) by server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APPS_GET_BY_SERVER, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const deployments = db_1.queries.getDeploymentsByServer(id);
            return { success: true, data: deployments };
        }
        catch (error) {
            console.error('Error getting apps:', error);
            return { success: false, error: String(error) };
        }
    });
    // Create deployment
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DEPLOYMENTS_CREATE, async (_event, input) => {
        try {
            const validated = types_1.CreateDeploymentSchema.parse(input);
            const limitCheck = LicenseService_1.licenseService.canAddDeployment();
            if (!limitCheck.allowed) {
                const message = limitCheck.reason ||
                    `Free trial allows up to ${limitCheck.max ?? 0} deployment(s). Activate a license to deploy more applications.`;
                return { success: false, error: message };
            }
            const deployment = {
                id: (0, crypto_1.randomUUID)(),
                server_id: validated.serverId,
                repo_url: validated.repoUrl || null,
                branch: validated.branch || null,
                commit_hash: null,
                env_summary: validated.envVars
                    ? Object.keys(validated.envVars).join(', ')
                    : null,
                status: 'running',
                started_at: Date.now(),
                finished_at: null,
                log_path: null,
                // New fields for deployment history
                app_name: null,
                build_command: null,
                start_command: null,
                port: null,
                runtime: 'node',
            };
            db_1.queries.createDeployment(deployment);
            // Start deployment in background
            deploymentService.deploy(deployment.id, validated).catch((error) => {
                console.error('Deployment failed:', error);
                db_1.queries.updateDeployment(deployment.id, {
                    status: 'failed',
                    finished_at: Date.now(),
                });
            });
            return { success: true, data: deployment };
        }
        catch (error) {
            console.error('Error creating deployment:', error);
            return { success: false, error: String(error) };
        }
    });
    // Deploy service with template support
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVICE_DEPLOY, async (_event, input) => {
        try {
            const validated = types_1.DeployServiceSchema.parse(input);
            // Use deployment queue to ensure only one deployment per app at a time
            let result;
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(validated.serverId, validated.appName, async () => {
                result = await deploymentService.deployService(validated);
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error deploying service:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get deployment history for an app
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_GET_DEPLOYMENTS, async (_event, input) => {
        try {
            const { serverId, appName } = types_1.GetAppDeploymentsSchema.parse(input);
            const deployments = db_1.queries.getDeploymentsByApp(serverId, appName);
            return { success: true, data: deployments };
        }
        catch (error) {
            console.error('Error getting app deployments:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update deployment status
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_UPDATE_DEPLOYMENT_STATUS, async (_event, input) => {
        try {
            const { deploymentId, status, finishedAt } = types_1.UpdateDeploymentStatusSchema.parse(input);
            const updates = { status };
            if (finishedAt) {
                updates.finished_at = finishedAt;
            }
            db_1.queries.updateDeployment(deploymentId, updates);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error updating deployment status:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get all apps from deployments for a server (includes failed deployments)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_GET_FROM_DEPLOYMENTS, async (_event, input) => {
        try {
            const { serverId } = types_1.GetAppsFromDeploymentsSchema.parse(input);
            const apps = db_1.queries.getAppsFromDeployments(serverId);
            return { success: true, data: apps };
        }
        catch (error) {
            console.error('Error getting apps from deployments:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get deployment by ID
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DEPLOYMENT_GET_BY_ID, async (_event, input) => {
        try {
            const { deploymentId } = types_1.GetDeploymentByIdSchema.parse(input);
            const deployment = db_1.queries.getDeploymentById(deploymentId);
            return { success: true, data: deployment ?? null };
        }
        catch (error) {
            console.error('Error getting deployment by ID:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete app (PM2 process and working directory)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_DELETE, async (_event, input) => {
        try {
            const validated = types_1.DeleteAppSchema.parse(input);
            const { serverId, appName, pmId, workingDirectory } = validated;
            // Step 1: Stop and delete PM2 process
            const target = pmId !== null ? String(pmId) : appName;
            const deleteCommand = `pm2 delete ${target}`;
            const pm2Result = await SSHService_1.sshService.executeCommand(serverId, deleteCommand);
            if (pm2Result.exitCode !== 0) {
                // If PM2 delete fails, log it but continue - the process might already be stopped
                console.warn('PM2 delete warning:', pm2Result.stderr);
            }
            // Step 2: Delete the working directory (if provided)
            if (workingDirectory && workingDirectory.trim()) {
                // Use rm -rf with safety checks to ensure we're not deleting root or important paths
                const safePaths = ['/var/www', '/root', '/home', '/opt', '/srv'];
                const isInSafePath = safePaths.some(path => workingDirectory.startsWith(path + '/'));
                if (!isInSafePath || workingDirectory === '/' || workingDirectory.length < 5) {
                    console.warn(`Skipping directory deletion: ${workingDirectory} (safety check failed)`);
                }
                else {
                    const deleteCommand2 = `rm -rf "${workingDirectory.replace(/"/g, '\\"')}"`;
                    const rmResult = await SSHService_1.sshService.executeCommand(serverId, deleteCommand2);
                    if (rmResult.exitCode !== 0) {
                        console.warn(`Failed to delete directory: ${rmResult.stderr}`);
                        // Continue anyway - the PM2 process is already deleted
                    }
                }
            }
            else {
                console.log('No working directory provided, skipping directory deletion');
            }
            // Step 3: Delete all app-related data from database
            db_1.queries.deleteAppData(serverId, appName);
            // Step 4: Save PM2 configuration
            await SSHService_1.sshService.executeCommand(serverId, 'pm2 save --force');
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting app:', error);
            return { success: false, error: String(error) };
        }
    });
    // Manual build (creates deployment record, runs build, reloads PM2)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_MANUAL_BUILD, async (_event, input) => {
        try {
            const validated = types_1.ManualBuildSchema.parse(input);
            const { serverId, appName, pmId, workingDirectory, buildCommand, repoUrl, branch } = validated;
            // Create deployment record
            const deploymentId = (0, crypto_1.randomUUID)();
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                repo_url: repoUrl || null,
                branch: branch || null,
                commit_hash: null, // Will be fetched if it's a git repo
                env_summary: null,
                status: 'running',
                started_at: Date.now(),
                finished_at: null,
                log_path: null,
                app_name: appName,
                build_command: buildCommand || 'npm run build',
                start_command: null,
                port: null,
                runtime: 'node',
            };
            db_1.queries.createDeployment(deployment);
            // Use deployment queue to ensure only one deployment per app at a time
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(serverId, appName, async () => {
                try {
                    // Get current commit hash if in git repo
                    let commitHash = null;
                    if (workingDirectory) {
                        const gitHashResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && git rev-parse HEAD 2>/dev/null || echo ""`);
                        if (gitHashResult.exitCode === 0 && gitHashResult.stdout.trim()) {
                            commitHash = gitHashResult.stdout.trim();
                        }
                        // Get current branch if not provided
                        if (!branch) {
                            const gitBranchResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`);
                            if (gitBranchResult.exitCode === 0 && gitBranchResult.stdout.trim()) {
                                deployment.branch = gitBranchResult.stdout.trim();
                            }
                        }
                    }
                    // Run build command
                    const finalBuildCommand = buildCommand || 'npm run build';
                    const buildResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && ${finalBuildCommand}`);
                    if (buildResult.exitCode !== 0) {
                        throw new Error(`Build failed: ${buildResult.stderr || buildResult.stdout}`);
                    }
                    // Reload PM2 process
                    const target = pmId !== null ? String(pmId) : appName;
                    const reloadResult = await SSHService_1.sshService.executeCommand(serverId, `pm2 reload ${target}`);
                    if (reloadResult.exitCode !== 0) {
                        throw new Error(`PM2 reload failed: ${reloadResult.stderr}`);
                    }
                    // Update deployment record to succeeded
                    db_1.queries.updateDeployment(deploymentId, {
                        status: 'succeeded',
                        finished_at: Date.now(),
                        commit_hash: commitHash,
                        working_directory: workingDirectory,
                        deployment_source: 'manual',
                    });
                }
                catch (error) {
                    // Update deployment record to failed
                    db_1.queries.updateDeployment(deploymentId, {
                        status: 'failed',
                        finished_at: Date.now(),
                    });
                    throw error;
                }
            });
            return { success: true, data: { deploymentId } };
        }
        catch (error) {
            console.error('Error running manual build:', error);
            return { success: false, error: String(error) };
        }
    });
    // Force fresh deployment (delete PM2 process, npm install, build, restart)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_FORCE_FRESH_DEPLOY, async (_event, input) => {
        try {
            const validated = types_1.ForceFreshDeploySchema.parse(input);
            const { serverId, appName, workingDirectory, port, buildCommand, repoUrl, branch } = validated;
            // Filter out invalid start commands (like "none")
            const sanitizedStartCommand = (0, startCommand_1.sanitizeStartCommand)(validated.startCommand);
            const finalStartCommand = sanitizedStartCommand || 'npm run start';
            // Create deployment record
            const deploymentId = (0, crypto_1.randomUUID)();
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                repo_url: repoUrl || null,
                branch: branch || null,
                commit_hash: null,
                env_summary: null,
                status: 'running',
                started_at: Date.now(),
                finished_at: null,
                log_path: null,
                app_name: appName,
                build_command: buildCommand || 'npm run build',
                start_command: finalStartCommand,
                port: port,
                runtime: 'node',
            };
            db_1.queries.createDeployment(deployment);
            // Use deployment queue to ensure only one deployment per app at a time
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(serverId, appName, async () => {
                try {
                    // Get current commit hash if in git repo
                    let commitHash = null;
                    if (workingDirectory) {
                        const gitHashResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && git rev-parse HEAD 2>/dev/null || echo ""`);
                        if (gitHashResult.exitCode === 0 && gitHashResult.stdout.trim()) {
                            commitHash = gitHashResult.stdout.trim();
                        }
                        // Get current branch if not provided
                        if (!branch) {
                            const gitBranchResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`);
                            if (gitBranchResult.exitCode === 0 && gitBranchResult.stdout.trim()) {
                                deployment.branch = gitBranchResult.stdout.trim();
                            }
                        }
                    }
                    // Step 1: Delete PM2 process
                    await SSHService_1.sshService.executeCommand(serverId, `pm2 delete ${appName} || true`);
                    // Step 2: Install dependencies
                    const installResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && npm install`);
                    if (installResult.exitCode !== 0) {
                        throw new Error(`npm install failed: ${installResult.stderr || installResult.stdout}`);
                    }
                    // Step 3: Run build command
                    const finalBuildCommand = buildCommand || 'npm run build';
                    const buildResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && ${finalBuildCommand}`);
                    if (buildResult.exitCode !== 0) {
                        throw new Error(`Build failed: ${buildResult.stderr || buildResult.stdout}`);
                    }
                    // Step 4: Start fresh PM2 process with port
                    const startResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && PORT=${port} NODE_ENV=production pm2 start "${finalStartCommand}" --name "${appName}" && pm2 save`);
                    if (startResult.exitCode !== 0) {
                        throw new Error(`PM2 start failed: ${startResult.stderr || startResult.stdout}`);
                    }
                    // Update deployment record to succeeded
                    db_1.queries.updateDeployment(deploymentId, {
                        status: 'succeeded',
                        finished_at: Date.now(),
                        commit_hash: commitHash,
                        working_directory: workingDirectory,
                        deployment_source: 'force-fresh',
                    });
                }
                catch (error) {
                    // Update deployment record to failed
                    db_1.queries.updateDeployment(deploymentId, {
                        status: 'failed',
                        finished_at: Date.now(),
                    });
                    throw error;
                }
            });
            return { success: true, data: { deploymentId } };
        }
        catch (error) {
            console.error('Error running force fresh deploy:', error);
            return { success: false, error: String(error) };
        }
    });
    // Simple reload (graceful reload without changing port or PM2 config)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_SIMPLE_RELOAD, async (_event, input) => {
        try {
            const validated = types_1.SimpleReloadSchema.parse(input);
            const { serverId, appName, workingDirectory, buildCommand, repoUrl, branch } = validated;
            // Create deployment record
            const deploymentId = (0, crypto_1.randomUUID)();
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                repo_url: repoUrl || null,
                branch: branch || null,
                commit_hash: null,
                env_summary: null,
                status: 'running',
                started_at: Date.now(),
                finished_at: null,
                log_path: null,
                app_name: appName,
                build_command: buildCommand || 'npm run build',
                start_command: null, // Not changing start command
                port: null, // Not changing port
                runtime: 'node',
            };
            db_1.queries.createDeployment(deployment);
            // Use deployment queue to ensure only one deployment per app at a time
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(serverId, appName, async () => {
                try {
                    // Get current commit hash if in git repo
                    let commitHash = null;
                    if (workingDirectory) {
                        const gitHashResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && git rev-parse HEAD 2>/dev/null || echo ""`);
                        if (gitHashResult.exitCode === 0 && gitHashResult.stdout.trim()) {
                            commitHash = gitHashResult.stdout.trim();
                        }
                        // Get current branch if not provided
                        if (!branch) {
                            const gitBranchResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`);
                            if (gitBranchResult.exitCode === 0 && gitBranchResult.stdout.trim()) {
                                deployment.branch = gitBranchResult.stdout.trim();
                            }
                        }
                    }
                    // Step 1: Install dependencies
                    const installResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && npm install`);
                    if (installResult.exitCode !== 0) {
                        throw new Error(`npm install failed: ${installResult.stderr || installResult.stdout}`);
                    }
                    // Step 2: Run build command if provided
                    if (buildCommand) {
                        const buildResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${workingDirectory}" && ${buildCommand}`);
                        if (buildResult.exitCode !== 0) {
                            throw new Error(`Build failed: ${buildResult.stderr || buildResult.stdout}`);
                        }
                    }
                    // Step 3: Gracefully reload PM2 process (preserves port and environment)
                    const reloadResult = await SSHService_1.sshService.executeCommand(serverId, `pm2 reload ${appName} && pm2 save`);
                    if (reloadResult.exitCode !== 0) {
                        throw new Error(`PM2 reload failed: ${reloadResult.stderr || reloadResult.stdout}`);
                    }
                    // Update deployment record to succeeded
                    db_1.queries.updateDeployment(deploymentId, {
                        status: 'succeeded',
                        finished_at: Date.now(),
                        commit_hash: commitHash,
                        working_directory: workingDirectory,
                        deployment_source: 'simple-reload',
                    });
                }
                catch (error) {
                    // Update deployment record to failed
                    db_1.queries.updateDeployment(deploymentId, {
                        status: 'failed',
                        finished_at: Date.now(),
                    });
                    throw error;
                }
            });
            return { success: true, data: { deploymentId } };
        }
        catch (error) {
            console.error('Error running simple reload:', error);
            return { success: false, error: String(error) };
        }
    });
    // Check port availability
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_CHECK_PORT_AVAILABILITY, async (_event, input) => {
        try {
            const { serverId, port } = types_1.CheckPortAvailabilitySchema.parse(input);
            // Get port bindings using bash and jq for proper JSON escaping
            const portsCommand = `
          # Auto-install jq if not available
          if ! command -v jq &>/dev/null; then
            echo "Installing jq..." >&2
            if command -v apt-get &>/dev/null; then
              sudo apt-get update -qq && sudo apt-get install -y jq >/dev/null 2>&1
            elif command -v yum &>/dev/null; then
              sudo yum install -y jq >/dev/null 2>&1
            fi
          fi

          ss -tlnpH 2>/dev/null | while IFS= read -r line; do
            # Extract port from local address (4th field)
            port=$(echo "$line" | awk '{print $4}' | grep -oE '[0-9]+$')

            # Extract PID from last field
            pid=$(echo "$line" | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | head -1)

            # Extract process name from last field
            processName=$(echo "$line" | grep -oE '"[^"]+"' | head -1 | tr -d '"')

            if [ -n "$port" ] && [ -n "$pid" ]; then
              # Read from /proc filesystem
              cmdline=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\\000' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
              cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
              ppid=$(grep '^PPid:' "/proc/$pid/status" 2>/dev/null | awk '{print $2}')

              # Use jq to properly create JSON object with escaping
              jq -n \\
                --arg port "$port" \\
                --arg pid "$pid" \\
                --arg ppid "$ppid" \\
                --arg processName "$processName" \\
                --arg cmdline "$cmdline" \\
                --arg cwd "$cwd" \\
                '{
                  port: ($port | tonumber),
                  pid: ($pid | tonumber),
                  ppid: (if $ppid == "" then null else ($ppid | tonumber) end),
                  processName: (if $processName == "" then null else $processName end),
                  cmdline: (if $cmdline == "" then null else $cmdline end),
                  cwd: (if $cwd == "" then null else $cwd end)
                }'
            fi
          done | jq -s '.'
        `;
            const portsResult = await SSHService_1.sshService.executeCommand(serverId, portsCommand);
            if (portsResult.exitCode !== 0) {
                throw new Error(`Failed to get port bindings: ${portsResult.stderr}`);
            }
            let portBindings = [];
            try {
                portBindings = JSON.parse(portsResult.stdout);
            }
            catch (e) {
                throw new Error('Failed to parse port bindings');
            }
            // Check if the requested port is in use
            const binding = portBindings.find(b => b.port === port);
            if (!binding) {
                // Port is available
                return {
                    success: true,
                    data: {
                        available: true,
                        port,
                    },
                };
            }
            // Port is in use - try to get PM2 info to identify the app
            const pm2Command = 'pm2 jlist';
            const pm2Result = await SSHService_1.sshService.executeCommand(serverId, pm2Command);
            let appName = 'Unknown Application';
            if (pm2Result.exitCode === 0) {
                try {
                    const pm2Processes = JSON.parse(pm2Result.stdout);
                    // Try to find PM2 process by PID or parent PID
                    const pm2Process = pm2Processes.find((p) => p.pid === binding.pid || p.pid === binding.ppid);
                    if (pm2Process) {
                        appName = pm2Process.name;
                    }
                }
                catch (e) {
                    // Ignore parse errors
                }
            }
            // Port is in use
            return {
                success: true,
                data: {
                    available: false,
                    port,
                    usedBy: {
                        appName,
                        pid: binding.pid,
                        processName: binding.processName,
                        cwd: binding.cwd,
                    },
                },
            };
        }
        catch (error) {
            console.error('Error checking port availability:', error);
            return { success: false, error: String(error) };
        }
    });
    // Local deployment: Select zip file
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_LOCAL_SELECT_FOLDER, async () => {
        try {
            const result = await electron_1.dialog.showOpenDialog({
                properties: ['openFile'],
                title: 'Select ZIP File',
                filters: [
                    { name: 'ZIP Archives', extensions: ['zip'] },
                    { name: 'All Files', extensions: ['*'] }
                ],
            });
            if (result.canceled || !result.filePaths[0]) {
                return { success: false, error: 'No file selected' };
            }
            return { success: true, data: { path: result.filePaths[0] } };
        }
        catch (error) {
            console.error('Error selecting zip file:', error);
            return { success: false, error: String(error) };
        }
    });
    // Local deployment: Get zip file info (size)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_LOCAL_GET_FOLDER_INFO, async (_event, input) => {
        try {
            const { localPath } = types_1.LocalFolderInfoSchema.parse(input);
            // Check if it's a zip file
            if (localPath.toLowerCase().endsWith('.zip')) {
                const stats = fs.statSync(localPath);
                // For zip files, we can't easily count files without extracting
                // So we return size and estimate file count as 0
                return {
                    success: true,
                    data: {
                        size: stats.size,
                        fileCount: 0, // Unknown until extracted
                    },
                };
            }
            // If not a zip file, return error
            return {
                success: false,
                error: 'Only ZIP files are supported. Please select a .zip file.',
            };
        }
        catch (error) {
            console.error('Error getting zip file info:', error);
            return { success: false, error: String(error) };
        }
    });
    // Local deployment: Detect framework (skipped for zip files)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_LOCAL_DETECT_FRAMEWORK, async (_event, input) => {
        try {
            const { localPath } = types_1.LocalDetectFrameworkSchema.parse(input);
            // For zip files, we can't detect framework without extracting
            // Return defaults
            if (localPath.toLowerCase().endsWith('.zip')) {
                return {
                    success: true,
                    data: {
                        framework: 'Node.js',
                        buildCommand: 'npm install && npm run build',
                        startCommand: 'npm start',
                    },
                };
            }
            // If not a zip file, return error
            return {
                success: false,
                error: 'Only ZIP files are supported. Please select a .zip file.',
            };
        }
        catch (error) {
            console.error('Error detecting framework:', error);
            return { success: false, error: String(error) };
        }
    });
    // Local deployment: Deploy from local folder
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_LOCAL_DEPLOY, async (_event, input) => {
        try {
            const validated = types_1.LocalDeploySchema.parse(input);
            // Check license
            const limitCheck = LicenseService_1.licenseService.canAddDeployment();
            if (!limitCheck.allowed) {
                const message = limitCheck.reason ||
                    `Free trial allows up to ${limitCheck.max ?? 0} deployment(s). Activate a license to deploy more applications.`;
                return { success: false, error: message };
            }
            // Use deployment queue to prevent concurrent deployments
            let result;
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(validated.serverId, validated.appName, async () => {
                result = await deploymentService.deployServiceFromLocal(validated);
            });
            if (!result) {
                return { success: false, error: 'Deployment failed to produce a result' };
            }
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error deploying from local folder:', error);
            return { success: false, error: String(error) };
        }
    });
    // Local deployment: Re-upload and redeploy
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_LOCAL_REUPLOAD, async (_event, input) => {
        try {
            const validated = types_1.LocalReuploadSchema.parse(input);
            let result;
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(validated.serverId, validated.appName, async () => {
                result = await deploymentService.reuploadLocalApp(validated);
            });
            if (!result) {
                return { success: false, error: 'Re-upload failed to produce a result' };
            }
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error re-uploading local app:', error);
            return { success: false, error: String(error) };
        }
    });
    // Local deployment: Link Git to local app
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_LOCAL_LINK_GIT, async (_event, input) => {
        try {
            const validated = types_1.LocalLinkGitSchema.parse(input);
            let result;
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(validated.serverId, validated.appName, async () => {
                result = await deploymentService.linkGitToLocalApp(validated);
            });
            if (!result) {
                return { success: false, error: 'Git linking failed to produce a result' };
            }
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error linking Git to local app:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=apps.js.map