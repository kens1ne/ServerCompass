"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSettingsHandlers = registerSettingsHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const db_1 = require("../db");
const AppPreferences_1 = require("../services/AppPreferences");
function registerSettingsHandlers() {
    // Get app version
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_GET_VERSION, async () => {
        try {
            const version = electron_1.app.getVersion();
            return { success: true, data: version };
        }
        catch (error) {
            console.error('Error getting app version:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get a setting
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SETTINGS_GET, async (_event, input) => {
        try {
            const { key } = types_1.GetSettingSchema.parse(input);
            const setting = db_1.queries.getSetting(key);
            return { success: true, data: setting?.value || null };
        }
        catch (error) {
            console.error('Error getting setting:', error);
            return { success: false, error: String(error) };
        }
    });
    // Set a setting
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SETTINGS_SET, async (_event, input) => {
        try {
            const { key, value } = types_1.SetSettingSchema.parse(input);
            db_1.queries.setSetting(key, value);
            return { success: true };
        }
        catch (error) {
            console.error('Error setting setting:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get all app preferences
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_PREFERENCES_GET, async () => {
        try {
            const maxDeploymentLogLines = AppPreferences_1.appPreferences.getMaxDeploymentLogLines();
            return { success: true, data: { maxDeploymentLogLines } };
        }
        catch (error) {
            console.error('Error getting app preferences:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get max deployment log lines
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_PREFERENCES_GET_MAX_LOG_LINES, async () => {
        try {
            const maxLines = AppPreferences_1.appPreferences.getMaxDeploymentLogLines();
            return { success: true, data: maxLines };
        }
        catch (error) {
            console.error('Error getting max log lines:', error);
            return { success: false, error: String(error) };
        }
    });
    // Set max deployment log lines
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.APP_PREFERENCES_SET_MAX_LOG_LINES, async (_event, input) => {
        try {
            const { lines } = types_1.SetMaxLogLinesSchema.parse(input);
            AppPreferences_1.appPreferences.setMaxDeploymentLogLines(lines);
            return { success: true };
        }
        catch (error) {
            console.error('Error setting max log lines:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=settings.js.map