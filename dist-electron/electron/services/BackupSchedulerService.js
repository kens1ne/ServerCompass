"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backupSchedulerService = exports.BackupSchedulerService = void 0;
const events_1 = require("events");
const db_1 = require("../db");
const types_1 = require("../ipc/types");
const BackupService_1 = require("./BackupService");
const ServerBackupService_1 = require("./ServerBackupService");
const CredentialVault_1 = require("./CredentialVault");
const SecureStorageService_1 = require("./SecureStorageService");
/**
 * BackupSchedulerService
 *
 * Manages automated backup scheduling for both app config and server data backups.
 * Features:
 * - setTimeout with max delay handling (JavaScript limit: 2,147,483,647ms)
 * - Per-target locking to prevent overlapping backups
 * - Concurrency limit via queue (maxConcurrentBackups = 1)
 * - IANA timezone support for DST-safe scheduling
 * - Graceful shutdown
 */
// JavaScript setTimeout max delay (24.8 days)
const MAX_TIMEOUT_MS = 2_147_483_647;
// Check interval for missed backups (1 hour)
const MISSED_BACKUP_CHECK_INTERVAL = 60 * 60 * 1000;
class BackupSchedulerService extends events_1.EventEmitter {
    mainWindow = null;
    tasks = new Map();
    runningBackups = new Set();
    maxConcurrentBackups = 1;
    isShuttingDown = false;
    missedBackupCheckInterval = null;
    vault = new CredentialVault_1.CredentialVault();
    secureStorage = new SecureStorageService_1.SecureStorageService();
    setMainWindow(window) {
        this.mainWindow = window;
    }
    /**
     * Initialize the scheduler - load all enabled schedules and set up timers
     */
    async initialize() {
        console.log('[BackupScheduler] Initializing...');
        // Load and schedule app config backup
        await this.loadAppConfigSchedule();
        // Load and schedule all server backups
        await this.loadServerBackupSchedules();
        // Set up periodic check for missed backups
        this.missedBackupCheckInterval = setInterval(() => {
            void this.checkMissedBackups();
        }, MISSED_BACKUP_CHECK_INTERVAL);
        // Do an initial check for missed backups
        void this.checkMissedBackups();
        console.log('[BackupScheduler] Initialized with', this.tasks.size, 'scheduled tasks');
    }
    /**
     * Gracefully shutdown the scheduler
     */
    shutdown() {
        console.log('[BackupScheduler] Shutting down...');
        this.isShuttingDown = true;
        // Clear missed backup check interval
        if (this.missedBackupCheckInterval) {
            clearInterval(this.missedBackupCheckInterval);
            this.missedBackupCheckInterval = null;
        }
        // Clear all scheduled timeouts
        for (const task of this.tasks.values()) {
            if (task.timeoutId) {
                clearTimeout(task.timeoutId);
            }
        }
        this.tasks.clear();
        console.log('[BackupScheduler] Shutdown complete');
    }
    /**
     * Reload a specific schedule (called when schedule is updated via IPC)
     */
    async reloadSchedule(type, serverId) {
        const taskKey = this.getTaskKey(type, serverId);
        // Cancel existing task
        const existingTask = this.tasks.get(taskKey);
        if (existingTask?.timeoutId) {
            clearTimeout(existingTask.timeoutId);
        }
        this.tasks.delete(taskKey);
        // Reload the schedule
        if (type === 'app_config') {
            await this.loadAppConfigSchedule();
        }
        else if (serverId) {
            await this.loadServerBackupSchedule(serverId);
        }
    }
    /**
     * Check if a backup is currently running for a target
     */
    isBackupRunning(type, serverId) {
        const lockKey = this.getLockKey(type, serverId);
        return this.runningBackups.has(lockKey);
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Private: Schedule Loading
    // ─────────────────────────────────────────────────────────────────────────────
    async loadAppConfigSchedule() {
        try {
            const schedule = db_1.db
                .prepare('SELECT * FROM app_backup_schedules WHERE id = ?')
                .get('app-config');
            if (!schedule || !schedule.enabled || !schedule.storage_config_id) {
                console.log('[BackupScheduler] App config backup not enabled or no storage configured');
                return;
            }
            const nextRunAt = this.calculateNextRun(schedule);
            await this.scheduleTask('app_config', undefined, nextRunAt);
            // Update next_run_at in database
            db_1.db.prepare('UPDATE app_backup_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, Date.now(), 'app-config');
        }
        catch (error) {
            console.error('[BackupScheduler] Failed to load app config schedule:', error);
        }
    }
    async loadServerBackupSchedules() {
        try {
            const schedules = db_1.db
                .prepare('SELECT * FROM server_backup_configs WHERE enabled = 1 AND storage_config_id IS NOT NULL')
                .all();
            for (const schedule of schedules) {
                const nextRunAt = this.calculateNextRun(schedule);
                await this.scheduleTask('server', schedule.server_id, nextRunAt);
                // Update next_run_at in database
                db_1.db.prepare('UPDATE server_backup_configs SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, Date.now(), schedule.id);
            }
        }
        catch (error) {
            console.error('[BackupScheduler] Failed to load server backup schedules:', error);
        }
    }
    async loadServerBackupSchedule(serverId) {
        try {
            const schedule = db_1.db
                .prepare('SELECT * FROM server_backup_configs WHERE server_id = ?')
                .get(serverId);
            if (!schedule || !schedule.enabled || !schedule.storage_config_id) {
                console.log('[BackupScheduler] Server backup not enabled for server:', serverId);
                return;
            }
            const nextRunAt = this.calculateNextRun(schedule);
            await this.scheduleTask('server', serverId, nextRunAt);
            // Update next_run_at in database
            db_1.db.prepare('UPDATE server_backup_configs SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, Date.now(), schedule.id);
        }
        catch (error) {
            console.error('[BackupScheduler] Failed to load server backup schedule:', error);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Private: Task Scheduling
    // ─────────────────────────────────────────────────────────────────────────────
    async scheduleTask(type, serverId, nextRunAt) {
        const taskKey = this.getTaskKey(type, serverId);
        const now = Date.now();
        let delay = nextRunAt - now;
        // If the scheduled time is in the past, schedule for minimum interval from now
        if (delay < 0) {
            console.log(`[BackupScheduler] Calculated next run for ${taskKey} is in the past (delay: ${delay}ms), rescheduling`);
            delay = BackupSchedulerService.MIN_INTERVAL_MS; // Use minimum interval instead of 1 second
        }
        // Handle JavaScript setTimeout max delay limitation
        // If delay exceeds MAX_TIMEOUT_MS, schedule a re-check instead
        if (delay > MAX_TIMEOUT_MS) {
            const recheckDelay = MAX_TIMEOUT_MS;
            const timeoutId = setTimeout(() => {
                void this.scheduleTask(type, serverId, nextRunAt);
            }, recheckDelay);
            this.tasks.set(taskKey, {
                id: taskKey,
                type,
                serverId,
                nextRunAt,
                timeoutId,
            });
            console.log(`[BackupScheduler] Scheduled re-check for ${taskKey} in ${Math.round(recheckDelay / 1000 / 60 / 60)} hours`);
            return;
        }
        const timeoutId = setTimeout(() => {
            void this.executeScheduledBackup(type, serverId);
        }, delay);
        this.tasks.set(taskKey, {
            id: taskKey,
            type,
            serverId,
            nextRunAt,
            timeoutId,
        });
        const nextRunDate = new Date(nextRunAt).toISOString();
        console.log(`[BackupScheduler] Scheduled ${taskKey} for ${nextRunDate} (in ${Math.round(delay / 1000 / 60)} minutes)`);
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Private: Backup Execution
    // ─────────────────────────────────────────────────────────────────────────────
    // Track last run time to prevent rapid re-execution
    lastRunTimes = new Map();
    static MIN_INTERVAL_MS = 5 * 60 * 1000; // Minimum 5 minutes between backups
    async executeScheduledBackup(type, serverId) {
        if (this.isShuttingDown) {
            console.log('[BackupScheduler] Shutdown in progress, skipping backup');
            return;
        }
        const lockKey = this.getLockKey(type, serverId);
        const taskKey = this.getTaskKey(type, serverId);
        // Check minimum interval to prevent rapid re-execution
        const lastRun = this.lastRunTimes.get(taskKey);
        const now = Date.now();
        if (lastRun && (now - lastRun) < BackupSchedulerService.MIN_INTERVAL_MS) {
            const waitTime = BackupSchedulerService.MIN_INTERVAL_MS - (now - lastRun);
            console.log(`[BackupScheduler] Too soon to run ${taskKey} again, waiting ${Math.round(waitTime / 1000)}s`);
            // Re-schedule after the minimum interval
            await this.scheduleTask(type, serverId, now + waitTime);
            return;
        }
        // Check concurrency limit
        if (this.runningBackups.size >= this.maxConcurrentBackups) {
            console.log(`[BackupScheduler] Max concurrent backups reached, queuing ${taskKey}`);
            // Re-schedule for 5 minutes later
            await this.scheduleTask(type, serverId, Date.now() + 5 * 60 * 1000);
            return;
        }
        // Check if already running
        if (this.runningBackups.has(lockKey)) {
            console.log(`[BackupScheduler] Backup already running for ${taskKey}`);
            return;
        }
        // Acquire lock and record last run time
        this.runningBackups.add(lockKey);
        this.lastRunTimes.set(taskKey, Date.now());
        console.log(`[BackupScheduler] Starting scheduled backup: ${taskKey}`);
        try {
            if (type === 'app_config') {
                await this.executeAppConfigBackup();
            }
            else if (serverId) {
                await this.executeServerBackup(serverId);
            }
        }
        catch (error) {
            console.error(`[BackupScheduler] Backup failed for ${taskKey}:`, error);
        }
        finally {
            // Release lock
            this.runningBackups.delete(lockKey);
            // Schedule next run
            if (type === 'app_config') {
                await this.loadAppConfigSchedule();
            }
            else if (serverId) {
                await this.loadServerBackupSchedule(serverId);
            }
        }
    }
    async executeAppConfigBackup() {
        const schedule = db_1.db
            .prepare('SELECT * FROM app_backup_schedules WHERE id = ?')
            .get('app-config');
        if (!schedule || !schedule.storage_config_id) {
            throw new Error('App config schedule not found or no storage configured');
        }
        // Check if passphrase is available
        const hasPassphrase = await this.secureStorage.hasBackupPassphrase();
        if (!hasPassphrase) {
            console.log('[BackupScheduler] No backup passphrase set, marking as blocked');
            db_1.db.prepare(`
        UPDATE app_backup_schedules
        SET last_run_at = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), 'blocked', 'Backup passphrase not set', Date.now(), 'app-config');
            return;
        }
        // Get storage config
        const storageConfig = await this.getStorageConfig(schedule.storage_config_id);
        if (!storageConfig) {
            throw new Error('Storage config not found');
        }
        // Execute backup
        const result = await BackupService_1.backupService.exportBackupToS3(storageConfig, {
            retentionCount: schedule.retention_count,
            onProgress: (progress, message) => {
                this.sendProgressEvent('app_config', undefined, progress, message);
            },
        });
        // Update schedule status
        const now = Date.now();
        if (result.success) {
            db_1.db.prepare(`
        UPDATE app_backup_schedules
        SET last_run_at = ?, last_run_status = ?, last_run_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, 'success', now, 'app-config');
        }
        else {
            db_1.db.prepare(`
        UPDATE app_backup_schedules
        SET last_run_at = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
        WHERE id = ?
      `).run(now, 'failed', result.error || 'Unknown error', now, 'app-config');
        }
        // Update backup_jobs record
        if (result.jobId) {
            db_1.db.prepare(`
        UPDATE backup_jobs
        SET triggered_by = ?
        WHERE id = ?
      `).run('scheduled', result.jobId);
        }
    }
    async executeServerBackup(serverId) {
        const config = db_1.db
            .prepare('SELECT * FROM server_backup_configs WHERE server_id = ?')
            .get(serverId);
        if (!config || !config.storage_config_id) {
            throw new Error('Server backup config not found or no storage configured');
        }
        // Check if passphrase is available
        const hasPassphrase = await this.secureStorage.hasBackupPassphrase();
        if (!hasPassphrase) {
            console.log('[BackupScheduler] No backup passphrase set, marking as blocked');
            db_1.db.prepare(`
        UPDATE server_backup_configs
        SET last_run_at = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), 'blocked', 'Backup passphrase not set', Date.now(), config.id);
            return;
        }
        // Get exclusions
        const exclusions = db_1.db
            .prepare('SELECT exclusion_type, exclusion_value FROM server_backup_exclusions WHERE server_backup_config_id = ?')
            .all(config.id);
        const excludedStacks = exclusions.filter(e => e.exclusion_type === 'stack').map(e => e.exclusion_value);
        const excludedVolumes = exclusions.filter(e => e.exclusion_type === 'volume').map(e => e.exclusion_value);
        const excludedDatabases = exclusions.filter(e => e.exclusion_type === 'database').map(e => e.exclusion_value);
        // Execute backup (ServerBackupService generates its own jobId and gets storage config internally)
        const result = await ServerBackupService_1.serverBackupService.runBackup({
            serverId,
            storageConfigId: config.storage_config_id,
            backupVolumes: config.backup_volumes === 1,
            backupDatabases: config.backup_databases === 1,
            backupComposeFiles: config.backup_compose_files === 1,
            backupEnvFiles: config.backup_env_files === 1,
            backupSslCerts: config.backup_ssl_certs === 1,
            backupCronJobs: config.backup_cron_jobs === 1,
            stopContainersForConsistency: config.stop_containers_for_consistency === 1,
            excludedStacks,
            excludedVolumes,
            excludedDatabases,
            retentionCount: config.retention_count,
        });
        // Update config status
        const now = Date.now();
        if (result.success) {
            db_1.db.prepare(`
        UPDATE server_backup_configs
        SET last_run_at = ?, last_run_status = ?, last_run_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, 'success', now, config.id);
        }
        else {
            db_1.db.prepare(`
        UPDATE server_backup_configs
        SET last_run_at = ?, last_run_status = ?, last_run_error = ?, updated_at = ?
        WHERE id = ?
      `).run(now, 'failed', result.error || 'Unknown error', now, config.id);
        }
        // Update backup_jobs record
        if (result.jobId) {
            db_1.db.prepare(`
        UPDATE backup_jobs
        SET triggered_by = ?
        WHERE id = ?
      `).run('scheduled', result.jobId);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Private: Missed Backup Check
    // ─────────────────────────────────────────────────────────────────────────────
    async checkMissedBackups() {
        if (this.isShuttingDown)
            return;
        const now = Date.now();
        // Check app config backup
        try {
            const schedule = db_1.db
                .prepare('SELECT * FROM app_backup_schedules WHERE id = ?')
                .get('app-config');
            if (schedule?.enabled && schedule.storage_config_id && schedule.next_run_at) {
                if (schedule.next_run_at < now) {
                    console.log('[BackupScheduler] Found missed app config backup, triggering now');
                    void this.executeScheduledBackup('app_config', undefined);
                }
            }
        }
        catch (error) {
            console.error('[BackupScheduler] Error checking missed app config backup:', error);
        }
        // Check server backups
        try {
            const configs = db_1.db
                .prepare('SELECT * FROM server_backup_configs WHERE enabled = 1 AND storage_config_id IS NOT NULL AND next_run_at < ?')
                .all(now);
            for (const config of configs) {
                console.log(`[BackupScheduler] Found missed server backup for ${config.server_id}, triggering now`);
                void this.executeScheduledBackup('server', config.server_id);
            }
        }
        catch (error) {
            console.error('[BackupScheduler] Error checking missed server backups:', error);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Private: Helpers
    // ─────────────────────────────────────────────────────────────────────────────
    getTaskKey(type, serverId) {
        return type === 'app_config' ? 'app_config' : `server:${serverId}`;
    }
    getLockKey(type, serverId) {
        return this.getTaskKey(type, serverId);
    }
    async getStorageConfig(configId) {
        try {
            const row = db_1.db
                .prepare('SELECT * FROM backup_storage_configs WHERE id = ?')
                .get(configId);
            if (!row)
                return null;
            // Decrypt credentials
            const decrypted = await this.vault.decrypt(row.encrypted_credentials);
            const credentials = JSON.parse(decrypted);
            return {
                id: row.id,
                name: row.name,
                provider: row.provider,
                bucket: row.bucket,
                region: row.region || undefined,
                endpoint: row.endpoint || undefined,
                pathPrefix: row.path_prefix,
                accessKey: credentials.accessKey,
                secretKey: credentials.secretKey,
            };
        }
        catch (error) {
            console.error('[BackupScheduler] Failed to get storage config:', error);
            return null;
        }
    }
    /**
     * Calculate the next run time based on schedule configuration
     * Uses IANA timezone for DST-safe scheduling
     */
    calculateNextRun(schedule) {
        const { frequency, time, day_of_week, day_of_month, timezone } = schedule;
        // Parse time (HH:MM format)
        const [hours, minutes] = time.split(':').map(Number);
        // Get current time in the specified timezone
        const now = new Date();
        // Create a date in the target timezone
        // Note: We use toLocaleString to get the current time in the target timezone,
        // then parse it back to get the correct offset
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const getPart = (type) => parts.find(p => p.type === type)?.value || '0';
        const currentYear = parseInt(getPart('year'));
        const currentMonth = parseInt(getPart('month')) - 1;
        const currentDay = parseInt(getPart('day'));
        const currentHour = parseInt(getPart('hour'));
        const currentMinute = parseInt(getPart('minute'));
        const currentDayOfWeek = new Date(currentYear, currentMonth, currentDay).getDay();
        // Start with today at the scheduled time
        let nextRun = new Date(currentYear, currentMonth, currentDay, hours, minutes, 0, 0);
        // If the scheduled time has already passed today, start from tomorrow
        if (currentHour > hours || (currentHour === hours && currentMinute >= minutes)) {
            nextRun.setDate(nextRun.getDate() + 1);
        }
        switch (frequency) {
            case 'hourly':
                // Run at the specified minutes past each hour
                nextRun = new Date(currentYear, currentMonth, currentDay, currentHour, minutes, 0, 0);
                if (currentMinute >= minutes) {
                    nextRun.setHours(nextRun.getHours() + 1);
                }
                break;
            case 'daily':
                // Already handled above
                break;
            case 'weekly':
                if (day_of_week !== null) {
                    // Find the next occurrence of the specified day
                    let daysUntil = day_of_week - currentDayOfWeek;
                    if (daysUntil < 0 || (daysUntil === 0 && (currentHour > hours || (currentHour === hours && currentMinute >= minutes)))) {
                        daysUntil += 7;
                    }
                    nextRun = new Date(currentYear, currentMonth, currentDay + daysUntil, hours, minutes, 0, 0);
                }
                break;
            case 'monthly':
                if (day_of_month !== null) {
                    // Find the next occurrence of the specified day of month
                    nextRun = new Date(currentYear, currentMonth, day_of_month, hours, minutes, 0, 0);
                    if (nextRun.getTime() <= now.getTime()) {
                        // Move to next month
                        nextRun.setMonth(nextRun.getMonth() + 1);
                    }
                    // Handle months with fewer days
                    if (nextRun.getDate() !== day_of_month) {
                        // Day doesn't exist in this month, use last day
                        nextRun.setDate(0);
                    }
                }
                break;
        }
        // Convert back to UTC timestamp
        // We need to account for the timezone offset
        const tzOffset = this.getTimezoneOffset(nextRun, timezone);
        return nextRun.getTime() + tzOffset;
    }
    /**
     * Get the timezone offset in milliseconds for a given date and timezone
     */
    getTimezoneOffset(date, timezone) {
        // Get the date string in the target timezone
        const tzString = date.toLocaleString('en-US', { timeZone: timezone });
        const tzDate = new Date(tzString);
        // Get the same date in UTC
        const utcString = date.toLocaleString('en-US', { timeZone: 'UTC' });
        const utcDate = new Date(utcString);
        return utcDate.getTime() - tzDate.getTime();
    }
    sendProgressEvent(type, serverId, progress, message) {
        if (!this.mainWindow || this.mainWindow.isDestroyed())
            return;
        this.mainWindow.webContents.send(types_1.IPC_CHANNELS.BACKUP_PROGRESS, {
            type,
            serverId,
            progress,
            message,
            timestamp: Date.now(),
        });
    }
}
exports.BackupSchedulerService = BackupSchedulerService;
exports.backupSchedulerService = new BackupSchedulerService();
//# sourceMappingURL=BackupSchedulerService.js.map