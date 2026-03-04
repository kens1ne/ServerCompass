"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.crashReportService = void 0;
const Sentry = __importStar(require("@sentry/electron/main"));
const electron_1 = require("electron");
const logger_1 = require("../logger");
const os_1 = __importDefault(require("os"));
const runtime_config_1 = require("../utils/runtime-config");
class CrashReportService {
    initialized = false;
    pendingCrash = null;
    /**
     * Initialize Sentry for crash reporting
     * NOTE: You need to set your Sentry DSN in environment variable SENTRY_DSN
     * or hardcode it here during development
     */
    initialize() {
        if (this.initialized) {
            logger_1.logger.warn('CrashReportService already initialized');
            return;
        }
        // Get DSN from environment variable or runtime config
        // For production, it's loaded from runtime-config.json (generated at build time)
        // For development, it's loaded from .env file
        const dsn = (0, runtime_config_1.getSentryDsn)();
        logger_1.logger.info('Attempting to initialize Sentry...', {
            dsnPresent: !!dsn,
            dsnLength: dsn?.length || 0,
        });
        if (!dsn) {
            logger_1.logger.warn('SENTRY_DSN not set, crash reporting disabled');
            return;
        }
        try {
            Sentry.init({
                dsn,
                // Set environment based on build type
                environment: electron_1.app.isPackaged ? 'production' : 'development',
                // Include app version for better tracking
                release: `server-compass@${electron_1.app.getVersion()}`,
                // Only send crash reports when user explicitly submits them
                beforeSend: (event) => {
                    // Return null to prevent automatic sending
                    // We'll manually capture when user approves
                    if (!this.pendingCrash) {
                        return null;
                    }
                    return event;
                },
            });
            // Set user context with anonymous ID
            Sentry.setUser({
                id: this.getAnonymousUserId(),
            });
            // Set system context
            this.setSystemContext();
            this.initialized = true;
            logger_1.logger.info('CrashReportService initialized successfully');
        }
        catch (error) {
            logger_1.logger.error('Failed to initialize CrashReportService', error);
        }
    }
    /**
     * Add breadcrumb to track user actions
     */
    addBreadcrumb(message, category, data) {
        if (!this.initialized)
            return;
        Sentry.addBreadcrumb({
            message,
            category: category || 'user-action',
            level: 'info',
            timestamp: Date.now() / 1000,
            data,
        });
    }
    /**
     * Capture an error for potential reporting
     * This doesn't send it to Sentry yet, just stores it
     */
    captureError(error, context) {
        // Store crash info for potential user-initiated report
        this.pendingCrash = {
            errorMessage: error.message,
            stackTrace: error.stack,
        };
        if (!this.initialized) {
            logger_1.logger.warn('Crash captured but Sentry not initialized - crash dialog will still work', error);
            return;
        }
        // Set additional context if Sentry is initialized
        if (context) {
            Sentry.setContext('crash_context', context);
        }
        logger_1.logger.info('Crash captured, awaiting user decision to report', error);
    }
    /**
     * Submit the pending crash report with user comment
     */
    async submitCrashReport(userComment) {
        if (!this.pendingCrash) {
            logger_1.logger.error('Cannot submit crash report: No pending crash');
            return false;
        }
        if (!this.initialized) {
            logger_1.logger.warn('Cannot submit crash report: Sentry not initialized. Set SENTRY_DSN environment variable to enable crash reporting.');
            // Clear the pending crash even though we can't send it
            this.pendingCrash = null;
            return false;
        }
        try {
            // Add user comment if provided
            if (userComment) {
                Sentry.setContext('user_feedback', {
                    comment: userComment,
                    timestamp: new Date().toISOString(),
                });
            }
            // Capture the exception
            const error = new Error(this.pendingCrash.errorMessage);
            if (this.pendingCrash.stackTrace) {
                error.stack = this.pendingCrash.stackTrace;
            }
            Sentry.captureException(error);
            // Flush events to ensure they're sent
            await Sentry.flush(2000);
            logger_1.logger.info('Crash report submitted successfully');
            this.pendingCrash = null;
            return true;
        }
        catch (error) {
            logger_1.logger.error('Failed to submit crash report', error);
            return false;
        }
    }
    /**
     * Dismiss the pending crash without reporting
     */
    dismissPendingCrash() {
        this.pendingCrash = null;
        logger_1.logger.info('Pending crash report dismissed by user');
    }
    /**
     * Check if there's a pending crash awaiting user decision
     */
    hasPendingCrash() {
        return this.pendingCrash !== null;
    }
    /**
     * Get pending crash details for display in UI
     */
    getPendingCrash() {
        return this.pendingCrash;
    }
    /**
     * Generate or retrieve anonymous user ID for privacy
     */
    getAnonymousUserId() {
        // Use machine ID or generate a random UUID
        // This helps correlate crashes from the same user without collecting PII
        const machineId = os_1.default.hostname() + os_1.default.platform();
        return Buffer.from(machineId).toString('base64').substring(0, 16);
    }
    /**
     * Set system information as context
     */
    setSystemContext() {
        Sentry.setContext('system', {
            os: {
                name: os_1.default.platform(),
                version: os_1.default.release(),
                arch: os_1.default.arch(),
            },
            memory: {
                total: os_1.default.totalmem(),
                free: os_1.default.freemem(),
            },
            cpu: {
                cores: os_1.default.cpus().length,
                model: os_1.default.cpus()[0]?.model,
            },
            app: {
                version: electron_1.app.getVersion(),
                name: electron_1.app.getName(),
                isPackaged: electron_1.app.isPackaged,
            },
        });
    }
    /**
     * Clean up on app shutdown
     */
    async shutdown() {
        if (this.initialized) {
            await Sentry.close(2000);
            logger_1.logger.info('CrashReportService shut down');
        }
    }
}
exports.crashReportService = new CrashReportService();
//# sourceMappingURL=CrashReportService.js.map