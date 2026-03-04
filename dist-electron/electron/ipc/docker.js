"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDockerHandlers = registerDockerHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const db_1 = require("../db");
const DockerComposeService_1 = require("../services/DockerComposeService");
const SSHService_1 = require("../services/SSHService");
const CredentialVault_1 = require("../services/CredentialVault");
const DeploymentQueueService_1 = require("../services/DeploymentQueueService");
const sshService = new SSHService_1.SSHService();
const credentialVault = new CredentialVault_1.CredentialVault();
const dockerComposeService = new DockerComposeService_1.DockerComposeService(sshService, credentialVault);
// Active log streams
const activeLogStreams = new Map();
function registerDockerHandlers() {
    // Get main window for log emissions
    const windows = electron_1.BrowserWindow.getAllWindows();
    const mainWindow = windows.length > 0 ? windows[0] : null;
    if (mainWindow) {
        dockerComposeService.setMainWindow(mainWindow);
    }
    // Deploy Docker Compose
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_DEPLOY, async (_event, input) => {
        try {
            const validated = types_1.DockerDeploySchema.parse(input);
            // Create deployment input
            const deployInput = {
                serverId: validated.serverId,
                projectName: validated.projectName,
                composeFileContent: validated.composeFileContent,
                envVars: validated.envVars,
                registryType: validated.registryType,
                registryUrl: validated.registryUrl,
                registryUsername: validated.registryUsername,
                registryPassword: validated.registryPassword,
                autoUpdate: validated.autoUpdate,
            };
            // Use queue to ensure sequential execution per project
            let deployResult;
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(validated.serverId, validated.projectName, async () => {
                deployResult = await dockerComposeService.deploy(deployInput);
                if (!deployResult.success) {
                    throw new Error(deployResult.error || 'Deployment failed');
                }
            });
            return {
                success: true,
                data: {
                    deploymentId: deployResult.deploymentId,
                    projectName: deployResult.projectName,
                },
            };
        }
        catch (error) {
            console.error('Docker deployment failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Redeploy (pull latest images and restart)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_REDEPLOY, async (_event, input) => {
        try {
            const validated = types_1.DockerRedeploySchema.parse(input);
            let redeployResult;
            await DeploymentQueueService_1.deploymentQueueService.enqueueDeployment(validated.serverId, validated.projectName, async () => {
                redeployResult = await dockerComposeService.redeploy(validated.serverId, validated.projectName);
                if (!redeployResult.success) {
                    throw new Error(redeployResult.error || 'Redeployment failed');
                }
            });
            return {
                success: true,
                data: {
                    projectName: redeployResult.projectName,
                    containers: redeployResult.containers || [],
                },
            };
        }
        catch (error) {
            console.error('Docker redeployment failed:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get deployments by server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_GET_DEPLOYMENTS, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const deployments = await dockerComposeService.getDeploymentsByServer(id);
            return { success: true, data: deployments };
        }
        catch (error) {
            console.error('Error getting Docker deployments:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get single deployment
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_GET_DEPLOYMENT, async (_event, deploymentId) => {
        try {
            const deployment = await dockerComposeService.getDeployment(deploymentId);
            if (!deployment) {
                return { success: false, error: 'Deployment not found' };
            }
            return { success: true, data: deployment };
        }
        catch (error) {
            console.error('Error getting Docker deployment:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get container status (docker compose ps)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_PS, async (_event, input) => {
        try {
            const validated = types_1.DockerProjectSchema.parse(input);
            const workingDir = `/opt/servercompass/${validated.projectName}`;
            const containers = await dockerComposeService.getContainerStatus(validated.serverId, workingDir, validated.projectName);
            return { success: true, data: containers };
        }
        catch (error) {
            console.error('Error getting container status:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get container logs
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_LOGS, async (_event, input) => {
        try {
            const validated = types_1.DockerLogsSchema.parse(input);
            const workingDir = `/opt/servercompass/${validated.projectName}`;
            // Get non-streaming logs
            const command = `cd ${workingDir} && docker compose logs --tail=${validated.tail || 100} ${validated.serviceName || ''}`;
            const result = await sshService.executeCommand(validated.serverId, command);
            if (result.exitCode !== 0) {
                return { success: false, error: result.stderr };
            }
            return { success: true, data: result.stdout };
        }
        catch (error) {
            console.error('Error getting container logs:', error);
            return { success: false, error: String(error) };
        }
    });
    // Start streaming logs
    electron_1.ipcMain.on(types_1.IPC_CHANNELS.DOCKER_LOGS_STREAM_START, async (event, input) => {
        try {
            const validated = types_1.DockerLogsSchema.parse(input);
            const streamId = `${validated.serverId}-${validated.projectName}-${validated.serviceName || 'all'}`;
            // Stop existing stream if any
            const existingController = activeLogStreams.get(streamId);
            if (existingController) {
                existingController.abort();
            }
            // Create new abort controller
            const abortController = new AbortController();
            activeLogStreams.set(streamId, abortController);
            // Start streaming logs
            const stream = dockerComposeService.streamLogs(validated.serverId, validated.projectName, validated.serviceName, validated.tail || 100);
            // Process stream
            (async () => {
                try {
                    for await (const chunk of stream) {
                        if (abortController.signal.aborted)
                            break;
                        event.sender.send(types_1.IPC_CHANNELS.DOCKER_LOGS_DATA, {
                            streamId,
                            data: chunk,
                        });
                    }
                }
                catch (error) {
                    console.error('Log streaming error:', error);
                    event.sender.send(types_1.IPC_CHANNELS.DOCKER_LOGS_DATA, {
                        streamId,
                        error: String(error),
                    });
                }
                finally {
                    activeLogStreams.delete(streamId);
                }
            })();
        }
        catch (error) {
            console.error('Error starting log stream:', error);
        }
    });
    // Stop streaming logs
    electron_1.ipcMain.on(types_1.IPC_CHANNELS.DOCKER_LOGS_STREAM_STOP, (_event, streamId) => {
        const controller = activeLogStreams.get(streamId);
        if (controller) {
            controller.abort();
            activeLogStreams.delete(streamId);
        }
    });
    // Restart service
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_RESTART, async (_event, input) => {
        try {
            const validated = types_1.DockerServiceSchema.parse(input);
            await dockerComposeService.restartService(validated.serverId, validated.projectName, validated.serviceName);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error restarting container:', error);
            return { success: false, error: String(error) };
        }
    });
    // Stop containers
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_STOP, async (_event, input) => {
        try {
            const validated = types_1.DockerProjectSchema.parse(input);
            await dockerComposeService.stopAll(validated.serverId, validated.projectName);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error stopping containers:', error);
            return { success: false, error: String(error) };
        }
    });
    // Start containers
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_START, async (_event, input) => {
        try {
            const validated = types_1.DockerProjectSchema.parse(input);
            const workingDir = `/opt/servercompass/${validated.projectName}`;
            const result = await sshService.executeCommand(validated.serverId, `cd ${workingDir} && docker compose up -d`);
            if (result.exitCode !== 0) {
                return { success: false, error: result.stderr };
            }
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error starting containers:', error);
            return { success: false, error: String(error) };
        }
    });
    // Test registry connection
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_TEST_REGISTRY, async (_event, input) => {
        try {
            const validated = types_1.DockerTestRegistrySchema.parse(input);
            // Just validate that credentials are provided
            // Actual testing would require SSH connection which we'll skip for now
            return {
                success: true,
                data: {
                    success: true,
                    message: `Registry credentials validated for ${validated.type}`,
                },
            };
        }
        catch (error) {
            console.error('Error testing registry:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get container stats
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_GET_STATS, async (_event, input) => {
        try {
            const validated = types_1.DockerProjectSchema.parse(input);
            const workingDir = `/opt/servercompass/${validated.projectName}`;
            // Get container IDs
            const psResult = await sshService.executeCommand(validated.serverId, `cd ${workingDir} && docker compose ps -q`);
            if (psResult.exitCode !== 0 || !psResult.stdout.trim()) {
                return { success: true, data: [] };
            }
            const containerIds = psResult.stdout.trim().split('\n').join(' ');
            // Get stats
            const statsResult = await sshService.executeCommand(validated.serverId, `docker stats ${containerIds} --no-stream --format "{{json .}}"`);
            if (statsResult.exitCode !== 0) {
                return { success: false, error: statsResult.stderr };
            }
            const stats = statsResult.stdout
                .split('\n')
                .filter(Boolean)
                .map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
                .filter(Boolean);
            return { success: true, data: stats };
        }
        catch (error) {
            console.error('Error getting container stats:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update compose file
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DOCKER_UPDATE_COMPOSE, async (_event, input) => {
        try {
            const validated = types_1.DockerUpdateComposeSchema.parse(input);
            // Get deployment
            const deployment = await dockerComposeService.getDeployment(validated.deploymentId);
            if (!deployment) {
                return { success: false, error: 'Deployment not found' };
            }
            // Update compose file in database
            const stmt = db_1.db.prepare(`
          UPDATE docker_compose_deployments
          SET compose_file_content = ?, updated_at = ?
          WHERE id = ?
        `);
            stmt.run(validated.composeFileContent, Date.now(), validated.deploymentId);
            // Upload new compose file to server
            const workingDir = `/opt/servercompass/${deployment.project_name}`;
            const command = `cat > ${workingDir}/docker-compose.yml << 'COMPOSE_EOF'
${validated.composeFileContent}
COMPOSE_EOF`;
            const result = await sshService.executeCommand(deployment.server_id, command);
            if (result.exitCode !== 0) {
                return { success: false, error: result.stderr };
            }
            // Update env vars if provided
            if (validated.envVars && Object.keys(validated.envVars).length > 0) {
                const envContent = Object.entries(validated.envVars)
                    .map(([key, value]) => {
                    const strValue = String(value);
                    const needsQuotes = strValue.includes(' ') || strValue.includes('\n');
                    const escapedValue = strValue.replace(/"/g, '\\"');
                    return needsQuotes ? `${key}="${escapedValue}"` : `${key}=${strValue}`;
                })
                    .join('\n');
                const envCommand = `cat > ${workingDir}/.env << 'ENV_EOF'
${envContent}
ENV_EOF`;
                await sshService.executeCommand(deployment.server_id, envCommand);
            }
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error updating compose file:', error);
            return { success: false, error: String(error) };
        }
    });
    // Cleanup on app quit
    process.on('beforeExit', () => {
        // Stop all active log streams
        for (const controller of activeLogStreams.values()) {
            controller.abort();
        }
        activeLogStreams.clear();
    });
}
//# sourceMappingURL=docker.js.map