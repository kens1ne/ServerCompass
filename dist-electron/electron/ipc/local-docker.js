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
exports.setLocalDockerMainWindow = setLocalDockerMainWindow;
exports.registerLocalDockerHandlers = registerLocalDockerHandlers;
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const LocalDockerService_1 = require("../services/LocalDockerService");
const SSHService_1 = require("../services/SSHService");
const DockerfileGenerator_1 = require("../services/DockerfileGenerator");
// Create a dedicated SSH service instance for local docker operations
const sshService = new SSHService_1.SSHService();
const types_1 = require("./types");
let mainWindow = null;
function setLocalDockerMainWindow(window) {
    mainWindow = window;
}
function registerLocalDockerHandlers() {
    // Check Docker availability
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_CHECK, async () => {
        try {
            const result = await LocalDockerService_1.localDockerService.checkDockerAvailable();
            return { success: true, data: result };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Validate build context
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_VALIDATE_CONTEXT, async (_event, input) => {
        try {
            const { projectPath } = types_1.LocalDockerValidateContextSchema.parse(input);
            const result = await LocalDockerService_1.localDockerService.validateBuildContext(projectPath);
            return { success: true, data: result };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Test git repository access (lightweight check using ls-remote)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_TEST_GIT_ACCESS, async (_event, input) => {
        try {
            const { repoUrl, sshKeyPath } = input;
            const result = await LocalDockerService_1.localDockerService.testGitAccess({
                repoUrl,
                sshKeyPath,
            });
            if (result.success) {
                return { success: true, data: undefined };
            }
            else {
                return { success: false, error: result.error };
            }
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Clone repository locally for building
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_CLONE, async (_event, input) => {
        try {
            const { repoUrl, branch, sshKeyPath } = input;
            const result = await LocalDockerService_1.localDockerService.cloneRepository({
                repoUrl,
                branch,
                sshKeyPath,
            });
            if (result.success) {
                return { success: true, data: { localPath: result.localPath } };
            }
            else {
                return { success: false, error: result.error };
            }
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Cleanup cloned repository
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_CLEANUP_CLONE, async (_event, input) => {
        try {
            const { localPath } = input;
            await LocalDockerService_1.localDockerService.cleanupClonedRepo(localPath);
            return { success: true, data: undefined };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Build Docker image locally
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD, async (_event, input) => {
        try {
            const options = types_1.LocalDockerBuildSchema.parse(input);
            const buildId = options.buildId || (0, crypto_1.randomUUID)();
            // Set up progress listeners
            const progressHandler = (progress) => {
                if (progress.buildId === buildId && mainWindow) {
                    mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_PROGRESS, progress);
                }
            };
            const logHandler = (log) => {
                if (log.buildId === buildId && mainWindow) {
                    mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_LOG, log);
                }
            };
            LocalDockerService_1.localDockerService.on('build-progress', progressHandler);
            LocalDockerService_1.localDockerService.on('build-log', logHandler);
            try {
                const result = await LocalDockerService_1.localDockerService.buildImage({
                    buildId,
                    projectPath: options.projectPath,
                    imageName: options.imageName,
                    imageTag: options.imageTag,
                    platform: options.platform,
                    noCache: options.noCache,
                    dockerfilePath: options.dockerfilePath,
                    buildArgs: options.buildArgs,
                });
                return {
                    success: result.success,
                    data: { buildId, ...result },
                };
            }
            finally {
                LocalDockerService_1.localDockerService.off('build-progress', progressHandler);
                LocalDockerService_1.localDockerService.off('build-log', logHandler);
            }
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Stream image to server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_STREAM, async (_event, input) => {
        try {
            const options = types_1.LocalDockerStreamSchema.parse(input);
            const streamId = options.streamId || (0, crypto_1.randomUUID)();
            // Set up progress listener
            const progressHandler = (progress) => {
                if (progress.streamId === streamId && mainWindow) {
                    mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_UPLOAD_PROGRESS, progress);
                }
            };
            const logHandler = (log) => {
                if (log.buildId === streamId && mainWindow) {
                    mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_LOG, log);
                }
            };
            LocalDockerService_1.localDockerService.on('upload-progress', progressHandler);
            LocalDockerService_1.localDockerService.on('build-log', logHandler);
            try {
                const result = await LocalDockerService_1.localDockerService.streamImageToServer({
                    streamId,
                    imageName: options.imageName,
                    imageTag: options.imageTag,
                    serverId: options.serverId,
                    sshService,
                    useCompression: options.useCompression,
                });
                return {
                    success: result.success,
                    data: { streamId, ...result },
                };
            }
            finally {
                LocalDockerService_1.localDockerService.off('upload-progress', progressHandler);
                LocalDockerService_1.localDockerService.off('build-log', logHandler);
            }
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Full deployment with local build
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_DEPLOY, async (_event, input) => {
        try {
            const options = types_1.LocalDockerDeploySchema.parse(input);
            const deploymentId = (0, crypto_1.randomUUID)();
            const buildId = (0, crypto_1.randomUUID)();
            const imageName = `servercompass/${options.appName}`;
            const imageTag = Date.now().toString();
            const emitProgress = (progress) => {
                if (mainWindow) {
                    mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_PROGRESS, {
                        ...progress,
                        buildId,
                    });
                }
            };
            const emitLog = (level, message) => {
                if (mainWindow) {
                    mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_LOG, {
                        buildId,
                        level,
                        message,
                        timestamp: Date.now(),
                    });
                }
            };
            // Save initial build record
            LocalDockerService_1.localDockerService.saveBuildRecord({
                id: buildId,
                deploymentId,
                serverId: options.serverId,
                appName: options.appName,
                projectPath: options.projectPath,
                imageName,
                imageTag,
                status: 'pending',
                dockerfileGenerated: false,
                platform: options.platform,
                buildArgs: options.buildArgs,
                useCompression: options.useCompression,
            });
            try {
                // Step 1: Check local Docker
                emitProgress({
                    buildId,
                    phase: 'analyzing',
                    step: 1,
                    totalSteps: 6,
                    message: 'Checking Docker availability...',
                    percentage: 5,
                });
                const dockerCheck = await LocalDockerService_1.localDockerService.checkDockerAvailable();
                if (!dockerCheck.available) {
                    throw new Error(dockerCheck.error || 'Docker is not available on your machine');
                }
                // Step 2: Validate build context and generate Dockerfile if needed
                emitProgress({
                    buildId,
                    phase: 'analyzing',
                    step: 2,
                    totalSteps: 6,
                    message: 'Analyzing project...',
                    percentage: 10,
                });
                const validation = await LocalDockerService_1.localDockerService.validateBuildContext(options.projectPath);
                let dockerfilePath = options.dockerfilePath;
                let dockerfileGenerated = false;
                if (!validation.hasDockerfile && !dockerfilePath) {
                    emitProgress({
                        buildId,
                        phase: 'generating',
                        step: 2,
                        totalSteps: 6,
                        message: 'Generating Dockerfile...',
                        percentage: 15,
                    });
                    const generated = await DockerfileGenerator_1.dockerfileGenerator.generateDockerfile(options.projectPath);
                    dockerfilePath = generated.dockerfilePath;
                    dockerfileGenerated = true;
                    emitLog('info', `Generated Dockerfile for ${generated.projectType} project`);
                }
                // Update build record with Dockerfile info
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    dockerfileGenerated,
                    dockerfilePath,
                });
                // Step 3: Build image locally
                const buildStartedAt = new Date().toISOString();
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    status: 'building',
                    buildStartedAt,
                });
                emitProgress({
                    buildId,
                    phase: 'building',
                    step: 3,
                    totalSteps: 6,
                    message: 'Building Docker image...',
                    percentage: 20,
                });
                // Forward build progress
                const buildProgressHandler = (progress) => {
                    if (progress.buildId === buildId && mainWindow) {
                        // Map percentage to 20-60 range
                        const mappedPercentage = 20 + Math.round((progress.percentage || 0) * 0.4);
                        mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_PROGRESS, {
                            ...progress,
                            percentage: mappedPercentage,
                        });
                    }
                };
                LocalDockerService_1.localDockerService.on('build-progress', buildProgressHandler);
                const buildResult = await LocalDockerService_1.localDockerService.buildImage({
                    buildId,
                    projectPath: options.projectPath,
                    dockerfilePath,
                    imageName,
                    imageTag,
                    platform: options.platform,
                    buildArgs: options.buildArgs,
                    noCache: options.noCache,
                });
                LocalDockerService_1.localDockerService.off('build-progress', buildProgressHandler);
                if (!buildResult.success) {
                    throw new Error(buildResult.error || 'Build failed');
                }
                const buildCompletedAt = new Date().toISOString();
                const buildDuration = Math.round((new Date(buildCompletedAt).getTime() - new Date(buildStartedAt).getTime()) / 1000);
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    buildCompletedAt,
                    buildDuration,
                    imageSize: buildResult.imageSize,
                });
                emitLog('info', `Build completed in ${buildDuration}s, image size: ${buildResult.imageSize ? Math.round(buildResult.imageSize / 1024 / 1024) + 'MB' : 'unknown'}`);
                // Step 4: Stream image to server
                const uploadStartedAt = new Date().toISOString();
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    status: 'uploading',
                    uploadStartedAt,
                });
                emitProgress({
                    buildId,
                    phase: 'uploading',
                    step: 4,
                    totalSteps: 6,
                    message: 'Uploading image to server...',
                    percentage: 60,
                });
                // Forward upload progress
                const uploadProgressHandler = (progress) => {
                    if (mainWindow) {
                        // Map percentage to 60-80 range
                        const mappedPercentage = 60 + Math.round(progress.percentage * 0.2);
                        mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_UPLOAD_PROGRESS, progress);
                        mainWindow.webContents.send(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_PROGRESS, {
                            buildId,
                            phase: 'uploading',
                            step: 4,
                            totalSteps: 6,
                            message: `Uploading: ${Math.round(progress.bytesTransferred / 1024 / 1024)}MB / ${Math.round(progress.totalBytes / 1024 / 1024)}MB`,
                            percentage: mappedPercentage,
                        });
                    }
                };
                LocalDockerService_1.localDockerService.on('upload-progress', uploadProgressHandler);
                const streamResult = await LocalDockerService_1.localDockerService.streamImageToServer({
                    streamId: buildId,
                    imageName,
                    imageTag,
                    serverId: options.serverId,
                    sshService,
                    useCompression: options.useCompression,
                });
                LocalDockerService_1.localDockerService.off('upload-progress', uploadProgressHandler);
                if (!streamResult.success) {
                    throw new Error(streamResult.error || 'Upload failed');
                }
                const uploadCompletedAt = new Date().toISOString();
                const uploadDuration = Math.round((new Date(uploadCompletedAt).getTime() - new Date(uploadStartedAt).getTime()) / 1000);
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    uploadCompletedAt,
                    uploadDuration,
                });
                emitLog('info', `Upload completed in ${uploadDuration}s`);
                // Step 5: Deploy container on server
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, { status: 'deploying' });
                emitProgress({
                    buildId,
                    phase: 'deploying',
                    step: 5,
                    totalSteps: 6,
                    message: 'Starting container...',
                    percentage: 85,
                });
                const containerName = `sc-${options.appName}`;
                const fullImageName = `${imageName}:${imageTag}`;
                const client = await sshService.connect(options.serverId);
                // Stop and remove existing container
                await sshService.executeCommand(client, `docker stop ${containerName} 2>/dev/null || true`);
                await sshService.executeCommand(client, `docker rm ${containerName} 2>/dev/null || true`);
                // Build docker run command
                let runCommand = `docker run -d --name ${containerName} --restart unless-stopped`;
                runCommand += ` -p ${options.port}:${options.port}`;
                // Add environment variables
                if (options.envVars) {
                    for (const [key, value] of Object.entries(options.envVars)) {
                        // Escape special characters in values
                        const escapedValue = String(value).replace(/"/g, '\\"').replace(/\$/g, '\\$');
                        runCommand += ` -e ${key}="${escapedValue}"`;
                    }
                }
                runCommand += ` ${fullImageName}`;
                const runResult = await sshService.executeCommand(client, runCommand);
                if (runResult.exitCode !== 0) {
                    throw new Error(`Failed to start container: ${runResult.stderr}`);
                }
                emitLog('info', `Container ${containerName} started successfully`);
                // Step 6: Verify deployment
                emitProgress({
                    buildId,
                    phase: 'verifying',
                    step: 6,
                    totalSteps: 6,
                    message: 'Verifying deployment...',
                    percentage: 95,
                });
                // Simple health check - verify container is running
                let healthy = false;
                let healthMessage = '';
                for (let attempt = 1; attempt <= 3; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const statusResult = await sshService.executeCommand(client, `docker inspect --format='{{.State.Status}}' ${containerName}`);
                    if (statusResult.stdout.trim() === 'running') {
                        healthy = true;
                        healthMessage = 'Container is running';
                        break;
                    }
                    if (attempt === 3) {
                        // Get container logs for debugging
                        const logsResult = await sshService.executeCommand(client, `docker logs --tail 20 ${containerName} 2>&1`);
                        healthMessage = `Container not running. Logs:\n${logsResult.stdout}`;
                    }
                }
                // Get server IP for URL
                const server = await sshService.executeCommand(client, 'hostname -I | awk \'{print $1}\'');
                const serverIp = server.stdout.trim();
                // Cleanup local image if requested
                if (options.cleanupLocalImage) {
                    emitProgress({
                        buildId,
                        phase: 'cleanup',
                        step: 6,
                        totalSteps: 6,
                        message: 'Cleaning up local image...',
                        percentage: 98,
                    });
                    await LocalDockerService_1.localDockerService.cleanupLocalImage(imageName, imageTag);
                }
                // Cleanup generated Dockerfile
                if (dockerfileGenerated && dockerfilePath) {
                    try {
                        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                        await fs.unlink(dockerfilePath);
                    }
                    catch {
                        // Ignore cleanup errors
                    }
                }
                // Update final status
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    status: healthy ? 'completed' : 'completed', // Still mark as completed even if health check uncertain
                });
                emitProgress({
                    buildId,
                    phase: 'deploying',
                    step: 6,
                    totalSteps: 6,
                    message: 'Deployment completed!',
                    percentage: 100,
                });
                const url = options.domain ? `https://${options.domain}` : `http://${serverIp}:${options.port}`;
                return {
                    success: true,
                    data: {
                        success: true,
                        deploymentId,
                        buildId,
                        imageName: fullImageName,
                        containerName,
                        url,
                        healthCheck: {
                            healthy,
                            message: healthMessage,
                        },
                    },
                };
            }
            catch (error) {
                // Update build record with error
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, {
                    status: 'failed',
                    errorMessage: error.message,
                });
                // Cleanup on failure
                LocalDockerService_1.localDockerService.cancelBuild(buildId);
                LocalDockerService_1.localDockerService.cancelStream(buildId);
                emitLog('error', error.message);
                return { success: false, error: error.message };
            }
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Cancel build or stream
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_CANCEL, async (_event, input) => {
        try {
            const { buildId, streamId } = types_1.LocalDockerCancelSchema.parse(input);
            if (buildId) {
                LocalDockerService_1.localDockerService.cancelBuild(buildId);
                LocalDockerService_1.localDockerService.updateBuildRecord(buildId, { status: 'cancelled' });
            }
            if (streamId) {
                LocalDockerService_1.localDockerService.cancelStream(streamId);
            }
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Cleanup local image
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_CLEANUP, async (_event, input) => {
        try {
            const { imageName, imageTag } = types_1.LocalDockerCleanupSchema.parse(input);
            await LocalDockerService_1.localDockerService.cleanupLocalImage(imageName, imageTag);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // Get build records
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_DOCKER_GET_BUILDS, async (_event, input) => {
        try {
            const { serverId, limit } = types_1.LocalDockerGetBuildsSchema.parse(input || {});
            const records = LocalDockerService_1.localDockerService.getBuildRecords(serverId, limit);
            return { success: true, data: records };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
}
//# sourceMappingURL=local-docker.js.map