"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackupImportSchema = exports.BackupExportSchema = void 0;
exports.registerBackupHandlers = registerBackupHandlers;
const electron_1 = require("electron");
const zod_1 = require("zod");
const BackupService_1 = require("../services/BackupService");
exports.BackupExportSchema = zod_1.z.object({
    password: zod_1.z.string().min(8, 'Password must be at least 8 characters'),
});
exports.BackupImportSchema = zod_1.z.object({
    filePath: zod_1.z.string(),
    password: zod_1.z.string(),
});
function registerBackupHandlers() {
    // Export backup
    electron_1.ipcMain.handle('backup:export', async (_event, input) => {
        try {
            const { password } = exports.BackupExportSchema.parse(input);
            const result = await BackupService_1.backupService.exportBackup(password);
            if (result.success && result.filePath) {
                return { success: true, data: result.filePath };
            }
            return { success: false, error: result.error || 'Export failed' };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Export failed' };
        }
    });
    // Preview backup
    electron_1.ipcMain.handle('backup:preview', async (_event, input) => {
        try {
            const { filePath, password } = exports.BackupImportSchema.parse(input);
            const result = await BackupService_1.backupService.previewBackup(filePath, password);
            if (result.success && result.metadata) {
                return { success: true, data: result.metadata };
            }
            return { success: false, error: result.error || 'Preview failed' };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Preview failed' };
        }
    });
    // Import backup
    electron_1.ipcMain.handle('backup:import', async (_event, input) => {
        try {
            const { filePath, password } = exports.BackupImportSchema.parse(input);
            const result = await BackupService_1.backupService.importBackup(filePath, password);
            if (result.success) {
                return { success: true };
            }
            return { success: false, error: result.error || 'Import failed' };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return { success: false, error: error instanceof Error ? error.message : 'Import failed' };
        }
    });
    // Select backup file
    electron_1.ipcMain.handle('backup:selectFile', async () => {
        try {
            const parentWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
            const result = parentWindow
                ? await electron_1.dialog.showOpenDialog(parentWindow, {
                    title: 'Select Backup File',
                    properties: ['openFile'],
                    filters: [{ name: 'ServerCompass Backup', extensions: ['scbackup'] }],
                })
                : await electron_1.dialog.showOpenDialog({
                    title: 'Select Backup File',
                    properties: ['openFile'],
                    filters: [{ name: 'ServerCompass Backup', extensions: ['scbackup'] }],
                });
            if (result.canceled || result.filePaths.length === 0) {
                return { success: false, error: 'File selection canceled' };
            }
            return { success: true, data: result.filePaths[0] };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'File selection failed',
            };
        }
    });
}
//# sourceMappingURL=backup.js.map