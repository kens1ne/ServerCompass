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
exports.registerBackupS3Handlers = registerBackupS3Handlers;
const electron_1 = require("electron");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const types_1 = require("./types");
const db_1 = require("../db");
const CredentialVault_1 = require("../services/CredentialVault");
const SecureStorageService_1 = require("../services/SecureStorageService");
const S3UploadService_1 = require("../services/S3UploadService");
const BackupService_1 = require("../services/BackupService");
const ServerBackupService_1 = require("../services/ServerBackupService");
const BackupSchedulerService_1 = require("../services/BackupSchedulerService");
const vault = new CredentialVault_1.CredentialVault();
const secureStorage = new SecureStorageService_1.SecureStorageService();
/**
 * Decrypt storage config credentials
 */
async function decryptStorageCredentials(encrypted) {
    const decrypted = await vault.decrypt(encrypted);
    return JSON.parse(decrypted);
}
/**
 * Encrypt storage config credentials
 */
async function encryptStorageCredentials(accessKey, secretKey) {
    const plain = JSON.stringify({ accessKey, secretKey });
    return vault.encrypt(plain);
}
/**
 * Map database row to decrypted config (without credentials)
 */
function mapRowToConfig(row) {
    return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        bucket: row.bucket,
        region: row.region,
        endpoint: row.endpoint,
        pathPrefix: row.path_prefix,
        isDefault: row.is_default === 1,
        lastTestedAt: row.last_tested_at,
        lastTestSuccess: row.last_test_success === null ? null : row.last_test_success === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
/**
 * Get full S3 config with decrypted credentials for S3 operations
 */
async function getS3ConfigWithCredentials(row) {
    const creds = await decryptStorageCredentials(row.encrypted_credentials);
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
// ============================================
// IPC Handlers
// ============================================
function registerBackupS3Handlers() {
    // ----------------------------------------
    // Storage Configuration Handlers
    // ----------------------------------------
    // List all storage configurations (without credentials)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_STORAGE_LIST, async () => {
        try {
            const rows = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs
        ORDER BY is_default DESC, created_at ASC
      `).all();
            const configs = rows.map(mapRowToConfig);
            return { success: true, data: configs };
        }
        catch (error) {
            console.error('[BackupS3] Failed to list storage configs:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list storage configurations',
            };
        }
    });
    // Create storage configuration
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_STORAGE_CREATE, async (_event, input) => {
        try {
            const parsed = types_1.BackupStorageConfigInputSchema.parse(input);
            const id = (0, crypto_1.randomUUID)();
            const now = Date.now();
            // Encrypt credentials
            const encryptedCreds = await encryptStorageCredentials(parsed.accessKey, parsed.secretKey);
            // If this is set as default, clear other defaults first
            if (parsed.isDefault) {
                db_1.db.prepare(`UPDATE backup_storage_configs SET is_default = 0`).run();
            }
            db_1.db.prepare(`
        INSERT INTO backup_storage_configs (
          id, name, provider, bucket, region, endpoint, path_prefix,
          encrypted_credentials, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, parsed.name, parsed.provider, parsed.bucket, parsed.region || null, parsed.endpoint || null, parsed.pathPrefix, encryptedCreds, parsed.isDefault ? 1 : 0, now, now);
            const row = db_1.db.prepare(`SELECT * FROM backup_storage_configs WHERE id = ?`).get(id);
            return { success: true, data: mapRowToConfig(row) };
        }
        catch (error) {
            console.error('[BackupS3] Failed to create storage config:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create storage configuration',
            };
        }
    });
    // Update storage configuration
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_STORAGE_UPDATE, async (_event, input) => {
        try {
            const parsed = types_1.BackupStorageUpdateSchema.parse(input);
            const { id, ...updates } = parsed;
            const now = Date.now();
            // Check if exists
            const existing = db_1.db.prepare(`SELECT * FROM backup_storage_configs WHERE id = ?`).get(id);
            if (!existing) {
                return { success: false, error: 'Storage configuration not found' };
            }
            // Build update fields
            const setFields = ['updated_at = ?'];
            const values = [now];
            if (updates.name !== undefined) {
                setFields.push('name = ?');
                values.push(updates.name);
            }
            if (updates.provider !== undefined) {
                setFields.push('provider = ?');
                values.push(updates.provider);
            }
            if (updates.bucket !== undefined) {
                setFields.push('bucket = ?');
                values.push(updates.bucket);
            }
            if (updates.region !== undefined) {
                setFields.push('region = ?');
                values.push(updates.region);
            }
            if (updates.endpoint !== undefined) {
                setFields.push('endpoint = ?');
                values.push(updates.endpoint);
            }
            if (updates.pathPrefix !== undefined) {
                setFields.push('path_prefix = ?');
                values.push(updates.pathPrefix);
            }
            // Handle credential updates
            if (updates.accessKey !== undefined || updates.secretKey !== undefined) {
                const existingCreds = await decryptStorageCredentials(existing.encrypted_credentials);
                const newCreds = await encryptStorageCredentials(updates.accessKey ?? existingCreds.accessKey, updates.secretKey ?? existingCreds.secretKey);
                setFields.push('encrypted_credentials = ?');
                values.push(newCreds);
            }
            // Handle default flag
            if (updates.isDefault !== undefined) {
                if (updates.isDefault) {
                    db_1.db.prepare(`UPDATE backup_storage_configs SET is_default = 0`).run();
                }
                setFields.push('is_default = ?');
                values.push(updates.isDefault ? 1 : 0);
            }
            values.push(id);
            db_1.db.prepare(`UPDATE backup_storage_configs SET ${setFields.join(', ')} WHERE id = ?`).run(...values);
            const row = db_1.db.prepare(`SELECT * FROM backup_storage_configs WHERE id = ?`).get(id);
            return { success: true, data: mapRowToConfig(row) };
        }
        catch (error) {
            console.error('[BackupS3] Failed to update storage config:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update storage configuration',
            };
        }
    });
    // Delete storage configuration
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_STORAGE_DELETE, async (_event, input) => {
        try {
            const { id } = types_1.BackupStorageConfigIdSchema.parse(input);
            const existing = db_1.db.prepare(`SELECT * FROM backup_storage_configs WHERE id = ?`).get(id);
            if (!existing) {
                return { success: false, error: 'Storage configuration not found' };
            }
            db_1.db.prepare(`DELETE FROM backup_storage_configs WHERE id = ?`).run(id);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to delete storage config:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete storage configuration',
            };
        }
    });
    // Test storage configuration connection
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_STORAGE_TEST, async (_event, input) => {
        try {
            const parsed = types_1.BackupStorageTestSchema.parse(input);
            const config = {
                name: 'test',
                provider: parsed.provider,
                bucket: parsed.bucket,
                region: parsed.region,
                endpoint: parsed.endpoint,
                accessKey: parsed.accessKey,
                secretKey: parsed.secretKey,
                pathPrefix: parsed.pathPrefix || 'servercompass-backups',
            };
            const result = await S3UploadService_1.s3UploadService.testConnection(config);
            if (result.success) {
                return { success: true, data: { latencyMs: result.latencyMs || 0 } };
            }
            return { success: false, error: result.error };
        }
        catch (error) {
            console.error('[BackupS3] Failed to test connection:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Connection test failed',
            };
        }
    });
    // Set default storage configuration
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_STORAGE_SET_DEFAULT, async (_event, input) => {
        try {
            const { id } = types_1.BackupStorageConfigIdSchema.parse(input);
            const existing = db_1.db.prepare(`SELECT * FROM backup_storage_configs WHERE id = ?`).get(id);
            if (!existing) {
                return { success: false, error: 'Storage configuration not found' };
            }
            db_1.db.prepare(`UPDATE backup_storage_configs SET is_default = 0`).run();
            db_1.db.prepare(`UPDATE backup_storage_configs SET is_default = 1 WHERE id = ?`).run(id);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to set default:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to set default',
            };
        }
    });
    // ----------------------------------------
    // Backup Passphrase Handlers (Per-Storage Config)
    // ----------------------------------------
    // Check if backup passphrase is set for a storage config
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_HAS, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({ storageConfigId: zod_1.z.string().optional() }).parse(input || {});
            const hasPassphrase = await secureStorage.hasBackupPassphrase(parsed.storageConfigId);
            return { success: true, data: hasPassphrase };
        }
        catch (error) {
            console.error('[BackupS3] Failed to check passphrase:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to check passphrase',
            };
        }
    });
    // Set backup passphrase for a storage config
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_SET, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                passphrase: zod_1.z.string().min(8),
                storageConfigId: zod_1.z.string().optional(),
            }).parse(input);
            await secureStorage.setBackupPassphrase(parsed.passphrase, parsed.storageConfigId);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to set passphrase:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to set passphrase',
            };
        }
    });
    // Clear backup passphrase for a storage config
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_CLEAR, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({ storageConfigId: zod_1.z.string().optional() }).parse(input || {});
            await secureStorage.clearBackupPassphrase(parsed.storageConfigId);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to clear passphrase:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to clear passphrase',
            };
        }
    });
    // Verify backup passphrase for a storage config
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_VERIFY, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                passphrase: zod_1.z.string(),
                storageConfigId: zod_1.z.string().optional(),
            }).parse(input);
            const stored = await secureStorage.getBackupPassphrase(parsed.storageConfigId);
            if (!stored) {
                return { success: false, error: 'No passphrase is set' };
            }
            const isMatch = parsed.passphrase === stored;
            return { success: true, data: isMatch };
        }
        catch (error) {
            console.error('[BackupS3] Failed to verify passphrase:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to verify passphrase',
            };
        }
    });
    // Get app backup schedule
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_GET_SCHEDULE, async () => {
        try {
            const row = db_1.db.prepare(`SELECT * FROM app_backup_schedules WHERE id = 'app-config'`).get();
            if (!row) {
                // Return default if not exists
                return {
                    success: true,
                    data: {
                        enabled: false,
                        storageConfigId: null,
                        frequency: 'daily',
                        time: '02:00',
                        dayOfWeek: null,
                        dayOfMonth: null,
                        timezone: 'UTC',
                        retentionCount: 30,
                        lastRunAt: null,
                        lastRunStatus: null,
                        lastRunError: null,
                        nextRunAt: null,
                    },
                };
            }
            return {
                success: true,
                data: {
                    enabled: row.enabled === 1,
                    storageConfigId: row.storage_config_id,
                    frequency: row.frequency,
                    time: row.time,
                    dayOfWeek: row.day_of_week,
                    dayOfMonth: row.day_of_month,
                    timezone: row.timezone,
                    retentionCount: row.retention_count,
                    lastRunAt: row.last_run_at,
                    lastRunStatus: row.last_run_status,
                    lastRunError: row.last_run_error,
                    nextRunAt: row.next_run_at,
                },
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to get app schedule:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get schedule',
            };
        }
    });
    // Update app backup schedule
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_UPDATE_SCHEDULE, async (_event, input) => {
        try {
            const parsed = types_1.AppBackupScheduleUpdateSchema.parse(input);
            const now = Date.now();
            const setFields = ['updated_at = ?'];
            const values = [now];
            if (parsed.enabled !== undefined) {
                setFields.push('enabled = ?');
                values.push(parsed.enabled ? 1 : 0);
            }
            if (parsed.storageConfigId !== undefined) {
                setFields.push('storage_config_id = ?');
                values.push(parsed.storageConfigId);
            }
            if (parsed.frequency !== undefined) {
                setFields.push('frequency = ?');
                values.push(parsed.frequency);
            }
            if (parsed.time !== undefined) {
                setFields.push('time = ?');
                values.push(parsed.time);
            }
            if (parsed.dayOfWeek !== undefined) {
                setFields.push('day_of_week = ?');
                values.push(parsed.dayOfWeek);
            }
            if (parsed.dayOfMonth !== undefined) {
                setFields.push('day_of_month = ?');
                values.push(parsed.dayOfMonth);
            }
            if (parsed.timezone !== undefined) {
                setFields.push('timezone = ?');
                values.push(parsed.timezone);
            }
            if (parsed.retentionCount !== undefined) {
                setFields.push('retention_count = ?');
                values.push(parsed.retentionCount);
            }
            db_1.db.prepare(`UPDATE app_backup_schedules SET ${setFields.join(', ')} WHERE id = 'app-config'`).run(...values);
            // Reload the schedule in the scheduler
            void BackupSchedulerService_1.backupSchedulerService.reloadSchedule('app_config');
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to update app schedule:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update schedule',
            };
        }
    });
    // Run app backup now
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_RUN_NOW, async (_event, input) => {
        try {
            // Get storage config (use provided or default)
            const parsed = zod_1.z.object({ storageConfigId: zod_1.z.string().optional() }).parse(input || {});
            let storageRow;
            if (parsed.storageConfigId) {
                storageRow = db_1.db.prepare(`
          SELECT * FROM backup_storage_configs WHERE id = ?
        `).get(parsed.storageConfigId);
            }
            else {
                storageRow = db_1.db.prepare(`
          SELECT * FROM backup_storage_configs WHERE is_default = 1
        `).get();
            }
            if (!storageRow) {
                return { success: false, error: 'No storage configuration available. Please add a cloud storage destination.' };
            }
            // Check passphrase is set for this storage config
            const hasPassphrase = await secureStorage.hasBackupPassphrase(storageRow.id);
            if (!hasPassphrase) {
                return { success: false, error: `Backup passphrase is not set for "${storageRow.name}". Please set a passphrase first.` };
            }
            // Get S3 config with credentials
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            // Get app backup schedule for retention count
            const schedule = db_1.db.prepare(`
        SELECT retention_count FROM app_backup_schedules WHERE id = 'app-config'
      `).get();
            const retentionCount = schedule?.retention_count || 30;
            console.log(`[BackupS3] Starting app config backup to ${storageRow.name}`);
            // Send progress to renderer
            const sendProgress = (progress, message) => {
                const windows = electron_1.BrowserWindow.getAllWindows();
                for (const win of windows) {
                    win.webContents.send(types_1.IPC_CHANNELS.BACKUP_PROGRESS, {
                        type: 'app_config',
                        progress,
                        message,
                    });
                }
            };
            // Execute backup
            const result = await BackupService_1.backupService.exportBackupToS3(s3Config, {
                retentionCount,
                onProgress: sendProgress,
            });
            if (!result.success) {
                console.error(`[BackupS3] App config backup failed: ${result.error}`);
                return {
                    success: false,
                    error: result.error || 'Backup failed',
                };
            }
            console.log(`[BackupS3] App config backup completed: ${result.s3Key}`);
            return {
                success: true,
                data: {
                    jobId: result.jobId,
                    s3Key: result.s3Key,
                },
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to run app backup:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to start backup',
            };
        }
    });
    // List app backup jobs
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_LIST_JOBS, async (_event, input) => {
        try {
            const parsed = types_1.ServerBackupListJobsSchema.parse(input || {});
            const rows = db_1.db.prepare(`
        SELECT * FROM backup_jobs
        WHERE job_type = 'app_config'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(parsed.limit || 50);
            return { success: true, data: rows };
        }
        catch (error) {
            console.error('[BackupS3] Failed to list app jobs:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list jobs',
            };
        }
    });
    // List app config backups from S3
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_LIST_FROM_S3, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                storageConfigId: zod_1.z.string().optional(),
                pathPrefix: zod_1.z.string().optional(),
            }).parse(input || {});
            // Get storage config (use provided or default)
            let storageRow;
            if (parsed.storageConfigId) {
                storageRow = db_1.db.prepare(`
          SELECT * FROM backup_storage_configs WHERE id = ?
        `).get(parsed.storageConfigId);
            }
            else {
                storageRow = db_1.db.prepare(`
          SELECT * FROM backup_storage_configs WHERE is_default = 1
        `).get();
            }
            if (!storageRow) {
                return { success: false, error: 'No storage configuration available' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            // Override pathPrefix if provided
            if (parsed.pathPrefix) {
                s3Config.pathPrefix = parsed.pathPrefix;
            }
            const result = await BackupService_1.backupService.listS3Backups(s3Config, 'app_config');
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: result.backups?.map((b) => ({
                    key: b.key,
                    lastModified: b.lastModified.toISOString(),
                    size: b.size,
                    // Extract filename from key
                    name: b.key.split('/').pop() || b.key,
                })) || [],
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to list app S3 backups:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list backups',
            };
        }
    });
    // Preview app config backup from S3
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_PREVIEW_FROM_S3, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                storageConfigId: zod_1.z.string(),
                s3Key: zod_1.z.string(),
            }).parse(input);
            const storageRow = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs WHERE id = ?
      `).get(parsed.storageConfigId);
            if (!storageRow) {
                return { success: false, error: 'Storage configuration not found' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            console.log(`[BackupS3] Previewing app config backup from ${parsed.s3Key}`);
            const result = await BackupService_1.backupService.previewBackupFromS3(s3Config, parsed.s3Key);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return { success: true, data: result.preview };
        }
        catch (error) {
            console.error('[BackupS3] Failed to preview app backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to preview backup',
            };
        }
    });
    // Import app config backup from S3
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_IMPORT_FROM_S3, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                storageConfigId: zod_1.z.string(),
                s3Key: zod_1.z.string(),
            }).parse(input);
            const storageRow = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs WHERE id = ?
      `).get(parsed.storageConfigId);
            if (!storageRow) {
                return { success: false, error: 'Storage configuration not found' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            console.log(`[BackupS3] Importing app config backup from ${parsed.s3Key}`);
            // Send progress to renderer
            const sendProgress = (progress, message) => {
                const windows = electron_1.BrowserWindow.getAllWindows();
                for (const win of windows) {
                    win.webContents.send(types_1.IPC_CHANNELS.BACKUP_PROGRESS, {
                        type: 'app_config_import',
                        progress,
                        message,
                    });
                }
            };
            const result = await BackupService_1.backupService.importBackupFromS3(s3Config, parsed.s3Key, sendProgress);
            if (!result.success) {
                console.error(`[BackupS3] Import failed: ${result.error}`);
                return { success: false, error: result.error };
            }
            console.log(`[BackupS3] App config backup imported successfully`);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to import app backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to import backup',
            };
        }
    });
    // Download app config backup from S3 to local machine
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_DOWNLOAD_FROM_S3, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                storageConfigId: zod_1.z.string(),
                s3Key: zod_1.z.string(),
            }).parse(input);
            const storageRow = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs WHERE id = ?
      `).get(parsed.storageConfigId);
            if (!storageRow) {
                return { success: false, error: 'Storage configuration not found' };
            }
            // Extract filename from s3Key
            const filename = parsed.s3Key.split('/').pop() || 'backup.scbackup';
            // Show save dialog
            const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
            const result = await dialog.showSaveDialog({
                title: 'Download Backup',
                defaultPath: filename,
                filters: [
                    { name: 'ServerCompass Backup', extensions: ['scbackup'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });
            if (result.canceled || !result.filePath) {
                return { success: false, error: 'Download cancelled' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            console.log(`[BackupS3] Downloading backup to ${result.filePath}`);
            // Send progress to renderer
            const sendProgress = (progress, message) => {
                const windows = electron_1.BrowserWindow.getAllWindows();
                for (const win of windows) {
                    win.webContents.send(types_1.IPC_CHANNELS.BACKUP_PROGRESS, {
                        type: 'app_config_download',
                        progress,
                        message,
                    });
                }
            };
            sendProgress(10, 'Starting download...');
            const downloadResult = await S3UploadService_1.s3UploadService.downloadFile(s3Config, parsed.s3Key, result.filePath, {
                onProgress: ({ loaded, total }) => {
                    const progress = Math.round((loaded / total) * 80) + 10;
                    sendProgress(progress, `Downloading... ${Math.round(loaded / 1024)}KB`);
                },
            });
            if (!downloadResult.success) {
                return { success: false, error: downloadResult.error };
            }
            sendProgress(100, 'Download complete');
            console.log(`[BackupS3] Backup downloaded to ${result.filePath}`);
            return { success: true, data: { localPath: result.filePath } };
        }
        catch (error) {
            console.error('[BackupS3] Failed to download backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to download backup',
            };
        }
    });
    // Delete app config backup from S3
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_APP_DELETE_FROM_S3, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                storageConfigId: zod_1.z.string(),
                s3Key: zod_1.z.string(),
            }).parse(input);
            const storageRow = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs WHERE id = ?
      `).get(parsed.storageConfigId);
            if (!storageRow) {
                return { success: false, error: 'Storage configuration not found' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            const result = await BackupService_1.backupService.deleteS3Backup(s3Config, parsed.s3Key);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            console.log(`[BackupS3] Deleted app config backup: ${parsed.s3Key}`);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to delete app backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete backup',
            };
        }
    });
    // ----------------------------------------
    // Server Backup Config Handlers
    // ----------------------------------------
    // Get server backup config
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_GET_CONFIG, async (_event, input) => {
        try {
            const { serverId } = zod_1.z.object({ serverId: zod_1.z.string() }).parse(input);
            const row = db_1.db.prepare(`
        SELECT * FROM server_backup_configs WHERE server_id = ?
      `).get(serverId);
            if (!row) {
                // Return default config
                return {
                    success: true,
                    data: {
                        serverId,
                        enabled: false,
                        storageConfigId: null,
                        frequency: 'daily',
                        time: '03:00',
                        dayOfWeek: null,
                        dayOfMonth: null,
                        timezone: 'UTC',
                        retentionCount: 7,
                        backupVolumes: true,
                        backupDatabases: true,
                        backupComposeFiles: true,
                        backupEnvFiles: true,
                        backupSslCerts: false,
                        backupCronJobs: false,
                        stopContainersForConsistency: true,
                        exclusions: [],
                        lastRunAt: null,
                        lastRunStatus: null,
                        lastRunError: null,
                        nextRunAt: null,
                    },
                };
            }
            // Get exclusions
            const exclusions = db_1.db.prepare(`
        SELECT exclusion_type, exclusion_value FROM server_backup_exclusions
        WHERE server_backup_config_id = ?
      `).all(row.id);
            return {
                success: true,
                data: {
                    id: row.id,
                    serverId: row.server_id,
                    enabled: row.enabled === 1,
                    storageConfigId: row.storage_config_id,
                    frequency: row.frequency,
                    time: row.time,
                    dayOfWeek: row.day_of_week,
                    dayOfMonth: row.day_of_month,
                    timezone: row.timezone,
                    retentionCount: row.retention_count,
                    backupVolumes: row.backup_volumes === 1,
                    backupDatabases: row.backup_databases === 1,
                    backupComposeFiles: row.backup_compose_files === 1,
                    backupEnvFiles: row.backup_env_files === 1,
                    backupSslCerts: row.backup_ssl_certs === 1,
                    backupCronJobs: row.backup_cron_jobs === 1,
                    stopContainersForConsistency: row.stop_containers_for_consistency === 1,
                    exclusions: exclusions.map((e) => ({ type: e.exclusion_type, value: e.exclusion_value })),
                    lastRunAt: row.last_run_at,
                    lastRunStatus: row.last_run_status,
                    lastRunError: row.last_run_error,
                    nextRunAt: row.next_run_at,
                },
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to get server config:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get config',
            };
        }
    });
    // Update server backup config
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_UPDATE_CONFIG, async (_event, input) => {
        try {
            const parsed = types_1.ServerBackupConfigUpdateSchema.parse(input);
            const { serverId, exclusions, ...updates } = parsed;
            const now = Date.now();
            // Check if config exists
            let row = db_1.db.prepare(`SELECT * FROM server_backup_configs WHERE server_id = ?`).get(serverId);
            if (!row) {
                // Create new config
                const id = (0, crypto_1.randomUUID)();
                db_1.db.prepare(`
          INSERT INTO server_backup_configs (id, server_id, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(id, serverId, now, now);
                row = { id };
            }
            // Build update
            const setFields = ['updated_at = ?'];
            const values = [now];
            if (updates.enabled !== undefined) {
                setFields.push('enabled = ?');
                values.push(updates.enabled ? 1 : 0);
            }
            if (updates.storageConfigId !== undefined) {
                setFields.push('storage_config_id = ?');
                values.push(updates.storageConfigId);
            }
            if (updates.frequency !== undefined) {
                setFields.push('frequency = ?');
                values.push(updates.frequency);
            }
            if (updates.time !== undefined) {
                setFields.push('time = ?');
                values.push(updates.time);
            }
            if (updates.dayOfWeek !== undefined) {
                setFields.push('day_of_week = ?');
                values.push(updates.dayOfWeek);
            }
            if (updates.dayOfMonth !== undefined) {
                setFields.push('day_of_month = ?');
                values.push(updates.dayOfMonth);
            }
            if (updates.timezone !== undefined) {
                setFields.push('timezone = ?');
                values.push(updates.timezone);
            }
            if (updates.retentionCount !== undefined) {
                setFields.push('retention_count = ?');
                values.push(updates.retentionCount);
            }
            if (updates.backupVolumes !== undefined) {
                setFields.push('backup_volumes = ?');
                values.push(updates.backupVolumes ? 1 : 0);
            }
            if (updates.backupDatabases !== undefined) {
                setFields.push('backup_databases = ?');
                values.push(updates.backupDatabases ? 1 : 0);
            }
            if (updates.backupComposeFiles !== undefined) {
                setFields.push('backup_compose_files = ?');
                values.push(updates.backupComposeFiles ? 1 : 0);
            }
            if (updates.backupEnvFiles !== undefined) {
                setFields.push('backup_env_files = ?');
                values.push(updates.backupEnvFiles ? 1 : 0);
            }
            if (updates.backupSslCerts !== undefined) {
                setFields.push('backup_ssl_certs = ?');
                values.push(updates.backupSslCerts ? 1 : 0);
            }
            if (updates.backupCronJobs !== undefined) {
                setFields.push('backup_cron_jobs = ?');
                values.push(updates.backupCronJobs ? 1 : 0);
            }
            if (updates.stopContainersForConsistency !== undefined) {
                setFields.push('stop_containers_for_consistency = ?');
                values.push(updates.stopContainersForConsistency ? 1 : 0);
            }
            values.push(row.id);
            db_1.db.prepare(`UPDATE server_backup_configs SET ${setFields.join(', ')} WHERE id = ?`).run(...values);
            // Update exclusions if provided
            if (exclusions !== undefined) {
                db_1.db.prepare(`DELETE FROM server_backup_exclusions WHERE server_backup_config_id = ?`).run(row.id);
                for (const exclusion of exclusions) {
                    db_1.db.prepare(`
            INSERT INTO server_backup_exclusions (id, server_backup_config_id, exclusion_type, exclusion_value, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run((0, crypto_1.randomUUID)(), row.id, exclusion.type, exclusion.value, now);
                }
            }
            // Reload the schedule in the scheduler
            void BackupSchedulerService_1.backupSchedulerService.reloadSchedule('server', serverId);
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to update server config:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update config',
            };
        }
    });
    // Run server backup now
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_RUN_NOW, async (_event, input) => {
        try {
            const parsed = types_1.ServerBackupRunNowSchema.parse(input);
            // Get storage config ID and name
            let storageConfigId;
            let storageConfigName;
            if (parsed.storageConfigId) {
                const storage = db_1.db.prepare(`
          SELECT id, name FROM backup_storage_configs WHERE id = ?
        `).get(parsed.storageConfigId);
                if (!storage) {
                    return { success: false, error: 'Storage configuration not found.' };
                }
                storageConfigId = storage.id;
                storageConfigName = storage.name;
            }
            else {
                const defaultStorage = db_1.db.prepare(`
          SELECT id, name FROM backup_storage_configs WHERE is_default = 1
        `).get();
                if (!defaultStorage) {
                    return { success: false, error: 'No storage configuration available. Please add a cloud storage destination.' };
                }
                storageConfigId = defaultStorage.id;
                storageConfigName = defaultStorage.name;
            }
            // Check passphrase is set for this storage config
            const hasPassphrase = await secureStorage.hasBackupPassphrase(storageConfigId);
            if (!hasPassphrase) {
                return { success: false, error: `Backup passphrase is not set for "${storageConfigName}". Please set a passphrase first.` };
            }
            // Get server backup config for options
            const backupConfig = db_1.db.prepare(`
        SELECT * FROM server_backup_configs WHERE server_id = ?
      `).get(parsed.serverId);
            // Get exclusions
            let excludedStacks = [];
            let excludedVolumes = [];
            let excludedDatabases = [];
            if (backupConfig) {
                const exclusions = db_1.db.prepare(`
          SELECT exclusion_type, exclusion_value FROM server_backup_exclusions
          WHERE server_backup_config_id = (SELECT id FROM server_backup_configs WHERE server_id = ?)
        `).all(parsed.serverId);
                for (const ex of exclusions) {
                    if (ex.exclusion_type === 'stack')
                        excludedStacks.push(ex.exclusion_value);
                    if (ex.exclusion_type === 'volume')
                        excludedVolumes.push(ex.exclusion_value);
                    if (ex.exclusion_type === 'database')
                        excludedDatabases.push(ex.exclusion_value);
                }
            }
            console.log(`[BackupS3] Starting server backup for server ${parsed.serverId}`);
            // Run backup (this runs synchronously but emits progress events)
            const result = await ServerBackupService_1.serverBackupService.runBackup({
                serverId: parsed.serverId,
                storageConfigId,
                backupVolumes: backupConfig?.backup_volumes !== 0,
                backupDatabases: backupConfig?.backup_databases !== 0,
                backupComposeFiles: backupConfig?.backup_compose_files !== 0,
                backupEnvFiles: backupConfig?.backup_env_files !== 0,
                backupSslCerts: backupConfig?.backup_ssl_certs === 1,
                backupCronJobs: backupConfig?.backup_cron_jobs === 1,
                stopContainersForConsistency: backupConfig?.stop_containers_for_consistency === 1,
                excludedStacks,
                excludedVolumes,
                excludedDatabases,
                retentionCount: backupConfig?.retention_count || 7,
            });
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: {
                    jobId: result.jobId,
                    manifestKey: result.manifestKey,
                },
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to run server backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to start backup',
            };
        }
    });
    // Cancel server backup
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_CANCEL, async (_event, input) => {
        try {
            const { jobId } = types_1.ServerBackupCancelSchema.parse(input);
            const row = db_1.db.prepare(`SELECT * FROM backup_jobs WHERE id = ?`).get(jobId);
            if (!row) {
                return { success: false, error: 'Backup job not found' };
            }
            if (row.status !== 'pending' && row.status !== 'running') {
                return { success: false, error: 'Job cannot be cancelled in its current state' };
            }
            // Signal ServerBackupService to cancel the running backup
            const cancelled = ServerBackupService_1.serverBackupService.cancelBackup(jobId);
            if (cancelled) {
                // Job was actively running, service will update the status
                console.log(`[BackupS3] Cancelled running backup job: ${jobId}`);
            }
            else {
                // Job wasn't actively running (maybe pending), update status directly
                db_1.db.prepare(`
          UPDATE backup_jobs SET status = 'cancelled', completed_at = ? WHERE id = ?
        `).run(Date.now(), jobId);
            }
            return { success: true };
        }
        catch (error) {
            console.error('[BackupS3] Failed to cancel backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to cancel backup',
            };
        }
    });
    // List server backup jobs
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_LIST_JOBS, async (_event, input) => {
        try {
            const parsed = types_1.ServerBackupListJobsSchema.parse(input || {});
            let query = `
        SELECT * FROM backup_jobs
        WHERE job_type = 'server_data'
      `;
            const params = [];
            if (parsed.serverId) {
                query += ` AND server_id = ?`;
                params.push(parsed.serverId);
            }
            query += ` ORDER BY created_at DESC LIMIT ?`;
            params.push(parsed.limit || 50);
            const rows = db_1.db.prepare(query).all(...params);
            return { success: true, data: rows };
        }
        catch (error) {
            console.error('[BackupS3] Failed to list server jobs:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list jobs',
            };
        }
    });
    // List backups from S3 for a server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_LIST_FROM_S3, async (_event, input) => {
        try {
            const parsed = types_1.BackupListFromS3Schema.parse(input);
            const storageRow = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs WHERE id = ?
      `).get(parsed.storageConfigId);
            if (!storageRow) {
                return { success: false, error: 'Storage configuration not found' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            const result = await ServerBackupService_1.serverBackupService.listBackups(s3Config, parsed.serverId);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return {
                success: true,
                data: result.backups?.map((b) => ({
                    timestamp: b.timestamp,
                    manifestKey: b.manifestKey,
                    size: b.size,
                    lastModified: b.lastModified.toISOString(),
                })) || [],
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to list S3 backups:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list backups',
            };
        }
    });
    // Get backup manifest from S3
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_GET_MANIFEST, async (_event, input) => {
        try {
            const parsed = zod_1.z.object({
                storageConfigId: zod_1.z.string(),
                manifestKey: zod_1.z.string(),
            }).parse(input);
            const storageRow = db_1.db.prepare(`
        SELECT * FROM backup_storage_configs WHERE id = ?
      `).get(parsed.storageConfigId);
            if (!storageRow) {
                return { success: false, error: 'Storage configuration not found' };
            }
            const s3Config = await getS3ConfigWithCredentials(storageRow);
            const result = await ServerBackupService_1.serverBackupService.getManifest(s3Config, parsed.manifestKey);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            return { success: true, data: result.manifest };
        }
        catch (error) {
            console.error('[BackupS3] Failed to get manifest:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get manifest',
            };
        }
    });
    // Restore server backup from S3
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BACKUP_SERVER_RESTORE, async (_event, input) => {
        try {
            const parsed = types_1.ServerBackupRestoreSchema.parse(input);
            console.log(`[BackupS3] Starting restore for server ${parsed.serverId} from ${parsed.manifestKey}`);
            const result = await ServerBackupService_1.serverBackupService.restoreBackup({
                serverId: parsed.serverId,
                storageConfigId: parsed.storageConfigId,
                manifestKey: parsed.manifestKey,
                restoreVolumes: parsed.restoreVolumes,
                restoreDatabases: parsed.restoreDatabases,
                restoreComposeFiles: parsed.restoreComposeFiles,
                restoreEnvFiles: parsed.restoreEnvFiles,
                restoreSslCerts: parsed.restoreSslCerts,
                restoreCronJobs: parsed.restoreCronJobs,
                selectedVolumes: parsed.selectedVolumes,
                selectedDatabases: parsed.selectedDatabases,
                selectedStacks: parsed.selectedStacks,
                stopContainersFirst: parsed.stopContainersFirst,
            });
            if (!result.success) {
                console.error(`[BackupS3] Restore failed: ${result.error}`);
                return {
                    success: false,
                    error: result.error,
                };
            }
            console.log(`[BackupS3] Restore completed: ${JSON.stringify(result.restoredItems)}`);
            return {
                success: true,
                data: {
                    jobId: result.jobId,
                    restoredItems: result.restoredItems,
                    warnings: result.warnings,
                },
            };
        }
        catch (error) {
            console.error('[BackupS3] Failed to restore backup:', error);
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to restore backup',
            };
        }
    });
}
//# sourceMappingURL=backup-s3.js.map