"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemHandlers = registerSystemHandlers;
const electron_1 = require("electron");
const logger_1 = require("../logger");
/**
 * Register system-level IPC handlers
 */
function registerSystemHandlers(secureStorage) {
    console.log('[IPC] Registering system handlers');
    /**
     * Check keychain access
     */
    electron_1.ipcMain.handle('system:check-keychain-access', async (_event, args) => {
        try {
            logger_1.logger.info('[IPC] Checking keychain access', args?.forceCheck ? '(force)' : '(cached)');
            const result = await secureStorage.checkKeychainAccess(args?.forceCheck);
            return {
                success: true,
                data: result,
            };
        }
        catch (error) {
            logger_1.logger.error('[IPC] Failed to check keychain access:', error);
            return {
                success: false,
                error: error.message || 'Failed to check keychain access',
            };
        }
    });
    /**
     * Clear keychain access cache
     * Useful when user grants permission and wants to force a fresh check
     */
    electron_1.ipcMain.handle('system:clear-keychain-cache', async () => {
        try {
            logger_1.logger.info('[IPC] Clearing keychain cache');
            secureStorage.clearKeychainCache();
            return {
                success: true,
                data: undefined,
            };
        }
        catch (error) {
            logger_1.logger.error('[IPC] Failed to clear keychain cache:', error);
            return {
                success: false,
                error: error.message || 'Failed to clear keychain cache',
            };
        }
    });
    /**
     * Open system keychain settings
     * - macOS: Keychain Access app
     * - Windows: Credential Manager
     * - Linux: Platform-specific settings
     */
    electron_1.ipcMain.handle('system:open-keychain-settings', async () => {
        try {
            logger_1.logger.info('[IPC] Opening keychain settings');
            const platform = process.platform;
            switch (platform) {
                case 'darwin': // macOS
                    // Open Keychain Access application
                    await electron_1.shell.openPath('/System/Applications/Utilities/Keychain Access.app');
                    break;
                case 'win32': // Windows
                    // Open Credential Manager
                    const { exec } = require('child_process');
                    exec('control /name Microsoft.CredentialManager');
                    break;
                case 'linux':
                    // Linux varies by desktop environment, open system settings
                    // This will open the default system settings app
                    await electron_1.shell.openPath('/usr/bin/gnome-control-center')
                        .catch(() => electron_1.shell.openPath('/usr/bin/systemsettings5'))
                        .catch(() => logger_1.logger.warn('[IPC] Could not open system settings on Linux'));
                    break;
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }
            return {
                success: true,
                data: undefined,
            };
        }
        catch (error) {
            logger_1.logger.error('[IPC] Failed to open keychain settings:', error);
            return {
                success: false,
                error: error.message || 'Failed to open keychain settings',
            };
        }
    });
}
//# sourceMappingURL=system.js.map