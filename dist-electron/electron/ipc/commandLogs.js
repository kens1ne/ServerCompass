"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCommandLogsHandlers = registerCommandLogsHandlers;
const electron_1 = require("electron");
const promises_1 = __importDefault(require("fs/promises"));
const types_1 = require("./types");
const db_1 = require("../db");
function registerCommandLogsHandlers() {
    // Get command logs
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.COMMAND_LOGS_GET, async (_event, input) => {
        try {
            const { serverId, limit } = types_1.GetCommandLogsSchema.parse(input);
            const commands = db_1.queries.getCommandsByServer(serverId, limit);
            return { success: true, data: commands };
        }
        catch (error) {
            console.error('Error fetching command logs:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get command logs size
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.COMMAND_LOGS_GET_SIZE, async (_event, input) => {
        try {
            const { serverId } = types_1.GetCommandLogsSizeSchema.parse(input);
            const size = db_1.queries.getCommandsSize(serverId);
            return { success: true, data: size };
        }
        catch (error) {
            console.error('Error fetching command logs size:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete all command logs
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.COMMAND_LOGS_DELETE_ALL, async (_event, input) => {
        try {
            const { serverId } = types_1.DeleteAllCommandLogsSchema.parse(input);
            db_1.queries.deleteAllCommands(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting all command logs:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.COMMAND_LOGS_EXPORT, async (event, input) => {
        try {
            const { serverId, content, suggestedFileName } = types_1.ExportCommandLogsSchema.parse(input);
            const window = electron_1.BrowserWindow.fromWebContents(event.sender);
            const defaultPath = suggestedFileName || `server-${serverId}-command-logs.json`;
            const result = await electron_1.dialog.showSaveDialog(window ?? electron_1.BrowserWindow.getAllWindows()[0], {
                title: 'Export Command Logs',
                defaultPath,
                filters: [
                    { name: 'JSON', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });
            if (result.canceled || !result.filePath) {
                return { success: false, error: 'Export canceled' };
            }
            await promises_1.default.writeFile(result.filePath, content, 'utf-8');
            return { success: true, data: { filePath: result.filePath } };
        }
        catch (error) {
            console.error('Error exporting command logs:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=commandLogs.js.map