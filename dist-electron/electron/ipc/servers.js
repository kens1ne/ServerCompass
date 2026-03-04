"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerServerHandlers = registerServerHandlers;
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const types_1 = require("./types");
const db_1 = require("../db");
const CredentialVault_1 = require("../services/CredentialVault");
const LicenseService_1 = require("../services/LicenseService");
const ProvisioningService_1 = require("../services/ProvisioningService");
const SSHService_1 = require("../services/SSHService");
const vault = new CredentialVault_1.CredentialVault();
async function fetchGeolocationViaSSH(serverId) {
    try {
        // Execute curl command on the VPS to get its own geolocation
        const result = await SSHService_1.sshService.executeCommand(serverId, 'curl -s ip-api.com/json');
        if (!result.stdout || result.stdout.trim().length === 0) {
            console.error('Failed to fetch geolocation: Empty response from server');
            return null;
        }
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed.status === 'success') {
            return parsed;
        }
        else {
            console.error('Geolocation API returned failure status:', parsed);
            return null;
        }
    }
    catch (error) {
        console.error('Failed to fetch geolocation via SSH:', error);
        return null;
    }
}
function registerServerHandlers() {
    // Get all servers
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_GET_ALL, async () => {
        try {
            const servers = db_1.queries.getAllServers();
            return { success: true, data: servers };
        }
        catch (error) {
            console.error('Error getting servers:', error);
            return { success: false, error: String(error) };
        }
    });
    // Get server by ID
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_GET_BY_ID, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const server = db_1.queries.getServerById(id);
            return { success: true, data: server || null };
        }
        catch (error) {
            console.error('Error getting server:', error);
            return { success: false, error: String(error) };
        }
    });
    // Create server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_CREATE, async (_event, input) => {
        try {
            const validated = types_1.CreateServerSchema.parse(input);
            const limitCheck = LicenseService_1.licenseService.canAddServer();
            if (!limitCheck.allowed) {
                const message = limitCheck.reason ||
                    `Free trial allows up to ${limitCheck.max ?? 0} server(s). Activate a license to add more.`;
                return { success: false, error: message };
            }
            // Encrypt the secret
            const encryptedSecret = await vault.encrypt(validated.auth.value);
            const server = {
                id: (0, crypto_1.randomUUID)(),
                name: validated.name,
                host: validated.host,
                port: validated.port,
                auth_type: validated.auth.type,
                username: validated.username,
                encrypted_secret: encryptedSecret,
                status: 'pending',
                last_check_in: Date.now(),
                display_order: null, // Will be auto-assigned by createServer
                packages_installed: 0, // Not checked yet
                packages_checked_at: null, // Not checked yet
                country_code: null, // Will be fetched on first access
                org: null, // Will be fetched on first access
                timezone: null, // Will be fetched on first access
                key_path: validated.keyPath ?? null, // Path to script-generated SSH key for cleanup
            };
            db_1.queries.createServer(server);
            const created = db_1.queries.getServerById(server.id);
            if (!created) {
                throw new Error('Failed to create server');
            }
            // Background check: Ensure essential packages are installed on the new server
            ProvisioningService_1.provisioningService.ensureEssentialPackages(server.id).catch((error) => {
                console.warn(`[ServerCreate] Background package check failed for ${server.id}:`, error);
                // Don't fail server creation if background check fails
            });
            return { success: true, data: created };
        }
        catch (error) {
            console.error('Error creating server:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_UPDATE, async (_event, input) => {
        try {
            const { id, updates } = types_1.UpdateServerSchema.parse(input);
            const { auth, keyPath, ...rest } = updates;
            const preparedUpdates = { ...rest };
            if (auth) {
                const encryptedSecret = await vault.encrypt(auth.value);
                preparedUpdates.auth_type = auth.type;
                preparedUpdates.encrypted_secret = encryptedSecret;
            }
            if (keyPath !== undefined) {
                preparedUpdates.key_path = keyPath ?? null;
            }
            db_1.queries.updateServer(id, preparedUpdates);
            return { success: true };
        }
        catch (error) {
            console.error('Error updating server:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_DELETE, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            // Get server to check for key_path before deletion
            const server = db_1.queries.getServerById(id);
            // Close SSH connection for this server if exists
            try {
                await SSHService_1.sshService.disconnect(id);
                console.log(`Closed SSH connection for deleted server: ${id}`);
            }
            catch (sshError) {
                // Log but don't fail the deletion if SSH disconnect fails
                console.warn(`Failed to close SSH connection for server ${id}:`, sshError);
            }
            // Clean up script-generated SSH key if exists
            if (server?.key_path) {
                const allowedDir = path_1.default.join(os_1.default.homedir(), '.ssh', 'servercompass');
                const resolvedPath = path_1.default.resolve(server.key_path);
                const resolvedAllowedDir = path_1.default.resolve(allowedDir);
                // Security: Only delete keys from the allowed directory
                if (resolvedPath.startsWith(resolvedAllowedDir + path_1.default.sep)) {
                    try {
                        // Delete private key
                        if (fs_1.default.existsSync(resolvedPath)) {
                            fs_1.default.unlinkSync(resolvedPath);
                            console.log(`[ServerDelete] Cleaned up private key: ${resolvedPath}`);
                        }
                        // Delete public key
                        const pubKeyPath = `${resolvedPath}.pub`;
                        if (fs_1.default.existsSync(pubKeyPath)) {
                            fs_1.default.unlinkSync(pubKeyPath);
                            console.log(`[ServerDelete] Cleaned up public key: ${pubKeyPath}`);
                        }
                    }
                    catch (keyError) {
                        // Log but don't fail deletion if key cleanup fails
                        console.warn(`[ServerDelete] Failed to clean up SSH key for server ${id}:`, keyError);
                    }
                }
                else {
                    console.warn(`[ServerDelete] Skipped key cleanup - path outside allowed directory: ${server.key_path}`);
                }
            }
            // Delete server from database
            db_1.queries.deleteServer(id);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting server:', error);
            return { success: false, error: String(error) };
        }
    });
    // Reorder servers
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_REORDER, async (_event, input) => {
        try {
            const { serverIds } = types_1.ReorderServersSchema.parse(input);
            db_1.queries.reorderServers(serverIds);
            return { success: true };
        }
        catch (error) {
            console.error('Error reordering servers:', error);
            return { success: false, error: String(error) };
        }
    });
    // Update server geolocation
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SERVERS_UPDATE_GEOLOCATION, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const server = db_1.queries.getServerById(id);
            if (!server) {
                return { success: false, error: 'Server not found' };
            }
            // Only fetch if not already set
            if (server.country_code && server.org && server.timezone) {
                return {
                    success: true,
                    data: {
                        countryCode: server.country_code,
                        org: server.org,
                        timezone: server.timezone
                    }
                };
            }
            // Fetch geolocation data via SSH (execute curl on the VPS)
            const geoData = await fetchGeolocationViaSSH(id);
            if (geoData && geoData.countryCode && geoData.org) {
                // Update the server with geolocation data
                db_1.queries.updateServer(id, {
                    country_code: geoData.countryCode,
                    org: geoData.org,
                    timezone: geoData.timezone ?? null,
                });
                return {
                    success: true,
                    data: {
                        countryCode: geoData.countryCode,
                        org: geoData.org,
                        timezone: geoData.timezone ?? null
                    }
                };
            }
            return {
                success: true,
                data: {
                    countryCode: null,
                    org: null,
                    timezone: null
                }
            };
        }
        catch (error) {
            console.error('Error updating server geolocation:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=servers.js.map