"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSecurityHandlers = registerSecurityHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const SecurityService_1 = require("../services/SecurityService");
const SSHService_1 = require("../services/SSHService");
const CredentialVault_1 = require("../services/CredentialVault");
const db_1 = require("../db");
function registerSecurityHandlers() {
    // ============ fail2ban Handlers ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_STATUS, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            const status = await SecurityService_1.securityService.getFail2BanStatus(serverId);
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Error getting fail2ban status:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_INSTALL, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.installFail2Ban(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error installing fail2ban:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_CONFIGURE, async (_event, input) => {
        try {
            const config = types_1.Fail2BanConfigSchema.parse(input);
            await SecurityService_1.securityService.configureFail2Ban(config.serverId, config);
            return { success: true };
        }
        catch (error) {
            console.error('Error configuring fail2ban:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_UNBAN, async (_event, input) => {
        try {
            const { serverId, ip, jail } = types_1.Fail2BanUnbanSchema.parse(input);
            await SecurityService_1.securityService.unbanIP(serverId, ip, jail);
            return { success: true };
        }
        catch (error) {
            console.error('Error unbanning IP:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_WHITELIST, async (_event, input) => {
        try {
            const { serverId, ips } = types_1.Fail2BanWhitelistSchema.parse(input);
            // Get current config and update whitelist
            const status = await SecurityService_1.securityService.getFail2BanStatus(serverId);
            if (status.config) {
                await SecurityService_1.securityService.configureFail2Ban(serverId, {
                    serverId,
                    enabled: status.sshJail.enabled,
                    banTime: status.config.banTime,
                    findTime: status.config.findTime,
                    maxRetry: status.config.maxRetry,
                    whitelistIPs: ips,
                });
            }
            return { success: true };
        }
        catch (error) {
            console.error('Error updating whitelist:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ UFW Firewall Handlers ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_STATUS, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            const status = await SecurityService_1.securityService.getUFWStatus(serverId);
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Error getting UFW status:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_INSTALL, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.installUFW(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error installing UFW:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_ENABLE, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.enableUFW(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error enabling UFW:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_DISABLE, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.disableUFW(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error disabling UFW:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_ADD_RULE, async (_event, input) => {
        try {
            const rule = types_1.UFWRuleSchema.parse(input);
            await SecurityService_1.securityService.addUFWRule(rule.serverId, {
                action: rule.action,
                port: rule.port,
                protocol: rule.protocol,
                from: rule.from,
                comment: rule.comment,
            });
            return { success: true };
        }
        catch (error) {
            console.error('Error adding UFW rule:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_DELETE_RULE, async (_event, input) => {
        try {
            const { serverId, ruleNumber } = types_1.UFWDeleteRuleSchema.parse(input);
            await SecurityService_1.securityService.deleteUFWRule(serverId, ruleNumber);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting UFW rule:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UFW_SET_DEFAULT, async (_event, input) => {
        try {
            const { serverId, direction, policy } = types_1.UFWSetDefaultSchema.parse(input);
            await SecurityService_1.securityService.setUFWDefault(serverId, direction, policy);
            return { success: true };
        }
        catch (error) {
            console.error('Error setting UFW default:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ SSH Hardening Handlers ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_SSH_STATUS, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            const status = await SecurityService_1.securityService.getSSHStatus(serverId);
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Error getting SSH status:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_SSH_CONFIGURE, async (_event, input) => {
        try {
            const config = types_1.SSHConfigSchema.parse(input);
            await SecurityService_1.securityService.configureSSH(config.serverId, config);
            return { success: true };
        }
        catch (error) {
            console.error('Error configuring SSH:', error);
            return { success: false, error: String(error) };
        }
    });
    // Safe SSH port change with verification and database update
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_SSH_CHANGE_PORT, async (_event, input) => {
        try {
            const { serverId, currentPort, newPort } = types_1.SSHPortChangeSchema.parse(input);
            const result = await SecurityService_1.securityService.changeSSHPortSafely(serverId, currentPort, newPort, (id, port) => {
                db_1.queries.updateServer(id, { port });
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error changing SSH port:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Auto Updates Handlers ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UPDATES_STATUS, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            const status = await SecurityService_1.securityService.getAutoUpdatesStatus(serverId);
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Error getting auto updates status:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UPDATES_INSTALL, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.installAutoUpdates(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error installing auto updates:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UPDATES_CONFIGURE, async (_event, input) => {
        try {
            const config = types_1.AutoUpdatesConfigSchema.parse(input);
            await SecurityService_1.securityService.configureAutoUpdates(config.serverId, config);
            return { success: true };
        }
        catch (error) {
            console.error('Error configuring auto updates:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UPDATES_CHECK, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            const pendingCount = await SecurityService_1.securityService.checkForUpdates(serverId);
            return { success: true, data: { pendingCount } };
        }
        catch (error) {
            console.error('Error checking for updates:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_UPDATES_APPLY, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.applyUpdates(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error applying updates:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Security Audit Handlers ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_AUDIT, async (_event, input) => {
        try {
            const { serverId } = types_1.SecurityAuditSchema.parse(input);
            const result = await SecurityService_1.securityService.runSecurityAudit(serverId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error running security audit:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_QUICK_HARDEN, async (_event, input) => {
        try {
            const { id: serverId } = types_1.ServerIdSchema.parse(input);
            await SecurityService_1.securityService.quickHarden(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error running quick harden:', error);
            return { success: false, error: String(error) };
        }
    });
    // Test SSH connection with a different username (using existing server credentials)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_TEST_USERNAME, async (_event, input) => {
        try {
            const { serverId, username } = types_1.SSHTestUsernameSchema.parse(input);
            // Get server info
            const server = db_1.queries.getServerById(serverId);
            if (!server) {
                return { success: false, error: 'Server not found' };
            }
            // Get decrypted credentials
            const vault = new CredentialVault_1.CredentialVault();
            const credential = await vault.decrypt(server.encrypted_secret);
            // Build connection config with new username
            const connectionConfig = {
                host: server.host,
                port: server.port,
                username: username,
            };
            if (server.auth_type === 'password') {
                connectionConfig.password = credential;
            }
            else {
                connectionConfig.privateKey = credential;
            }
            // Test connection
            const result = await SSHService_1.sshService.testConnection(connectionConfig);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error testing username:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ User Management Handlers ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_USERS_LIST, async (_event, input) => {
        try {
            const { serverId } = types_1.UserListSchema.parse(input);
            const users = await SecurityService_1.securityService.listUsers(serverId);
            return { success: true, data: users };
        }
        catch (error) {
            console.error('Error listing users:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_USERS_CREATE, async (_event, input) => {
        try {
            const params = types_1.UserCreateSchema.parse(input);
            const result = await SecurityService_1.securityService.createUser(params.serverId, params);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error creating user:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_USERS_DELETE, async (_event, input) => {
        try {
            const { serverId, username, removeHome } = types_1.UserDeleteSchema.parse(input);
            await SecurityService_1.securityService.deleteUser(serverId, username, removeHome);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting user:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_USERS_ADD_KEY, async (_event, input) => {
        try {
            const { serverId, username, publicKey } = types_1.UserAddKeySchema.parse(input);
            await SecurityService_1.securityService.addUserSSHKey(serverId, username, publicKey);
            return { success: true };
        }
        catch (error) {
            console.error('Error adding SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_USERS_LIST_KEYS, async (_event, input) => {
        try {
            const { serverId, username } = types_1.UserListKeysSchema.parse(input);
            const keys = await SecurityService_1.securityService.listUserSSHKeys(serverId, username);
            return { success: true, data: keys };
        }
        catch (error) {
            console.error('Error listing SSH keys:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECURITY_USERS_REMOVE_KEY, async (_event, input) => {
        try {
            const { serverId, username, keyIndex } = types_1.UserRemoveKeySchema.parse(input);
            await SecurityService_1.securityService.removeUserSSHKey(serverId, username, keyIndex);
            return { success: true };
        }
        catch (error) {
            console.error('Error removing SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=security.js.map