"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerProvisioningHandlers = registerProvisioningHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const ProvisioningService_1 = require("../services/ProvisioningService");
function registerProvisioningHandlers() {
    // Install nginx and certbot
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.PROVISION_INSTALL_NGINX_CERTBOT, async (_event, input) => {
        try {
            const { serverId } = types_1.InstallNginxCertbotSchema.parse(input);
            // Set up progress event forwarding to renderer
            const progressHandler = (event) => {
                const win = electron_1.BrowserWindow.getAllWindows()[0];
                if (win) {
                    win.webContents.send('progress:update', event);
                }
            };
            ProvisioningService_1.provisioningService.on('progress', progressHandler);
            try {
                await ProvisioningService_1.provisioningService.installNginxAndCertbot(serverId);
                return { success: true };
            }
            finally {
                ProvisioningService_1.provisioningService.off('progress', progressHandler);
            }
        }
        catch (error) {
            console.error('Error installing nginx and certbot:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=provisioning.js.map