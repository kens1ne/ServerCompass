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
exports.localDockerService = exports.LocalDockerService = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("../db");
/**
 * Get a PATH that includes common Docker binary locations.
 * Packaged Electron apps on macOS inherit a minimal PATH (/usr/bin:/bin)
 * that doesn't include /usr/local/bin where Docker Desktop/OrbStack symlinks live.
 */
function getDockerEnv(extra) {
    const currentPath = process.env.PATH || '/usr/bin:/bin';
    const dockerPaths = [
        '/usr/local/bin', // Docker Desktop / OrbStack symlinks
        '/opt/homebrew/bin', // Homebrew on Apple Silicon
        '/Applications/Docker.app/Contents/Resources/bin', // Docker Desktop direct
    ];
    // Prepend missing paths
    const parts = currentPath.split(':');
    const additions = dockerPaths.filter(p => !parts.includes(p));
    const fullPath = [...additions, ...parts].join(':');
    return { ...process.env, PATH: fullPath, ...extra };
}
class LocalDockerService extends events_1.EventEmitter {
    activeBuilds = new Map();
    activeStreams = new Map();
    /**
     * Check if Docker is available on the local machine
     * Distinguishes between "not installed" and "installed but not running"
     */
    async checkDockerAvailable() {
        const platform = process.platform === 'darwin' ? 'mac'
            : process.platform === 'win32' ? 'windows'
                : 'linux';
        const downloadUrls = {
            mac: 'https://docs.docker.com/desktop/install/mac-install/',
            windows: 'https://docs.docker.com/desktop/install/windows-install/',
            linux: 'https://docs.docker.com/engine/install/',
        };
        try {
            // First check if docker CLI exists
            await this.executeCommand('docker', ['--version']);
        }
        catch (error) {
            // ENOENT means docker command not found
            if (error.message?.includes('ENOENT') || error.message?.includes('not found') || error.code === 'ENOENT') {
                return {
                    available: false,
                    status: 'not_installed',
                    platform,
                    error: 'Docker is not installed on this machine',
                    downloadUrl: downloadUrls[platform],
                };
            }
        }
        try {
            // Docker CLI exists, check if daemon is running
            const result = await this.executeCommand('docker', ['version', '--format', '{{.Server.Version}}']);
            return {
                available: true,
                status: 'available',
                version: result.trim(),
                platform,
            };
        }
        catch (error) {
            // Docker CLI exists but daemon is not running
            return {
                available: false,
                status: 'not_running',
                platform,
                error: 'Docker daemon is not running. Please start Docker Desktop.',
            };
        }
    }
    /**
     * Validate build context before building
     */
    async validateBuildContext(projectPath) {
        const warnings = [];
        const suggestions = [];
        // Check if directory exists
        if (!fs_1.default.existsSync(projectPath)) {
            return {
                valid: false,
                totalSize: 0,
                fileCount: 0,
                hasDockerfile: false,
                hasDockerignore: false,
                warnings: ['Project directory does not exist'],
                suggestions: [],
            };
        }
        // Check for Dockerfile
        const hasDockerfile = fs_1.default.existsSync(path_1.default.join(projectPath, 'Dockerfile'));
        // Check for .dockerignore
        const hasDockerignore = fs_1.default.existsSync(path_1.default.join(projectPath, '.dockerignore'));
        if (!hasDockerignore) {
            warnings.push('No .dockerignore file found');
            suggestions.push('Create a .dockerignore to exclude node_modules, .git, etc.');
        }
        // Check for large directories that should be ignored
        const largeDirectories = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv'];
        for (const dir of largeDirectories) {
            const dirPath = path_1.default.join(projectPath, dir);
            if (fs_1.default.existsSync(dirPath)) {
                try {
                    const stats = fs_1.default.statSync(dirPath);
                    if (stats.isDirectory()) {
                        const size = await this.getDirectorySize(dirPath);
                        if (size > 100 * 1024 * 1024) { // > 100MB
                            warnings.push(`Large directory found: ${dir} (${this.formatBytes(size)})`);
                            if (!hasDockerignore) {
                                suggestions.push(`Add "${dir}" to .dockerignore`);
                            }
                        }
                    }
                }
                catch {
                    // Skip if can't read directory
                }
            }
        }
        // Calculate total context size (rough estimate)
        let totalSize = 0;
        let fileCount = 0;
        try {
            const result = await this.calculateContextSize(projectPath, hasDockerignore);
            totalSize = result.totalSize;
            fileCount = result.fileCount;
            if (totalSize > 500 * 1024 * 1024) { // > 500MB
                warnings.push(`Build context is very large (${this.formatBytes(totalSize)})`);
                suggestions.push('Large build contexts slow down builds. Check .dockerignore.');
            }
        }
        catch {
            // Skip size calculation on error
        }
        return {
            valid: true,
            totalSize,
            fileCount,
            hasDockerfile,
            hasDockerignore,
            warnings,
            suggestions,
        };
    }
    /**
     * Build SSH environment for git commands
     */
    buildGitSshEnv(sshKeyPath) {
        const env = { ...process.env };
        // Ensure SSH_AUTH_SOCK is passed through for SSH agent
        if (process.env.SSH_AUTH_SOCK) {
            env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
        }
        if (sshKeyPath && fs_1.default.existsSync(sshKeyPath)) {
            // Use specific SSH key
            env.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
        }
        else {
            // Use SSH agent with auto host key acceptance
            env.GIT_SSH_COMMAND = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
        }
        return env;
    }
    /**
     * Test git repository access without cloning (lightweight check)
     */
    async testGitAccess(options) {
        const { repoUrl, sshKeyPath } = options;
        return new Promise((resolve) => {
            const env = this.buildGitSshEnv(sshKeyPath);
            // Use ls-remote to test access without downloading anything
            const args = ['ls-remote', '--heads', repoUrl];
            const proc = (0, child_process_1.spawn)('git', args, { env });
            let stderr = '';
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true });
                }
                else {
                    resolve({
                        success: false,
                        error: stderr || `Git access test failed with code ${code}`,
                    });
                }
            });
            proc.on('error', (error) => {
                resolve({
                    success: false,
                    error: error.message,
                });
            });
        });
    }
    /**
     * Clone a git repository locally for building
     */
    async cloneRepository(options) {
        const { repoUrl, branch = 'main', targetPath, sshKeyPath } = options;
        const os = await Promise.resolve().then(() => __importStar(require('os')));
        // Create a unique temp directory if no target path provided
        const localPath = targetPath || path_1.default.join(os.tmpdir(), 'servercompass-local-build', `repo-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        // Ensure parent directory exists
        fs_1.default.mkdirSync(path_1.default.dirname(localPath), { recursive: true });
        return new Promise((resolve) => {
            const env = this.buildGitSshEnv(sshKeyPath);
            const args = ['clone', '--depth', '1', '--branch', branch, repoUrl, localPath];
            const proc = (0, child_process_1.spawn)('git', args, { env });
            let stderr = '';
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true, localPath });
                }
                else {
                    // Clean up on failure
                    try {
                        fs_1.default.rmSync(localPath, { recursive: true, force: true });
                    }
                    catch {
                        // Ignore cleanup errors
                    }
                    resolve({
                        success: false,
                        localPath: '',
                        error: stderr || `Git clone failed with code ${code}`,
                    });
                }
            });
            proc.on('error', (error) => {
                resolve({
                    success: false,
                    localPath: '',
                    error: error.message,
                });
            });
        });
    }
    /**
     * Clean up a cloned repository
     */
    async cleanupClonedRepo(localPath) {
        try {
            if (localPath.includes('servercompass-local-build') && fs_1.default.existsSync(localPath)) {
                fs_1.default.rmSync(localPath, { recursive: true, force: true });
            }
        }
        catch {
            // Ignore cleanup errors
        }
    }
    /**
     * Build Docker image locally
     */
    async buildImage(options) {
        const { buildId, projectPath, dockerfilePath, imageName, imageTag, platform, buildArgs = {}, noCache = false, } = options;
        const args = [
            'build',
            '--platform', platform,
            '--tag', `${imageName}:${imageTag}`,
            '--progress', 'plain', // For parseable output
        ];
        if (dockerfilePath) {
            args.push('--file', dockerfilePath);
        }
        if (noCache) {
            args.push('--no-cache');
        }
        // Add build arguments
        for (const [key, value] of Object.entries(buildArgs)) {
            args.push('--build-arg', `${key}=${value}`);
        }
        args.push('.');
        console.log(`[LocalDockerService] buildImage: docker ${args.join(' ')}`);
        console.log(`[LocalDockerService] buildImage: cwd=${projectPath}, buildId=${buildId}`);
        return new Promise((resolve) => {
            const proc = (0, child_process_1.spawn)('docker', args, {
                cwd: projectPath,
                stdio: ['ignore', 'pipe', 'pipe'], // Explicit: no stdin, pipe stdout/stderr
                env: getDockerEnv({ DOCKER_BUILDKIT: '1' }),
            });
            this.activeBuilds.set(buildId, proc);
            let output = '';
            let currentStep = 0;
            let totalSteps = 0;
            const processLine = (line, isStderr) => {
                output += line + '\n';
                // Parse Docker build output for progress
                const stepMatch = line.match(/#(\d+)\s+\[/);
                if (stepMatch) {
                    currentStep = parseInt(stepMatch[1], 10);
                    if (currentStep > totalSteps) {
                        totalSteps = currentStep;
                    }
                }
                // Parse step count from FROM or COPY statements
                const totalMatch = line.match(/\[(\d+)\/(\d+)\]/);
                if (totalMatch) {
                    currentStep = parseInt(totalMatch[1], 10);
                    totalSteps = parseInt(totalMatch[2], 10);
                }
                const progress = {
                    buildId,
                    phase: 'building',
                    step: currentStep,
                    totalSteps: totalSteps || 1,
                    message: line.trim().substring(0, 500), // Limit message length
                    percentage: totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0,
                    details: {
                        cached: line.includes('CACHED'),
                    },
                };
                this.emit('build-progress', progress);
                // Docker BuildKit writes ALL output (including normal progress) to stderr.
                // Only classify as error if line contains actual error indicators.
                if (isStderr && line.trim()) {
                    const trimmed = line.trim().toLowerCase();
                    const isActualError = trimmed.startsWith('error') ||
                        trimmed.includes('error:') ||
                        trimmed.includes('failed to') ||
                        trimmed.includes('cannot ') ||
                        trimmed.includes('denied:') ||
                        trimmed.includes('permission denied') ||
                        trimmed.includes('no such file') ||
                        trimmed.includes('exit code:') ||
                        trimmed.includes('returned a non-zero code');
                    const log = {
                        buildId,
                        level: isActualError ? 'error' : 'info',
                        message: line.trim(),
                        timestamp: Date.now(),
                    };
                    this.emit('build-log', log);
                }
            };
            proc.stdout.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        processLine(line, false);
                    }
                });
            });
            proc.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        processLine(line, true);
                    }
                });
            });
            proc.on('close', async (code) => {
                console.log(`[LocalDockerService] buildImage: process closed with code=${code}, buildId=${buildId}`);
                this.activeBuilds.delete(buildId);
                if (code === 0) {
                    try {
                        // Get image ID and size
                        const imageId = await this.executeCommand('docker', ['images', '-q', `${imageName}:${imageTag}`]);
                        const sizeStr = await this.executeCommand('docker', [
                            'image', 'inspect', `${imageName}:${imageTag}`,
                            '--format', '{{.Size}}'
                        ]);
                        const imageSize = parseInt(sizeStr.trim(), 10);
                        resolve({
                            success: true,
                            imageId: imageId.trim(),
                            imageSize,
                        });
                    }
                    catch {
                        resolve({ success: true });
                    }
                }
                else {
                    resolve({
                        success: false,
                        error: `Build failed with exit code ${code}`,
                    });
                }
            });
            proc.on('error', (error) => {
                console.error(`[LocalDockerService] buildImage: process error: ${error.message}, buildId=${buildId}`);
                this.activeBuilds.delete(buildId);
                resolve({
                    success: false,
                    error: error.message,
                });
            });
        });
    }
    /**
     * Stream Docker image directly to remote server via SSH
     */
    async streamImageToServer(options) {
        const { streamId, imageName, imageTag, serverId, sshService, useCompression = false } = options;
        const fullImageName = `${imageName}:${imageTag}`;
        // Get image size for progress tracking
        // Note: docker inspect returns virtual size, tar export is typically larger
        let totalBytes;
        try {
            const sizeOutput = await this.executeCommand('docker', [
                'image', 'inspect', fullImageName,
                '--format', '{{.Size}}'
            ]);
            const virtualSize = parseInt(sizeOutput.trim(), 10);
            // Estimate tar overhead.
            //
            // IMPORTANT: docker save output size is often larger than `.Size`, and whole-tar gzip
            // compression ratio varies wildly (sometimes even larger than expected).
            // We treat `totalBytes` as an estimate and adjust upward during streaming if needed.
            const estimatedTarSize = Math.round(virtualSize * 1.25);
            totalBytes = useCompression ? Math.round(estimatedTarSize * 0.85) : estimatedTarSize;
        }
        catch (error) {
            return { success: false, error: `Failed to get image size: ${error.message}` };
        }
        return new Promise(async (resolve) => {
            try {
                // Get SSH connection
                const client = await sshService.connect(serverId);
                // Start docker save process
                const dockerSave = (0, child_process_1.spawn)('docker', ['save', fullImageName], { env: getDockerEnv() });
                this.activeStreams.set(streamId, dockerSave);
                let bytesTransferred = 0;
                const startTime = Date.now();
                let lastPercentage = 0;
                // Determine remote command based on compression
                const remoteCommand = useCompression ? 'gunzip | docker load' : 'docker load';
                // If using compression, pipe through gzip
                let sourceStream = dockerSave.stdout;
                let gzipProc = null;
                if (useCompression) {
                    gzipProc = (0, child_process_1.spawn)('gzip', ['-1']); // Fast compression
                    if (dockerSave.stdout && gzipProc.stdin && gzipProc.stdout) {
                        dockerSave.stdout.pipe(gzipProc.stdin);
                        sourceStream = gzipProc.stdout;
                        this.activeStreams.set(`${streamId}-gzip`, gzipProc);
                    }
                }
                client.exec(remoteCommand, (err, stream) => {
                    if (err) {
                        dockerSave.kill();
                        if (gzipProc)
                            gzipProc.kill();
                        this.activeStreams.delete(streamId);
                        this.activeStreams.delete(`${streamId}-gzip`);
                        return resolve({ success: false, error: err.message });
                    }
                    // Track bytes transferred
                    sourceStream.on('data', (chunk) => {
                        bytesTransferred += chunk.length;
                        // If we underestimated, bump the estimate to avoid showing >100% transferred.
                        // Add headroom so progress remains <100% until the stream ends.
                        if (bytesTransferred > totalBytes) {
                            totalBytes = Math.round(bytesTransferred * 1.15);
                        }
                        const elapsed = (Date.now() - startTime) / 1000;
                        const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;
                        const remaining = Math.max(0, totalBytes - bytesTransferred);
                        const eta = speed > 0 ? remaining / speed : 0;
                        const rawPercentage = totalBytes > 0
                            ? Math.round((bytesTransferred / totalBytes) * 100)
                            : 0;
                        // Never report 100% until the stream closes successfully.
                        const nextPercentage = Math.max(0, Math.min(99, rawPercentage));
                        lastPercentage = Math.max(lastPercentage, nextPercentage);
                        const progress = {
                            streamId,
                            bytesTransferred,
                            totalBytes,
                            speed,
                            eta,
                            percentage: lastPercentage,
                        };
                        this.emit('upload-progress', progress);
                    });
                    // Pipe to SSH stream
                    sourceStream.pipe(stream);
                    let remoteOutput = '';
                    stream.on('data', (data) => {
                        remoteOutput += data.toString();
                    });
                    stream.stderr.on('data', (data) => {
                        const log = {
                            buildId: streamId,
                            level: 'error',
                            message: data.toString(),
                            timestamp: Date.now(),
                        };
                        this.emit('build-log', log);
                    });
                    stream.on('close', (code) => {
                        this.activeStreams.delete(streamId);
                        this.activeStreams.delete(`${streamId}-gzip`);
                        if (code === 0) {
                            // Emit a final progress update with exact totals and 100% completion.
                            const elapsed = (Date.now() - startTime) / 1000;
                            const speed = elapsed > 0 ? bytesTransferred / elapsed : 0;
                            const finalProgress = {
                                streamId,
                                bytesTransferred,
                                totalBytes: bytesTransferred,
                                speed,
                                eta: 0,
                                percentage: 100,
                            };
                            this.emit('upload-progress', finalProgress);
                            resolve({ success: true });
                        }
                        else {
                            resolve({
                                success: false,
                                error: `Remote docker load failed with code ${code}. Output: ${remoteOutput}`,
                            });
                        }
                    });
                });
                dockerSave.on('error', (error) => {
                    this.activeStreams.delete(streamId);
                    this.activeStreams.delete(`${streamId}-gzip`);
                    if (gzipProc)
                        gzipProc.kill();
                    resolve({ success: false, error: error.message });
                });
                dockerSave.stderr.on('data', (data) => {
                    const log = {
                        buildId: streamId,
                        level: 'error',
                        message: data.toString(),
                        timestamp: Date.now(),
                    };
                    this.emit('build-log', log);
                });
            }
            catch (error) {
                this.activeStreams.delete(streamId);
                resolve({ success: false, error: error.message });
            }
        });
    }
    /**
     * Cancel an active build
     */
    cancelBuild(buildId) {
        const proc = this.activeBuilds.get(buildId);
        if (proc) {
            proc.kill('SIGTERM');
            this.activeBuilds.delete(buildId);
            return true;
        }
        return false;
    }
    /**
     * Cancel an active stream
     */
    cancelStream(streamId) {
        const proc = this.activeStreams.get(streamId);
        const gzipProc = this.activeStreams.get(`${streamId}-gzip`);
        if (proc) {
            proc.kill('SIGTERM');
            this.activeStreams.delete(streamId);
        }
        if (gzipProc) {
            gzipProc.kill('SIGTERM');
            this.activeStreams.delete(`${streamId}-gzip`);
        }
        return !!proc || !!gzipProc;
    }
    /**
     * Clean up local Docker image
     */
    async cleanupLocalImage(imageName, imageTag) {
        try {
            await this.executeCommand('docker', ['rmi', `${imageName}:${imageTag}`]);
        }
        catch (error) {
            // Ignore errors if image doesn't exist or is in use
            console.warn(`[LocalDockerService] Failed to cleanup image ${imageName}:${imageTag}:`, error.message);
        }
    }
    /**
     * Get local image size
     */
    async getImageSize(imageName, imageTag) {
        const output = await this.executeCommand('docker', [
            'image', 'inspect', `${imageName}:${imageTag}`,
            '--format', '{{.Size}}'
        ]);
        return parseInt(output.trim(), 10);
    }
    /**
     * Save build record to database
     */
    saveBuildRecord(record) {
        const now = new Date().toISOString();
        // Using db directly from import
        db_1.db.prepare(`
      INSERT INTO local_builds (
        id, deployment_id, server_id, app_name, project_path,
        image_name, image_tag, image_size,
        build_started_at, build_completed_at, build_duration,
        upload_started_at, upload_completed_at, upload_duration,
        status, error_message, dockerfile_generated, dockerfile_path,
        platform, build_args, use_compression, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).run(record.id, record.deploymentId || null, record.serverId, record.appName, record.projectPath, record.imageName, record.imageTag, record.imageSize || null, record.buildStartedAt || null, record.buildCompletedAt || null, record.buildDuration || null, record.uploadStartedAt || null, record.uploadCompletedAt || null, record.uploadDuration || null, record.status, record.errorMessage || null, record.dockerfileGenerated ? 1 : 0, record.dockerfilePath || null, record.platform, record.buildArgs ? JSON.stringify(record.buildArgs) : null, record.useCompression ? 1 : 0, now, now);
    }
    /**
     * Update build record status
     */
    updateBuildRecord(id, updates) {
        // Using db directly from import
        const now = new Date().toISOString();
        const setClauses = ['updated_at = ?'];
        const values = [now];
        if (updates.status !== undefined) {
            setClauses.push('status = ?');
            values.push(updates.status);
        }
        if (updates.errorMessage !== undefined) {
            setClauses.push('error_message = ?');
            values.push(updates.errorMessage);
        }
        if (updates.buildStartedAt !== undefined) {
            setClauses.push('build_started_at = ?');
            values.push(updates.buildStartedAt);
        }
        if (updates.buildCompletedAt !== undefined) {
            setClauses.push('build_completed_at = ?');
            values.push(updates.buildCompletedAt);
        }
        if (updates.buildDuration !== undefined) {
            setClauses.push('build_duration = ?');
            values.push(updates.buildDuration);
        }
        if (updates.uploadStartedAt !== undefined) {
            setClauses.push('upload_started_at = ?');
            values.push(updates.uploadStartedAt);
        }
        if (updates.uploadCompletedAt !== undefined) {
            setClauses.push('upload_completed_at = ?');
            values.push(updates.uploadCompletedAt);
        }
        if (updates.uploadDuration !== undefined) {
            setClauses.push('upload_duration = ?');
            values.push(updates.uploadDuration);
        }
        if (updates.imageSize !== undefined) {
            setClauses.push('image_size = ?');
            values.push(updates.imageSize);
        }
        values.push(id);
        db_1.db.prepare(`UPDATE local_builds SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    }
    /**
     * Get build records
     */
    getBuildRecords(serverId, limit = 20) {
        // Using db directly from import
        let query = 'SELECT * FROM local_builds';
        const params = [];
        if (serverId) {
            query += ' WHERE server_id = ?';
            params.push(serverId);
        }
        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        const rows = db_1.db.prepare(query).all(...params);
        return rows.map(row => ({
            id: row.id,
            deploymentId: row.deployment_id,
            serverId: row.server_id,
            appName: row.app_name,
            projectPath: row.project_path,
            imageName: row.image_name,
            imageTag: row.image_tag,
            imageSize: row.image_size,
            buildStartedAt: row.build_started_at,
            buildCompletedAt: row.build_completed_at,
            buildDuration: row.build_duration,
            uploadStartedAt: row.upload_started_at,
            uploadCompletedAt: row.upload_completed_at,
            uploadDuration: row.upload_duration,
            status: row.status,
            errorMessage: row.error_message,
            dockerfileGenerated: !!row.dockerfile_generated,
            dockerfilePath: row.dockerfile_path,
            platform: row.platform,
            buildArgs: row.build_args ? JSON.parse(row.build_args) : undefined,
            useCompression: !!row.use_compression,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }
    /**
     * Execute a command and return stdout
     */
    executeCommand(command, args) {
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(command, args, { env: getDockerEnv() });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (data) => { stdout += data; });
            proc.stderr.on('data', (data) => { stderr += data; });
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                }
                else {
                    const error = new Error(stderr || `Command failed with code ${code}`);
                    error.code = code;
                    reject(error);
                }
            });
            proc.on('error', reject);
        });
    }
    /**
     * Calculate directory size
     */
    async getDirectorySize(dirPath) {
        let size = 0;
        const walkDir = async (dir) => {
            const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path_1.default.join(dir, entry.name);
                try {
                    if (entry.isDirectory()) {
                        await walkDir(fullPath);
                    }
                    else if (entry.isFile()) {
                        const stats = fs_1.default.statSync(fullPath);
                        size += stats.size;
                    }
                }
                catch {
                    // Skip files we can't access
                }
            }
        };
        await walkDir(dirPath);
        return size;
    }
    /**
     * Calculate build context size (respecting .dockerignore would be ideal but simplified here)
     */
    async calculateContextSize(projectPath, _hasDockerignore) {
        let totalSize = 0;
        let fileCount = 0;
        // Directories to always skip
        const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', 'venv', '.venv']);
        const walkDir = (dir) => {
            const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path_1.default.join(dir, entry.name);
                try {
                    if (entry.isDirectory()) {
                        if (!skipDirs.has(entry.name)) {
                            walkDir(fullPath);
                        }
                    }
                    else if (entry.isFile()) {
                        const stats = fs_1.default.statSync(fullPath);
                        totalSize += stats.size;
                        fileCount++;
                    }
                }
                catch {
                    // Skip files we can't access
                }
            }
        };
        walkDir(projectPath);
        return { totalSize, fileCount };
    }
    /**
     * Format bytes to human readable
     */
    formatBytes(bytes) {
        if (bytes === 0)
            return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}
exports.LocalDockerService = LocalDockerService;
exports.localDockerService = new LocalDockerService();
//# sourceMappingURL=LocalDockerService.js.map