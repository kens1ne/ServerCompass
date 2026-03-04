"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCronHandlers = registerCronHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const CronService_1 = require("../services/CronService");
const CronLogService_1 = require("../services/CronLogService");
function registerCronHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_LIST, async (_event, input) => {
        try {
            const config = types_1.CronListSchema.parse(input);
            const jobs = await CronService_1.cronService.list(config.serverId);
            return { success: true, data: jobs };
        }
        catch (error) {
            console.error('Error listing cron jobs:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_SAVE_METADATA, async (_event, input) => {
        try {
            const config = types_1.CronSaveMetadataSchema.parse(input);
            CronService_1.cronService.saveMetadata(config.serverId, config.jobSignature, config.cronId, config.name, config.description, config.type, config.createdBy);
            return { success: true };
        }
        catch (error) {
            console.error('Error saving cron metadata:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_UPDATE_JOB, async (_event, input) => {
        try {
            const config = types_1.CronUpdateJobSchema.parse(input);
            const result = await CronService_1.cronService.updateJob(config);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error updating cron job:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_TOGGLE_JOB, async (_event, input) => {
        try {
            const config = types_1.CronToggleJobSchema.parse(input);
            await CronService_1.cronService.toggleJob(config);
            return { success: true };
        }
        catch (error) {
            console.error('Error toggling cron job:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_DELETE_JOB, async (_event, input) => {
        try {
            const config = types_1.CronDeleteJobSchema.parse(input);
            await CronService_1.cronService.deleteJob(config);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting cron job:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_ADD_JOB, async (_event, input) => {
        try {
            const config = types_1.CronAddJobSchema.parse(input);
            const result = await CronService_1.cronService.addJob(config);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error adding cron job:', error);
            return { success: false, error: String(error) };
        }
    });
    // Cron log handlers
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_GET_LOGS, async (_event, input) => {
        try {
            const config = types_1.CronGetLogsSchema.parse(input);
            const logs = await CronLogService_1.cronLogService.getLogs(config.serverId, config.cronId, {
                tailLines: config.tailLines,
            });
            return { success: true, data: logs };
        }
        catch (error) {
            console.error('Error getting cron logs:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_CLEAR_LOGS, async (_event, input) => {
        try {
            const config = types_1.CronClearLogsSchema.parse(input);
            await CronLogService_1.cronLogService.clearLogs(config.serverId, config.cronId);
            return { success: true };
        }
        catch (error) {
            console.error('Error clearing cron logs:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_GET_LOG_INFO, async (_event, input) => {
        try {
            const config = types_1.CronGetLogInfoSchema.parse(input);
            const info = await CronLogService_1.cronLogService.getLogInfo(config.serverId, config.cronId);
            return { success: true, data: info };
        }
        catch (error) {
            console.error('Error getting cron log info:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CRON_WRAP_COMMAND, async (_event, input) => {
        try {
            const config = types_1.CronWrapCommandSchema.parse(input);
            const wrappedCommand = CronLogService_1.cronLogService.wrapCommandWithLogging(config.command, config.cronId, {
                maxSizeBytes: config.maxSizeBytes,
                maxLines: config.maxLines,
                backupCount: config.backupCount,
            });
            return { success: true, data: wrappedCommand };
        }
        catch (error) {
            console.error('Error wrapping cron command:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=cron.js.map