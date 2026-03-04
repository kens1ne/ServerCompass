"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sshService = exports.SSHService = void 0;
const ssh2_1 = require("ssh2");
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const db_1 = require("../db");
const CredentialVault_1 = require("./CredentialVault");
const LicenseService_1 = require("./LicenseService");
const sshErrorLogger_1 = require("../utils/sshErrorLogger");
const DEV_COMMAND_LOGGING_ENABLED = process.env.NODE_ENV === 'development';
let devCommandLogPath = null;
let announcedDevCommandLogLocation = false;
const REDACTION_PLACEHOLDER = '[REDACTED]';
const redactSensitiveText = (input) => {
    if (!input)
        return input;
    // SECURITY: this is a best-effort scrubber for dev SSH command logs + persisted command logs.
    // It's designed to prevent accidental logging of secrets like API keys, passwords, and webhook URLs.
    let output = input;
    // Redact common JSON secrets (single-line string values).
    output = output.replace(/("(?:(?:api[_-]?key)|token|secret|password|smtp[_-]?password|webhook[_-]?url|url)"\s*:\s*)"[^"]*"/gi, `$1"${REDACTION_PLACEHOLDER}"`);
    // Redact env var assignments (quoted and unquoted).
    output = output.replace(/\b((?:PASSWORD|PASS|TOKEN|SECRET|API_KEY|APIKEY)\s*=\s*)(["'])(.*?)\2/gi, `$1$2${REDACTION_PLACEHOLDER}$2`);
    output = output.replace(/\b((?:PASSWORD|PASS|TOKEN|SECRET|API_KEY|APIKEY)\s*=\s*)([^\s'"]+)/gi, `$1${REDACTION_PLACEHOLDER}`);
    // Redact basic auth / user:pass patterns.
    output = output.replace(/(\s(?:--user|-u)\s+["']?[^:"'\s]+:)[^"'\s]+/gi, `$1${REDACTION_PLACEHOLDER}`);
    output = output.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s\/]+:)[^@\s\/]+@/gi, `$1${REDACTION_PLACEHOLDER}@`);
    return output;
};
const resolveDevCommandLogPath = () => {
    if (!DEV_COMMAND_LOGGING_ENABLED) {
        return null;
    }
    if (devCommandLogPath) {
        return devCommandLogPath;
    }
    try {
        const logDir = path_1.default.join(process.cwd(), 'servercompass-logs', 'logs');
        fs_1.default.mkdirSync(logDir, { recursive: true });
        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        devCommandLogPath = path_1.default.join(logDir, `ssh-commands-${safeTimestamp}.log`);
        if (!announcedDevCommandLogLocation) {
            console.info(`[SSHService] Development SSH command log: ${devCommandLogPath}`);
            announcedDevCommandLogLocation = true;
        }
    }
    catch (error) {
        console.warn('[SSHService] Failed to prepare development SSH command log file:', error);
        devCommandLogPath = null;
    }
    return devCommandLogPath;
};
const writeDevCommandLog = (entry) => {
    if (!DEV_COMMAND_LOGGING_ENABLED) {
        return;
    }
    const logFilePath = resolveDevCommandLogPath();
    if (!logFilePath) {
        return;
    }
    const record = {
        timestamp: new Date().toISOString(),
        ...entry,
    };
    fs_1.default.promises
        .appendFile(logFilePath, `${JSON.stringify(record)}\n`)
        .catch((error) => {
        console.warn('[SSHService] Failed to write to development SSH command log:', error);
    });
};
class SSHService extends events_1.EventEmitter {
    connections = new Map();
    homeDirectories = new Map();
    vault;
    constructor() {
        super();
        this.vault = new CredentialVault_1.CredentialVault();
    }
    /**
     * Get an existing SSH connection without creating a new one.
     * Used by the tunnel feature to access the raw ssh2 Client.
     */
    getConnection(serverId) {
        return this.connections.get(serverId);
    }
    /**
     * Get or create an SSH connection for a server
     */
    async connect(serverId) {
        // Return existing connection if available
        if (this.connections.has(serverId)) {
            const client = this.connections.get(serverId);
            // Check if connection is still alive
            try {
                await this.executeCommand(client, 'echo "ping"');
                return client;
            }
            catch (error) {
                // Connection is dead, remove it
                this.connections.delete(serverId);
            }
        }
        // Create new connection
        const server = db_1.queries.getServerById(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        const client = await this.createConnection(server);
        this.connections.set(serverId, client);
        // Get and cache home directory if not already cached
        if (!this.homeDirectories.has(serverId)) {
            try {
                const result = await this.executeCommand(client, 'echo $HOME');
                const homeDir = result.stdout.trim();
                if (homeDir) {
                    this.homeDirectories.set(serverId, homeDir);
                }
            }
            catch (error) {
                console.warn(`Failed to get home directory for ${serverId}:`, error);
            }
        }
        // Update last check-in
        db_1.queries.updateServer(serverId, {
            last_check_in: Date.now(),
            status: 'ready',
        });
        return client;
    }
    async getHomeDirectory(serverId) {
        if (!this.homeDirectories.has(serverId)) {
            try {
                const client = await this.connect(serverId);
                const result = await this.executeCommand(client, 'echo $HOME');
                const homeDir = result.stdout.trim();
                if (homeDir) {
                    this.homeDirectories.set(serverId, homeDir);
                }
            }
            catch (error) {
                console.warn(`[SSHService] Failed to resolve home directory for server ${serverId}:`, error);
                return null;
            }
        }
        return this.homeDirectories.get(serverId) ?? null;
    }
    /**
     * Scan the local ~/.ssh directory for private keys that might be used with a VPS.
     * Excludes public keys, known config files, and encrypted keys that cannot be read without passphrase.
     */
    listLocalKeys() {
        const sshDir = path_1.default.join(os_1.default.homedir(), '.ssh');
        let entries = [];
        try {
            entries = fs_1.default.readdirSync(sshDir, { withFileTypes: true });
        }
        catch (error) {
            console.warn('Unable to read ~/.ssh directory:', error);
            return [];
        }
        const privateKeyCandidates = entries.filter((entry) => {
            if (!entry.isFile()) {
                return false;
            }
            const filename = entry.name;
            // Skip obvious non-private-key files
            if (filename.endsWith('.pub') ||
                filename.endsWith('.cfg') ||
                filename.endsWith('.conf') ||
                filename === 'known_hosts' ||
                filename === 'config' ||
                filename === 'authorized_keys' ||
                filename.startsWith('.') // excludes .DS_Store etc.
            ) {
                return false;
            }
            return true;
        });
        return privateKeyCandidates.map((entry) => {
            const fullPath = path_1.default.join(sshDir, entry.name);
            let fingerprint;
            try {
                const keyContent = fs_1.default.readFileSync(fullPath, 'utf-8');
                // Heuristic check: if file contains "PRIVATE KEY"
                if (!/PRIVATE KEY/.test(keyContent)) {
                    return {
                        name: entry.name,
                        path: fullPath,
                    };
                }
                // Try deriving a fingerprint using ssh-keygen if available
                try {
                    const output = (0, child_process_1.execSync)(`ssh-keygen -lf "${fullPath}"`, { encoding: 'utf-8' });
                    fingerprint = output.split(' ')[1];
                }
                catch (fingerprintError) {
                    // Fingerprint generation is best-effort; ignore failures
                    console.warn(`Failed to derive fingerprint for ${fullPath}:`, fingerprintError);
                }
                return {
                    name: entry.name,
                    path: fullPath,
                    fingerprint,
                };
            }
            catch (readError) {
                console.warn(`Unable to read SSH key ${fullPath}:`, readError);
                return {
                    name: entry.name,
                    path: fullPath,
                };
            }
        });
    }
    /**
     * Progressive key scanner that scans common locations and emits progress events.
     * Scans ~/.ssh by default, plus any additional paths provided.
     */
    async listLocalKeysProgressive(onProgress, additionalPaths) {
        const homeDir = os_1.default.homedir();
        const allKeys = [];
        const foundKeyPaths = new Set();
        // Define scan locations - ~/.ssh plus any custom additional paths
        const scanLocations = [
            { path: path_1.default.join(homeDir, '.ssh'), label: '~/.ssh' },
        ];
        // Add any additional custom paths
        if (additionalPaths && additionalPaths.length > 0) {
            for (const customPath of additionalPaths) {
                // Normalize and create label from the path
                const normalizedPath = customPath.startsWith('~')
                    ? path_1.default.join(homeDir, customPath.slice(1))
                    : customPath;
                const label = customPath.startsWith(homeDir)
                    ? customPath.replace(homeDir, '~')
                    : customPath;
                scanLocations.push({ path: normalizedPath, label });
            }
        }
        const completedLocations = [];
        for (let i = 0; i < scanLocations.length; i++) {
            const { path: scanPath, label } = scanLocations[i];
            // Check if directory exists before scanning
            if (!fs_1.default.existsSync(scanPath)) {
                console.debug(`Skipping ${label}: directory does not exist`);
                completedLocations.push(label);
                // Emit progress for skipped location
                onProgress({
                    currentLocation: label,
                    foundKeys: [...allKeys],
                    completedLocations: [...completedLocations],
                    totalLocations: scanLocations.length,
                    isComplete: i === scanLocations.length - 1,
                });
                continue;
            }
            try {
                const keysInLocation = await this.scanDirectoryForKeys(scanPath, foundKeyPaths);
                // Add newly found keys
                for (const key of keysInLocation) {
                    if (!foundKeyPaths.has(key.path)) {
                        allKeys.push(key);
                        foundKeyPaths.add(key.path);
                    }
                }
                completedLocations.push(label);
                // Emit progress
                onProgress({
                    currentLocation: label,
                    foundKeys: [...allKeys],
                    completedLocations: [...completedLocations],
                    totalLocations: scanLocations.length,
                    isComplete: i === scanLocations.length - 1,
                });
            }
            catch (error) {
                console.warn(`Failed to scan ${label}:`, error);
                completedLocations.push(label);
                // Still emit progress even if this location failed
                onProgress({
                    currentLocation: label,
                    foundKeys: [...allKeys],
                    completedLocations: [...completedLocations],
                    totalLocations: scanLocations.length,
                    isComplete: i === scanLocations.length - 1,
                });
            }
        }
        return allKeys;
    }
    /**
     * Recursively scan a directory for SSH private keys
     */
    async scanDirectoryForKeys(dirPath, excludePaths = new Set(), maxDepth = 3, currentDepth = 0) {
        const keys = [];
        if (currentDepth > maxDepth) {
            return keys;
        }
        try {
            const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path_1.default.join(dirPath, entry.name);
                // Skip if already found
                if (excludePaths.has(fullPath)) {
                    continue;
                }
                // Skip common directories that won't contain keys
                const skipDirs = [
                    'node_modules',
                    '.git',
                    '.cache',
                    'Library',
                    'Applications',
                    '.npm',
                    '.Trash',
                    'Music',
                    'Movies',
                    'Pictures',
                    'Public',
                    '.vscode',
                    '.idea',
                ];
                if (entry.isDirectory()) {
                    // Skip directories we don't want to scan
                    if (skipDirs.includes(entry.name) || entry.name.startsWith('.')) {
                        continue;
                    }
                    // Recursively scan subdirectories
                    const subKeys = await this.scanDirectoryForKeys(fullPath, excludePaths, maxDepth, currentDepth + 1);
                    keys.push(...subKeys);
                }
                else if (entry.isFile()) {
                    // Check if this might be a private key
                    if (this.isPotentialPrivateKey(entry.name, fullPath)) {
                        const keyInfo = this.extractKeyInfo(entry.name, fullPath);
                        if (keyInfo) {
                            keys.push(keyInfo);
                        }
                    }
                }
            }
        }
        catch (error) {
            // Silently skip directories we can't read (permission errors, non-existent directories, etc.)
            // Only log if it's not a common ENOENT error
            if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
                console.debug(`Cannot read directory ${dirPath}:`, error);
            }
        }
        return keys;
    }
    /**
     * Check if a file might be a private key based on name and content
     */
    isPotentialPrivateKey(filename, fullPath) {
        // Skip obvious non-private-key files
        if (filename.endsWith('.pub') ||
            filename.endsWith('.cfg') ||
            filename.endsWith('.conf') ||
            filename.endsWith('.txt') ||
            filename.endsWith('.md') ||
            filename.endsWith('.json') ||
            filename === 'known_hosts' ||
            filename === 'config' ||
            filename === 'authorized_keys' ||
            filename.startsWith('.')) {
            return false;
        }
        // Check file size (private keys are typically < 10KB)
        try {
            const stats = fs_1.default.statSync(fullPath);
            if (stats.size > 10 * 1024) {
                return false;
            }
        }
        catch {
            return false;
        }
        return true;
    }
    /**
     * Extract key information from a file
     */
    extractKeyInfo(filename, fullPath) {
        try {
            const keyContent = fs_1.default.readFileSync(fullPath, 'utf-8');
            // Check if file contains "PRIVATE KEY"
            if (!/PRIVATE KEY/.test(keyContent)) {
                return null;
            }
            let fingerprint;
            // Try deriving a fingerprint using ssh-keygen if available
            try {
                const output = (0, child_process_1.execSync)(`ssh-keygen -lf "${fullPath}"`, { encoding: 'utf-8' });
                fingerprint = output.split(' ')[1];
            }
            catch {
                // Fingerprint generation is best-effort; ignore failures
            }
            return {
                name: filename,
                path: fullPath,
                fingerprint,
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Read a private key from disk after validating it lives inside the user's home directory.
     */
    readLocalKey(keyPath) {
        const homeDir = path_1.default.resolve(os_1.default.homedir());
        const normalized = path_1.default.resolve(keyPath);
        // Security: only allow reading files within the user's home directory
        const withinHomeDir = normalized === homeDir || normalized.startsWith(`${homeDir}${path_1.default.sep}`);
        if (!withinHomeDir) {
            throw new Error('Access denied: key must live inside your home directory');
        }
        try {
            return fs_1.default.readFileSync(normalized, 'utf-8');
        }
        catch (error) {
            console.error(`Failed to read SSH key at ${normalized}:`, error);
            throw new Error('Unable to read the selected SSH key file.');
        }
    }
    /**
     * Create a new SSH connection
     */
    async createConnection(server) {
        return new Promise(async (resolve, reject) => {
            const client = new ssh2_1.Client();
            // Decrypt credentials
            const secret = await this.vault.decrypt(server.encrypted_secret);
            const config = {
                host: server.host,
                port: server.port,
                username: server.username,
                readyTimeout: 30000,
            };
            if (server.auth_type === 'password') {
                config.password = secret;
            }
            else {
                config.privateKey = secret;
            }
            let resolved = false;
            client
                .on('ready', () => {
                resolved = true;
                console.log(`SSH connection established to ${server.host}`);
                resolve(client);
            })
                .on('error', (err) => {
                if (!resolved) {
                    // Connection failed during setup — reject the promise
                    if (err instanceof Error) {
                        (0, sshErrorLogger_1.logSSHErrorCompact)(err, {
                            operation: 'connect',
                            serverId: server.id,
                            serverHost: server.host,
                        });
                    }
                    else {
                        console.error(`[SSH] Connection error for ${server.host}:`, err);
                    }
                    reject(err);
                }
                else {
                    // Post-connection error (e.g. ECONNRESET) — clean up gracefully
                    console.warn(`[SSH] Connection lost for ${server.host}: ${err.message}`);
                    this.connections.delete(server.id);
                    this.homeDirectories.delete(server.id);
                }
            })
                .on('end', () => {
                console.log(`SSH connection ended for ${server.host}`);
                this.connections.delete(server.id);
            })
                .connect(config);
        });
    }
    /**
     * Test SSH connection without saving
     */
    async testConnection(config) {
        return new Promise((resolve) => {
            const client = new ssh2_1.Client();
            const sshConfig = {
                host: config.host,
                port: config.port,
                username: config.username,
                readyTimeout: 10000,
            };
            if (config.password) {
                sshConfig.password = config.password;
            }
            else if (config.privateKey) {
                sshConfig.privateKey = config.privateKey;
            }
            client
                .on('ready', () => {
                client.end();
                resolve(true);
            })
                .on('error', () => {
                resolve(false);
            })
                .connect(sshConfig);
        });
    }
    /**
     * Execute a command on a server
     */
    async executeCommand(clientOrServerId, command) {
        const serverId = typeof clientOrServerId === 'string' ? clientOrServerId : null;
        const client = typeof clientOrServerId === 'string'
            ? await this.connect(clientOrServerId)
            : clientOrServerId;
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const sanitizedCommand = redactSensitiveText(command);
            writeDevCommandLog({
                stage: 'start',
                type: 'executeCommand',
                command: sanitizedCommand,
                serverId,
            });
            client.exec(command, (err, stream) => {
                if (err) {
                    writeDevCommandLog({
                        stage: 'error',
                        type: 'executeCommand',
                        command: sanitizedCommand,
                        serverId,
                        error: err instanceof Error ? err.message : String(err),
                        durationMs: Date.now() - startedAt,
                    });
                    reject(err);
                    return;
                }
                let stdout = '';
                let stderr = '';
                stream
                    .on('close', (code) => {
                    const stdoutTrimmed = stdout.trim();
                    const stderrTrimmed = stderr.trim();
                    // Resolve immediately to avoid blocking
                    resolve({
                        stdout: stdoutTrimmed,
                        stderr: stderrTrimmed,
                        exitCode: code,
                    });
                    writeDevCommandLog({
                        stage: 'complete',
                        type: 'executeCommand',
                        command: sanitizedCommand,
                        serverId,
                        exitCode: code,
                        stdout: redactSensitiveText(stdoutTrimmed),
                        stderr: redactSensitiveText(stderrTrimmed),
                        durationMs: Date.now() - startedAt,
                    });
                    // Save command to database in background if we have a serverId
                    if (serverId) {
                        const sanitizedStdout = redactSensitiveText(stdoutTrimmed);
                        const sanitizedStderr = redactSensitiveText(stderrTrimmed);
                        setImmediate(() => {
                            try {
                                db_1.queries.createCommand({
                                    id: (0, crypto_1.randomUUID)(),
                                    server_id: serverId,
                                    command: sanitizedCommand,
                                    executed_at: Date.now(),
                                    exit_code: code,
                                    stdout: sanitizedStdout || null,
                                    stderr: sanitizedStderr || null,
                                });
                                // Enforce trial command log limits
                                LicenseService_1.licenseService.enforceCommandLogLimit(serverId);
                                // Check and cleanup old logs if needed
                                this.cleanupLogsIfNeeded(serverId);
                            }
                            catch (error) {
                                console.error('[SSHService] Failed to save command to database:', error);
                            }
                        });
                    }
                })
                    .on('data', (data) => {
                    stdout += data.toString();
                })
                    .stderr.on('data', (data) => {
                    stderr += data.toString();
                });
            });
        });
    }
    /**
     * Execute a command and stream output
     */
    async executeCommandStreaming(serverId, command, onData) {
        const client = await this.connect(serverId);
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const sanitizedCommand = redactSensitiveText(command);
            writeDevCommandLog({
                stage: 'start',
                type: 'executeCommandStreaming',
                command: sanitizedCommand,
                serverId,
            });
            client.exec(command, (err, stream) => {
                if (err) {
                    writeDevCommandLog({
                        stage: 'error',
                        type: 'executeCommandStreaming',
                        command: sanitizedCommand,
                        serverId,
                        error: err instanceof Error ? err.message : String(err),
                        durationMs: Date.now() - startedAt,
                    });
                    reject(err);
                    return;
                }
                const stdoutChunks = [];
                const stderrChunks = [];
                stream
                    .on('close', (code) => {
                    const stdout = stdoutChunks.join('');
                    const stderr = stderrChunks.join('');
                    writeDevCommandLog({
                        stage: 'complete',
                        type: 'executeCommandStreaming',
                        command: sanitizedCommand,
                        serverId,
                        exitCode: code,
                        stdout: redactSensitiveText(stdout.trim()),
                        stderr: redactSensitiveText(stderr.trim()),
                        durationMs: Date.now() - startedAt,
                    });
                    resolve(code);
                })
                    .on('data', (data) => {
                    const chunk = data.toString();
                    stdoutChunks.push(chunk);
                    onData(chunk, false);
                })
                    .stderr.on('data', (data) => {
                    const chunk = data.toString();
                    stderrChunks.push(chunk);
                    onData(chunk, true);
                });
            });
        });
    }
    /**
     * Expand tilde (~) in remote path to actual home directory
     */
    expandRemotePath(serverId, remotePath) {
        if (!remotePath.startsWith('~')) {
            return remotePath;
        }
        const homeDir = this.homeDirectories.get(serverId);
        if (!homeDir) {
            // Fallback: return as-is if home directory not cached
            console.warn(`Home directory not cached for ${serverId}, using path as-is`);
            return remotePath;
        }
        // Replace ~ with actual home directory
        if (remotePath === '~') {
            return homeDir;
        }
        else if (remotePath.startsWith('~/')) {
            return homeDir + remotePath.substring(1);
        }
        return remotePath;
    }
    /**
     * Upload a file via SFTP
     */
    async uploadFile(serverId, localPath, remotePath, onProgress) {
        const client = await this.connect(serverId);
        // Expand tilde if present (synchronous now)
        const expandedPath = this.expandRemotePath(serverId, remotePath);
        return new Promise((resolve, reject) => {
            client.sftp(async (err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    // Ensure the remote directory exists
                    const remoteDir = path_1.default.posix.dirname(expandedPath);
                    await this.createRemoteDirectory(sftp, remoteDir);
                    const stats = fs_1.default.statSync(localPath);
                    const totalSize = stats.size;
                    sftp.fastPut(localPath, expandedPath, {
                        step: (transferred) => {
                            if (onProgress) {
                                onProgress(transferred, totalSize);
                            }
                        }
                    }, (err) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve();
                        }
                    });
                }
                catch (error) {
                    reject(error);
                }
            });
        });
    }
    /**
     * Upload a folder recursively via SFTP
     */
    async uploadFolder(serverId, localPath, remotePath, onProgress, options) {
        const client = await this.connect(serverId);
        // Expand tilde if present (synchronous now)
        const expandedPath = this.expandRemotePath(serverId, remotePath);
        // Directories to exclude from upload
        const defaultExcludedDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.vscode', '.idea'];
        const excludedDirs = options?.excludeDirs ?? defaultExcludedDirs;
        const includeHidden = options?.includeHidden ?? true;
        // Get all files in the folder recursively
        const getAllFiles = (dirPath, arrayOfFiles = []) => {
            const files = fs_1.default.readdirSync(dirPath);
            files.forEach((file) => {
                const fullPath = path_1.default.join(dirPath, file);
                // Skip hidden files/dirs if includeHidden is false (but never skip explicitly non-excluded ones)
                if (!includeHidden && file.startsWith('.') && !excludedDirs.includes(file)) {
                    console.log(`[SSHService] Skipping hidden: ${file}`);
                    return;
                }
                if (fs_1.default.statSync(fullPath).isDirectory()) {
                    // Skip excluded directories
                    if (excludedDirs.includes(file)) {
                        console.log(`[SSHService] Skipping excluded directory: ${file}`);
                        return;
                    }
                    arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
                }
                else {
                    arrayOfFiles.push(fullPath);
                }
            });
            return arrayOfFiles;
        };
        const allFiles = getAllFiles(localPath);
        let uploadedCount = 0;
        return new Promise((resolve, reject) => {
            client.sftp(async (err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }
                try {
                    // Create remote directory structure and upload files
                    for (const localFilePath of allFiles) {
                        const relativePath = path_1.default.relative(localPath, localFilePath);
                        const remoteFilePath = path_1.default.posix.join(expandedPath, relativePath.split(path_1.default.sep).join('/'));
                        const remoteDir = path_1.default.posix.dirname(remoteFilePath);
                        // Create remote directory if it doesn't exist
                        await this.createRemoteDirectory(sftp, remoteDir);
                        // Upload file
                        await new Promise((resolveFile, rejectFile) => {
                            sftp.fastPut(localFilePath, remoteFilePath, (err) => {
                                if (err) {
                                    rejectFile(err);
                                }
                                else {
                                    uploadedCount++;
                                    if (onProgress) {
                                        onProgress(relativePath, uploadedCount, allFiles.length);
                                    }
                                    resolveFile();
                                }
                            });
                        });
                    }
                    resolve();
                }
                catch (error) {
                    reject(error);
                }
            });
        });
    }
    /**
     * Create a remote directory recursively via SFTP
     */
    createRemoteDirectory(sftp, remotePath) {
        return new Promise((resolve, reject) => {
            sftp.stat(remotePath, (err) => {
                if (!err) {
                    // Directory exists
                    resolve();
                    return;
                }
                // Directory doesn't exist, create it
                const parts = remotePath.split('/').filter(Boolean);
                let currentPath = '';
                const createNext = (index) => {
                    if (index >= parts.length) {
                        resolve();
                        return;
                    }
                    currentPath += '/' + parts[index];
                    sftp.stat(currentPath, (err) => {
                        if (!err) {
                            // Directory exists, move to next
                            createNext(index + 1);
                        }
                        else {
                            // Create directory
                            sftp.mkdir(currentPath, (err) => {
                                if (err) {
                                    reject(err);
                                }
                                else {
                                    createNext(index + 1);
                                }
                            });
                        }
                    });
                };
                createNext(0);
            });
        });
    }
    /**
     * Download a file via SFTP
     */
    async downloadFile(serverId, remotePath, localPath, onProgress) {
        const client = await this.connect(serverId);
        return new Promise((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }
                // Get file size first for progress tracking
                sftp.stat(remotePath, (statErr, stats) => {
                    if (statErr) {
                        reject(statErr);
                        return;
                    }
                    const totalSize = stats.size;
                    sftp.fastGet(remotePath, localPath, {
                        step: (transferred) => {
                            if (onProgress) {
                                onProgress(transferred, totalSize);
                            }
                        }
                    }, (err) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve();
                        }
                    });
                });
            });
        });
    }
    /**
     * Close a specific connection
     */
    disconnect(serverId) {
        const client = this.connections.get(serverId);
        if (client) {
            client.end();
            this.connections.delete(serverId);
            this.homeDirectories.delete(serverId);
        }
    }
    /**
     * Close all connections
     */
    disconnectAll() {
        for (const client of this.connections.values()) {
            client.end();
        }
        this.connections.clear();
        this.homeDirectories.clear();
    }
    /**
     * Clean up old logs if size exceeds limit
     */
    cleanupLogsIfNeeded(serverId) {
        try {
            // Get max log size setting (in MB)
            const setting = db_1.queries.getSetting('max_log_size_mb');
            const maxSizeMB = setting ? parseInt(setting.value, 10) : 50;
            const maxSizeBytes = maxSizeMB * 1024 * 1024;
            // Get current size for this server
            const currentSize = db_1.queries.getCommandsSize(serverId);
            if (currentSize > maxSizeBytes) {
                // Calculate how many commands to delete (delete 20% of old commands)
                const commands = db_1.queries.getCommandsByServer(serverId, 999999);
                const deleteCount = Math.ceil(commands.length * 0.2);
                if (deleteCount > 0) {
                    db_1.queries.deleteOldestCommands(serverId, deleteCount);
                    console.log(`[SSHService] Cleaned up ${deleteCount} old command logs for server ${serverId}`);
                }
            }
        }
        catch (error) {
            console.error('[SSHService] Failed to cleanup logs:', error);
        }
    }
}
exports.SSHService = SSHService;
exports.sshService = new SSHService();
//# sourceMappingURL=SSHService.js.map