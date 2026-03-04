"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUpdaterHandlers = registerUpdaterHandlers;
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const types_1 = require("./types");
const logger_1 = require("../logger");
const LicenseService_1 = require("../services/LicenseService");
const UpdatePreferences_1 = require("../services/UpdatePreferences");
const types_2 = require("./types");
function registerUpdaterHandlers() {
    // Check for updates manually
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_CHECK_FOR_UPDATES, async () => {
        try {
            logger_1.logger.info('Manual update check requested');
            // Get current license info
            const initialInfo = LicenseService_1.licenseService.getLicenseInfo();
            // If user has a license, validate with Lemon Squeezy API to get fresh expires_at
            // This prevents cheating by modifying the local database
            if (initialInfo.isLicensed && initialInfo.licenseKey && initialInfo.instanceId) {
                logger_1.logger.info('Validating license with server before update check');
                try {
                    await LicenseService_1.licenseService.validateLicense();
                    logger_1.logger.info('License validated successfully with server');
                }
                catch (validationError) {
                    // Log but don't block - allow offline grace period
                    // The periodic validation will catch persistent issues
                    logger_1.logger.warn('License validation failed, using cached data', validationError);
                }
            }
            // Re-fetch license info after validation (may have updated expires_at)
            const licenseInfo = LicenseService_1.licenseService.getLicenseInfo();
            if (!licenseInfo.canUpdate) {
                return {
                    success: false,
                    error: 'Your license does not include updates. Please renew your license to receive updates.',
                    data: {
                        isLicensed: licenseInfo.isLicensed,
                        updatesUntil: licenseInfo.updatesUntil,
                    },
                };
            }
            const result = await electron_updater_1.autoUpdater.checkForUpdates();
            return {
                success: true,
                data: result,
            };
        }
        catch (error) {
            logger_1.logger.error('Failed to check for updates', error);
            return {
                success: false,
                error: error.message || 'Failed to check for updates',
            };
        }
    });
    // Download update manually
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE, async () => {
        try {
            logger_1.logger.info('Manual update download requested');
            // Get current license info
            const initialInfo = LicenseService_1.licenseService.getLicenseInfo();
            // Validate with Lemon Squeezy API before downloading
            // This is critical - prevents downloading updates with tampered expires_at
            if (initialInfo.isLicensed && initialInfo.licenseKey && initialInfo.instanceId) {
                logger_1.logger.info('Validating license with server before download');
                try {
                    const isValid = await LicenseService_1.licenseService.validateLicense();
                    if (!isValid) {
                        logger_1.logger.warn('License validation returned invalid');
                        return {
                            success: false,
                            error: 'License validation failed. Please check your license status.',
                        };
                    }
                    logger_1.logger.info('License validated successfully with server');
                }
                catch (validationError) {
                    // For downloads, we require successful validation (no offline grace)
                    // User needs internet to download anyway
                    logger_1.logger.error('License validation failed before download', validationError);
                    return {
                        success: false,
                        error: 'Unable to verify license. Please check your internet connection and try again.',
                    };
                }
            }
            // Re-fetch license info after validation
            const licenseInfo = LicenseService_1.licenseService.getLicenseInfo();
            if (!licenseInfo.canUpdate) {
                return {
                    success: false,
                    error: 'Your license does not include updates. Please renew your license to receive updates.',
                };
            }
            await electron_updater_1.autoUpdater.downloadUpdate();
            return {
                success: true,
            };
        }
        catch (error) {
            logger_1.logger.error('Failed to download update', error);
            return {
                success: false,
                error: error.message || 'Failed to download update',
            };
        }
    });
    // Install update and restart
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL, async () => {
        try {
            logger_1.logger.info('Quit and install requested');
            // This will quit the app and install the update
            electron_updater_1.autoUpdater.quitAndInstall(false, true);
            return {
                success: true,
            };
        }
        catch (error) {
            logger_1.logger.error('Failed to quit and install', error);
            return {
                success: false,
                error: error.message || 'Failed to quit and install',
            };
        }
    });
    // Get current version
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_GET_CURRENT_VERSION, async () => {
        try {
            const version = electron_updater_1.autoUpdater.currentVersion.version;
            return {
                success: true,
                data: version,
            };
        }
        catch (error) {
            logger_1.logger.error('Failed to get current version', error);
            return {
                success: false,
                error: error.message || 'Failed to get current version',
            };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_SKIP_VERSION, async (_event, rawInput) => {
        try {
            const { version } = types_2.UpdaterSkipVersionSchema.parse(rawInput);
            UpdatePreferences_1.updatePreferences.setSkippedVersion(version);
            logger_1.logger.info(`User chose to skip update version ${version}`);
            electron_1.BrowserWindow.getAllWindows().forEach((window) => {
                if (!window.isDestroyed()) {
                    window.webContents.send(types_1.IPC_CHANNELS.UPDATER_UPDATE_SKIPPED, { version });
                }
            });
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to persist skipped version', error);
            return { success: false, error: error.message || 'Failed to skip version' };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_CLEAR_SKIPPED_VERSION, async () => {
        try {
            UpdatePreferences_1.updatePreferences.clearSkippedVersion();
            return { success: true };
        }
        catch (error) {
            logger_1.logger.error('Failed to clear skipped version', error);
            return { success: false, error: error.message || 'Failed to clear skipped version' };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.UPDATER_GET_PREFERENCES, async () => {
        try {
            const preferences = {
                skippedVersion: UpdatePreferences_1.updatePreferences.getSkippedVersion(),
            };
            return { success: true, data: preferences };
        }
        catch (error) {
            logger_1.logger.error('Failed to read update preferences', error);
            return { success: false, error: error.message || 'Failed to read preferences' };
        }
    });
    // DEV ONLY: Simulate update available for testing UI
    // if (process.env.NODE_ENV !== 'production') {
    //   ipcMain.handle('updater:dev-simulate-update', async (_event, rawInput): Promise<ApiResult<void>> => {
    //     try {
    //       const mockInfo = rawInput || {
    //         version: '1.11.1',
    //         releaseDate: new Date().toISOString(),
    //         releaseNotes: `##
    // ![newupdate2](https://github.com/user-attachments/assets/c2fef923-636a-40bf-9805-fe50dba8354c)
    // ![newupdate3](https://github.com/user-attachments/assets/1366b835-e231-4677-b05e-7dc20f8440d3)
    // ![newupdate4](https://github.com/user-attachments/assets/01419c75-d670-41e3-bd70-4f6a96081d91)
    // ![newupdate5](https://github.com/user-attachments/assets/6457f674-bc23-451e-8706-d23dd03453d2)
    // ![newupdate1](https://github.com/user-attachments/assets/75789efa-2dd8-4b44-8500-fd15ec454db2)
    // - **Monitoring Agent** - Install a lightweight monitoring agent on your server with one click
    // - **Custom Alert Rules** - Create rules to trigger alerts when CPU, memory, or disk usage exceeds your thresholds
    // - **Multiple Severity Levels** - Set alerts as critical, warning, or info based on importance
    //
    // ## NoSQL Database Support
    // - **MongoDB Query Editor** - Run queries against MongoDB databases with a built-in editor
    // - **Elasticsearch Query Editor** - Execute Elasticsearch queries and browse results
    //
    // ## Code Editor
    // - **Built-in Code Editor** - New code editor component with syntax highlighting
    // - **Multiple Languages** - Support for YAML, Dockerfile, Shell scripts, and JSON`,
    //       };
    //       logger.info('[DEV] Simulating update available', mockInfo);
    //       BrowserWindow.getAllWindows().forEach((window) => {
    //         if (!window.isDestroyed()) {
    //           window.webContents.send('updater:update-available', mockInfo);
    //         }
    //       });
    //       return { success: true };
    //     } catch (error: any) {
    //       return { success: false, error: error.message };
    //     }
    //   });
    // }
    logger_1.logger.info('Updater IPC handlers registered');
}
//# sourceMappingURL=updater.js.map