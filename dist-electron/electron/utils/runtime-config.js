"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRuntimeConfig = loadRuntimeConfig;
exports.getEnv = getEnv;
exports.getGitHubClientId = getGitHubClientId;
exports.getSentryDsn = getSentryDsn;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
let cachedRuntimeConfig;
/**
 * Load runtime configuration from runtime-config.json
 * This file is generated during build time and contains environment variables
 * that need to be available in production builds
 */
function loadRuntimeConfig() {
    // Return cached value if already loaded
    if (cachedRuntimeConfig !== undefined) {
        return cachedRuntimeConfig;
    }
    const candidates = getRuntimeConfigPaths();
    for (const candidate of candidates) {
        try {
            if (!fs_1.default.existsSync(candidate)) {
                continue;
            }
            const contents = fs_1.default.readFileSync(candidate, 'utf-8');
            const parsed = JSON.parse(contents);
            cachedRuntimeConfig = parsed;
            console.log('[runtime-config] Loaded from:', candidate);
            return parsed;
        }
        catch (error) {
            console.warn('[runtime-config] Failed to parse:', candidate, error);
        }
    }
    console.warn('[runtime-config] Not found; using environment variables only');
    cachedRuntimeConfig = null;
    return null;
}
/**
 * Get an environment variable from process.env or runtime config
 * Checks process.env first (for development), then falls back to runtime config (for production)
 */
function getEnv(key) {
    // First check environment variable (for development)
    if (process.env[key]) {
        return process.env[key];
    }
    // Fall back to runtime config (for production builds)
    const config = loadRuntimeConfig();
    return config?.[key];
}
/**
 * Get the GitHub Client ID from environment or runtime config
 */
function getGitHubClientId() {
    return getEnv('GITHUB_CLIENT_ID') || '';
}
/**
 * Get the Sentry DSN from environment or runtime config
 * Checks both SENTRY_DSN and VITE_SENTRY_DSN
 */
function getSentryDsn() {
    return getEnv('SENTRY_DSN') || getEnv('VITE_SENTRY_DSN') || '';
}
function getRuntimeConfigPaths() {
    const paths = new Set();
    try {
        const appPath = electron_1.app.getAppPath();
        paths.add(path_1.default.join(appPath, 'dist', 'runtime-config.json'));
        paths.add(path_1.default.join(appPath, 'runtime-config.json'));
    }
    catch (error) {
        console.warn('[runtime-config] Unable to resolve app path', error);
    }
    paths.add(path_1.default.resolve(__dirname, '../../dist/runtime-config.json'));
    paths.add(path_1.default.resolve(__dirname, '../../runtime-config.json'));
    paths.add(path_1.default.resolve(process.cwd(), 'dist/runtime-config.json'));
    return Array.from(paths);
}
//# sourceMappingURL=runtime-config.js.map