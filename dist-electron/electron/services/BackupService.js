"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.backupService = exports.BackupService = void 0;
const crypto_1 = require("crypto");
const util_1 = require("util");
const electron_1 = require("electron");
const promises_1 = __importDefault(require("fs/promises"));
const db_1 = require("../db");
const CredentialVault_1 = require("./CredentialVault");
const SecureStorageService_1 = require("./SecureStorageService");
const S3UploadService_1 = require("./S3UploadService");
const scryptAsync = (0, util_1.promisify)(crypto_1.scrypt);
/**
 * BackupService handles secure export and import of all ServerCompass data.
 *
 * Security features:
 * - AES-256-GCM encryption with scrypt key derivation
 * - Credentials are decrypted from vault, then re-encrypted with user password for export
 * - On import, credentials are decrypted with user password, then re-encrypted with local vault
 * - SHA-256 checksum for data integrity verification
 */
class BackupService {
    algorithm = 'aes-256-gcm';
    saltLength = 32;
    ivLength = 16;
    keyLength = 32;
    vault;
    secureStorage;
    constructor() {
        this.vault = new CredentialVault_1.CredentialVault();
        this.secureStorage = new SecureStorageService_1.SecureStorageService();
    }
    // Tables to export (excludes license-related tables)
    EXPORT_TABLES = [
        'servers',
        'settings',
        'deployments',
        'commands',
        'cron_metadata',
        'auto_deploy_config',
        'auto_deploy_settings',
        'databases',
        'database_operations',
        'git_sources',
        'git_accounts',
        'server_git_accounts',
        'app_git_bindings',
        'git_connection_status',
        'github_actions_config',
        'docker_stacks',
        'docker_stack_deployments',
        'docker_registry_credentials',
        'docker_proxy_configs',
        'docker_compose_templates',
        'pm2_migrations',
        'domains',
        'domain_redirects',
    ];
    // Tables with encrypted fields that need re-encryption
    ENCRYPTED_FIELDS = {
        servers: 'encrypted_secret',
        databases: 'encrypted_credentials',
        git_accounts: 'encrypted_token',
        docker_registry_credentials: 'encrypted_password',
    };
    /**
     * Derive encryption key from password using scrypt
     */
    async deriveKey(password, salt) {
        return scryptAsync(password, salt, this.keyLength);
    }
    /**
     * Encrypt data with user-derived key
     */
    encryptWithKey(data, key) {
        const iv = (0, crypto_1.randomBytes)(this.ivLength);
        const cipher = (0, crypto_1.createCipheriv)(this.algorithm, key, iv);
        const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return {
            iv: iv.toString('base64'),
            authTag: authTag.toString('base64'),
            encrypted: encrypted.toString('base64'),
        };
    }
    /**
     * Decrypt data with user-derived key
     */
    decryptWithKey(encrypted, iv, authTag, key) {
        const decipher = (0, crypto_1.createDecipheriv)(this.algorithm, key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(authTag, 'base64'));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(encrypted, 'base64')),
            decipher.final(),
        ]);
        return decrypted.toString('utf8');
    }
    /**
     * Re-encrypt a vault-encrypted credential with user password for export
     */
    async reEncryptForExport(encryptedBuffer, userKey) {
        // Decrypt with vault
        const plaintext = await this.vault.decrypt(encryptedBuffer);
        // Re-encrypt with user key
        const { iv, authTag, encrypted } = this.encryptWithKey(plaintext, userKey);
        // Return combined format: iv:authTag:encrypted
        return `${iv}:${authTag}:${encrypted}`;
    }
    /**
     * Decrypt user-encrypted credential and re-encrypt with vault for import
     */
    async reEncryptForImport(exportedCredential, userKey) {
        const [iv, authTag, encrypted] = exportedCredential.split(':');
        // Decrypt with user key
        const plaintext = this.decryptWithKey(encrypted, iv, authTag, userKey);
        // Re-encrypt with vault
        return this.vault.encrypt(plaintext);
    }
    /**
     * Export all data to encrypted backup file
     */
    async exportBackup(password) {
        try {
            // Show save dialog
            const result = await electron_1.dialog.showSaveDialog({
                title: 'Save Backup',
                defaultPath: `servercompass-backup-${new Date().toISOString().split('T')[0]}.scbackup`,
                filters: [{ name: 'ServerCompass Backup', extensions: ['scbackup'] }],
            });
            if (result.canceled || !result.filePath) {
                return { success: false, error: 'Export canceled' };
            }
            // Generate salt and derive key
            const salt = (0, crypto_1.randomBytes)(this.saltLength);
            const userKey = await this.deriveKey(password, salt);
            // Export all tables
            const tables = {};
            const recordCounts = {};
            for (const tableName of this.EXPORT_TABLES) {
                try {
                    // Check if table exists
                    const tableExists = db_1.db
                        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                        .get(tableName);
                    if (!tableExists) {
                        console.warn(`Table ${tableName} does not exist, skipping`);
                        continue;
                    }
                    const rows = db_1.db.prepare(`SELECT * FROM ${tableName}`).all();
                    // Handle encrypted fields
                    const encryptedField = this.ENCRYPTED_FIELDS[tableName];
                    if (encryptedField) {
                        for (const row of rows) {
                            const buffer = row[encryptedField];
                            if (buffer && Buffer.isBuffer(buffer)) {
                                try {
                                    row[encryptedField] = await this.reEncryptForExport(buffer, userKey);
                                }
                                catch (err) {
                                    console.warn(`Failed to re-encrypt ${encryptedField} in ${tableName}:`, err);
                                    // Keep the row but null out the encrypted field
                                    row[encryptedField] = null;
                                }
                            }
                        }
                    }
                    tables[tableName] = rows;
                    recordCounts[tableName] = rows.length;
                }
                catch (err) {
                    console.warn(`Skipping table ${tableName}:`, err);
                }
            }
            // Create backup data
            const backupData = {
                metadata: {
                    version: 1,
                    appVersion: electron_1.app.getVersion(),
                    createdAt: Date.now(),
                    checksum: '', // Will be filled
                    recordCounts,
                },
                tables,
            };
            // Generate checksum (before setting it)
            const dataForChecksum = JSON.stringify(backupData.tables);
            backupData.metadata.checksum = (0, crypto_1.createHash)('sha256').update(dataForChecksum).digest('hex');
            // Encrypt entire payload
            const jsonPayload = JSON.stringify(backupData);
            const { iv, authTag, encrypted } = this.encryptWithKey(jsonPayload, userKey);
            // Create backup file
            const backupFile = {
                format: 'servercompass-backup',
                version: 1,
                salt: salt.toString('base64'),
                iv,
                authTag,
                data: encrypted,
            };
            await promises_1.default.writeFile(result.filePath, JSON.stringify(backupFile, null, 2));
            return { success: true, filePath: result.filePath };
        }
        catch (error) {
            console.error('Export backup failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Export failed' };
        }
    }
    /**
     * Preview backup contents without importing
     */
    async previewBackup(filePath, password) {
        try {
            const fileContent = await promises_1.default.readFile(filePath, 'utf8');
            const backupFile = JSON.parse(fileContent);
            if (backupFile.format !== 'servercompass-backup') {
                return { success: false, error: 'Invalid backup file format' };
            }
            // Derive key and decrypt
            const salt = Buffer.from(backupFile.salt, 'base64');
            const userKey = await this.deriveKey(password, salt);
            try {
                const decrypted = this.decryptWithKey(backupFile.data, backupFile.iv, backupFile.authTag, userKey);
                const backupData = JSON.parse(decrypted);
                return { success: true, metadata: backupData.metadata };
            }
            catch {
                return { success: false, error: 'Incorrect password' };
            }
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read backup file',
            };
        }
    }
    /**
     * Import backup from file
     */
    async importBackup(filePath, password) {
        try {
            const fileContent = await promises_1.default.readFile(filePath, 'utf8');
            const backupFile = JSON.parse(fileContent);
            if (backupFile.format !== 'servercompass-backup') {
                return { success: false, error: 'Invalid backup file format' };
            }
            // Derive key and decrypt
            const salt = Buffer.from(backupFile.salt, 'base64');
            const userKey = await this.deriveKey(password, salt);
            let backupData;
            try {
                const decrypted = this.decryptWithKey(backupFile.data, backupFile.iv, backupFile.authTag, userKey);
                backupData = JSON.parse(decrypted);
            }
            catch {
                return { success: false, error: 'Incorrect password' };
            }
            // Verify checksum
            const dataForChecksum = JSON.stringify(backupData.tables);
            const checksum = (0, crypto_1.createHash)('sha256').update(dataForChecksum).digest('hex');
            if (checksum !== backupData.metadata.checksum) {
                return { success: false, error: 'Backup file may be corrupted (checksum mismatch)' };
            }
            // Process encrypted fields before transaction
            for (const tableName of Object.keys(this.ENCRYPTED_FIELDS)) {
                const rows = backupData.tables[tableName];
                if (!rows || rows.length === 0)
                    continue;
                const encryptedField = this.ENCRYPTED_FIELDS[tableName];
                for (const row of rows) {
                    const exportedCredential = row[encryptedField];
                    if (exportedCredential && typeof exportedCredential === 'string') {
                        try {
                            row[encryptedField] = await this.reEncryptForImport(exportedCredential, userKey);
                        }
                        catch (err) {
                            console.warn(`Failed to re-encrypt ${encryptedField} for import:`, err);
                            row[encryptedField] = null;
                        }
                    }
                }
            }
            // Disable foreign keys BEFORE transaction (SQLite requires this outside transaction)
            db_1.db.pragma('foreign_keys = OFF');
            try {
                // Import in transaction
                const importTransaction = db_1.db.transaction(() => {
                    // Delete existing data in reverse order
                    for (const tableName of [...this.EXPORT_TABLES].reverse()) {
                        try {
                            // Check if table exists
                            const tableExists = db_1.db
                                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                                .get(tableName);
                            if (tableExists) {
                                db_1.db.prepare(`DELETE FROM ${tableName}`).run();
                            }
                        }
                        catch {
                            // Table might not exist
                        }
                    }
                    // Insert new data
                    for (const tableName of this.EXPORT_TABLES) {
                        const rows = backupData.tables[tableName];
                        if (!rows || rows.length === 0)
                            continue;
                        // Check if table exists
                        const tableExists = db_1.db
                            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                            .get(tableName);
                        if (!tableExists) {
                            console.warn(`Table ${tableName} does not exist, skipping import`);
                            continue;
                        }
                        // Get table column info
                        const tableInfo = db_1.db.prepare(`PRAGMA table_info(${tableName})`).all();
                        const validColumns = new Set(tableInfo.map((col) => col.name));
                        // Insert rows
                        for (const row of rows) {
                            // Filter to only valid columns
                            const columns = Object.keys(row).filter((col) => validColumns.has(col));
                            if (columns.length === 0)
                                continue;
                            const placeholders = columns.map(() => '?').join(', ');
                            const insertStmt = db_1.db.prepare(`INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`);
                            const values = columns.map((col) => row[col]);
                            insertStmt.run(...values);
                        }
                    }
                });
                importTransaction();
            }
            finally {
                // Re-enable foreign keys after transaction completes (or fails)
                db_1.db.pragma('foreign_keys = ON');
            }
            return { success: true };
        }
        catch (error) {
            console.error('Import backup failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Import failed' };
        }
    }
    /**
     * Export backup data to an encrypted buffer (for S3 upload)
     * Reuses encryption logic from exportBackup()
     */
    async exportBackupToBuffer(password) {
        try {
            // Generate salt and derive key
            const salt = (0, crypto_1.randomBytes)(this.saltLength);
            const userKey = await this.deriveKey(password, salt);
            // Export all tables
            const tables = {};
            const recordCounts = {};
            for (const tableName of this.EXPORT_TABLES) {
                try {
                    // Check if table exists
                    const tableExists = db_1.db
                        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                        .get(tableName);
                    if (!tableExists) {
                        console.warn(`Table ${tableName} does not exist, skipping`);
                        continue;
                    }
                    const rows = db_1.db.prepare(`SELECT * FROM ${tableName}`).all();
                    // Handle encrypted fields
                    const encryptedField = this.ENCRYPTED_FIELDS[tableName];
                    if (encryptedField) {
                        for (const row of rows) {
                            const buffer = row[encryptedField];
                            if (buffer && Buffer.isBuffer(buffer)) {
                                try {
                                    row[encryptedField] = await this.reEncryptForExport(buffer, userKey);
                                }
                                catch (err) {
                                    console.warn(`Failed to re-encrypt ${encryptedField} in ${tableName}:`, err);
                                    row[encryptedField] = null;
                                }
                            }
                        }
                    }
                    tables[tableName] = rows;
                    recordCounts[tableName] = rows.length;
                }
                catch (err) {
                    console.warn(`Skipping table ${tableName}:`, err);
                }
            }
            // Create backup data
            const backupData = {
                metadata: {
                    version: 1,
                    appVersion: electron_1.app.getVersion(),
                    createdAt: Date.now(),
                    checksum: '',
                    recordCounts,
                },
                tables,
            };
            // Generate checksum
            const dataForChecksum = JSON.stringify(backupData.tables);
            backupData.metadata.checksum = (0, crypto_1.createHash)('sha256').update(dataForChecksum).digest('hex');
            // Encrypt entire payload
            const jsonPayload = JSON.stringify(backupData);
            const { iv, authTag, encrypted } = this.encryptWithKey(jsonPayload, userKey);
            // Create backup file structure
            const backupFile = {
                format: 'servercompass-backup',
                version: 1,
                salt: salt.toString('base64'),
                iv,
                authTag,
                data: encrypted,
            };
            const buffer = Buffer.from(JSON.stringify(backupFile, null, 2), 'utf8');
            return { success: true, buffer, metadata: backupData.metadata };
        }
        catch (error) {
            console.error('Export backup to buffer failed:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Export failed' };
        }
    }
    /**
     * Export backup to S3-compatible storage
     */
    async exportBackupToS3(storageConfig, options) {
        const { scheduleId, retentionCount, onProgress } = options || {};
        try {
            // Step 1: Get passphrase from keychain
            onProgress?.(5, 'Retrieving backup passphrase...');
            const passphrase = await this.secureStorage.getBackupPassphrase();
            if (!passphrase) {
                return {
                    success: false,
                    error: 'Backup passphrase not set. Please configure a backup passphrase in Settings.',
                    errorCode: 'passphrase_unavailable',
                };
            }
            // Step 2: Export backup to buffer
            onProgress?.(15, 'Exporting app configuration...');
            const exportResult = await this.exportBackupToBuffer(passphrase);
            if (!exportResult.success || !exportResult.buffer) {
                return {
                    success: false,
                    error: exportResult.error || 'Failed to create backup',
                };
            }
            // Step 3: Create backup job record
            const jobId = (0, crypto_1.randomBytes)(16).toString('hex');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            // s3Key should NOT include pathPrefix - S3UploadService methods prepend it automatically
            const s3Key = `app-config/servercompass-backup-${timestamp}.scbackup`;
            onProgress?.(25, 'Creating backup job record...');
            db_1.db.prepare(`
        INSERT INTO backup_jobs (
          id, job_type, status, storage_config_id, storage_config_name,
          triggered_by, s3_key, file_size_bytes, started_at, manifest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, 'app_config', 'running', storageConfig.id, storageConfig.name, scheduleId ? 'scheduled' : 'manual', s3Key, exportResult.buffer.length, Date.now(), JSON.stringify({
                appVersion: exportResult.metadata?.appVersion,
                recordCounts: exportResult.metadata?.recordCounts,
            }), Date.now());
            try {
                // Step 4: Upload to S3
                onProgress?.(35, 'Uploading to cloud storage...');
                const uploadResult = await S3UploadService_1.s3UploadService.uploadBuffer(storageConfig, exportResult.buffer, s3Key, {
                    contentType: 'application/json',
                    onProgress: (progress) => {
                        // Map upload progress (0-100) to overall progress (35-85)
                        const overallProgress = 35 + Math.round(progress.percent * 0.5);
                        onProgress?.(overallProgress, `Uploading... ${progress.percent}%`);
                    },
                });
                if (!uploadResult.success) {
                    // Update job status to failed
                    db_1.db.prepare(`
            UPDATE backup_jobs
            SET status = 'failed', error_message = ?, completed_at = ?
            WHERE id = ?
          `).run(uploadResult.error || 'Upload failed', Date.now(), jobId);
                    return {
                        success: false,
                        error: uploadResult.error || 'Upload failed',
                        jobId,
                    };
                }
                // Step 5: Update job status to completed
                onProgress?.(90, 'Finalizing backup...');
                db_1.db.prepare(`
          UPDATE backup_jobs
          SET status = 'success', completed_at = ?
          WHERE id = ?
        `).run(Date.now(), jobId);
                // Step 6: Apply retention policy if configured
                if (retentionCount && retentionCount > 0) {
                    onProgress?.(95, 'Applying retention policy...');
                    // Prefix should NOT include pathPrefix - applyRetentionPolicy uses listBackups which prepends it
                    await S3UploadService_1.s3UploadService.applyRetentionPolicy(storageConfig, 'app-config/', retentionCount);
                }
                onProgress?.(100, 'Backup completed successfully');
                return {
                    success: true,
                    s3Key,
                    jobId,
                };
            }
            catch (uploadError) {
                // Update job status to failed
                const errorMessage = uploadError instanceof Error ? uploadError.message : 'Upload failed';
                db_1.db.prepare(`
          UPDATE backup_jobs
          SET status = 'failed', error_message = ?, completed_at = ?
          WHERE id = ?
        `).run(errorMessage, Date.now(), jobId);
                throw uploadError;
            }
        }
        catch (error) {
            console.error('Export backup to S3 failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Export to S3 failed',
            };
        }
    }
    /**
     * List backups from S3 storage
     */
    async listS3Backups(storageConfig, type = 'app_config') {
        try {
            // Only pass the sub-path - listBackups will prepend storageConfig.pathPrefix
            const prefix = type === 'app_config' ? 'app-config/' : 'servers/';
            const result = await S3UploadService_1.s3UploadService.listBackups(storageConfig, prefix);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                backups: result.items?.map((item) => ({
                    key: item.key,
                    lastModified: item.lastModified,
                    size: item.size,
                })),
            };
        }
        catch (error) {
            console.error('List S3 backups failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list backups',
            };
        }
    }
    /**
     * Download and import backup from S3
     */
    async importBackupFromS3(storageConfig, s3Key, onProgress) {
        try {
            // Step 1: Get passphrase from keychain
            onProgress?.(5, 'Retrieving backup passphrase...');
            const passphrase = await this.secureStorage.getBackupPassphrase();
            if (!passphrase) {
                return {
                    success: false,
                    error: 'Backup passphrase not set. Please configure a backup passphrase in Settings.',
                    errorCode: 'passphrase_unavailable',
                };
            }
            // Step 2: Download from S3
            onProgress?.(15, 'Downloading backup from cloud storage...');
            const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, s3Key);
            if (!downloadResult.success || !downloadResult.data) {
                return {
                    success: false,
                    error: downloadResult.error || 'Failed to download backup',
                };
            }
            onProgress?.(55, 'Download complete, validating...');
            // Step 3: Parse backup file
            onProgress?.(60, 'Validating backup...');
            let backupFile;
            try {
                backupFile = JSON.parse(downloadResult.data.toString('utf8'));
            }
            catch {
                return { success: false, error: 'Invalid backup file format' };
            }
            if (backupFile.format !== 'servercompass-backup') {
                return { success: false, error: 'Invalid backup file format' };
            }
            // Step 4: Decrypt and import
            onProgress?.(70, 'Decrypting and importing data...');
            const salt = Buffer.from(backupFile.salt, 'base64');
            const userKey = await this.deriveKey(passphrase, salt);
            let backupData;
            try {
                const decrypted = this.decryptWithKey(backupFile.data, backupFile.iv, backupFile.authTag, userKey);
                backupData = JSON.parse(decrypted);
            }
            catch {
                return {
                    success: false,
                    error: 'Failed to decrypt backup. The backup passphrase may have changed since this backup was created.',
                    errorCode: 'decryption_failed',
                };
            }
            // Step 5: Verify checksum
            const dataForChecksum = JSON.stringify(backupData.tables);
            const checksum = (0, crypto_1.createHash)('sha256').update(dataForChecksum).digest('hex');
            if (checksum !== backupData.metadata.checksum) {
                return { success: false, error: 'Backup file may be corrupted (checksum mismatch)' };
            }
            // Step 6: Process encrypted fields
            onProgress?.(80, 'Processing credentials...');
            for (const tableName of Object.keys(this.ENCRYPTED_FIELDS)) {
                const rows = backupData.tables[tableName];
                if (!rows || rows.length === 0)
                    continue;
                const encryptedField = this.ENCRYPTED_FIELDS[tableName];
                for (const row of rows) {
                    const exportedCredential = row[encryptedField];
                    if (exportedCredential && typeof exportedCredential === 'string') {
                        try {
                            row[encryptedField] = await this.reEncryptForImport(exportedCredential, userKey);
                        }
                        catch (err) {
                            console.warn(`Failed to re-encrypt ${encryptedField} for import:`, err);
                            row[encryptedField] = null;
                        }
                    }
                }
            }
            // Step 7: Import to database
            onProgress?.(90, 'Importing data to database...');
            db_1.db.pragma('foreign_keys = OFF');
            try {
                const importTransaction = db_1.db.transaction(() => {
                    // Delete existing data in reverse order
                    for (const tableName of [...this.EXPORT_TABLES].reverse()) {
                        try {
                            const tableExists = db_1.db
                                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                                .get(tableName);
                            if (tableExists) {
                                db_1.db.prepare(`DELETE FROM ${tableName}`).run();
                            }
                        }
                        catch {
                            // Table might not exist
                        }
                    }
                    // Insert new data
                    for (const tableName of this.EXPORT_TABLES) {
                        const rows = backupData.tables[tableName];
                        if (!rows || rows.length === 0)
                            continue;
                        const tableExists = db_1.db
                            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                            .get(tableName);
                        if (!tableExists) {
                            console.warn(`Table ${tableName} does not exist, skipping import`);
                            continue;
                        }
                        const tableInfo = db_1.db.prepare(`PRAGMA table_info(${tableName})`).all();
                        const validColumns = new Set(tableInfo.map((col) => col.name));
                        for (const row of rows) {
                            const columns = Object.keys(row).filter((col) => validColumns.has(col));
                            if (columns.length === 0)
                                continue;
                            const placeholders = columns.map(() => '?').join(', ');
                            const insertStmt = db_1.db.prepare(`INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`);
                            const values = columns.map((col) => row[col]);
                            insertStmt.run(...values);
                        }
                    }
                });
                importTransaction();
            }
            finally {
                db_1.db.pragma('foreign_keys = ON');
            }
            onProgress?.(100, 'Import completed successfully');
            return { success: true };
        }
        catch (error) {
            console.error('Import backup from S3 failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Import from S3 failed',
            };
        }
    }
    /**
     * Preview backup from S3 without importing
     * Returns metadata and sample data for preview screen
     */
    async previewBackupFromS3(storageConfig, s3Key) {
        try {
            // Step 1: Get passphrase from keychain
            const passphrase = await this.secureStorage.getBackupPassphrase();
            if (!passphrase) {
                return {
                    success: false,
                    error: 'Backup passphrase not set. Please configure a backup passphrase in Settings.',
                    errorCode: 'passphrase_unavailable',
                };
            }
            // Step 2: Download from S3
            const downloadResult = await S3UploadService_1.s3UploadService.downloadBuffer(storageConfig, s3Key);
            if (!downloadResult.success || !downloadResult.data) {
                return {
                    success: false,
                    error: downloadResult.error || 'Failed to download backup',
                };
            }
            // Step 3: Parse backup file
            let backupFile;
            try {
                backupFile = JSON.parse(downloadResult.data.toString('utf8'));
            }
            catch {
                return { success: false, error: 'Invalid backup file format' };
            }
            if (backupFile.format !== 'servercompass-backup') {
                return { success: false, error: 'Invalid backup file format' };
            }
            // Step 4: Decrypt
            const salt = Buffer.from(backupFile.salt, 'base64');
            const userKey = await this.deriveKey(passphrase, salt);
            let backupData;
            try {
                const decrypted = this.decryptWithKey(backupFile.data, backupFile.iv, backupFile.authTag, userKey);
                backupData = JSON.parse(decrypted);
            }
            catch {
                return {
                    success: false,
                    error: 'Failed to decrypt backup. The backup passphrase may have changed since this backup was created.',
                    errorCode: 'decryption_failed',
                };
            }
            const serversData = (backupData.tables.servers || []);
            const stacksData = (backupData.tables.docker_stacks || []);
            const domainsData = (backupData.tables.domains || []);
            const databasesData = (backupData.tables.databases || []);
            const gitAccountsData = (backupData.tables.git_accounts || []);
            const servers = serversData.map((s) => ({
                id: String(s.id || ''),
                name: String(s.name || 'Unnamed'),
                ip: String(s.ip || s.host || ''),
            }));
            const stacks = stacksData.map((s) => ({
                id: String(s.id || ''),
                name: String(s.project_name || s.name || 'Unnamed'),
                serverId: String(s.server_id || ''),
            }));
            const domains = domainsData.map((d) => ({
                id: String(d.id || ''),
                domain: String(d.domain || ''),
                serverId: String(d.server_id || ''),
            }));
            const databases = databasesData.map((d) => ({
                id: String(d.id || ''),
                name: String(d.name || 'Unnamed'),
                type: String(d.db_type || d.type || 'unknown'),
                serverId: String(d.server_id || ''),
            }));
            const gitAccounts = gitAccountsData.map((g) => ({
                id: String(g.id || ''),
                name: String(g.display_name || g.username || 'Unnamed'),
                provider: String(g.provider || 'github'),
            }));
            const deployments = (backupData.tables.deployments || []).length;
            const cronJobs = (backupData.tables.cron_metadata || []).length;
            return {
                success: true,
                preview: {
                    metadata: backupData.metadata,
                    servers,
                    stacks,
                    domains,
                    databases,
                    gitAccounts,
                    deployments,
                    cronJobs,
                },
            };
        }
        catch (error) {
            console.error('Preview backup from S3 failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Preview failed',
            };
        }
    }
    /**
     * Delete a backup from S3
     */
    async deleteS3Backup(storageConfig, s3Key) {
        try {
            const result = await S3UploadService_1.s3UploadService.deleteBackup(storageConfig, s3Key);
            return result;
        }
        catch (error) {
            console.error('Delete S3 backup failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete backup',
            };
        }
    }
}
exports.BackupService = BackupService;
exports.backupService = new BackupService();
//# sourceMappingURL=BackupService.js.map