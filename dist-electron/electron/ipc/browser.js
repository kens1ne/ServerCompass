"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBrowserHandlers = registerBrowserHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
function registerBrowserHandlers() {
    // Open URL in external browser
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, async (_, input) => {
        try {
            const { url } = types_1.OpenExternalURLSchema.parse(input);
            await electron_1.shell.openExternal(url);
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to open external URL',
            };
        }
    });
}
//# sourceMappingURL=browser.js.map