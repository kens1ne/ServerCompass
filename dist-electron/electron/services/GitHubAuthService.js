"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubAuthService = void 0;
const events_1 = require("events");
const SecureStorageService_1 = require("./SecureStorageService");
const runtime_config_1 = require("../utils/runtime-config");
/**
 * GitHub OAuth Device Flow authentication service
 *
 * Events:
 * - 'authenticated': { token: string, user: GitHubUser }
 * - 'error': Error
 * - 'signed-out': void
 */
class GitHubAuthService extends events_1.EventEmitter {
    clientId;
    storage;
    pollingInterval = null;
    constructor() {
        super();
        // Load from environment (dev) or runtime config (production)
        this.clientId = (0, runtime_config_1.getGitHubClientId)();
        this.storage = new SecureStorageService_1.SecureStorageService();
        if (!this.clientId) {
            console.warn('[GitHubAuth] GITHUB_CLIENT_ID is not configured in environment or runtime config');
        }
        else {
            console.log('[GitHubAuth] GitHub Client ID loaded successfully');
        }
    }
    /**
     * Start GitHub Device Flow authentication
     * Returns device code that user needs to enter on GitHub
     */
    async startDeviceFlow() {
        console.log('[GitHubAuth] Starting device flow...');
        if (!this.clientId) {
            throw new Error('GITHUB_CLIENT_ID is not configured');
        }
        try {
            // Step 1: Request device code from GitHub
            const response = await fetch('https://github.com/login/device/code', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    client_id: this.clientId,
                    scope: 'repo workflow write:packages read:user user:email admin:public_key',
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                console.error('[GitHubAuth] GitHub API error response:', data);
                throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${data.error || ''}: ${data.error_description || ''}`);
            }
            console.log('[GitHubAuth] Device code received:', {
                userCode: data.user_code,
                verificationUri: data.verification_uri,
                expiresIn: data.expires_in,
                interval: data.interval,
            });
            // Step 2: Start polling for token
            this.startPolling(data.device_code, data.interval);
            return data;
        }
        catch (error) {
            console.error('[GitHubAuth] Failed to start device flow:', error);
            throw new Error('Failed to start GitHub authentication');
        }
    }
    /**
     * Poll GitHub for access token
     * Automatically called after startDeviceFlow()
     */
    startPolling(deviceCode, interval) {
        console.log('[GitHubAuth] Starting to poll for token (interval:', interval, 'seconds)');
        this.pollingInterval = setInterval(async () => {
            try {
                const response = await fetch('https://github.com/login/oauth/access_token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({
                        client_id: this.clientId,
                        device_code: deviceCode,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    }),
                });
                const data = await response.json();
                if (data.access_token) {
                    // Success! We got the token
                    console.log('[GitHubAuth] Access token received');
                    this.stopPolling();
                    // Get user info first
                    const user = await this.getUserInfo(data.access_token);
                    // Save token securely with username and account info
                    await this.storage.saveGitHubToken(user.login, data.access_token, {
                        username: user.login,
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        avatar_url: user.avatar_url,
                    });
                    const scopes = typeof data.scope === 'string'
                        ? data.scope.split(/[\s,]+/).filter(Boolean)
                        : [];
                    // Emit success event
                    this.emit('authenticated', {
                        token: data.access_token,
                        user,
                        username: user.login,
                        scopes,
                    });
                }
                else if (data.error === 'authorization_pending') {
                    // User hasn't authorized yet, keep polling
                    console.log('[GitHubAuth] Still waiting for user authorization...');
                }
                else if (data.error === 'slow_down') {
                    // We're polling too fast, increase interval
                    console.log('[GitHubAuth] Slowing down polling...');
                    this.stopPolling();
                    this.startPolling(deviceCode, interval + 5);
                }
                else if (data.error === 'expired_token') {
                    // Device code expired
                    console.log('[GitHubAuth] Device code expired');
                    this.stopPolling();
                    this.emit('error', new Error('Authentication timeout - device code expired'));
                }
                else if (data.error === 'access_denied') {
                    // User denied access
                    console.log('[GitHubAuth] User denied access');
                    this.stopPolling();
                    this.emit('error', new Error('Access denied by user'));
                }
                else {
                    // Unknown error
                    console.error('[GitHubAuth] Unknown error:', data);
                    this.stopPolling();
                    this.emit('error', new Error(data.error_description || data.error || 'Unknown error'));
                }
            }
            catch (error) {
                console.error('[GitHubAuth] Polling error:', error);
                this.stopPolling();
                this.emit('error', error);
            }
        }, interval * 1000);
    }
    /**
     * Stop polling for token
     */
    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            console.log('[GitHubAuth] Stopped polling');
        }
    }
    /**
     * Get user info from GitHub API
     */
    async getUserInfo(token) {
        const response = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
            },
        });
        if (!response.ok) {
            throw new Error('Failed to get user info from GitHub');
        }
        const user = await response.json();
        console.log('[GitHubAuth] User info retrieved:', user.login);
        return user;
    }
    /**
     * Check if user is authenticated
     */
    async isAuthenticated() {
        return await this.storage.isAuthenticated();
    }
    /**
     * Get current user for active account
     */
    async getCurrentUser() {
        const activeAccount = await this.storage.getActiveAccount();
        if (!activeAccount)
            return null;
        const token = await this.storage.getGitHubToken(activeAccount);
        if (!token)
            return null;
        try {
            return await this.getUserInfo(token);
        }
        catch (error) {
            console.error('[GitHubAuth] Failed to get current user:', error);
            // Token might be expired or invalid
            await this.storage.deleteGitHubToken(activeAccount);
            return null;
        }
    }
    /**
     * Get user for a specific account
     */
    async getUserForAccount(username) {
        const token = await this.storage.getGitHubToken(username);
        if (!token)
            return null;
        try {
            return await this.getUserInfo(token);
        }
        catch (error) {
            console.error('[GitHubAuth] Failed to get user for account:', username, error);
            return null;
        }
    }
    /**
     * List all connected GitHub accounts
     */
    async listAccounts() {
        return await this.storage.listGitHubAccounts();
    }
    /**
     * Get active account username
     */
    async getActiveAccount() {
        return await this.storage.getActiveAccount();
    }
    /**
     * Switch to a different account
     */
    async switchAccount(username) {
        await this.storage.setActiveAccount(username);
        console.log('[GitHubAuth] Switched to account:', username);
        this.emit('account-switched', { username });
    }
    /**
     * Sign out from a specific account
     */
    async signOutAccount(username) {
        await this.storage.deleteGitHubToken(username);
        console.log('[GitHubAuth] Account signed out:', username);
        this.emit('account-removed', { username });
    }
    /**
     * Sign out from all accounts
     */
    async signOut() {
        const accounts = await this.storage.listGitHubAccounts();
        for (const account of accounts) {
            await this.storage.deleteGitHubToken(account.username);
        }
        console.log('[GitHubAuth] All accounts signed out');
        this.emit('signed-out');
    }
    /**
     * Cleanup - stop polling and remove listeners
     */
    destroy() {
        this.stopPolling();
        this.removeAllListeners();
        console.log('[GitHubAuth] Service destroyed');
    }
}
exports.GitHubAuthService = GitHubAuthService;
//# sourceMappingURL=GitHubAuthService.js.map