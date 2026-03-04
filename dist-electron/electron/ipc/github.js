"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGitHubHandlers = registerGitHubHandlers;
const electron_1 = require("electron");
const ServerGitAccountService_1 = require("../services/ServerGitAccountService");
const logger_1 = require("../logger");
const db_1 = require("../db");
/**
 * Register GitHub IPC handlers
 */
function registerGitHubHandlers(authService, apiService) {
    console.log('[IPC] Registering GitHub handlers');
    /**
     * Start GitHub Device Flow authentication
     */
    electron_1.ipcMain.handle('github:start-auth', async () => {
        try {
            const deviceCode = await authService.startDeviceFlow();
            // Open verification URL in browser
            await electron_1.shell.openExternal(deviceCode.verification_uri);
            return {
                success: true,
                data: {
                    userCode: deviceCode.user_code,
                    verificationUri: deviceCode.verification_uri,
                    expiresIn: deviceCode.expires_in,
                },
            };
        }
        catch (error) {
            console.error('[IPC] Failed to start GitHub auth:', error);
            return {
                success: false,
                error: error.message || 'Failed to start GitHub authentication',
            };
        }
    });
    /**
     * Check authentication status and get current user
     */
    electron_1.ipcMain.handle('github:check-auth', async () => {
        try {
            const user = await authService.getCurrentUser();
            return {
                success: true,
                data: {
                    authenticated: !!user,
                    user,
                },
            };
        }
        catch (error) {
            console.error('[IPC] Failed to check GitHub auth:', error);
            return {
                success: true,
                data: {
                    authenticated: false,
                    user: null,
                },
            };
        }
    });
    /**
     * Get repositories for authenticated user
     */
    electron_1.ipcMain.handle('github:get-repos', async () => {
        try {
            const repos = await apiService.getRepositories({
                sort: 'updated',
                per_page: 100,
            });
            return {
                success: true,
                data: repos,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get GitHub repositories:', error);
            return {
                success: false,
                error: error.message || 'Failed to fetch repositories',
            };
        }
    });
    /**
     * Detect framework for a specific repository
     */
    electron_1.ipcMain.handle('github:detect-framework', async (_event, owner, repo) => {
        try {
            const framework = await apiService.detectFramework(owner, repo);
            return {
                success: true,
                data: framework,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to detect framework:', error);
            return {
                success: false,
                error: error.message || 'Failed to detect framework',
            };
        }
    });
    /**
     * Get branches for a repository
     */
    electron_1.ipcMain.handle('github:get-branches', async (_event, owner, repo) => {
        try {
            const branches = await apiService.getBranches(owner, repo);
            return {
                success: true,
                data: branches,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get branches:', error);
            return {
                success: false,
                error: error.message || 'Failed to fetch branches',
            };
        }
    });
    /**
     * Sign out from GitHub
     */
    electron_1.ipcMain.handle('github:sign-out', async () => {
        try {
            await authService.signOut();
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to sign out:', error);
            return {
                success: false,
                error: error.message || 'Failed to sign out',
            };
        }
    });
    /**
     * Upload SSH public key to GitHub
     */
    electron_1.ipcMain.handle('github:upload-ssh-key', async (_event, title, publicKey) => {
        try {
            await apiService.uploadSSHKey(title, publicKey);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to upload SSH key:', error);
            return {
                success: false,
                error: error.message || 'Failed to upload SSH key',
            };
        }
    });
    /**
     * List SSH keys on GitHub
     */
    electron_1.ipcMain.handle('github:list-ssh-keys', async () => {
        try {
            const keys = await apiService.listSSHKeys();
            return {
                success: true,
                data: keys,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to list SSH keys:', error);
            return {
                success: false,
                error: error.message || 'Failed to list SSH keys',
            };
        }
    });
    /**
     * Delete SSH key from GitHub
     */
    electron_1.ipcMain.handle('github:delete-ssh-key', async (_event, keyId) => {
        try {
            await apiService.deleteSSHKey(keyId);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to delete SSH key:', error);
            return {
                success: false,
                error: error.message || 'Failed to delete SSH key',
            };
        }
    });
    /**
     * List all connected GitHub accounts
     */
    electron_1.ipcMain.handle('github:list-accounts', async () => {
        try {
            const accounts = await authService.listAccounts();
            return {
                success: true,
                data: accounts,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to list accounts:', error);
            return {
                success: false,
                error: error.message || 'Failed to list accounts',
            };
        }
    });
    /**
     * Get active GitHub account
     */
    electron_1.ipcMain.handle('github:get-active-account', async () => {
        try {
            const activeAccount = await authService.getActiveAccount();
            return {
                success: true,
                data: activeAccount,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get active account:', error);
            return {
                success: false,
                error: error.message || 'Failed to get active account',
            };
        }
    });
    /**
     * Switch to a different GitHub account
     */
    electron_1.ipcMain.handle('github:switch-account', async (_event, username) => {
        try {
            await authService.switchAccount(username);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to switch account:', error);
            return {
                success: false,
                error: error.message || 'Failed to switch account',
            };
        }
    });
    /**
     * Sign out from a specific account
     */
    electron_1.ipcMain.handle('github:sign-out-account', async (_event, username) => {
        try {
            await authService.signOutAccount(username);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to sign out account:', error);
            return {
                success: false,
                error: error.message || 'Failed to sign out account',
            };
        }
    });
    /**
     * Get repositories for a specific account
     */
    electron_1.ipcMain.handle('github:get-repos-for-account', async (_event, username) => {
        try {
            const repos = await apiService.getRepositories({
                sort: 'updated',
                per_page: 100,
                username,
            });
            return {
                success: true,
                data: repos,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get repositories for account:', error);
            return {
                success: false,
                error: error.message || 'Failed to fetch repositories',
            };
        }
    });
    // Listen to auth service events and forward to renderer
    authService.on('authenticated', async (data) => {
        console.log('[IPC] Broadcasting authentication success to renderers');
        let gitAccountId = null;
        try {
            const username = data.username || data.user?.login;
            if (username) {
                const accountInfo = {
                    username,
                    id: data.user?.id ?? Date.now(),
                    name: data.user?.name ?? null,
                    email: data.user?.email ?? null,
                    avatar_url: data.user?.avatar_url ?? '',
                };
                gitAccountId = await ServerGitAccountService_1.serverGitAccountService.syncAccountFromOAuth(accountInfo, data.token, 'github', data.scopes);
                console.log('[IPC] Synced GitHub account, gitAccountId:', gitAccountId);
            }
        }
        catch (error) {
            console.error('[IPC] Failed to sync GitHub account with database:', error);
        }
        const payload = {
            ...data,
            username: data.username || data.user?.login || null,
            gitAccountId,
        };
        // Broadcast to all windows
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('github:authenticated', payload);
        });
    });
    authService.on('error', (error) => {
        console.log('[IPC] Broadcasting authentication error to renderers');
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('github:auth-error', { error: error.message });
        });
    });
    authService.on('signed-out', () => {
        console.log('[IPC] Broadcasting sign-out to renderers');
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('github:signed-out');
        });
    });
    authService.on('account-switched', (data) => {
        console.log('[IPC] Broadcasting account switch to renderers');
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('github:account-switched', data);
        });
    });
    authService.on('account-removed', (data) => {
        console.log('[IPC] Broadcasting account removal to renderers');
        electron_1.BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('github:account-removed', data);
        });
    });
    // ============================================================================
    // SERVER-SCOPED GIT ACCOUNT HANDLERS
    // ============================================================================
    /**
     * Get all Git accounts linked to a specific server
     */
    electron_1.ipcMain.handle('github:get-server-accounts', async (_event, serverId) => {
        try {
            const accounts = await ServerGitAccountService_1.serverGitAccountService.getAccountsForServer(serverId);
            return {
                success: true,
                data: accounts,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get server accounts:', error);
            return {
                success: false,
                error: error.message || 'Failed to get server accounts',
            };
        }
    });
    /**
     * Get all global Git accounts (for adding to servers)
     */
    electron_1.ipcMain.handle('github:get-all-accounts', async () => {
        try {
            const accounts = await ServerGitAccountService_1.serverGitAccountService.getAllGitAccounts();
            return {
                success: true,
                data: accounts,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get all git accounts:', error);
            return {
                success: false,
                error: error.message || 'Failed to get all git accounts',
            };
        }
    });
    /**
     * Link a Git account to a server
     */
    electron_1.ipcMain.handle('github:link-to-server', async (_event, serverId, gitAccountId, isDefault = false) => {
        try {
            logger_1.logger.info('[IPC] link-to-server request', { serverId, gitAccountId, isDefault });
            await ServerGitAccountService_1.serverGitAccountService.linkAccountToServer(serverId, gitAccountId, isDefault);
            const [accounts, defaultAccount] = await Promise.all([
                ServerGitAccountService_1.serverGitAccountService.getAccountsForServer(serverId),
                ServerGitAccountService_1.serverGitAccountService.getDefaultAccountForServer(serverId),
            ]);
            logger_1.logger.info('[IPC] link-to-server response', {
                serverId,
                accountsCount: accounts.length,
                defaultAccount: defaultAccount?.username || null,
                accounts: accounts.map(a => ({ id: a.gitAccountId, username: a.username }))
            });
            return {
                success: true,
                data: {
                    accounts,
                    defaultAccount,
                },
            };
        }
        catch (error) {
            logger_1.logger.error('[IPC] Failed to link account to server:', error);
            return {
                success: false,
                error: error.message || 'Failed to link account to server',
            };
        }
    });
    /**
     * Unlink a Git account from a server
     */
    electron_1.ipcMain.handle('github:unlink-from-server', async (_event, serverId, gitAccountId) => {
        try {
            logger_1.logger.info('[IPC] unlink-from-server request', { serverId, gitAccountId });
            await ServerGitAccountService_1.serverGitAccountService.unlinkAccountFromServer(serverId, gitAccountId);
            // Ensure default is cleared if we removed it
            let defaultAccount = await ServerGitAccountService_1.serverGitAccountService.getDefaultAccountForServer(serverId);
            if (defaultAccount?.gitAccountId === gitAccountId) {
                defaultAccount = null;
            }
            const accounts = await ServerGitAccountService_1.serverGitAccountService.getAccountsForServer(serverId);
            return {
                success: true,
                data: {
                    accounts,
                    defaultAccount,
                },
            };
        }
        catch (error) {
            console.error('[IPC] Failed to unlink account from server:', error);
            return {
                success: false,
                error: error.message || 'Failed to unlink account from server',
            };
        }
    });
    /**
     * Set an account as default for a server
     */
    electron_1.ipcMain.handle('github:set-server-default', async (_event, serverId, gitAccountId) => {
        try {
            await ServerGitAccountService_1.serverGitAccountService.setDefaultAccount(serverId, gitAccountId);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to set default account:', error);
            return {
                success: false,
                error: error.message || 'Failed to set default account',
            };
        }
    });
    /**
     * Get default Git account for a server
     */
    electron_1.ipcMain.handle('github:get-server-default', async (_event, serverId) => {
        try {
            const account = await ServerGitAccountService_1.serverGitAccountService.getDefaultAccountForServer(serverId);
            return {
                success: true,
                data: account,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get default account:', error);
            return {
                success: false,
                error: error.message || 'Failed to get default account',
            };
        }
    });
    /**
     * Get repositories for a server's default account
     */
    electron_1.ipcMain.handle('github:get-server-repos', async (_event, serverId) => {
        try {
            const defaultAccount = await ServerGitAccountService_1.serverGitAccountService.getDefaultAccountForServer(serverId);
            if (!defaultAccount) {
                return {
                    success: false,
                    error: 'No default Git account set for this server',
                };
            }
            const repos = await apiService.getRepositories({
                sort: 'updated',
                per_page: 100,
                username: defaultAccount.username,
            });
            return {
                success: true,
                data: repos,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get server repositories:', error);
            return {
                success: false,
                error: error.message || 'Failed to fetch server repositories',
            };
        }
    });
    /**
     * Get git account ID by username
     */
    electron_1.ipcMain.handle('github:get-account-id-by-username', async (_event, username, provider = 'github') => {
        try {
            const accountId = await ServerGitAccountService_1.serverGitAccountService.getGitAccountIdByUsername(username, provider);
            return {
                success: true,
                data: accountId,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to get git account ID by username:', error);
            return {
                success: false,
                error: error.message || 'Failed to get git account ID',
            };
        }
    });
    /**
     * Analyze a repository for Docker deployment
     * Checks for docker-compose.yml, Dockerfile, and detects framework
     */
    electron_1.ipcMain.handle('github:analyze-repo-for-docker', async (_event, owner, repo) => {
        try {
            const analysis = await apiService.analyzeRepoForDocker(owner, repo);
            return {
                success: true,
                data: analysis,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to analyze repository for Docker:', error);
            return {
                success: false,
                error: error.message || 'Failed to analyze repository',
            };
        }
    });
    /**
     * Create a new GitHub repository
     */
    electron_1.ipcMain.handle('github:createRepo', async (_event, options) => {
        try {
            // Get the account to find the username
            const account = db_1.db.prepare(`
        SELECT username FROM git_accounts WHERE id = ?
      `).get(options.accountId);
            if (!account) {
                return {
                    success: false,
                    error: 'GitHub account not found',
                };
            }
            const repo = await apiService.createRepo({
                name: options.name,
                description: options.description,
                private: options.private ?? true,
                username: account.username,
            });
            return {
                success: true,
                data: repo,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to create repository:', error);
            return {
                success: false,
                error: error.message || 'Failed to create repository',
            };
        }
    });
    /**
     * Commit multiple files to a repository
     */
    electron_1.ipcMain.handle('github:commitFiles', async (_event, options) => {
        try {
            // Get the account to find the username
            const account = db_1.db.prepare(`
        SELECT username FROM git_accounts WHERE id = ?
      `).get(options.accountId);
            if (!account) {
                return {
                    success: false,
                    error: 'GitHub account not found',
                };
            }
            await apiService.createOrUpdateMultipleFiles(options.owner, options.repo, options.branch, options.files, options.message, account.username);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('[IPC] Failed to commit files:', error);
            return {
                success: false,
                error: error.message || 'Failed to commit files',
            };
        }
    });
    console.log('[IPC] GitHub handlers registered');
}
//# sourceMappingURL=github.js.map