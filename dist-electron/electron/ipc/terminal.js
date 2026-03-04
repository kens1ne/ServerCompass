"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTerminalHandlers = registerTerminalHandlers;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const types_1 = require("./types");
const TerminalService_1 = require("../services/TerminalService");
const CloseTerminalSchema = types_1.TerminalInputSchema.pick({ sessionId: true });
const isDev = !electron_1.app.isPackaged && process.env.NODE_ENV !== 'production';
const resolveRendererEntry = () => {
    const appPath = electron_1.app.getAppPath();
    const candidates = [
        { path: path_1.default.resolve(__dirname, '..', '..', 'dist-renderer', 'index.html'), source: 'relative-to-main' },
        { path: path_1.default.join(appPath, 'dist-renderer', 'index.html'), source: 'app-root' },
        { path: path_1.default.join(process.resourcesPath, 'dist-renderer', 'index.html'), source: 'resources-root' },
    ];
    for (const candidate of candidates) {
        if (fs_1.default.existsSync(candidate.path)) {
            return candidate;
        }
    }
    return candidates[0];
};
function registerTerminalHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TERMINAL_CREATE, async (event, rawInput) => {
        try {
            const input = types_1.CreateTerminalSchema.parse(rawInput);
            const window = electron_1.BrowserWindow.fromWebContents(event.sender);
            if (!window) {
                throw new Error('Unable to resolve renderer window for terminal session.');
            }
            const result = await TerminalService_1.terminalService.createSession({
                serverId: input.serverId,
                cols: input.cols,
                rows: input.rows,
                webContentsId: event.sender.id,
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[Terminal] Failed to create session:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TERMINAL_INPUT, async (_event, rawInput) => {
        try {
            const input = types_1.TerminalInputSchema.parse(rawInput);
            await TerminalService_1.terminalService.write(input.sessionId, input.data);
            return { success: true };
        }
        catch (error) {
            console.error('[Terminal] Failed to forward input:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TERMINAL_RESIZE, async (_event, rawInput) => {
        try {
            const input = types_1.TerminalResizeSchema.parse(rawInput);
            await TerminalService_1.terminalService.resize(input.sessionId, input.cols, input.rows);
            return { success: true };
        }
        catch (error) {
            console.error('[Terminal] Failed to resize session:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TERMINAL_CLOSE, async (_event, rawInput) => {
        try {
            const input = CloseTerminalSchema.parse(rawInput);
            await TerminalService_1.terminalService.close(input.sessionId);
            return { success: true };
        }
        catch (error) {
            console.error('[Terminal] Failed to close session:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TERMINAL_OPEN_WINDOW, async (_event, rawInput) => {
        try {
            const input = types_1.OpenTerminalWindowSchema.parse(rawInput);
            const { serverId, serverName, initialCommand } = input;
            const terminalWindow = new electron_1.BrowserWindow({
                width: 900,
                height: 600,
                minWidth: 600,
                minHeight: 400,
                title: serverName ? `Terminal - ${serverName}` : 'Terminal',
                webPreferences: {
                    preload: path_1.default.join(__dirname, '../preload.js'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: false,
                },
                titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
                show: false,
            });
            terminalWindow.once('ready-to-show', () => {
                terminalWindow.show();
            });
            const devServerURL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
            const { path: rendererIndexPath } = resolveRendererEntry();
            const queryParams = new URLSearchParams({
                serverId,
                serverName: serverName || '',
                ...(initialCommand ? { initialCommand } : {}),
            });
            if (isDev) {
                await terminalWindow.loadURL(`${devServerURL}#/terminal-window?${queryParams.toString()}`);
            }
            else {
                await terminalWindow.loadFile(rendererIndexPath, {
                    hash: `/terminal-window?${queryParams.toString()}`,
                });
            }
            return { success: true, data: { windowId: terminalWindow.id } };
        }
        catch (error) {
            console.error('[Terminal] Failed to open terminal window:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
//# sourceMappingURL=terminal.js.map