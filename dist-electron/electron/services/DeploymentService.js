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
exports.DeploymentService = void 0;
const events_1 = require("events");
const SSHService_1 = require("./SSHService");
const GitAccountService_1 = require("./GitAccountService");
const ProvisioningService_1 = require("./ProvisioningService");
const db_1 = require("../db");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const electron_1 = require("electron");
const types_1 = require("../ipc/types");
const startCommand_1 = require("../utils/startCommand");
const AppPreferences_1 = require("./AppPreferences");
class DeploymentService extends events_1.EventEmitter {
    // In-memory log storage per deployment
    deploymentLogs = new Map();
    /**
     * Emit log message to renderer and store in memory
     */
    emitLog(message, type = 'info', deploymentId) {
        const mainWindow = electron_1.BrowserWindow.getAllWindows()[0];
        const logEntry = { message, type, timestamp: Date.now() };
        if (mainWindow) {
            mainWindow.webContents.send(types_1.IPC_CHANNELS.DEPLOYMENT_LOG, logEntry);
        }
        // Store log in memory if deploymentId is provided
        if (deploymentId) {
            const logs = this.deploymentLogs.get(deploymentId) || [];
            logs.push(logEntry);
            this.deploymentLogs.set(deploymentId, logs);
        }
        console.log(`[DeploymentService] ${message}`);
    }
    /**
     * Truncate logs to configured limit and persist to database
     */
    persistLogs(deploymentId, errorMessage) {
        const logs = this.deploymentLogs.get(deploymentId) || [];
        if (logs.length === 0 && !errorMessage) {
            return; // Nothing to persist
        }
        const maxLines = AppPreferences_1.appPreferences.getMaxDeploymentLogLines();
        let truncatedLogs = logs;
        // Truncate if exceeds limit: keep first half and last half
        if (logs.length > maxLines) {
            const halfLimit = Math.floor(maxLines / 2);
            truncatedLogs = [
                ...logs.slice(0, halfLimit),
                { message: `... ${logs.length - maxLines} lines truncated ...`, type: 'info', timestamp: Date.now() },
                ...logs.slice(-halfLimit),
            ];
        }
        // Convert logs to JSON string
        const logsJson = JSON.stringify(truncatedLogs);
        // Store in database
        db_1.queries.updateDeploymentLogs(deploymentId, logsJson, errorMessage || null, logs.length);
        // Clean up from memory
        this.deploymentLogs.delete(deploymentId);
    }
    /**
     * Deploy a service with runtime support (Node.js)
     */
    async deployService(input) {
        const { serverId, runtime, repoUrl, branch, appName, port: customPort, buildCommand, startCommand, envVars, isRedeploy } = input;
        const sanitizedStartCommand = (0, startCommand_1.sanitizeStartCommand)(startCommand);
        // Get server info for URL
        const server = db_1.queries.getServerById(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        // Create deployment record
        const deploymentId = `deploy-${Date.now()}`;
        const deployment = {
            id: deploymentId,
            server_id: serverId,
            repo_url: repoUrl,
            branch: branch || 'main',
            commit_hash: null, // Will be updated after clone
            env_summary: envVars ? Object.keys(envVars).join(', ') : null,
            status: 'running',
            started_at: Date.now(),
            finished_at: null,
            log_path: null,
            app_name: appName,
            build_command: buildCommand || null,
            start_command: sanitizedStartCommand || null,
            port: customPort || null,
            runtime: runtime || 'node',
        };
        db_1.queries.createDeployment(deployment);
        try {
            // Background check: Ensure essential packages are installed before deployment
            this.emitLog('Checking server prerequisites...', 'info', deploymentId);
            await ProvisioningService_1.provisioningService.ensureEssentialPackages(serverId).catch((error) => {
                console.warn('[DeploymentService] Background package check had issues:', error);
                // Continue anyway - installSystemDependencies will handle missing packages
            });
            const steps = [
                { name: 'Install system dependencies', fn: this.installSystemDependencies.bind(this) },
                { name: 'Prepare deployment directory', fn: this.prepareDeploymentDirectory.bind(this) },
                { name: 'Clone/pull repository', fn: this.clonePullRepository.bind(this) },
                { name: 'Create environment file', fn: this.createEnvFile.bind(this) },
                { name: 'Install dependencies', fn: this.installProjectDependencies.bind(this) },
                { name: 'Build application', fn: this.buildApplication.bind(this) },
                { name: 'Configure PM2', fn: this.configureAndStartPM2.bind(this) },
            ];
            let detectedPort = customPort;
            let appPath = '';
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                this.emitLog(`[${i + 1}/${steps.length}] ${step.name}...`, 'info', deploymentId);
                try {
                    if (step.name === 'Clone/pull repository') {
                        appPath = await this.clonePullRepository(serverId, repoUrl, branch, appName, {
                            gitAccountId: input.gitAccountId,
                            repository: input.repository,
                        });
                        // Persist working directory for auto-deploy
                        db_1.queries.updateDeployment(deploymentId, {
                            working_directory: appPath,
                        });
                        this.emitLog(`✓ Repository cloned/updated successfully`, 'success', deploymentId);
                    }
                    else if (step.name === 'Create environment file') {
                        if (envVars && Object.keys(envVars).length > 0) {
                            await this.createEnvFile(serverId, appPath, envVars);
                            this.emitLog(`✓ Environment variables configured`, 'success', deploymentId);
                        }
                        else {
                            this.emitLog(`⊘ No custom environment variables to configure`, 'info', deploymentId);
                        }
                    }
                    else if (step.name === 'Configure PM2') {
                        // Parse package.json to get port and commands if not provided
                        let finalBuildCommand = buildCommand;
                        let finalStartCommand = sanitizedStartCommand;
                        if (!detectedPort || !finalBuildCommand || !finalStartCommand) {
                            const packageJsonInfo = await GitAccountService_1.gitAccountService.parsePackageJson(serverId, appPath);
                            detectedPort = detectedPort || packageJsonInfo.port || 3000; // Default to 3000
                            // If commands not provided, use defaults or detect from package.json
                            if (!finalBuildCommand) {
                                finalBuildCommand = 'npm install && npm run build';
                            }
                            if (!finalStartCommand) {
                                finalStartCommand = 'npm start';
                            }
                        }
                        await this.configureAndStartPM2(serverId, appName, appPath, finalStartCommand, detectedPort, envVars, isRedeploy);
                        this.emitLog(`✓ Application ${isRedeploy ? 'reloaded' : 'started'} on port ${detectedPort}`, 'success', deploymentId);
                    }
                    else if (step.name === 'Install dependencies') {
                        await this.installProjectDependencies(serverId, appPath, buildCommand);
                        this.emitLog(`✓ Dependencies installed successfully`, 'success', deploymentId);
                    }
                    else if (step.name === 'Build application') {
                        await this.buildApplication(serverId, appPath, buildCommand);
                        this.emitLog(`✓ Application built successfully`, 'success', deploymentId);
                    }
                    else if (step.name === 'Install system dependencies') {
                        await this.installSystemDependencies(serverId);
                        this.emitLog(`✓ System dependencies ready`, 'success', deploymentId);
                    }
                    else if (step.name === 'Prepare deployment directory') {
                        await this.prepareDeploymentDirectory(serverId, appName);
                        this.emitLog(`✓ Deployment directory prepared`, 'success', deploymentId);
                    }
                }
                catch (error) {
                    this.emitLog(`✗ Failed at step: ${step.name} - ${error}`, 'error', deploymentId);
                    throw error;
                }
            }
            const url = `http://${server.host}:${detectedPort}`;
            // Update deployment record to succeeded
            db_1.queries.updateDeployment(deploymentId, {
                status: 'succeeded',
                finished_at: Date.now(),
                port: detectedPort,
            });
            // Persist logs to database on success
            this.persistLogs(deploymentId);
            if (input.gitAccountId && input.repository) {
                await GitAccountService_1.gitAccountService.bindApp({
                    serverId,
                    appName,
                    gitAccountId: input.gitAccountId,
                    repository: input.repository,
                    branch,
                });
            }
            return {
                deploymentId,
                appName,
                port: detectedPort,
                url,
                status: 'running',
            };
        }
        catch (error) {
            console.error('[DeploymentService] Deployment failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Update deployment record to failed
            db_1.queries.updateDeployment(deploymentId, {
                status: 'failed',
                finished_at: Date.now(),
            });
            // Persist logs to database on failure with error message
            this.persistLogs(deploymentId, errorMessage);
            throw error;
        }
    }
    /**
     * Install system dependencies (Node.js, npm, git, PM2)
     */
    async installSystemDependencies(serverId) {
        this.emitLog('Checking and installing required system packages...', 'info');
        // Check if git is installed
        const gitCheck = await SSHService_1.sshService.executeCommand(serverId, 'which git || echo "not_found"');
        if (gitCheck.stdout.trim() === 'not_found' || !gitCheck.stdout.trim()) {
            this.emitLog('Installing git...', 'info');
            await SSHService_1.sshService.executeCommand(serverId, `
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq git
      `);
            this.emitLog('✓ Git installed', 'success');
        }
        // Check if Node.js is installed
        const nodeCheck = await SSHService_1.sshService.executeCommand(serverId, 'which node || echo "not_found"');
        if (nodeCheck.stdout.trim() === 'not_found' || !nodeCheck.stdout.trim()) {
            this.emitLog('Installing Node.js LTS...', 'info');
            await SSHService_1.sshService.executeCommand(serverId, `
        curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
        apt-get install -y -qq nodejs
      `);
            this.emitLog('✓ Node.js installed', 'success');
        }
        // Check if PM2 is installed
        const pm2Check = await SSHService_1.sshService.executeCommand(serverId, 'command -v pm2 || echo "not_found"');
        if (pm2Check.stdout.trim() === 'not_found' || !pm2Check.stdout.trim()) {
            this.emitLog('Installing PM2...', 'info');
            // Install PM2 globally using npm
            const pm2InstallResult = await SSHService_1.sshService.executeCommand(serverId, `
        npm install -g pm2
        pm2 startup systemd -u root --hp /root || true
      `);
            if (pm2InstallResult.exitCode !== 0) {
                this.emitLog('⚠ PM2 installation had issues, retrying...', 'info');
                // Retry without sudo in case it's not available
                await SSHService_1.sshService.executeCommand(serverId, 'npm install -g pm2');
            }
            // Verify PM2 is now available
            const pm2VerifyCheck = await SSHService_1.sshService.executeCommand(serverId, 'command -v pm2 || echo "not_found"');
            if (pm2VerifyCheck.stdout.trim() === 'not_found' || !pm2VerifyCheck.stdout.trim()) {
                throw new Error('Failed to install PM2. Please ensure npm is properly configured.');
            }
            this.emitLog('✓ PM2 installed and configured', 'success');
        }
    }
    /**
     * Prepare deployment directory structure
     */
    async prepareDeploymentDirectory(serverId, appName) {
        const appPath = await this.getAppPath(serverId, appName);
        const escapedPath = appPath.replace(/"/g, '\\"');
        await SSHService_1.sshService.executeCommand(serverId, `mkdir -p "${escapedPath}"`);
    }
    /**
     * Clone or pull repository
     */
    async clonePullRepository(serverId, repoUrl, branch, appName, options) {
        const appPath = await this.getAppPath(serverId, appName);
        const escapedAppPath = appPath.replace(/"/g, '\\"');
        // If git account ID is provided, try to use OAuth token for HTTPS cloning
        if (options?.gitAccountId) {
            try {
                // Get the OAuth token for this git account
                const token = await this.getOAuthTokenForAccount(options.gitAccountId);
                if (token && repoUrl.startsWith('https://github.com/')) {
                    // Use OAuth token for HTTPS cloning
                    console.log('[DeploymentService] Cloning with GitHub OAuth token...');
                    const authenticatedUrl = repoUrl.replace('https://github.com/', `https://oauth2:${token}@github.com/`);
                    await this.cloneWithToken(serverId, authenticatedUrl, branch, escapedAppPath);
                    return appPath;
                }
                else if (options.repository) {
                    // Fall back to SSH-based cloning with account
                    await GitAccountService_1.gitAccountService.cloneWithAccount(serverId, options.gitAccountId, options.repository, escapedAppPath, branch);
                    return appPath;
                }
            }
            catch (error) {
                console.warn('[DeploymentService] Failed to clone with OAuth token, falling back to regular clone:', error);
                // Continue to fallback method below
            }
        }
        const existsCheck = await SSHService_1.sshService.executeCommand(serverId, `test -d "${escapedAppPath}/.git" && echo "exists" || echo "not_exists"`);
        if (existsCheck.stdout.trim() === 'exists') {
            console.log('[DeploymentService] Repository exists, pulling latest changes...');
            await SSHService_1.sshService.executeCommand(serverId, `
        cd "${escapedAppPath}"
        git fetch origin ${branch}
        git checkout ${branch}
        git pull origin ${branch}
      `);
        }
        else {
            console.log('[DeploymentService] Cloning repository...');
            await SSHService_1.sshService.executeCommand(serverId, `
        # Ensure parent directory exists
        mkdir -p "$(dirname "${escapedAppPath}")"
        # Remove target directory if it exists to prevent nested clone
        rm -rf "${escapedAppPath}"
        # Clone directly into target path
        git clone -b ${branch} ${repoUrl} "${escapedAppPath}"
      `);
        }
        return appPath;
    }
    /**
     * Get OAuth token for a git account
     */
    async getOAuthTokenForAccount(gitAccountId) {
        try {
            const { db } = await Promise.resolve().then(() => __importStar(require('../db')));
            const { CredentialVault } = await Promise.resolve().then(() => __importStar(require('./CredentialVault')));
            const account = db.prepare(`
        SELECT encrypted_token FROM git_accounts WHERE id = ?
      `).get(gitAccountId);
            if (!account || !account.encrypted_token || account.encrypted_token.length === 0) {
                return null;
            }
            const vault = new CredentialVault();
            const token = await vault.decrypt(account.encrypted_token);
            return token;
        }
        catch (error) {
            console.error('[DeploymentService] Failed to get OAuth token:', error);
            return null;
        }
    }
    /**
     * Clone repository using OAuth token
     */
    async cloneWithToken(serverId, authenticatedUrl, branch, escapedAppPath) {
        const existsCheck = await SSHService_1.sshService.executeCommand(serverId, `test -d "${escapedAppPath}/.git" && echo "exists" || echo "not_exists"`);
        if (existsCheck.stdout.trim() === 'exists') {
            console.log('[DeploymentService] Repository exists, pulling latest changes with OAuth...');
            // Update remote URL to use token and pull
            await SSHService_1.sshService.executeCommand(serverId, `
        cd "${escapedAppPath}"
        git remote set-url origin "${authenticatedUrl}"
        git fetch origin ${branch}
        git checkout ${branch}
        git pull origin ${branch}
      `);
        }
        else {
            console.log('[DeploymentService] Cloning repository with OAuth...');
            await SSHService_1.sshService.executeCommand(serverId, `
        # Ensure parent directory exists
        mkdir -p "$(dirname "${escapedAppPath}")"
        # Remove target directory if it exists to prevent nested clone
        rm -rf "${escapedAppPath}"
        # Clone directly into target path
        git clone -b ${branch} "${authenticatedUrl}" "${escapedAppPath}"
      `);
        }
    }
    async getAppPath(serverId, appName) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        const fallback = `~/apps/${appName}`;
        if (!homeDir) {
            return fallback;
        }
        const trimmedHome = homeDir.replace(/\/+$/, '');
        return path_1.default.posix.join(trimmedHome || '/', 'apps', appName);
    }
    /**
     * Create .env file with user-provided environment variables ONLY
     * NOTE: NODE_ENV and PORT are NOT included in .env
     * PORT is passed to PM2 directly
     */
    async createEnvFile(serverId, appPath, envVars) {
        const escapedAppPath = appPath.replace(/"/g, '\\"');
        console.log('[DeploymentService] createEnvFile called with:', {
            appPath,
            escapedAppPath,
            envVars
        });
        // Only user-provided environment variables (no NODE_ENV, no PORT)
        const envFileContent = Object.entries(envVars)
            .map(([key, value]) => {
            // Escape special characters in values for .env format
            // Wrap in quotes if value contains spaces or special characters
            const needsQuotes = /[\s#"'$\\]/.test(value);
            if (needsQuotes) {
                // Escape backslashes and quotes
                const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                return `${key}="${escapedValue}"`;
            }
            return `${key}=${value}`;
        })
            .join('\n');
        console.log('[DeploymentService] .env file content to write:', envFileContent);
        // Write .env file
        const result = await SSHService_1.sshService.executeCommand(serverId, `
      cat > "${escapedAppPath}/.env" << 'EOF'
${envFileContent}
EOF
    `);
        console.log('[DeploymentService] .env file write result:', {
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout
        });
        if (result.exitCode !== 0) {
            throw new Error(`Failed to create .env file: ${result.stderr}`);
        }
        // Verify the file was created
        const verifyResult = await SSHService_1.sshService.executeCommand(serverId, `test -f "${escapedAppPath}/.env" && echo "EXISTS" || echo "NOT_FOUND"`);
        console.log('[DeploymentService] .env file verification:', verifyResult.stdout.trim());
    }
    /**
     * Install project dependencies (part of build command)
     */
    async installProjectDependencies(serverId, appPath, buildCommand) {
        // If build command includes install, skip separate install
        if (buildCommand && buildCommand.includes('npm install')) {
            this.emitLog('Installation will be handled by build command', 'info');
            return;
        }
        console.log('[DeploymentService] Installing dependencies with npm...');
        const escapedAppPath = appPath.replace(/"/g, '\\"');
        await SSHService_1.sshService.executeCommand(serverId, `
      cd "${escapedAppPath}"
      npm install
    `);
    }
    /**
     * Build application using custom build command
     */
    async buildApplication(serverId, appPath, buildCommand) {
        const command = buildCommand || 'npm install && npm run build';
        const escapedAppPath = appPath.replace(/"/g, '\\"');
        console.log(`[DeploymentService] Building app with command: ${command}`);
        const runBuild = async () => {
            return SSHService_1.sshService.executeCommand(serverId, `
        cd "${escapedAppPath}"
        ${command}
      `);
        };
        let result = await runBuild();
        let retriedAfterLock = false;
        const handleResult = async () => {
            // Stream build output
            if (result.stdout) {
                const lines = result.stdout.split('\n');
                lines.forEach((line) => {
                    if (line.trim()) {
                        this.emitLog(line, 'info');
                    }
                });
            }
            // Detect Next.js lock contention and retry once after cleanup
            const lockErrorDetected = (result.stderr && result.stderr.includes('.next/lock')) ||
                (result.stdout && result.stdout.includes('.next/lock'));
            if (result.exitCode !== 0) {
                if (lockErrorDetected && !retriedAfterLock) {
                    retriedAfterLock = true;
                    this.emitLog('Detected stale Next.js build lock (.next/lock). Cleaning up and retrying build...', 'info');
                    await this.removeNextBuildLock(serverId, escapedAppPath);
                    result = await runBuild();
                    await handleResult();
                    return;
                }
                if (result.stderr) {
                    this.emitLog(result.stderr, 'error');
                    throw new Error(`Build failed: ${result.stderr}`);
                }
                throw new Error('Build failed with unknown error');
            }
        };
        await handleResult();
    }
    async removeNextBuildLock(serverId, escapedAppPath) {
        await SSHService_1.sshService.executeCommand(serverId, `
      if [ -d "${escapedAppPath}/.next" ] && [ -f "${escapedAppPath}/.next/lock" ]; then
        rm -f "${escapedAppPath}/.next/lock"
      fi
    `);
    }
    /**
     * Configure PM2 and start application with custom start command
     */
    async configureAndStartPM2(serverId, appName, appPath, startCommand, port, _envVars, isRedeploy) {
        // Skip port check for redeployments (port is expected to be in use)
        if (!isRedeploy) {
            // Verify port is not in use before deployment
            const portCheckResult = await SSHService_1.sshService.executeCommand(serverId, `
      # Auto-install jq if not available
      if ! command -v jq &>/dev/null; then
        echo "Installing jq..." >&2
        if command -v apt-get &>/dev/null; then
          sudo apt-get update -qq && sudo apt-get install -y jq >/dev/null 2>&1
        elif command -v yum &>/dev/null; then
          sudo yum install -y jq >/dev/null 2>&1
        fi
      fi

      # Check if port is listening
      if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
        echo "ERROR: Port ${port} is already listening"
        exit 1
      fi

      # Check PM2 processes using the port
      pm2_process=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.pm2_env.env.PORT == "${port}") | .name' 2>/dev/null | head -1)
      if [ -n "$pm2_process" ]; then
        echo "ERROR: Port ${port} is used by PM2 process: $pm2_process"
        exit 1
      fi

      echo "OK"
    `);
            if (portCheckResult.exitCode !== 0) {
                const errorMsg = portCheckResult.stdout?.trim() || portCheckResult.stderr?.trim() || `Port ${port} is already in use`;
                throw new Error(errorMsg.replace('ERROR: ', ''));
            }
        }
        const escapedAppPath = appPath.replace(/"/g, '\\"');
        // Build environment variables string for PM2 command (PORT only)
        // Other env vars (NODE_ENV, user vars) are in the .env file
        const envString = `PORT='${port}'`;
        // For redeployments, use pm2 reload for zero-downtime restart
        // For fresh deployments, delete and start fresh
        if (isRedeploy) {
            // Use pm2 reload for zero-downtime restart
            const result = await SSHService_1.sshService.executeCommand(serverId, `
        cd "${escapedAppPath}"
        pm2 reload "${appName}"
        pm2 save
      `);
            if (result.exitCode !== 0) {
                // If reload fails (e.g., process doesn't exist), fall back to restart
                this.emitLog('Reload failed, trying restart...', 'info');
                const restartResult = await SSHService_1.sshService.executeCommand(serverId, `
          cd "${escapedAppPath}"
          pm2 restart "${appName}" || ${envString} pm2 start "${startCommand}" --name "${appName}"
          pm2 save
        `);
                if (restartResult.exitCode !== 0) {
                    throw new Error(`Failed to reload/restart PM2: ${restartResult.stderr}`);
                }
            }
        }
        else {
            // Fresh deployment: stop existing PM2 process if it exists, then start fresh
            await SSHService_1.sshService.executeCommand(serverId, `pm2 delete ${appName} || true`);
            const result = await SSHService_1.sshService.executeCommand(serverId, `
        cd "${escapedAppPath}"
        ${envString} pm2 start "${startCommand}" --name "${appName}"
        pm2 save
      `);
            if (result.exitCode !== 0) {
                throw new Error(`Failed to start PM2: ${result.stderr}`);
            }
        }
        console.log(`[DeploymentService] Application ${appName} started on port ${port}`);
    }
    /**
     * Legacy deploy method (kept for backwards compatibility)
     */
    async deploy(deploymentId, input) {
        const deployment = db_1.queries.getDeploymentsByServer(input.serverId).find(d => d.id === deploymentId);
        if (!deployment) {
            throw new Error(`Deployment ${deploymentId} not found`);
        }
        try {
            const steps = [
                { name: 'Prepare deployment directory', fn: this.prepareDirectory.bind(this) },
                { name: 'Transfer code', fn: this.transferCode.bind(this) },
                { name: 'Install dependencies', fn: this.installDependencies.bind(this) },
                { name: 'Build application', fn: this.buildApplicationLegacy.bind(this) },
                { name: 'Configure PM2', fn: this.configurePM2.bind(this) },
                { name: 'Start application', fn: this.startApplication.bind(this) },
            ];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                this.emitProgress(deploymentId, step.name, 'running', (i / steps.length) * 100);
                try {
                    await step.fn(input.serverId, input);
                    this.emitProgress(deploymentId, step.name, 'completed', ((i + 1) / steps.length) * 100);
                }
                catch (error) {
                    this.emitProgress(deploymentId, step.name, 'failed', ((i + 1) / steps.length) * 100);
                    throw error;
                }
            }
            db_1.queries.updateDeployment(deploymentId, {
                status: 'succeeded',
                finished_at: Date.now(),
            });
        }
        catch (error) {
            db_1.queries.updateDeployment(deploymentId, {
                status: 'failed',
                finished_at: Date.now(),
            });
            throw error;
        }
    }
    async prepareDirectory(serverId, input) {
        const appName = input.repoUrl ? path_1.default.basename(input.repoUrl, '.git') : 'app';
        const timestamp = Date.now();
        const releasePath = `~/${appName}/releases/${timestamp}`;
        await SSHService_1.sshService.executeCommand(serverId, `
      mkdir -p ~/${appName}/releases
      mkdir -p ~/${appName}/shared
      mkdir -p ${releasePath}
    `);
    }
    async transferCode(serverId, input) {
        const appName = input.repoUrl ? path_1.default.basename(input.repoUrl, '.git') : 'app';
        if (input.type === 'git' && input.repoUrl) {
            // Git-based deployment
            await SSHService_1.sshService.executeCommand(serverId, `
        cd ~/${appName}/releases
        if [ -d .git ]; then
          git fetch origin ${input.branch || 'main'}
          git checkout ${input.branch || 'main'}
          git pull origin ${input.branch || 'main'}
        else
          git clone -b ${input.branch || 'main'} ${input.repoUrl} latest
        fi
      `);
        }
        else if (input.type === 'local' && input.localPath) {
            // Local upload - TODO: implement SFTP upload
            throw new Error('Local deployment not yet implemented');
        }
    }
    async installDependencies(serverId, input) {
        const appName = input.repoUrl ? path_1.default.basename(input.repoUrl, '.git') : 'app';
        await SSHService_1.sshService.executeCommand(serverId, `
      cd ~/${appName}/releases/latest
      npm install
    `);
    }
    async buildApplicationLegacy(serverId, input) {
        const appName = input.repoUrl ? path_1.default.basename(input.repoUrl, '.git') : 'app';
        await SSHService_1.sshService.executeCommand(serverId, `
      cd ~/${appName}/releases/latest
      npm run build
    `);
    }
    async configurePM2(serverId, input) {
        const appName = input.repoUrl ? path_1.default.basename(input.repoUrl, '.git') : 'app';
        const ecosystem = `
module.exports = {
  apps: [{
    name: '${appName}',
    script: 'npm',
    args: 'start',
    cwd: '~/${appName}/releases/latest',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
`;
        // Write ecosystem file
        const localPath = path_1.default.join(electron_1.app.getPath('temp'), 'ecosystem.config.js');
        fs_1.default.writeFileSync(localPath, ecosystem);
        // Upload to server - TODO: implement
        // For now, write directly via command
        await SSHService_1.sshService.executeCommand(serverId, `
      cat > ~/${appName}/ecosystem.config.js << 'EOF'
${ecosystem}
EOF
    `);
    }
    async startApplication(serverId, input) {
        const appName = input.repoUrl ? path_1.default.basename(input.repoUrl, '.git') : 'app';
        await SSHService_1.sshService.executeCommand(serverId, `
      pm2 delete ${appName} || true
      pm2 start ~/${appName}/ecosystem.config.js
      pm2 save
    `);
    }
    emitProgress(deploymentId, step, status, progress) {
        const event = {
            id: deploymentId,
            type: 'deployment',
            step,
            status,
            message: `${status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Failed'}: ${step}`,
            progress,
        };
        this.emit('progress', event);
    }
    /**
     * Deploy service from local folder upload
     */
    async deployServiceFromLocal(input) {
        const deploymentId = crypto_1.default.randomUUID();
        const { serverId, localPath, appName, buildCommand, startCommand, envVars, runtime } = input;
        this.emitLog(`Starting local deployment for ${appName}`, 'info', deploymentId);
        console.log('[DeploymentService] deployServiceFromLocal - envVars received:', envVars);
        try {
            // 1. Check port availability
            let port = input.port;
            if (!port) {
                this.emitLog('Finding available port...', 'info', deploymentId);
                const portResult = await SSHService_1.sshService.executeCommand(serverId, 'comm -23 <(seq 3000 3100) <(ss -Htan | awk \'{print $4}\' | cut -d\':\' -f2 | sort) | head -1');
                port = parseInt(portResult.stdout.trim(), 10);
                if (!port || isNaN(port)) {
                    throw new Error('Could not find available port');
                }
                this.emitLog(`Selected port: ${port}`, 'success', deploymentId);
            }
            // 2. Create working directory on server (use getAppPath to properly expand ~)
            const workingDirectory = await this.getAppPath(serverId, appName);
            this.emitLog(`Creating directory: ${workingDirectory}`, 'info', deploymentId);
            const escapedWorkingDir = workingDirectory.replace(/"/g, '\\"');
            await SSHService_1.sshService.executeCommand(serverId, `mkdir -p "${escapedWorkingDir}"`);
            // 3. Verify that localPath is a zip file
            if (!localPath.toLowerCase().endsWith('.zip')) {
                throw new Error('Only ZIP files are supported. Please select a .zip file.');
            }
            const zipFileName = path_1.default.basename(localPath);
            const zipStats = fs_1.default.statSync(localPath);
            const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);
            this.emitLog(`Uploading ${zipFileName} (${zipSizeMB} MB)...`, 'info', deploymentId);
            // 4. Upload zip file directly (user provided it)
            const remoteZipPath = `${workingDirectory}/${zipFileName}`;
            await SSHService_1.sshService.uploadFile(serverId, localPath, remoteZipPath);
            this.emitLog('Upload complete!', 'success', deploymentId);
            // 5. Ensure unzip is available and extract
            await this.ensureUnzipInstalled(serverId, deploymentId);
            this.emitLog('Extracting files on server...', 'info', deploymentId);
            // Extract and handle nested directories (flatten if zip contains a single root folder)
            const extractCommand = `
        cd "${escapedWorkingDir}" && \
        unzip -q "${zipFileName}" && \
        rm "${zipFileName}" && \
        shopt -s dotglob nullglob && \
        contents=(*) && \
        if [ \${#contents[@]} -eq 1 ] && [ -d "\${contents[0]}" ]; then \
          mv "\${contents[0]}"/* . 2>/dev/null || true && \
          mv "\${contents[0]}"/.[!.]* . 2>/dev/null || true && \
          rmdir "\${contents[0]}" 2>/dev/null || true; \
        fi
      `;
            const unzipResult = await SSHService_1.sshService.executeCommand(serverId, extractCommand);
            if (unzipResult.exitCode !== 0) {
                throw new Error(`Failed to extract zip file: ${unzipResult.stderr}`);
            }
            this.emitLog('Files extracted successfully!', 'success', deploymentId);
            // Get zip file info for database
            const folderInfo = {
                size: zipStats.size,
                fileCount: 0, // Unknown until extracted
            };
            // 4. Create .env file if environment variables are provided
            console.log('[DeploymentService] Checking envVars before .env creation:', {
                envVars,
                hasEnvVars: !!envVars,
                envVarsKeys: envVars ? Object.keys(envVars) : [],
                envVarsLength: envVars ? Object.keys(envVars).length : 0
            });
            if (envVars && Object.keys(envVars).length > 0) {
                this.emitLog('Creating environment file...', 'info', deploymentId);
                console.log('[DeploymentService] Creating .env file with vars:', envVars);
                await this.createEnvFile(serverId, workingDirectory, envVars);
                this.emitLog('Environment variables configured!', 'success', deploymentId);
            }
            else {
                console.log('[DeploymentService] Skipping .env file creation - no environment variables provided');
                this.emitLog('No environment variables to configure', 'info', deploymentId);
            }
            // 5. Install dependencies
            this.emitLog('Installing dependencies...', 'info', deploymentId);
            const installResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${escapedWorkingDir}" && npm install`);
            if (installResult.exitCode !== 0) {
                throw new Error(`npm install failed: ${installResult.stderr}`);
            }
            this.emitLog('Dependencies installed!', 'success', deploymentId);
            // 6. Build application (if build command specified)
            if (buildCommand) {
                this.emitLog(`Building application: ${buildCommand}`, 'info', deploymentId);
                const buildResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${escapedWorkingDir}" && ${buildCommand}`);
                if (buildResult.exitCode !== 0) {
                    throw new Error(`Build failed: ${buildResult.stderr}`);
                }
                this.emitLog('Build complete!', 'success', deploymentId);
            }
            // 7. Start with PM2
            this.emitLog('Starting application with PM2...', 'info', deploymentId);
            const sanitizedStartCmd = startCommand ? (0, startCommand_1.sanitizeStartCommand)(startCommand) : 'npm start';
            // Only pass PORT to PM2; other env vars are in .env file
            const pm2Command = `cd "${escapedWorkingDir}" && PORT=${port} pm2 start "${sanitizedStartCmd}" --name ${appName} && pm2 save`;
            const pm2Result = await SSHService_1.sshService.executeCommand(serverId, pm2Command);
            if (pm2Result.exitCode !== 0) {
                throw new Error(`PM2 start failed: ${pm2Result.stderr}`);
            }
            this.emitLog('Application started!', 'success', deploymentId);
            // 8. Create deployment record
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                repo_url: null,
                branch: null,
                commit_hash: null,
                env_summary: envVars ? Object.keys(envVars).join(', ') : null,
                status: 'succeeded',
                started_at: Date.now(),
                finished_at: Date.now(),
                log_path: null,
                app_name: appName,
                build_command: buildCommand ?? null,
                start_command: sanitizedStartCmd,
                port,
                runtime,
                deployment_source: 'local',
                working_directory: workingDirectory,
                source_type: 'local',
                local_upload_size: folderInfo.size,
                local_upload_file_count: folderInfo.fileCount,
            };
            db_1.queries.createDeployment(deployment);
            this.persistLogs(deploymentId);
            this.emitLog(`Deployment completed successfully! App running on port ${port}`, 'success', deploymentId);
            return {
                deploymentId,
                appName,
                port,
                url: `http://localhost:${port}`,
                status: 'succeeded',
            };
        }
        catch (error) {
            this.emitLog(`Deployment failed: ${String(error)}`, 'error', deploymentId);
            db_1.queries.updateDeployment(deploymentId, { status: 'failed', finished_at: Date.now() });
            this.persistLogs(deploymentId, String(error));
            throw error;
        }
    }
    /**
     * Re-upload and redeploy local app
     */
    async reuploadLocalApp(input) {
        const deploymentId = crypto_1.default.randomUUID();
        const { serverId, appName, localPath } = input;
        this.emitLog(`Re-uploading ${appName} from local folder`, 'info', deploymentId);
        try {
            // Get existing deployment info
            const existingDeployment = db_1.queries.getLatestDeploymentForApp(serverId, appName);
            if (!existingDeployment) {
                throw new Error(`App ${appName} not found`);
            }
            // If working_directory has ~, expand it properly
            let workingDirectory = existingDeployment.working_directory;
            if (!workingDirectory || workingDirectory.startsWith('~')) {
                // Expand tilde to actual home directory path
                workingDirectory = await this.getAppPath(serverId, appName);
            }
            const escapedWorkingDir = workingDirectory.replace(/"/g, '\\"');
            // 1. Stop PM2 process
            this.emitLog('Stopping application...', 'info', deploymentId);
            await SSHService_1.sshService.executeCommand(serverId, `pm2 stop ${appName} || true`);
            // 2. Backup current files (optional - create backup directory)
            this.emitLog('Creating backup of current files...', 'info', deploymentId);
            await SSHService_1.sshService.executeCommand(serverId, `cp -r "${escapedWorkingDir}" "${escapedWorkingDir}.backup.$(date +%s)" || true`);
            // 3. Verify that localPath is a zip file
            if (!localPath.toLowerCase().endsWith('.zip')) {
                throw new Error('Only ZIP files are supported. Please select a .zip file.');
            }
            const zipFileName = path_1.default.basename(localPath);
            const zipStats = fs_1.default.statSync(localPath);
            const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);
            this.emitLog(`Uploading ${zipFileName} (${zipSizeMB} MB)...`, 'info', deploymentId);
            // Upload zip file directly
            const remoteZipPath = `${workingDirectory}/${zipFileName}`;
            await SSHService_1.sshService.uploadFile(serverId, localPath, remoteZipPath);
            this.emitLog('Upload complete!', 'success', deploymentId);
            // Ensure unzip is available and extract (overwrite existing files)
            await this.ensureUnzipInstalled(serverId, deploymentId);
            this.emitLog('Extracting files on server...', 'info', deploymentId);
            // Backup existing .env file before extraction (to preserve environment variables)
            await SSHService_1.sshService.executeCommand(serverId, `
        if [ -f "${escapedWorkingDir}/.env" ]; then
          cp "${escapedWorkingDir}/.env" "${escapedWorkingDir}/.env.backup.$(date +%s)"
        fi
      `);
            // Extract and handle nested directories (flatten if zip contains a single root folder)
            const extractCommand = `
        cd "${escapedWorkingDir}" && \
        unzip -o -q "${zipFileName}" && \
        rm "${zipFileName}" && \
        shopt -s dotglob nullglob && \
        contents=(*) && \
        if [ \${#contents[@]} -eq 1 ] && [ -d "\${contents[0]}" ]; then \
          mv "\${contents[0]}"/* . 2>/dev/null || true && \
          mv "\${contents[0]}"/.[!.]* . 2>/dev/null || true && \
          rmdir "\${contents[0]}" 2>/dev/null || true; \
        fi
      `;
            const unzipResult = await SSHService_1.sshService.executeCommand(serverId, extractCommand);
            if (unzipResult.exitCode !== 0) {
                throw new Error(`Failed to extract zip file: ${unzipResult.stderr}`);
            }
            // Restore .env file if it was backed up and the new upload doesn't have one
            await SSHService_1.sshService.executeCommand(serverId, `
        if [ -f "${escapedWorkingDir}/.env.backup."* ] && [ ! -f "${escapedWorkingDir}/.env" ]; then
          latest_backup=$(ls -t "${escapedWorkingDir}/.env.backup."* 2>/dev/null | head -1)
          if [ -n "$latest_backup" ]; then
            mv "$latest_backup" "${escapedWorkingDir}/.env"
          fi
        fi
        rm -f "${escapedWorkingDir}/.env.backup."* 2>/dev/null || true
      `);
            this.emitLog('Files extracted successfully!', 'success', deploymentId);
            // Get zip file info for database
            const folderInfo = {
                size: zipStats.size,
                fileCount: 0,
            };
            // 4. Install dependencies
            this.emitLog('Installing dependencies...', 'info', deploymentId);
            const installResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${escapedWorkingDir}" && npm install`);
            if (installResult.exitCode !== 0) {
                throw new Error(`npm install failed: ${installResult.stderr}`);
            }
            this.emitLog('Dependencies installed!', 'success', deploymentId);
            // 5. Build if needed
            if (existingDeployment.build_command) {
                this.emitLog(`Building: ${existingDeployment.build_command}`, 'info', deploymentId);
                const buildResult = await SSHService_1.sshService.executeCommand(serverId, `cd "${escapedWorkingDir}" && ${existingDeployment.build_command}`);
                if (buildResult.exitCode !== 0) {
                    throw new Error(`Build failed: ${buildResult.stderr}`);
                }
                this.emitLog('Build complete!', 'success', deploymentId);
            }
            // 6. Restart PM2
            this.emitLog('Restarting application...', 'info', deploymentId);
            const restartResult = await SSHService_1.sshService.executeCommand(serverId, `pm2 restart ${appName}`);
            if (restartResult.exitCode !== 0) {
                throw new Error(`PM2 restart failed: ${restartResult.stderr}`);
            }
            this.emitLog('Application restarted!', 'success', deploymentId);
            // 7. Create new deployment record
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                repo_url: null,
                branch: null,
                commit_hash: null,
                env_summary: existingDeployment.env_summary,
                status: 'succeeded',
                started_at: Date.now(),
                finished_at: Date.now(),
                log_path: null,
                app_name: appName,
                build_command: existingDeployment.build_command,
                start_command: existingDeployment.start_command,
                port: existingDeployment.port,
                runtime: existingDeployment.runtime,
                deployment_source: 'local-reupload',
                working_directory: workingDirectory,
                source_type: 'local',
                local_upload_size: folderInfo.size,
                local_upload_file_count: folderInfo.fileCount,
            };
            db_1.queries.createDeployment(deployment);
            this.persistLogs(deploymentId);
            this.emitLog(`Re-upload completed! App running on port ${existingDeployment.port}`, 'success', deploymentId);
            return {
                deploymentId,
                appName,
                port: existingDeployment.port,
                url: `http://localhost:${existingDeployment.port}`,
                status: 'succeeded',
            };
        }
        catch (error) {
            this.emitLog(`Re-upload failed: ${String(error)}`, 'error', deploymentId);
            db_1.queries.updateDeployment(deploymentId, { status: 'failed', finished_at: Date.now() });
            this.persistLogs(deploymentId, String(error));
            throw error;
        }
    }
    /**
     * Link Git repository to local app
     * This will replace uploaded files with Git repository and enable auto-deploy
     */
    async linkGitToLocalApp(input) {
        const deploymentId = crypto_1.default.randomUUID();
        const { serverId, appName, repoUrl, branch, gitAccountId } = input;
        this.emitLog(`Linking Git repository to ${appName}`, 'info', deploymentId);
        try {
            // Get existing deployment info
            const existingDeployment = db_1.queries.getLatestDeploymentForApp(serverId, appName);
            if (!existingDeployment) {
                throw new Error(`App ${appName} not found`);
            }
            const workingDirectory = existingDeployment.working_directory || `~/apps/${appName}`;
            // 1. Stop PM2 process
            this.emitLog('Stopping application...', 'info', deploymentId);
            await SSHService_1.sshService.executeCommand(serverId, `pm2 stop ${appName} || true`);
            // 2. Backup uploaded files
            this.emitLog('Backing up current files...', 'info', deploymentId);
            const backupPath = `${workingDirectory}.local-backup.$(date +%s)`;
            await SSHService_1.sshService.executeCommand(serverId, `mv ${workingDirectory} ${backupPath}`);
            this.emitLog(`Backup created at ${backupPath}`, 'success', deploymentId);
            // 3. Clone Git repository
            this.emitLog(`Cloning repository: ${repoUrl}`, 'info', deploymentId);
            try {
                await GitAccountService_1.gitAccountService.cloneWithAccount(serverId, gitAccountId, repoUrl, workingDirectory, branch);
            }
            catch (error) {
                // Restore backup on failure
                await SSHService_1.sshService.executeCommand(serverId, `mv ${backupPath} ${workingDirectory}`);
                throw new Error(`Git clone failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.emitLog('Repository cloned!', 'success', deploymentId);
            // 4. Install dependencies
            this.emitLog('Installing dependencies...', 'info', deploymentId);
            const installResult = await SSHService_1.sshService.executeCommand(serverId, `cd ${workingDirectory} && npm install`);
            if (installResult.exitCode !== 0) {
                throw new Error(`npm install failed: ${installResult.stderr}`);
            }
            this.emitLog('Dependencies installed!', 'success', deploymentId);
            // 5. Build if needed
            if (existingDeployment.build_command) {
                this.emitLog(`Building: ${existingDeployment.build_command}`, 'info', deploymentId);
                const buildResult = await SSHService_1.sshService.executeCommand(serverId, `cd ${workingDirectory} && ${existingDeployment.build_command}`);
                if (buildResult.exitCode !== 0) {
                    throw new Error(`Build failed: ${buildResult.stderr}`);
                }
                this.emitLog('Build complete!', 'success', deploymentId);
            }
            // 6. Restart PM2
            this.emitLog('Starting application...', 'info', deploymentId);
            const restartResult = await SSHService_1.sshService.executeCommand(serverId, `pm2 start ${appName}`);
            if (restartResult.exitCode !== 0) {
                throw new Error(`PM2 start failed: ${restartResult.stderr}`);
            }
            this.emitLog('Application started!', 'success', deploymentId);
            // 7. Update deployment record to reflect Git linking
            db_1.queries.updateAppSourceType(serverId, appName, 'local-git-linked', Date.now());
            // 8. Create Git binding
            await GitAccountService_1.gitAccountService.bindApp({ serverId, appName, gitAccountId, repository: repoUrl, branch });
            // 9. Create new deployment record
            const deployment = {
                id: deploymentId,
                server_id: serverId,
                repo_url: repoUrl,
                branch,
                commit_hash: null, // TODO: Get actual commit hash
                env_summary: existingDeployment.env_summary,
                status: 'succeeded',
                started_at: Date.now(),
                finished_at: Date.now(),
                log_path: null,
                app_name: appName,
                build_command: existingDeployment.build_command,
                start_command: existingDeployment.start_command,
                port: existingDeployment.port,
                runtime: existingDeployment.runtime,
                deployment_source: 'git-linked',
                working_directory: workingDirectory,
                source_type: 'local-git-linked',
                git_linked_at: Date.now(),
            };
            db_1.queries.createDeployment(deployment);
            this.persistLogs(deploymentId);
            this.emitLog(`Git linked successfully! App now deployable via GitHub Actions`, 'success', deploymentId);
            return {
                deploymentId,
                appName,
                port: existingDeployment.port,
                url: `http://localhost:${existingDeployment.port}`,
                status: 'succeeded',
            };
        }
        catch (error) {
            this.emitLog(`Git linking failed: ${String(error)}`, 'error', deploymentId);
            db_1.queries.updateDeployment(deploymentId, { status: 'failed', finished_at: Date.now() });
            this.persistLogs(deploymentId, String(error));
            throw error;
        }
    }
    /**
     * Ensure unzip utility is installed on the server
     * Detects the package manager and installs unzip if not available
     */
    async ensureUnzipInstalled(serverId, deploymentId) {
        // Check if unzip is already installed
        const checkResult = await SSHService_1.sshService.executeCommand(serverId, 'command -v unzip');
        if (checkResult.exitCode === 0) {
            // unzip is already installed
            return;
        }
        this.emitLog('Installing unzip utility...', 'info', deploymentId);
        // Try different package managers in order of likelihood
        const installCommands = [
            'apt-get update && apt-get install -y unzip', // Debian/Ubuntu
            'yum install -y unzip', // CentOS/RHEL 7
            'dnf install -y unzip', // Fedora/RHEL 8+
            'apk add unzip', // Alpine
            'zypper install -y unzip', // openSUSE
            'pacman -S --noconfirm unzip', // Arch
        ];
        let installed = false;
        let lastError = '';
        for (const cmd of installCommands) {
            const result = await SSHService_1.sshService.executeCommand(serverId, `sudo ${cmd}`);
            if (result.exitCode === 0) {
                installed = true;
                this.emitLog('Unzip utility installed successfully!', 'success', deploymentId);
                break;
            }
            else {
                lastError = result.stderr;
            }
        }
        if (!installed) {
            throw new Error(`Failed to install unzip utility. Last error: ${lastError}. Please install unzip manually on your server.`);
        }
    }
}
exports.DeploymentService = DeploymentService;
//# sourceMappingURL=DeploymentService.js.map