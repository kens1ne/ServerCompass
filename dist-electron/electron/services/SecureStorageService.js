"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecureStorageService = void 0;
const keytar_1 = __importDefault(require("keytar"));
const types_1 = require("../ipc/types");
const SERVICE_NAME = 'ServerCompass';
const GITHUB_ACCOUNTS_KEY = 'github-accounts-list';
const ACTIVE_ACCOUNT_KEY = 'github-active-account';
const BACKUP_PASSPHRASE_KEY = 'backup-passphrase';
/**
 * Secure storage service using system keychain
 * Supports multiple GitHub accounts
 * - macOS: Keychain
 * - Windows: Credential Manager
 * - Linux: Secret Service API (libsecret)
 */
class SecureStorageService {
    // In-memory cache for keychain access check (cleared on app restart)
    keychainAccessCache = null;
    /**
     * Check if keychain access is available
     * Uses a single read operation to minimize permission prompts
     * Results are cached in-memory to avoid repeated prompts during the same session
     *
     * @param forceCheck - Skip cache and perform fresh check (useful after permission change)
     */
    async checkKeychainAccess(forceCheck = false) {
        // Return cached result unless force check is requested
        if (!forceCheck && this.keychainAccessCache !== null) {
            console.log('[SecureStorage] Using cached keychain access result:', this.keychainAccessCache.hasAccess);
            return this.keychainAccessCache;
        }
        try {
            // Single operation: attempt to read accounts list (lightweight and likely exists)
            // This triggers only ONE permission prompt instead of three (set, get, delete)
            await keytar_1.default.getPassword(SERVICE_NAME, GITHUB_ACCOUNTS_KEY);
            console.log('[SecureStorage] Keychain access verified');
            const result = { hasAccess: true };
            // Cache successful result
            this.keychainAccessCache = result;
            return result;
        }
        catch (error) {
            console.error('[SecureStorage] Keychain access check failed:', error);
            // Detect specific error types
            const errorMessage = error?.message?.toLowerCase() || '';
            let result;
            if (errorMessage.includes('user canceled') ||
                errorMessage.includes('access denied') ||
                errorMessage.includes('permission denied')) {
                result = {
                    hasAccess: false,
                    errorType: types_1.KeychainErrorType.PERMISSION_DENIED,
                    errorMessage: 'Keychain access was denied by the user',
                };
            }
            else if (errorMessage.includes('not available') ||
                errorMessage.includes('no such service') ||
                errorMessage.includes('dbus')) {
                result = {
                    hasAccess: false,
                    errorType: types_1.KeychainErrorType.NOT_AVAILABLE,
                    errorMessage: 'System keychain is not available',
                };
            }
            else {
                result = {
                    hasAccess: false,
                    errorType: types_1.KeychainErrorType.UNKNOWN_ERROR,
                    errorMessage: error?.message || 'Unknown keychain error',
                };
            }
            // Cache the error result to avoid repeated prompts
            this.keychainAccessCache = result;
            return result;
        }
    }
    /**
     * Clear the cached keychain access result
     * Useful when user grants permission and wants to retry
     */
    clearKeychainCache() {
        console.log('[SecureStorage] Keychain access cache cleared');
        this.keychainAccessCache = null;
    }
    /**
     * Save GitHub token for a specific account
     */
    async saveGitHubToken(username, token, accountInfo) {
        try {
            const accountKey = `github-token-${username}`;
            await keytar_1.default.setPassword(SERVICE_NAME, accountKey, token);
            // Update accounts list
            const accounts = await this.listGitHubAccounts();
            const existingIndex = accounts.findIndex(acc => acc.username === username);
            if (existingIndex >= 0) {
                accounts[existingIndex] = accountInfo;
            }
            else {
                accounts.push(accountInfo);
            }
            await keytar_1.default.setPassword(SERVICE_NAME, GITHUB_ACCOUNTS_KEY, JSON.stringify(accounts));
            // Set as active account if no active account exists
            const activeAccount = await this.getActiveAccount();
            if (!activeAccount) {
                await this.setActiveAccount(username);
            }
            console.log('[SecureStorage] GitHub token saved for account:', username);
        }
        catch (error) {
            console.error('[SecureStorage] Failed to save token:', error);
            throw new Error('Failed to save GitHub token to system keychain');
        }
    }
    /**
     * Get GitHub token for a specific account
     */
    async getGitHubToken(username) {
        try {
            const accountKey = `github-token-${username}`;
            const token = await keytar_1.default.getPassword(SERVICE_NAME, accountKey);
            if (token) {
                console.log('[SecureStorage] GitHub token retrieved for account:', username);
            }
            return token;
        }
        catch (error) {
            console.error('[SecureStorage] Failed to get token:', error);
            return null;
        }
    }
    /**
     * Get token for the active account
     */
    async getActiveGitHubToken() {
        const activeAccount = await this.getActiveAccount();
        if (!activeAccount) {
            return null;
        }
        return await this.getGitHubToken(activeAccount);
    }
    /**
     * Delete GitHub token for a specific account
     */
    async deleteGitHubToken(username) {
        try {
            const accountKey = `github-token-${username}`;
            const deleted = await keytar_1.default.deletePassword(SERVICE_NAME, accountKey);
            if (deleted) {
                // Remove from accounts list
                const accounts = await this.listGitHubAccounts();
                const filtered = accounts.filter(acc => acc.username !== username);
                await keytar_1.default.setPassword(SERVICE_NAME, GITHUB_ACCOUNTS_KEY, JSON.stringify(filtered));
                // If this was the active account, switch to another one or clear
                const activeAccount = await this.getActiveAccount();
                if (activeAccount === username) {
                    if (filtered.length > 0) {
                        await this.setActiveAccount(filtered[0].username);
                    }
                    else {
                        await keytar_1.default.deletePassword(SERVICE_NAME, ACTIVE_ACCOUNT_KEY);
                    }
                }
                console.log('[SecureStorage] GitHub token deleted for account:', username);
            }
            return deleted;
        }
        catch (error) {
            console.error('[SecureStorage] Failed to delete token:', error);
            return false;
        }
    }
    /**
     * List all connected GitHub accounts
     */
    async listGitHubAccounts() {
        try {
            const accountsJson = await keytar_1.default.getPassword(SERVICE_NAME, GITHUB_ACCOUNTS_KEY);
            if (!accountsJson) {
                return [];
            }
            return JSON.parse(accountsJson);
        }
        catch (error) {
            console.error('[SecureStorage] Failed to list accounts:', error);
            return [];
        }
    }
    /**
     * Set the active GitHub account
     */
    async setActiveAccount(username) {
        try {
            await keytar_1.default.setPassword(SERVICE_NAME, ACTIVE_ACCOUNT_KEY, username);
            console.log('[SecureStorage] Active account set to:', username);
        }
        catch (error) {
            console.error('[SecureStorage] Failed to set active account:', error);
            throw new Error('Failed to set active account');
        }
    }
    /**
     * Get the active GitHub account username
     */
    async getActiveAccount() {
        try {
            return await keytar_1.default.getPassword(SERVICE_NAME, ACTIVE_ACCOUNT_KEY);
        }
        catch (error) {
            console.error('[SecureStorage] Failed to get active account:', error);
            return null;
        }
    }
    /**
     * Check if any GitHub account is authenticated
     */
    async isAuthenticated() {
        const accounts = await this.listGitHubAccounts();
        return accounts.length > 0;
    }
    /**
     * Get account info by username
     */
    async getAccountInfo(username) {
        const accounts = await this.listGitHubAccounts();
        return accounts.find(acc => acc.username === username) || null;
    }
    // ============================================
    // Backup Passphrase Methods (Per-Storage Config)
    // ============================================
    /**
     * Get the keychain key for a storage config's passphrase
     */
    getPassphraseKey(storageConfigId) {
        return `${BACKUP_PASSPHRASE_KEY}-${storageConfigId}`;
    }
    /**
     * Set the backup passphrase for a specific storage config
     * @param storageConfigId The ID of the storage configuration
     * @param passphrase The passphrase to encrypt backups
     */
    async setBackupPassphrase(passphrase, storageConfigId) {
        try {
            const key = storageConfigId ? this.getPassphraseKey(storageConfigId) : BACKUP_PASSPHRASE_KEY;
            await keytar_1.default.setPassword(SERVICE_NAME, key, passphrase);
            console.log(`[SecureStorage] Backup passphrase saved for ${storageConfigId || 'global'}`);
        }
        catch (error) {
            console.error('[SecureStorage] Failed to save backup passphrase:', error);
            throw new Error('Failed to save backup passphrase to system keychain');
        }
    }
    /**
     * Get the backup passphrase for a specific storage config
     * @param storageConfigId The ID of the storage configuration
     */
    async getBackupPassphrase(storageConfigId) {
        try {
            const key = storageConfigId ? this.getPassphraseKey(storageConfigId) : BACKUP_PASSPHRASE_KEY;
            const passphrase = await keytar_1.default.getPassword(SERVICE_NAME, key);
            if (passphrase) {
                console.log(`[SecureStorage] Backup passphrase retrieved for ${storageConfigId || 'global'}`);
            }
            return passphrase;
        }
        catch (error) {
            console.error('[SecureStorage] Failed to get backup passphrase:', error);
            return null;
        }
    }
    /**
     * Check if a backup passphrase is set for a specific storage config
     * @param storageConfigId The ID of the storage configuration
     */
    async hasBackupPassphrase(storageConfigId) {
        try {
            const key = storageConfigId ? this.getPassphraseKey(storageConfigId) : BACKUP_PASSPHRASE_KEY;
            const passphrase = await keytar_1.default.getPassword(SERVICE_NAME, key);
            return passphrase !== null && passphrase.length > 0;
        }
        catch (error) {
            console.error('[SecureStorage] Failed to check backup passphrase:', error);
            return false;
        }
    }
    /**
     * Clear the backup passphrase for a specific storage config
     * @param storageConfigId The ID of the storage configuration
     */
    async clearBackupPassphrase(storageConfigId) {
        try {
            const key = storageConfigId ? this.getPassphraseKey(storageConfigId) : BACKUP_PASSPHRASE_KEY;
            const deleted = await keytar_1.default.deletePassword(SERVICE_NAME, key);
            if (deleted) {
                console.log(`[SecureStorage] Backup passphrase cleared for ${storageConfigId || 'global'}`);
            }
            return deleted;
        }
        catch (error) {
            console.error('[SecureStorage] Failed to clear backup passphrase:', error);
            return false;
        }
    }
}
exports.SecureStorageService = SecureStorageService;
//# sourceMappingURL=SecureStorageService.js.map