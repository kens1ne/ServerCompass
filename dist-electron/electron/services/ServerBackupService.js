"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serverBackupService = exports.ServerBackupService = void 0;
const events_1 = require("events");
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const SSHService_1 = require("./SSHService");
const S3UploadService_1 = require("./S3UploadService");
const SecureStorageService_1 = require("./SecureStorageService");
const CredentialVault_1 = require("./CredentialVault");
const db_1 = require("../db");
const types_1 = require("../ipc/types");
// Shell escape helper - prevents command injection
const shEscape = (v) => `'${v.replace(/'/g, "'\\''")}'`;
/**
 * ServerBackupService handles backup of server data to S3.
 *
 * Backed up items:
 * - Docker volumes (tar.gz compressed)
 * - Databases (pg_dump / mysqldump)
 * - Docker compose files
 * - Environment files (.env) - encrypted with backup passphrase
 * - SSL certificates
 * - Cron jobs
 */
class ServerBackupService extends events_1.EventEmitter {
    secureStorage;
    vault;
    activeJobs = new Map();
    algorithm = 'aes-256-gcm';
    ivLength = 16;
    constructor() {
        super();
        this.secureStorage = new SecureStorageService_1.SecureStorageService();
        this.vault = new CredentialVault_1.CredentialVault();
    }
    /**
     * Send progress update to renderer
     */
    sendProgress(progress) {
        this.emit('backup:progress', progress);
        const windows = electron_1.BrowserWindow.getAllWindows();
        for (const win of windows) {
            win.webContents.send(types_1.IPC_CHANNELS.BACKUP_PROGRESS, {
                type: 'server_backup',
                ...progress,
            });
        }
    }
    /**
     * Encrypt sensitive data with backup passphrase
     */
    async encryptWithPassphrase(data, passphrase) {
        // Use passphrase directly as key material (padded/truncated to 32 bytes)
        const keyMaterial = Buffer.alloc(32);
        Buffer.from(passphrase, 'utf8').copy(keyMaterial);
        const iv = (0, crypto_1.randomBytes)(this.ivLength);
        const cipher = (0, crypto_1.createCipheriv)(this.algorithm, keyMaterial, iv);
        const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        // Format: iv:authTag:encrypted (all base64)
        return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
    }
    /**
     * Decrypt sensitive data with backup passphrase
     */
    decryptWithPassphrase(encryptedData, passphrase) {
        // Use passphrase directly as key material (padded/truncated to 32 bytes)
        const keyMaterial = Buffer.alloc(32);
        Buffer.from(passphrase, 'utf8').copy(keyMaterial);
        // Parse format: iv:authTag:encrypted (all base64)
        const parts = encryptedData.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted data format');
        }
        const iv = Buffer.from(parts[0], 'base64');
        const authTag = Buffer.from(parts[1], 'base64');
        const encrypted = Buffer.from(parts[2], 'base64');
        const decipher = (0, crypto_1.createDecipheriv)(this.algorithm, keyMaterial, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return decrypted.toString('utf8');
    }
    /**
     * Get S3 storage config with decrypted credentials
     */
    async getStorageConfig(storageConfigId) {
        const row = db_1.db.prepare(`
      SELECT * FROM backup_storage_configs WHERE id = ?
    `).get(storageConfigId);
        if (!row)
            return null;
        const creds = JSON.parse(await this.vault.decrypt(row.encrypted_credentials));
        return {
            id: row.id,
            name: row.name,
            provider: row.provider,
            bucket: row.bucket,
            region: row.region || undefined,
            endpoint: row.endpoint || undefined,
            accessKey: creds.accessKey,
            secretKey: creds.secretKey,
            pathPrefix: row.path_prefix,
        };
    }
    /**
     * Get server info from database
     */
    getServerInfo(serverId) {
        const row = db_1.db.prepare(`SELECT name, host FROM servers WHERE id = ?`).get(serverId);
        return row || null;
    }
    /**
     * Run a server backup job
     */
    async runBackup(options) {
        const jobId = (0, crypto_1.randomUUID)();
        const jobState = { cancelled: false };
        this.activeJobs.set(jobId, jobState);
        const startTime = Date.now();
        try {
            // Get passphrase
            const passphrase = await this.secureStorage.getBackupPassphrase();
            if (!passphrase) {
                return { success: false, error: 'Backup passphrase not set' };
            }
            // Get storage config
            const storageConfig = await this.getStorageConfig(options.storageConfigId);
            if (!storageConfig) {
                return { success: false, error: 'Storage configuration not found' };
            }
            // Get server info
            const serverInfo = this.getServerInfo(options.serverId);
            if (!serverInfo) {
                return { success: false, error: 'Server not found' };
            }
            // Create job record
            const now = Date.now();
            db_1.db.prepare(`
        INSERT INTO backup_jobs (
          id, job_type, server_id, storage_config_id, storage_config_name,
          status, triggered_by, created_at, started_at
        ) VALUES (?, 'server_data', ?, ?, ?, 'running', 'manual', ?, ?)
      `).run(jobId, options.serverId, options.storageConfigId, storageConfig.name, now, now);
            this.sendProgress({
                jobId,
                phase: 'preparing',
                progress: 5,
                message: 'Preparing backup...',
            });
            // Initialize manifest
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPrefix = `${storageConfig.pathPrefix || 'servercompass-backups'}/servers/${options.serverId}/${timestamp}`;
            const manifest = {
                version: 1,
                createdAt: new Date().toISOString(),
                serverId: options.serverId,
                serverName: serverInfo.name,
                hostname: serverInfo.host,
                contents: {
                    volumes: [],
                    databases: [],
                    composeFiles: [],
                    envFiles: [],
                    sslCerts: [],
                },
                stats: {
                    totalSize: 0,
                    volumeCount: 0,
                    databaseCount: 0,
                    duration: 0,
                },
            };
            // Check if cancelled
            if (jobState.cancelled) {
                throw new Error('Backup cancelled');
            }
            // Get list of stacks to potentially stop
            let stoppedStacks = [];
            if (options.stopContainersForConsistency && options.backupVolumes) {
                stoppedStacks = await this.getRunningStacks(options.serverId, options.excludedStacks);
            }
            try {
                // Stop containers if requested
                if (stoppedStacks.length > 0) {
                    this.sendProgress({
                        jobId,
                        phase: 'preparing',
                        progress: 10,
                        message: `Stopping ${stoppedStacks.length} stacks for consistency...`,
                    });
                    await this.stopStacks(options.serverId, stoppedStacks);
                }
                // Backup volumes
                if (options.backupVolumes !== false) {
                    if (jobState.cancelled)
                        throw new Error('Backup cancelled');
                    await this.backupVolumes(options.serverId, storageConfig, backupPrefix, manifest, jobId, options.excludedVolumes || [], jobState);
                }
                // Backup databases
                if (options.backupDatabases !== false) {
                    if (jobState.cancelled)
                        throw new Error('Backup cancelled');
                    await this.backupDatabases(options.serverId, storageConfig, backupPrefix, manifest, jobId, passphrase, options.excludedDatabases || [], jobState);
                }
                // Backup compose files and env files
                if (options.backupComposeFiles !== false || options.backupEnvFiles !== false) {
                    if (jobState.cancelled)
                        throw new Error('Backup cancelled');
                    await this.backupStackConfigs(options.serverId, storageConfig, backupPrefix, manifest, jobId, passphrase, options.backupComposeFiles !== false, options.backupEnvFiles !== false, options.excludedStacks || [], jobState);
                }
                // Backup SSL certs
                if (options.backupSslCerts) {
                    if (jobState.cancelled)
                        throw new Error('Backup cancelled');
                    await this.backupSslCerts(options.serverId, storageConfig, backupPrefix, manifest, jobId, jobState);
                }
                // Backup cron jobs
                if (options.backupCronJobs) {
                    if (jobState.cancelled)
                        throw new Error('Backup cancelled');
                    await this.backupCronJobs(options.serverId, storageConfig, backupPrefix, manifest, jobId, jobState);
                }
            }
            finally {
                // Restart stopped containers
                if (stoppedStacks.length > 0) {
                    this.sendProgress({
                        jobId,
                        phase: 'cleanup',
                        progress: 90,
                        message: 'Restarting stopped stacks...',
                    });
                    await this.startStacks(options.serverId, stoppedStacks);
                }
            }
            // Finalize manifest
            manifest.stats.duration = Date.now() - startTime;
            manifest.stats.volumeCount = manifest.contents.volumes.length;
            manifest.stats.databaseCount = manifest.contents.databases.length;
            // Upload manifest
            this.sendProgress({
                jobId,
                phase: 'uploading',
                progress: 95,
                message: 'Uploading backup manifest...',
            });
            const manifestKey = `${backupPrefix}/manifest.json`;
            const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
            const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, manifestBuffer, manifestKey, { contentType: 'application/json' });
            if (!uploadResult.success) {
                throw new Error(`Failed to upload manifest: ${uploadResult.error}`);
            }
            // Update job record
            db_1.db.prepare(`
        UPDATE backup_jobs
        SET status = 'completed', completed_at = ?, s3_key = ?, file_size = ?,
            metadata = ?
        WHERE id = ?
      `).run(Date.now(), manifestKey, manifest.stats.totalSize, JSON.stringify({
                volumeCount: manifest.stats.volumeCount,
                databaseCount: manifest.stats.databaseCount,
                duration: manifest.stats.duration,
            }), jobId);
            // Apply retention policy
            if (options.retentionCount && options.retentionCount > 0) {
                const prefix = `${storageConfig.pathPrefix || 'servercompass-backups'}/servers/${options.serverId}/`;
                await this.applyRetentionPolicy(storageConfig, prefix, options.retentionCount);
            }
            this.sendProgress({
                jobId,
                phase: 'complete',
                progress: 100,
                message: 'Backup completed successfully',
            });
            return { success: true, jobId, manifestKey };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Backup failed';
            // Update job record
            db_1.db.prepare(`
        UPDATE backup_jobs
        SET status = 'failed', completed_at = ?, error_message = ?
        WHERE id = ?
      `).run(Date.now(), errorMessage, jobId);
            this.sendProgress({
                jobId,
                phase: 'failed',
                progress: 0,
                message: errorMessage,
            });
            console.error('[ServerBackup] Backup failed:', error);
            return { success: false, jobId, error: errorMessage };
        }
        finally {
            this.activeJobs.delete(jobId);
        }
    }
    /**
     * Cancel a running backup job
     */
    cancelBackup(jobId) {
        const jobState = this.activeJobs.get(jobId);
        if (jobState) {
            jobState.cancelled = true;
            return true;
        }
        return false;
    }
    /**
     * Get running Docker stacks
     */
    async getRunningStacks(serverId, excludedStacks = []) {
        const excludeSet = new Set(excludedStacks);
        const result = await SSHService_1.sshService.executeCommand(serverId, `docker compose ls --format json 2>/dev/null || echo '[]'`);
        if (result.exitCode !== 0) {
            return [];
        }
        try {
            const stacks = JSON.parse(result.stdout.trim());
            return stacks
                .filter((s) => s.Status?.includes('running') && !excludeSet.has(s.Name))
                .map((s) => s.Name);
        }
        catch {
            return [];
        }
    }
    /**
     * Stop Docker stacks
     */
    async stopStacks(serverId, stacks) {
        for (const stack of stacks) {
            // Find the compose file path
            const pathResult = await SSHService_1.sshService.executeCommand(serverId, `docker compose ls --format json | jq -r '.[] | select(.Name=="${stack}") | .ConfigFiles' 2>/dev/null || echo ""`);
            if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
                const configPath = pathResult.stdout.trim().split(',')[0];
                if (configPath) {
                    await SSHService_1.sshService.executeCommand(serverId, `docker compose -f ${shEscape(configPath)} stop`);
                }
            }
        }
    }
    /**
     * Start Docker stacks
     */
    async startStacks(serverId, stacks) {
        for (const stack of stacks) {
            const pathResult = await SSHService_1.sshService.executeCommand(serverId, `docker compose ls --format json | jq -r '.[] | select(.Name=="${stack}") | .ConfigFiles' 2>/dev/null || echo ""`);
            if (pathResult.exitCode === 0 && pathResult.stdout.trim()) {
                const configPath = pathResult.stdout.trim().split(',')[0];
                if (configPath) {
                    await SSHService_1.sshService.executeCommand(serverId, `docker compose -f ${shEscape(configPath)} start`);
                }
            }
        }
    }
    /**
     * Backup Docker volumes
     */
    async backupVolumes(serverId, storageConfig, backupPrefix, manifest, jobId, excludedVolumes, jobState) {
        this.sendProgress({
            jobId,
            phase: 'volumes',
            progress: 20,
            message: 'Discovering Docker volumes...',
        });
        const excludeSet = new Set(excludedVolumes);
        // Get list of volumes
        const volumeResult = await SSHService_1.sshService.executeCommand(serverId, `docker volume ls --format '{{.Name}}' 2>/dev/null || echo ""`);
        if (volumeResult.exitCode !== 0) {
            console.warn('[ServerBackup] Failed to list volumes:', volumeResult.stderr);
            return;
        }
        const volumes = volumeResult.stdout
            .trim()
            .split('\n')
            .filter((v) => v && !excludeSet.has(v));
        if (volumes.length === 0) {
            return;
        }
        const totalVolumes = volumes.length;
        let completedVolumes = 0;
        for (const volumeName of volumes) {
            if (jobState.cancelled)
                throw new Error('Backup cancelled');
            this.sendProgress({
                jobId,
                phase: 'volumes',
                progress: 20 + Math.round((completedVolumes / totalVolumes) * 25),
                message: `Backing up volume: ${volumeName}`,
                currentItem: volumeName,
            });
            try {
                // Create tar archive of volume
                const tarCommand = `docker run --rm -v ${shEscape(volumeName)}:/data:ro alpine tar czf - -C /data . 2>/dev/null | base64`;
                const tarResult = await SSHService_1.sshService.executeCommand(serverId, tarCommand);
                if (tarResult.exitCode === 0 && tarResult.stdout.trim()) {
                    const tarBuffer = Buffer.from(tarResult.stdout.trim(), 'base64');
                    const s3Key = `${backupPrefix}/volumes/${volumeName}.tar.gz`;
                    const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, tarBuffer, s3Key, { contentType: 'application/gzip' });
                    if (uploadResult.success) {
                        // Try to determine which stack owns this volume
                        const inspectResult = await SSHService_1.sshService.executeCommand(serverId, `docker volume inspect ${shEscape(volumeName)} --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null || echo ""`);
                        const stack = inspectResult.stdout.trim() || undefined;
                        manifest.contents.volumes.push({
                            name: volumeName,
                            stack,
                            size: tarBuffer.length,
                            s3Key,
                        });
                        manifest.stats.totalSize += tarBuffer.length;
                    }
                }
            }
            catch (err) {
                console.warn(`[ServerBackup] Failed to backup volume ${volumeName}:`, err);
            }
            completedVolumes++;
        }
    }
    /**
     * Backup databases (PostgreSQL and MySQL)
     */
    async backupDatabases(serverId, storageConfig, backupPrefix, manifest, jobId, _passphrase, // Reserved for future encrypted dumps
    excludedDatabases, jobState) {
        this.sendProgress({
            jobId,
            phase: 'databases',
            progress: 45,
            message: 'Backing up databases...',
        });
        const excludeSet = new Set(excludedDatabases);
        // Get databases from ServerCompass DB
        const databases = db_1.db.prepare(`
      SELECT id, name, type, container_name
      FROM databases
      WHERE server_id = ? AND status = 'ready'
    `).all(serverId);
        if (databases.length === 0)
            return;
        const totalDbs = databases.filter((d) => !excludeSet.has(d.name)).length;
        let completedDbs = 0;
        for (const database of databases) {
            if (excludeSet.has(database.name))
                continue;
            if (jobState.cancelled)
                throw new Error('Backup cancelled');
            this.sendProgress({
                jobId,
                phase: 'databases',
                progress: 45 + Math.round((completedDbs / totalDbs) * 15),
                message: `Backing up database: ${database.name}`,
                currentItem: database.name,
            });
            try {
                let dumpCommand;
                let fileExt;
                if (database.type === 'postgresql') {
                    dumpCommand = `docker exec ${shEscape(database.container_name)} pg_dumpall -U postgres 2>/dev/null | gzip | base64`;
                    fileExt = 'sql.gz';
                }
                else if (database.type === 'mysql' || database.type === 'mariadb') {
                    dumpCommand = `docker exec ${shEscape(database.container_name)} sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --all-databases 2>/dev/null' | gzip | base64`;
                    fileExt = 'sql.gz';
                }
                else {
                    continue;
                }
                const dumpResult = await SSHService_1.sshService.executeCommand(serverId, dumpCommand);
                if (dumpResult.exitCode === 0 && dumpResult.stdout.trim()) {
                    const dumpBuffer = Buffer.from(dumpResult.stdout.trim(), 'base64');
                    const s3Key = `${backupPrefix}/databases/${database.name}.${fileExt}`;
                    const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, dumpBuffer, s3Key, { contentType: 'application/gzip' });
                    if (uploadResult.success) {
                        manifest.contents.databases.push({
                            name: database.name,
                            type: database.type,
                            size: dumpBuffer.length,
                            s3Key,
                        });
                        manifest.stats.totalSize += dumpBuffer.length;
                    }
                }
            }
            catch (err) {
                console.warn(`[ServerBackup] Failed to backup database ${database.name}:`, err);
            }
            completedDbs++;
        }
    }
    /**
     * Backup stack configs (compose files and env files)
     */
    async backupStackConfigs(serverId, storageConfig, backupPrefix, manifest, jobId, passphrase, backupCompose, backupEnv, excludedStacks, jobState) {
        this.sendProgress({
            jobId,
            phase: 'configs',
            progress: 60,
            message: 'Backing up stack configurations...',
        });
        const excludeSet = new Set(excludedStacks);
        // Get stacks from Docker
        const stackResult = await SSHService_1.sshService.executeCommand(serverId, `docker compose ls --format json 2>/dev/null || echo '[]'`);
        if (stackResult.exitCode !== 0)
            return;
        let stacks = [];
        try {
            stacks = JSON.parse(stackResult.stdout.trim());
        }
        catch {
            return;
        }
        const filteredStacks = stacks.filter((s) => !excludeSet.has(s.Name));
        const totalStacks = filteredStacks.length;
        let completedStacks = 0;
        for (const stack of filteredStacks) {
            if (jobState.cancelled)
                throw new Error('Backup cancelled');
            this.sendProgress({
                jobId,
                phase: 'configs',
                progress: 60 + Math.round((completedStacks / totalStacks) * 15),
                message: `Backing up config: ${stack.Name}`,
                currentItem: stack.Name,
            });
            const configPath = stack.ConfigFiles?.split(',')[0];
            if (!configPath)
                continue;
            const configDir = configPath.substring(0, configPath.lastIndexOf('/'));
            try {
                // Backup compose file
                if (backupCompose) {
                    const composeResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${shEscape(configPath)} 2>/dev/null | base64`);
                    if (composeResult.exitCode === 0 && composeResult.stdout.trim()) {
                        const composeBuffer = Buffer.from(composeResult.stdout.trim(), 'base64');
                        const s3Key = `${backupPrefix}/configs/${stack.Name}/docker-compose.yml`;
                        const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, composeBuffer, s3Key, { contentType: 'text/yaml' });
                        if (uploadResult.success) {
                            manifest.contents.composeFiles.push({
                                stack: stack.Name,
                                s3Key,
                            });
                            manifest.stats.totalSize += composeBuffer.length;
                        }
                    }
                }
                // Backup .env file (encrypted)
                if (backupEnv) {
                    const envResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${shEscape(configDir)}/.env 2>/dev/null || echo ""`);
                    if (envResult.exitCode === 0 && envResult.stdout.trim()) {
                        // Encrypt env file with passphrase
                        const encrypted = await this.encryptWithPassphrase(envResult.stdout, passphrase);
                        const envBuffer = Buffer.from(encrypted, 'utf8');
                        const s3Key = `${backupPrefix}/configs/${stack.Name}/.env.encrypted`;
                        const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, envBuffer, s3Key, { contentType: 'text/plain' });
                        if (uploadResult.success) {
                            manifest.contents.envFiles.push({
                                stack: stack.Name,
                                s3Key,
                                encrypted: true,
                            });
                            manifest.stats.totalSize += envBuffer.length;
                        }
                    }
                }
            }
            catch (err) {
                console.warn(`[ServerBackup] Failed to backup config for ${stack.Name}:`, err);
            }
            completedStacks++;
        }
    }
    /**
     * Backup SSL certificates
     */
    async backupSslCerts(serverId, storageConfig, backupPrefix, manifest, jobId, jobState) {
        this.sendProgress({
            jobId,
            phase: 'configs',
            progress: 75,
            message: 'Backing up SSL certificates...',
        });
        // Common certificate locations
        const certPaths = [
            '/etc/letsencrypt',
            '/etc/ssl/certs',
            '/etc/traefik/certs',
        ];
        for (const certPath of certPaths) {
            if (jobState.cancelled)
                throw new Error('Backup cancelled');
            const checkResult = await SSHService_1.sshService.executeCommand(serverId, `test -d ${shEscape(certPath)} && echo "exists" || echo ""`);
            if (checkResult.stdout.trim() === 'exists') {
                try {
                    const tarCommand = `tar czf - -C ${shEscape(certPath)} . 2>/dev/null | base64`;
                    const tarResult = await SSHService_1.sshService.executeCommand(serverId, tarCommand);
                    if (tarResult.exitCode === 0 && tarResult.stdout.trim()) {
                        const tarBuffer = Buffer.from(tarResult.stdout.trim(), 'base64');
                        const safePath = certPath.replace(/\//g, '_').replace(/^_/, '');
                        const s3Key = `${backupPrefix}/ssl/${safePath}.tar.gz`;
                        const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, tarBuffer, s3Key, { contentType: 'application/gzip' });
                        if (uploadResult.success) {
                            manifest.contents.sslCerts.push({
                                domain: certPath,
                                s3Key,
                            });
                            manifest.stats.totalSize += tarBuffer.length;
                        }
                    }
                }
                catch (err) {
                    console.warn(`[ServerBackup] Failed to backup SSL certs from ${certPath}:`, err);
                }
            }
        }
    }
    /**
     * Backup cron jobs
     */
    async backupCronJobs(serverId, storageConfig, backupPrefix, manifest, jobId, jobState) {
        if (jobState.cancelled)
            throw new Error('Backup cancelled');
        this.sendProgress({
            jobId,
            phase: 'configs',
            progress: 80,
            message: 'Backing up cron jobs...',
        });
        try {
            // Get all user crontabs
            const cronResult = await SSHService_1.sshService.executeCommand(serverId, `for user in $(cut -f1 -d: /etc/passwd); do crontab -u $user -l 2>/dev/null && echo "# END USER: $user"; done`);
            if (cronResult.exitCode === 0 && cronResult.stdout.trim()) {
                const cronBuffer = Buffer.from(cronResult.stdout, 'utf8');
                const s3Key = `${backupPrefix}/cron/crontabs.txt`;
                const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, cronBuffer, s3Key, { contentType: 'text/plain' });
                if (uploadResult.success) {
                    manifest.contents.cronJobs = { s3Key };
                    manifest.stats.totalSize += cronBuffer.length;
                }
            }
        }
        catch (err) {
            console.warn('[ServerBackup] Failed to backup cron jobs:', err);
        }
    }
    /**
     * Apply retention policy by deleting old backups
     */
    async applyRetentionPolicy(storageConfig, prefix, retentionCount) {
        try {
            // List all backup folders (by timestamp)
            const listResult = await S3UploadService_1.s3UploadService.listBackups(storageConfig, prefix);
            if (!listResult.success || !listResult.items)
                return;
            // Find manifest files to identify backup sets
            const manifests = listResult.items
                .filter((item) => item.key.endsWith('/manifest.json'))
                .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
            if (manifests.length <= retentionCount)
                return;
            // Delete older backups
            const toDelete = manifests.slice(retentionCount);
            for (const manifest of toDelete) {
                // Get the backup folder prefix
                const backupFolder = manifest.key.replace('/manifest.json', '');
                // List all objects in that folder
                const folderContents = await S3UploadService_1.s3UploadService.listBackups(storageConfig, backupFolder);
                if (folderContents.success && folderContents.items) {
                    for (const item of folderContents.items) {
                        await S3UploadService_1.s3UploadService.deleteBackup(storageConfig, item.key);
                    }
                }
            }
        }
        catch (err) {
            console.warn('[ServerBackup] Failed to apply retention policy:', err);
        }
    }
    /**
     * List backups for a server from S3
     */
    async listBackups(storageConfig, serverId) {
        try {
            const prefix = `${storageConfig.pathPrefix || 'servercompass-backups'}/servers/${serverId}/`;
            const result = await S3UploadService_1.s3UploadService.listBackups(storageConfig, prefix);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            // Find manifest files
            const manifests = result.items
                .filter((item) => item.key.endsWith('/manifest.json'))
                .map((item) => {
                // Extract timestamp from path
                const parts = item.key.split('/');
                const timestamp = parts[parts.length - 2] || '';
                return {
                    timestamp,
                    manifestKey: item.key,
                    size: item.size,
                    lastModified: item.lastModified,
                };
            })
                .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
            return { success: true, backups: manifests };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list backups',
            };
        }
    }
    /**
     * Get backup manifest from S3
     */
    async getManifest(storageConfig, manifestKey) {
        try {
            const result = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, manifestKey);
            if (!result.success || !result.data) {
                return { success: false, error: result.error || 'Failed to download manifest' };
            }
            const manifest = JSON.parse(result.data.toString('utf8'));
            return { success: true, manifest };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get manifest',
            };
        }
    }
    /**
     * Restore a backup to a server
     */
    async restoreBackup(options) {
        const jobId = (0, crypto_1.randomUUID)();
        const jobState = { cancelled: false };
        this.activeJobs.set(jobId, jobState);
        const warnings = [];
        const restoredItems = {
            volumes: 0,
            databases: 0,
            composeFiles: 0,
            envFiles: 0,
            sslCerts: 0,
            cronJobs: false,
        };
        try {
            // Get passphrase
            const passphrase = await this.secureStorage.getBackupPassphrase();
            if (!passphrase) {
                return { success: false, error: 'Backup passphrase not set' };
            }
            // Get storage config
            const storageConfig = await this.getStorageConfig(options.storageConfigId);
            if (!storageConfig) {
                return { success: false, error: 'Storage configuration not found' };
            }
            // Get manifest
            const manifestResult = await this.getManifest(storageConfig, options.manifestKey);
            if (!manifestResult.success || !manifestResult.manifest) {
                return { success: false, error: manifestResult.error || 'Failed to get backup manifest' };
            }
            const manifest = manifestResult.manifest;
            this.sendRestoreProgress(jobId, 'preparing', 5, 'Preparing restore...');
            // Determine what to restore
            const volumesToRestore = options.selectedVolumes
                ? manifest.contents.volumes.filter((v) => options.selectedVolumes.includes(v.name))
                : options.restoreVolumes !== false
                    ? manifest.contents.volumes
                    : [];
            const databasesToRestore = options.selectedDatabases
                ? manifest.contents.databases.filter((d) => options.selectedDatabases.includes(d.name))
                : options.restoreDatabases !== false
                    ? manifest.contents.databases
                    : [];
            const stacksToRestore = options.selectedStacks
                ? new Set(options.selectedStacks)
                : null;
            const composeFilesToRestore = stacksToRestore
                ? manifest.contents.composeFiles.filter((c) => stacksToRestore.has(c.stack))
                : options.restoreComposeFiles !== false
                    ? manifest.contents.composeFiles
                    : [];
            const envFilesToRestore = stacksToRestore
                ? manifest.contents.envFiles.filter((e) => stacksToRestore.has(e.stack))
                : options.restoreEnvFiles !== false
                    ? manifest.contents.envFiles
                    : [];
            const sslCertsToRestore = options.restoreSslCerts !== false ? manifest.contents.sslCerts : [];
            const restoreCron = options.restoreCronJobs !== false && manifest.contents.cronJobs;
            // Stop containers if requested
            let stoppedStacks = [];
            if (options.stopContainersFirst && volumesToRestore.length > 0) {
                this.sendRestoreProgress(jobId, 'preparing', 10, 'Stopping containers...');
                stoppedStacks = await this.getRunningStacks(options.serverId);
                if (stoppedStacks.length > 0) {
                    await this.stopStacks(options.serverId, stoppedStacks);
                }
            }
            try {
                // Restore volumes
                if (volumesToRestore.length > 0) {
                    if (jobState.cancelled)
                        throw new Error('Restore cancelled');
                    await this.restoreVolumes(options.serverId, storageConfig, volumesToRestore, jobId, jobState, restoredItems, warnings);
                }
                // Restore databases
                if (databasesToRestore.length > 0) {
                    if (jobState.cancelled)
                        throw new Error('Restore cancelled');
                    await this.restoreDatabases(options.serverId, storageConfig, databasesToRestore, jobId, jobState, restoredItems, warnings);
                }
                // Restore compose files
                if (composeFilesToRestore.length > 0) {
                    if (jobState.cancelled)
                        throw new Error('Restore cancelled');
                    await this.restoreComposeFiles(options.serverId, storageConfig, composeFilesToRestore, jobId, jobState, restoredItems, warnings);
                }
                // Restore env files
                if (envFilesToRestore.length > 0) {
                    if (jobState.cancelled)
                        throw new Error('Restore cancelled');
                    await this.restoreEnvFiles(options.serverId, storageConfig, envFilesToRestore, passphrase, jobId, jobState, restoredItems, warnings);
                }
                // Restore SSL certs
                if (sslCertsToRestore.length > 0) {
                    if (jobState.cancelled)
                        throw new Error('Restore cancelled');
                    await this.restoreSslCerts(options.serverId, storageConfig, sslCertsToRestore, jobId, jobState, restoredItems, warnings);
                }
                // Restore cron jobs
                if (restoreCron && manifest.contents.cronJobs) {
                    if (jobState.cancelled)
                        throw new Error('Restore cancelled');
                    await this.restoreCronJobs(options.serverId, storageConfig, manifest.contents.cronJobs.s3Key, jobId, jobState, restoredItems, warnings);
                }
            }
            finally {
                // Restart stopped containers
                if (stoppedStacks.length > 0) {
                    this.sendRestoreProgress(jobId, 'cleanup', 90, 'Restarting containers...');
                    await this.startStacks(options.serverId, stoppedStacks);
                }
            }
            this.sendRestoreProgress(jobId, 'complete', 100, 'Restore completed');
            return {
                success: true,
                jobId,
                restoredItems,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Restore failed';
            this.sendRestoreProgress(jobId, 'failed', 0, errorMessage);
            console.error('[ServerBackup] Restore failed:', error);
            return {
                success: false,
                jobId,
                error: errorMessage,
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        }
        finally {
            this.activeJobs.delete(jobId);
        }
    }
    /**
     * Send restore progress update
     */
    sendRestoreProgress(jobId, phase, progress, message, currentItem) {
        const windows = electron_1.BrowserWindow.getAllWindows();
        for (const win of windows) {
            win.webContents.send(types_1.IPC_CHANNELS.BACKUP_PROGRESS, {
                type: 'server_restore',
                jobId,
                phase,
                progress,
                message,
                currentItem,
            });
        }
    }
    /**
     * Restore Docker volumes
     */
    async restoreVolumes(serverId, storageConfig, volumes, jobId, jobState, restoredItems, warnings) {
        this.sendRestoreProgress(jobId, 'volumes', 20, 'Restoring volumes...');
        const totalVolumes = volumes.length;
        let completed = 0;
        for (const volume of volumes) {
            if (jobState.cancelled)
                throw new Error('Restore cancelled');
            this.sendRestoreProgress(jobId, 'volumes', 20 + Math.round((completed / totalVolumes) * 25), `Restoring volume: ${volume.name}`, volume.name);
            try {
                // Download volume archive
                const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, volume.s3Key);
                if (!downloadResult.success || !downloadResult.data) {
                    warnings.push(`Failed to download volume ${volume.name}: ${downloadResult.error}`);
                    continue;
                }
                // Create volume if it doesn't exist
                await SSHService_1.sshService.executeCommand(serverId, `docker volume create ${shEscape(volume.name)} 2>/dev/null || true`);
                // Restore volume contents
                const base64Data = downloadResult.data.toString('base64');
                const restoreCommand = `echo ${shEscape(base64Data)} | base64 -d | docker run --rm -i -v ${shEscape(volume.name)}:/data alpine sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf - -C /data'`;
                const result = await SSHService_1.sshService.executeCommand(serverId, restoreCommand);
                if (result.exitCode === 0) {
                    restoredItems.volumes++;
                }
                else {
                    warnings.push(`Failed to restore volume ${volume.name}: ${result.stderr}`);
                }
            }
            catch (err) {
                warnings.push(`Error restoring volume ${volume.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
            completed++;
        }
    }
    /**
     * Restore databases
     */
    async restoreDatabases(serverId, storageConfig, databases, jobId, jobState, restoredItems, warnings) {
        this.sendRestoreProgress(jobId, 'databases', 45, 'Restoring databases...');
        const totalDbs = databases.length;
        let completed = 0;
        for (const database of databases) {
            if (jobState.cancelled)
                throw new Error('Restore cancelled');
            this.sendRestoreProgress(jobId, 'databases', 45 + Math.round((completed / totalDbs) * 15), `Restoring database: ${database.name}`, database.name);
            try {
                // Get database container info from local DB
                const dbRow = db_1.db.prepare(`
          SELECT container_name FROM databases WHERE name = ? AND server_id = ?
        `).get(database.name, serverId);
                if (!dbRow) {
                    warnings.push(`Database ${database.name} not found in ServerCompass, skipping restore`);
                    continue;
                }
                // Download dump
                const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, database.s3Key);
                if (!downloadResult.success || !downloadResult.data) {
                    warnings.push(`Failed to download database ${database.name}: ${downloadResult.error}`);
                    continue;
                }
                const base64Data = downloadResult.data.toString('base64');
                let restoreCommand;
                if (database.type === 'postgresql') {
                    restoreCommand = `echo ${shEscape(base64Data)} | base64 -d | gunzip | docker exec -i ${shEscape(dbRow.container_name)} psql -U postgres`;
                }
                else if (database.type === 'mysql' || database.type === 'mariadb') {
                    restoreCommand = `echo ${shEscape(base64Data)} | base64 -d | gunzip | docker exec -i ${shEscape(dbRow.container_name)} sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD"'`;
                }
                else {
                    warnings.push(`Unsupported database type for ${database.name}: ${database.type}`);
                    continue;
                }
                const result = await SSHService_1.sshService.executeCommand(serverId, restoreCommand);
                if (result.exitCode === 0) {
                    restoredItems.databases++;
                }
                else {
                    warnings.push(`Failed to restore database ${database.name}: ${result.stderr}`);
                }
            }
            catch (err) {
                warnings.push(`Error restoring database ${database.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
            completed++;
        }
    }
    /**
     * Restore compose files
     */
    async restoreComposeFiles(serverId, storageConfig, composeFiles, jobId, jobState, restoredItems, warnings) {
        this.sendRestoreProgress(jobId, 'configs', 60, 'Restoring compose files...');
        const totalFiles = composeFiles.length;
        let completed = 0;
        for (const composeFile of composeFiles) {
            if (jobState.cancelled)
                throw new Error('Restore cancelled');
            this.sendRestoreProgress(jobId, 'configs', 60 + Math.round((completed / totalFiles) * 10), `Restoring compose: ${composeFile.stack}`, composeFile.stack);
            try {
                // Download compose file
                const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, composeFile.s3Key);
                if (!downloadResult.success || !downloadResult.data) {
                    warnings.push(`Failed to download compose file for ${composeFile.stack}: ${downloadResult.error}`);
                    continue;
                }
                // Find existing stack path or create new directory
                const stackResult = await SSHService_1.sshService.executeCommand(serverId, `docker compose ls --format json | jq -r '.[] | select(.Name=="${composeFile.stack}") | .ConfigFiles' 2>/dev/null || echo ""`);
                let composePath;
                if (stackResult.exitCode === 0 && stackResult.stdout.trim()) {
                    composePath = stackResult.stdout.trim().split(',')[0];
                }
                else {
                    // Create new stack directory
                    const stackDir = `/opt/stacks/${composeFile.stack}`;
                    await SSHService_1.sshService.executeCommand(serverId, `mkdir -p ${shEscape(stackDir)}`);
                    composePath = `${stackDir}/docker-compose.yml`;
                }
                // Write compose file
                const base64Data = downloadResult.data.toString('base64');
                const writeResult = await SSHService_1.sshService.executeCommand(serverId, `echo ${shEscape(base64Data)} | base64 -d > ${shEscape(composePath)}`);
                if (writeResult.exitCode === 0) {
                    restoredItems.composeFiles++;
                }
                else {
                    warnings.push(`Failed to write compose file for ${composeFile.stack}: ${writeResult.stderr}`);
                }
            }
            catch (err) {
                warnings.push(`Error restoring compose for ${composeFile.stack}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
            completed++;
        }
    }
    /**
     * Restore env files
     */
    async restoreEnvFiles(serverId, storageConfig, envFiles, passphrase, jobId, jobState, restoredItems, warnings) {
        this.sendRestoreProgress(jobId, 'configs', 70, 'Restoring environment files...');
        const totalFiles = envFiles.length;
        let completed = 0;
        for (const envFile of envFiles) {
            if (jobState.cancelled)
                throw new Error('Restore cancelled');
            this.sendRestoreProgress(jobId, 'configs', 70 + Math.round((completed / totalFiles) * 10), `Restoring env: ${envFile.stack}`, envFile.stack);
            try {
                // Download encrypted env file
                const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, envFile.s3Key);
                if (!downloadResult.success || !downloadResult.data) {
                    warnings.push(`Failed to download env file for ${envFile.stack}: ${downloadResult.error}`);
                    continue;
                }
                // Decrypt env content
                let envContent;
                if (envFile.encrypted) {
                    const encryptedData = downloadResult.data.toString('utf8');
                    envContent = this.decryptWithPassphrase(encryptedData, passphrase);
                }
                else {
                    envContent = downloadResult.data.toString('utf8');
                }
                // Find stack directory
                const stackResult = await SSHService_1.sshService.executeCommand(serverId, `docker compose ls --format json | jq -r '.[] | select(.Name=="${envFile.stack}") | .ConfigFiles' 2>/dev/null || echo ""`);
                let envPath;
                if (stackResult.exitCode === 0 && stackResult.stdout.trim()) {
                    const composePath = stackResult.stdout.trim().split(',')[0];
                    const stackDir = composePath.substring(0, composePath.lastIndexOf('/'));
                    envPath = `${stackDir}/.env`;
                }
                else {
                    // Use default stack directory
                    envPath = `/opt/stacks/${envFile.stack}/.env`;
                    await SSHService_1.sshService.executeCommand(serverId, `mkdir -p /opt/stacks/${shEscape(envFile.stack)}`);
                }
                // Write env file
                const base64Data = Buffer.from(envContent, 'utf8').toString('base64');
                const writeResult = await SSHService_1.sshService.executeCommand(serverId, `echo ${shEscape(base64Data)} | base64 -d > ${shEscape(envPath)} && chmod 600 ${shEscape(envPath)}`);
                if (writeResult.exitCode === 0) {
                    restoredItems.envFiles++;
                }
                else {
                    warnings.push(`Failed to write env file for ${envFile.stack}: ${writeResult.stderr}`);
                }
            }
            catch (err) {
                warnings.push(`Error restoring env for ${envFile.stack}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
            completed++;
        }
    }
    /**
     * Restore SSL certificates
     */
    async restoreSslCerts(serverId, storageConfig, sslCerts, jobId, jobState, restoredItems, warnings) {
        this.sendRestoreProgress(jobId, 'configs', 80, 'Restoring SSL certificates...');
        for (const cert of sslCerts) {
            if (jobState.cancelled)
                throw new Error('Restore cancelled');
            try {
                // Download cert archive
                const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, cert.s3Key);
                if (!downloadResult.success || !downloadResult.data) {
                    warnings.push(`Failed to download SSL cert ${cert.domain}: ${downloadResult.error}`);
                    continue;
                }
                // Restore cert to original path
                // The domain field contains the original path (e.g., /etc/letsencrypt)
                const certPath = cert.domain;
                const base64Data = downloadResult.data.toString('base64');
                const restoreResult = await SSHService_1.sshService.executeCommand(serverId, `mkdir -p ${shEscape(certPath)} && echo ${shEscape(base64Data)} | base64 -d | tar xzf - -C ${shEscape(certPath)}`);
                if (restoreResult.exitCode === 0) {
                    restoredItems.sslCerts++;
                }
                else {
                    warnings.push(`Failed to restore SSL cert ${cert.domain}: ${restoreResult.stderr}`);
                }
            }
            catch (err) {
                warnings.push(`Error restoring SSL cert ${cert.domain}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
        }
    }
    /**
     * Restore cron jobs
     */
    async restoreCronJobs(serverId, storageConfig, cronS3Key, jobId, jobState, restoredItems, warnings) {
        if (jobState.cancelled)
            throw new Error('Restore cancelled');
        this.sendRestoreProgress(jobId, 'configs', 85, 'Restoring cron jobs...');
        try {
            // Download crontabs
            const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, cronS3Key);
            if (!downloadResult.success || !downloadResult.data) {
                warnings.push(`Failed to download cron jobs: ${downloadResult.error}`);
                return;
            }
            // Parse and restore crontabs per user
            const content = downloadResult.data.toString('utf8');
            const sections = content.split('# END USER: ');
            for (const section of sections) {
                if (!section.trim())
                    continue;
                // Find the user name at the end of the section
                const lines = section.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const userMatch = lastLine?.match(/^(\w+)$/);
                if (userMatch) {
                    const user = userMatch[1];
                    const crontab = lines.slice(0, -1).join('\n');
                    if (crontab.trim()) {
                        const base64Data = Buffer.from(crontab, 'utf8').toString('base64');
                        await SSHService_1.sshService.executeCommand(serverId, `echo ${shEscape(base64Data)} | base64 -d | crontab -u ${shEscape(user)} - 2>/dev/null || true`);
                    }
                }
            }
            restoredItems.cronJobs = true;
        }
        catch (err) {
            warnings.push(`Error restoring cron jobs: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }
}
exports.ServerBackupService = ServerBackupService;
exports.serverBackupService = new ServerBackupService();
//# sourceMappingURL=ServerBackupService.js.map