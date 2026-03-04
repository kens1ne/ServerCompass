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
exports.registerSSHHandlers = registerSSHHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const SSHService_1 = require("../services/SSHService");
const CredentialVault_1 = require("../services/CredentialVault");
const db_1 = require("../db");
const sshErrorLogger_1 = require("../utils/sshErrorLogger");
const child_process_1 = require("child_process");
const dns_1 = require("dns");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
/**
 * SSH IPC Handlers
 *
 * ERROR HANDLING STRATEGY:
 * ========================
 * All SSH operations use improved error logging from sshErrorLogger.ts
 *
 * WHEN TO USE logSSHError() vs logSSHErrorCompact():
 *
 * 1. logSSHError() - Full mode with detailed output:
 *    - User-facing operations (test connection, manual SSH commands)
 *    - First-time errors that users need to understand and fix
 *    - Connection setup and authentication errors
 *    Example: User clicks "Test Connection" → needs to know exactly what went wrong
 *
 * 2. logSSHErrorCompact() - Compact one-line mode:
 *    - Internal/automated operations (execute command, metrics polling, docker ps)
 *    - High-frequency operations that might fail occasionally
 *    - Background operations where we want to reduce log noise
 *    Example: Auto-refreshing Docker containers every 30s → don't spam logs with full errors
 *
 * CONTEXT OBJECT:
 * ===============
 * Always provide context to help debug:
 * - operation: What was being attempted (e.g., 'testConnection', 'executeCommand')
 * - serverId: Which server (from database) - helps correlate with other logs
 * - serverHost: Which IP/hostname - helps with network debugging
 * - command: What command was running (for executeCommand) - truncated if too long
 *
 * ERROR DEDUPLICATION:
 * ====================
 * The logger automatically deduplicates errors within a 5-second window
 * Same error type + server + operation = only logged once, then suppressed
 * After 5 seconds of quiet, logging resumes
 *
 * This prevents:
 * - 10+ identical "Channel open failure" errors from parallel operations
 * - Log spam during SSH connection storms
 * - Missing actual different errors in the noise
 */
function registerSSHHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_TEST_CONNECTION, async (_event, input) => {
        try {
            const config = types_1.SSHTestConnectionSchema.parse(input);
            const ok = await SSHService_1.sshService.testConnection({
                host: config.host,
                port: config.port,
                username: config.username,
                password: config.auth.type === 'password' ? config.auth.value : undefined,
                privateKey: config.auth.type === 'private_key' ? config.auth.value : undefined,
            });
            return { success: true, data: ok };
        }
        catch (error) {
            // CRITICAL: Use improved SSH error logging with context
            if (error instanceof Error) {
                (0, sshErrorLogger_1.logSSHError)(error, {
                    operation: 'testConnection',
                    serverHost: input.host,
                });
            }
            else {
                console.error('[SSH] Error testing connection:', error);
            }
            return { success: false, error: String(error) };
        }
    });
    // Test connection for an existing server using stored credentials
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_TEST_EXISTING_CONNECTION, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            // Get server from database
            const server = db_1.queries.getServerById(serverId);
            if (!server) {
                return { success: false, error: 'Server not found' };
            }
            // Decrypt credentials
            const vault = new CredentialVault_1.CredentialVault();
            const credential = await vault.decrypt(server.encrypted_secret);
            // Test connection
            const ok = await SSHService_1.sshService.testConnection({
                host: server.host,
                port: server.port,
                username: server.username,
                password: server.auth_type === 'password' ? credential : undefined,
                privateKey: server.auth_type === 'private_key' ? credential : undefined,
            });
            return { success: true, data: ok };
        }
        catch (error) {
            if (error instanceof Error) {
                (0, sshErrorLogger_1.logSSHError)(error, {
                    operation: 'testExistingConnection',
                    serverId: input?.id,
                });
            }
            else {
                console.error('[SSH] Error testing existing connection:', error);
            }
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_EXECUTE_COMMAND, async (_event, input) => {
        try {
            const config = types_1.SSHCommandSchema.parse(input);
            const result = await SSHService_1.sshService.executeCommand(config.serverId, config.command);
            return { success: true, data: result };
        }
        catch (error) {
            // CRITICAL: Use improved SSH error logging with context
            // Use compact logging for command execution to reduce noise (these are frequent)
            if (error instanceof Error) {
                (0, sshErrorLogger_1.logSSHErrorCompact)(error, {
                    operation: 'executeCommand',
                    serverId: input.serverId,
                    command: input.command,
                });
            }
            else {
                console.error('[SSH] Error executing command:', error);
            }
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_GENERATE_KEY, async (_event, input) => {
        try {
            const options = types_1.GenerateSSHKeySchema.parse(input);
            const expandedFilename = (() => {
                if (options.filename.startsWith('~')) {
                    return path_1.default.join(os_1.default.homedir(), options.filename.slice(1));
                }
                if (path_1.default.isAbsolute(options.filename)) {
                    return options.filename;
                }
                return path_1.default.join(os_1.default.homedir(), '.ssh', options.filename);
            })();
            const targetDir = path_1.default.dirname(expandedFilename);
            fs_1.default.mkdirSync(targetDir, { recursive: true });
            // Remove existing key files to avoid ssh-keygen's interactive overwrite prompt
            // (which would hang since execFile doesn't provide stdin)
            const publicKeyPath = `${expandedFilename}.pub`;
            if (fs_1.default.existsSync(expandedFilename)) {
                fs_1.default.unlinkSync(expandedFilename);
            }
            if (fs_1.default.existsSync(publicKeyPath)) {
                fs_1.default.unlinkSync(publicKeyPath);
            }
            await new Promise((resolve, reject) => {
                const args = ['-t', 'ed25519', '-f', expandedFilename, '-N', options.passphrase || ''];
                if (options.comment) {
                    args.push('-C', options.comment);
                }
                (0, child_process_1.execFile)('ssh-keygen', args, (error) => {
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve();
                    }
                });
            });
            return {
                success: true,
                data: {
                    privateKeyPath: expandedFilename,
                    publicKeyPath: `${expandedFilename}.pub`,
                },
            };
        }
        catch (error) {
            console.error('Error generating SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_LIST_KEYS, async (_event, input) => {
        try {
            types_1.ListSSHKeysSchema.parse(input ?? {});
            const keys = SSHService_1.sshService.listLocalKeys();
            return { success: true, data: keys };
        }
        catch (error) {
            console.error('Error listing SSH keys:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_LIST_KEYS_PROGRESSIVE, async (event, input) => {
        try {
            const { additionalPaths } = types_1.ListSSHKeysProgressiveSchema.parse(input ?? {});
            const window = electron_1.BrowserWindow.fromWebContents(event.sender);
            const keys = await SSHService_1.sshService.listLocalKeysProgressive((progress) => {
                // Send progress updates to the renderer
                if (window && !window.isDestroyed()) {
                    window.webContents.send(types_1.IPC_CHANNELS.SSH_KEY_SCAN_PROGRESS, progress);
                }
            }, additionalPaths);
            return { success: true, data: keys };
        }
        catch (error) {
            console.error('Error listing SSH keys progressively:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_READ_KEY, async (_event, input) => {
        try {
            const { path: keyPath } = types_1.ReadSSHKeySchema.parse(input);
            // Expand ~ to home directory
            const expandedPath = keyPath.startsWith('~')
                ? path_1.default.join(os_1.default.homedir(), keyPath.slice(1))
                : keyPath;
            const content = SSHService_1.sshService.readLocalKey(expandedPath);
            return { success: true, data: { content } };
        }
        catch (error) {
            console.error('Error reading SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
    // SSH_DELETE_KEY handler with path whitelisting for security
    // Only allows deletion of keys within ~/.ssh/servercompass/ directory
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_DELETE_KEY, async (_event, input) => {
        try {
            const { keyPath } = types_1.DeleteSSHKeySchema.parse(input);
            // Expand ~ to home directory
            const expandedPath = keyPath.startsWith('~')
                ? path_1.default.join(os_1.default.homedir(), keyPath.slice(1))
                : keyPath;
            // Security: Path whitelisting - only allow deletion from ~/.ssh/servercompass/
            const allowedDir = path_1.default.join(os_1.default.homedir(), '.ssh', 'servercompass');
            const resolvedPath = path_1.default.resolve(expandedPath);
            const resolvedAllowedDir = path_1.default.resolve(allowedDir);
            // Ensure the path is within the allowed directory
            if (!resolvedPath.startsWith(resolvedAllowedDir + path_1.default.sep) && resolvedPath !== resolvedAllowedDir) {
                console.error(`[SSH_DELETE_KEY] Blocked: Path "${keyPath}" is outside allowed directory "${allowedDir}"`);
                return {
                    success: false,
                    error: `Security violation: Can only delete keys from ${allowedDir}`,
                };
            }
            // Check if file exists
            if (!fs_1.default.existsSync(resolvedPath)) {
                return { success: true }; // Already deleted, consider success
            }
            // Delete the private key
            fs_1.default.unlinkSync(resolvedPath);
            console.log(`[SSH_DELETE_KEY] Deleted private key: ${resolvedPath}`);
            // Also delete the public key if it exists
            const pubKeyPath = `${resolvedPath}.pub`;
            if (fs_1.default.existsSync(pubKeyPath)) {
                fs_1.default.unlinkSync(pubKeyPath);
                console.log(`[SSH_DELETE_KEY] Deleted public key: ${pubKeyPath}`);
            }
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_GET_NETWORK_INTERFACES, async (_event, input) => {
        try {
            const { serverId } = types_1.GetNetworkInterfacesSchema.parse(input);
            // Execute `ip -4 -o addr show` to get all IPv4 addresses
            const result = await SSHService_1.sshService.executeCommand(serverId, 'ip -4 -o addr show');
            if (!result.stdout) {
                return { success: true, data: [] };
            }
            const interfaces = [];
            const lines = result.stdout.trim().split('\n');
            for (const line of lines) {
                // Parse output like: "2: eth0    inet 5.223.74.101/32 ..."
                const match = line.match(/^\d+:\s+(\S+)\s+inet\s+([0-9.]+)\/\d+/);
                if (!match)
                    continue;
                const ifaceName = match[1];
                const ipAddress = match[2];
                // Determine type and purpose
                let type = 'Unknown';
                let purpose = '';
                if (ifaceName === 'lo') {
                    type = 'Local loopback';
                    purpose = 'Used by the system itself';
                }
                else if (ipAddress.startsWith('10.') || ipAddress.startsWith('172.') || ipAddress.startsWith('192.168.')) {
                    type = 'Private/Internal';
                    purpose = 'Internal or backend network (e.g., private routing, NAT, or VPN)';
                }
                else if (ipAddress === '127.0.0.1') {
                    type = 'Local loopback';
                    purpose = 'Used by the system itself';
                }
                else {
                    type = 'Public';
                    purpose = 'Internet-facing IP accessible from anywhere';
                }
                interfaces.push({
                    interface: ifaceName,
                    type,
                    ipAddress,
                    purpose,
                });
            }
            return { success: true, data: interfaces };
        }
        catch (error) {
            console.error('Error getting network interfaces:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SSH_DNS_LOOKUP, async (_event, input) => {
        try {
            const { domain, bypassCache } = types_1.DNSLookupSchema.parse(input);
            let addresses;
            if (bypassCache) {
                // Use a custom resolver with public DNS servers to bypass local cache
                // This queries Google (8.8.8.8) and Cloudflare (1.1.1.1) DNS directly
                const { Resolver } = await Promise.resolve().then(() => __importStar(require('dns'))).then(m => m.promises);
                const resolver = new Resolver();
                resolver.setServers(['8.8.8.8', '1.1.1.1']);
                addresses = await resolver.resolve4(domain);
            }
            else {
                // Use system DNS resolver (may use cached results)
                addresses = await dns_1.promises.resolve4(domain);
            }
            return {
                success: true,
                data: {
                    domain,
                    addresses,
                    resolvedAt: Date.now(),
                },
            };
        }
        catch (error) {
            console.error('Error performing DNS lookup:', error);
            // Provide more specific error messages
            let errorMessage = String(error);
            if (error.code === 'ENOTFOUND') {
                errorMessage = `Domain "${input?.domain || 'unknown'}" could not be resolved. Please check if the domain is correct and DNS records are configured.`;
            }
            else if (error.code === 'ENODATA') {
                errorMessage = `No DNS records found for "${input?.domain || 'unknown'}".`;
            }
            return { success: false, error: errorMessage };
        }
    });
}
//# sourceMappingURL=ssh.js.map