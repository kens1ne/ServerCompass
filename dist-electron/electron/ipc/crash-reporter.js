"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCrashReportHandlers = registerCrashReportHandlers;
const electron_1 = require("electron");
const zod_1 = require("zod");
const logger_1 = require("../logger");
const CrashReportService_1 = require("../services/CrashReportService");
const IPC_CHANNELS = {
    CRASH_REPORT_SUBMIT: 'crash-report:submit',
    CRASH_REPORT_DISMISS: 'crash-report:dismiss',
    CRASH_REPORT_HAS_PENDING: 'crash-report:has-pending',
    CRASH_REPORT_GET_PENDING: 'crash-report:get-pending',
    CRASH_REPORT_ADD_BREADCRUMB: 'crash-report:add-breadcrumb',
    CRASH_REPORT_CAPTURE_RENDERER_ERROR: 'crash-report:capture-renderer-error',
    CRASH_REPORT_SHOW_DIALOG: 'crash-report:show-dialog',
};
const submitReportSchema = zod_1.z.object({
    userComment: zod_1.z.string().optional(),
});
const addBreadcrumbSchema = zod_1.z.object({
    message: zod_1.z.string(),
    category: zod_1.z.string().optional(),
    data: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
});
const captureRendererErrorSchema = zod_1.z.object({
    message: zod_1.z.string(),
    stack: zod_1.z.string().optional(),
});
function registerCrashReportHandlers() {
    // Submit crash report
    electron_1.ipcMain.handle(IPC_CHANNELS.CRASH_REPORT_SUBMIT, async (_event, args) => {
        try {
            const { userComment } = submitReportSchema.parse(args);
            const success = await CrashReportService_1.crashReportService.submitCrashReport(userComment);
            return {
                success,
                data: { submitted: success },
                error: success ? undefined : 'Failed to submit crash report',
            };
        }
        catch (error) {
            logger_1.logger.error('Error submitting crash report', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Dismiss crash report
    electron_1.ipcMain.handle(IPC_CHANNELS.CRASH_REPORT_DISMISS, async () => {
        try {
            CrashReportService_1.crashReportService.dismissPendingCrash();
            return {
                success: true,
                data: { dismissed: true },
            };
        }
        catch (error) {
            logger_1.logger.error('Error dismissing crash report', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Check if there's a pending crash
    electron_1.ipcMain.handle(IPC_CHANNELS.CRASH_REPORT_HAS_PENDING, async () => {
        try {
            const hasPending = CrashReportService_1.crashReportService.hasPendingCrash();
            return {
                success: true,
                data: { hasPending },
            };
        }
        catch (error) {
            logger_1.logger.error('Error checking for pending crash', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Get pending crash details
    electron_1.ipcMain.handle(IPC_CHANNELS.CRASH_REPORT_GET_PENDING, async () => {
        try {
            const crash = CrashReportService_1.crashReportService.getPendingCrash();
            return {
                success: true,
                data: crash,
            };
        }
        catch (error) {
            logger_1.logger.error('Error getting pending crash', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Add breadcrumb
    electron_1.ipcMain.handle(IPC_CHANNELS.CRASH_REPORT_ADD_BREADCRUMB, async (_event, args) => {
        try {
            const { message, category, data } = addBreadcrumbSchema.parse(args);
            CrashReportService_1.crashReportService.addBreadcrumb(message, category, data);
            return {
                success: true,
                data: { added: true },
            };
        }
        catch (error) {
            logger_1.logger.error('Error adding breadcrumb', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Capture renderer error and show dialog
    electron_1.ipcMain.handle(IPC_CHANNELS.CRASH_REPORT_CAPTURE_RENDERER_ERROR, async (event, args) => {
        try {
            const { message, stack } = captureRendererErrorSchema.parse(args);
            const error = new Error(message);
            if (stack) {
                error.stack = stack;
            }
            // Capture the error
            CrashReportService_1.crashReportService.captureError(error, {
                type: 'rendererError',
                timestamp: new Date().toISOString(),
            });
            // Notify renderer to show crash dialog
            const window = electron_1.BrowserWindow.fromWebContents(event.sender);
            if (window && !window.isDestroyed()) {
                window.webContents.send(IPC_CHANNELS.CRASH_REPORT_SHOW_DIALOG);
            }
            return {
                success: true,
                data: { captured: true },
            };
        }
        catch (error) {
            logger_1.logger.error('Error capturing renderer error', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    logger_1.logger.info('Crash report IPC handlers registered');
}
//# sourceMappingURL=crash-reporter.js.map