"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLicenseHandlers = registerLicenseHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const LicenseService_1 = require("../services/LicenseService");
/**
 * Format error messages to be more user-friendly
 */
function formatLicenseError(error) {
    const message = error instanceof Error ? error.message : String(error);
    // Map common error messages to user-friendly versions
    const errorMap = {
        'license_key not found': 'Your license key is not valid. Please check and try again.',
        'License key is required': 'Please enter a license key to continue.',
        'Email does not match license purchase': 'The email address does not match the license purchase. Please use the email you used when purchasing.',
        'activation limit exceeded': 'This license has reached its activation limit. Please deactivate it on another device first.',
        'License activation failed': 'Unable to activate license. Please check your internet connection and try again.',
    };
    // Check for exact matches first
    if (errorMap[message]) {
        return errorMap[message];
    }
    // Check for partial matches
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('license_key not found') || lowerMessage.includes('license key not found')) {
        return 'Your license key is not valid. Please check and try again.';
    }
    if (lowerMessage.includes('activation limit')) {
        return 'This license has reached its activation limit. Please deactivate it on another device first.';
    }
    if (lowerMessage.includes('email') && lowerMessage.includes('match')) {
        return 'The email address does not match the license purchase. Please use the email you used when purchasing.';
    }
    if (lowerMessage.includes('network') || lowerMessage.includes('fetch') || lowerMessage.includes('connection')) {
        return 'Unable to connect to license server. Please check your internet connection and try again.';
    }
    if (lowerMessage.includes('expired')) {
        return 'Your update eligibility has expired. All PRO features remain available — purchase a new license to receive updates.';
    }
    // Return original message if no mapping found
    return message;
}
function registerLicenseHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_GET_INFO, async () => {
        try {
            const info = LicenseService_1.licenseService.getLicenseInfo();
            return { success: true, data: info };
        }
        catch (error) {
            console.error('[license ipc] Failed to fetch license info', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_GET_LIMITS, async () => {
        try {
            const limits = LicenseService_1.licenseService.getUsageLimits();
            return { success: true, data: limits };
        }
        catch (error) {
            console.error('[license ipc] Failed to fetch usage limits', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_ACTIVATE, async (_event, payload) => {
        try {
            const { licenseKey, email } = types_1.LicenseActivateSchema.parse(payload);
            await LicenseService_1.licenseService.activateLicense(licenseKey, email);
            const info = LicenseService_1.licenseService.getLicenseInfo();
            const limits = LicenseService_1.licenseService.getUsageLimits();
            return { success: true, data: { info, limits } };
        }
        catch (error) {
            console.error('[license ipc] Failed to activate license', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_VALIDATE, async () => {
        try {
            const isValid = await LicenseService_1.licenseService.validateLicense();
            const info = LicenseService_1.licenseService.getLicenseInfo();
            return { success: true, data: { valid: isValid, info } };
        }
        catch (error) {
            console.error('[license ipc] Failed to validate license', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_DEACTIVATE, async () => {
        try {
            await LicenseService_1.licenseService.deactivateLicense();
            const info = LicenseService_1.licenseService.getLicenseInfo();
            const limits = LicenseService_1.licenseService.getUsageLimits();
            return { success: true, data: { info, limits } };
        }
        catch (error) {
            console.error('[license ipc] Failed to deactivate license', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_SERVER, async () => {
        try {
            const result = LicenseService_1.licenseService.canAddServer();
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate server limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_DEPLOYMENT, async () => {
        try {
            const result = LicenseService_1.licenseService.canAddDeployment();
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate deployment limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_DOMAIN, async (_event, payload) => {
        try {
            const { currentCount } = types_1.LicenseCountSchema.parse(payload ?? {});
            const result = LicenseService_1.licenseService.canAddDomain(currentCount ?? 0);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate domain limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_CRON, async (_event, payload) => {
        try {
            const { currentCount } = types_1.LicenseCountSchema.parse(payload ?? {});
            const result = LicenseService_1.licenseService.canAddCronJob(currentCount ?? 0);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate cron limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_CAN_USE_AUTO_DEPLOY, async () => {
        try {
            const result = LicenseService_1.licenseService.canUseAutoDeploy();
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate auto-deploy access', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LICENSE_CAN_USE_DATABASES, async () => {
        try {
            const result = LicenseService_1.licenseService.canUseDatabases();
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate database access', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
}
//# sourceMappingURL=license.js.map