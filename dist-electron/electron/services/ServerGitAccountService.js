"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serverGitAccountService = exports.ServerGitAccountService = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const CredentialVault_1 = require("./CredentialVault");
const SecureStorageService_1 = require("./SecureStorageService");
/**
 * Service for managing Git accounts scoped to specific servers
 */
class ServerGitAccountService {
    storage;
    vault;
    providerSourceIds = new Map();
    constructor() {
        this.storage = new SecureStorageService_1.SecureStorageService();
        this.vault = new CredentialVault_1.CredentialVault();
    }
    getProviderSourceId(provider) {
        const cached = this.providerSourceIds.get(provider);
        if (cached) {
            return cached;
        }
        const source = db_1.db.prepare(`
      SELECT id FROM git_sources WHERE type = ?
    `).get(provider);
        if (!source) {
            throw new Error(`Provider ${provider} not found`);
        }
        this.providerSourceIds.set(provider, source.id);
        return source.id;
    }
    sanitizeHostAlias(value) {
        const sanitized = value
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return sanitized || 'git-account';
    }
    ensureUniqueHostAlias(base) {
        const sanitizedBase = this.sanitizeHostAlias(base);
        let candidate = sanitizedBase;
        let counter = 1;
        while (db_1.db.prepare('SELECT 1 FROM git_accounts WHERE host_alias = ?').get(candidate)) {
            counter += 1;
            candidate = `${sanitizedBase}-${counter}`;
        }
        return candidate;
    }
    scopesToJson(scopes) {
        if (!scopes) {
            return null;
        }
        const collection = Array.isArray(scopes)
            ? scopes
            : scopes
                .split(/[\s,]+/)
                .map(scope => scope.trim())
                .filter(Boolean);
        return collection.length ? JSON.stringify(collection) : null;
    }
    async upsertGitAccountRecord(accountInfo, token, provider = 'github', scopes) {
        const sourceId = this.getProviderSourceId(provider);
        const now = Date.now();
        const scopesJson = this.scopesToJson(scopes);
        const encryptedToken = await this.vault.encrypt(token);
        const existing = db_1.db.prepare(`
      SELECT id FROM git_accounts
      WHERE username = ? AND source_id = ?
      LIMIT 1
    `).get(accountInfo.username, sourceId);
        if (existing?.id) {
            db_1.db.prepare(`
        UPDATE git_accounts
        SET alias = ?, email = ?, avatar_url = ?, scopes = ?, encrypted_token = ?, last_used_at = ?
        WHERE id = ?
      `).run(accountInfo.name || accountInfo.username, accountInfo.email, accountInfo.avatar_url, scopesJson, encryptedToken, now, existing.id);
            return existing.id;
        }
        const accountId = (0, crypto_1.randomUUID)();
        const hostAlias = this.ensureUniqueHostAlias(`${provider}-${accountInfo.username}`);
        db_1.db.prepare(`
      INSERT INTO git_accounts (
        id,
        source_id,
        alias,
        username,
        email,
        avatar_url,
        scopes,
        host_alias,
        encrypted_token,
        created_at,
        last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, sourceId, accountInfo.name || accountInfo.username, accountInfo.username, accountInfo.email, accountInfo.avatar_url, scopesJson, hostAlias, encryptedToken, now, now);
        return accountId;
    }
    async hydrateAccountsFromSecureStorage(provider = 'github') {
        const storedAccounts = await this.storage.listGitHubAccounts();
        if (!storedAccounts.length) {
            return;
        }
        const sourceId = this.getProviderSourceId(provider);
        for (const account of storedAccounts) {
            const exists = db_1.db.prepare(`
        SELECT 1 FROM git_accounts WHERE username = ? AND source_id = ?
      `).get(account.username, sourceId);
            if (exists) {
                continue;
            }
            const token = await this.storage.getGitHubToken(account.username);
            if (!token) {
                console.warn('[ServerGitAccountService] Missing token for account in secure storage:', account.username);
                continue;
            }
            await this.upsertGitAccountRecord(account, token, provider);
        }
    }
    async ensureGitAccountExists(gitAccountId, provider = 'github') {
        const exists = db_1.db.prepare('SELECT 1 FROM git_accounts WHERE id = ?').get(gitAccountId);
        if (exists) {
            console.log('[ServerGitAccountService] Git account exists in database:', gitAccountId);
            return;
        }
        console.warn('[ServerGitAccountService] Missing git account row for id, hydrating from secure storage:', gitAccountId);
        await this.hydrateAccountsFromSecureStorage(provider);
        const existsAfterHydration = db_1.db.prepare('SELECT 1 FROM git_accounts WHERE id = ?').get(gitAccountId);
        if (!existsAfterHydration) {
            // Log all existing account IDs for debugging
            const allAccounts = db_1.db.prepare('SELECT id, username FROM git_accounts').all();
            console.error('[ServerGitAccountService] Account not found after hydration. Existing accounts:', allAccounts);
            throw new Error('Git account not found. Connect it globally before linking to a server.');
        }
        console.log('[ServerGitAccountService] Git account found after hydration:', gitAccountId);
    }
    async syncAccountFromOAuth(accountInfo, token, provider = 'github', scopes) {
        return this.upsertGitAccountRecord(accountInfo, token, provider, scopes);
    }
    /**
     * Link a Git account to a server
     */
    async linkAccountToServer(serverId, gitAccountId, isDefault = false, sshKeyPath) {
        try {
            await this.ensureGitAccountExists(gitAccountId);
            // If this should be the default, unset other defaults for this server
            if (isDefault) {
                db_1.db.prepare(`
          UPDATE server_git_accounts
          SET is_default = 0
          WHERE server_id = ?
        `).run(serverId);
            }
            // Link the account to the server (with optional SSH key path)
            const result = db_1.db.prepare(`
        INSERT OR REPLACE INTO server_git_accounts (server_id, git_account_id, ssh_key_path, is_default)
        VALUES (?, ?, ?, ?)
      `).run(serverId, gitAccountId, sshKeyPath ?? null, isDefault ? 1 : 0);
            console.log('[ServerGitAccountService] Linked account to server:', {
                serverId,
                gitAccountId,
                isDefault,
                sshKeyPath,
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid
            });
            // Verify the link was created
            const verification = db_1.db.prepare(`
        SELECT * FROM server_git_accounts WHERE server_id = ? AND git_account_id = ?
      `).get(serverId, gitAccountId);
            console.log('[ServerGitAccountService] Link verification:', verification);
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to link account to server:', error);
            throw error;
        }
    }
    /**
     * Update SSH key path for an account linked to a server
     */
    async updateSSHKeyPath(serverId, gitAccountId, sshKeyPath) {
        try {
            db_1.db.prepare(`
        UPDATE server_git_accounts
        SET ssh_key_path = ?
        WHERE server_id = ? AND git_account_id = ?
      `).run(sshKeyPath, serverId, gitAccountId);
            console.log('[ServerGitAccountService] Updated SSH key path:', {
                serverId,
                gitAccountId,
                sshKeyPath,
            });
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to update SSH key path:', error);
            throw error;
        }
    }
    /**
     * Unlink a Git account from a server
     */
    async unlinkAccountFromServer(serverId, gitAccountId) {
        try {
            db_1.db.prepare(`
        DELETE FROM server_git_accounts
        WHERE server_id = ? AND git_account_id = ?
      `).run(serverId, gitAccountId);
            console.log('[ServerGitAccountService] Unlinked account from server:', {
                serverId,
                gitAccountId,
            });
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to unlink account from server:', error);
            throw error;
        }
    }
    /**
     * Get all Git accounts linked to a specific server
     */
    async getAccountsForServer(serverId) {
        try {
            const accounts = db_1.db.prepare(`
        SELECT
          sga.server_id as serverId,
          sga.git_account_id as gitAccountId,
          sga.ssh_key_path as sshKeyPath,
          sga.is_default as isDefault,
          sga.created_at as createdAt,
          ga.alias,
          ga.username,
          ga.email,
          ga.avatar_url as avatarUrl,
          ga.scopes,
          gs.type as provider
        FROM server_git_accounts sga
        INNER JOIN git_accounts ga ON sga.git_account_id = ga.id
        INNER JOIN git_sources gs ON ga.source_id = gs.id
        WHERE sga.server_id = ?
        ORDER BY sga.is_default DESC, sga.created_at DESC
      `).all(serverId);
            console.log('[ServerGitAccountService] getAccountsForServer result:', {
                serverId,
                accountsCount: accounts.length,
                accounts: accounts.map(a => ({ gitAccountId: a.gitAccountId, username: a.username }))
            });
            return accounts;
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to get accounts for server:', error);
            return [];
        }
    }
    /**
     * Get the default Git account for a server
     */
    async getDefaultAccountForServer(serverId) {
        try {
            const account = db_1.db.prepare(`
        SELECT
          sga.server_id as serverId,
          sga.git_account_id as gitAccountId,
          sga.ssh_key_path as sshKeyPath,
          sga.is_default as isDefault,
          sga.created_at as createdAt,
          ga.alias,
          ga.username,
          ga.email,
          ga.avatar_url as avatarUrl,
          ga.scopes,
          gs.type as provider
        FROM server_git_accounts sga
        INNER JOIN git_accounts ga ON sga.git_account_id = ga.id
        INNER JOIN git_sources gs ON ga.source_id = gs.id
        WHERE sga.server_id = ? AND sga.is_default = 1
        LIMIT 1
      `).get(serverId);
            return account || null;
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to get default account:', error);
            return null;
        }
    }
    /**
     * Set an account as the default for a server
     */
    async setDefaultAccount(serverId, gitAccountId) {
        try {
            // Unset all defaults for this server
            db_1.db.prepare(`
        UPDATE server_git_accounts
        SET is_default = 0
        WHERE server_id = ?
      `).run(serverId);
            // Set the new default
            db_1.db.prepare(`
        UPDATE server_git_accounts
        SET is_default = 1
        WHERE server_id = ? AND git_account_id = ?
      `).run(serverId, gitAccountId);
            console.log('[ServerGitAccountService] Set default account:', {
                serverId,
                gitAccountId,
            });
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to set default account:', error);
            throw error;
        }
    }
    /**
     * Get all global Git accounts (for adding to servers)
     */
    async getAllGitAccounts() {
        try {
            // First hydrate any accounts from secure storage that aren't in the database
            await this.hydrateAccountsFromSecureStorage('github');
            const accounts = db_1.db.prepare(`
        SELECT
          ga.id,
          ga.alias,
          ga.username,
          ga.email,
          ga.avatar_url as avatarUrl,
          gs.type as provider
        FROM git_accounts ga
        INNER JOIN git_sources gs ON ga.source_id = gs.id
        ORDER BY ga.created_at DESC
      `).all();
            console.log('[ServerGitAccountService] getAllGitAccounts found:', accounts.length, 'accounts');
            // If no accounts found in database but we have them in secure storage, force re-hydration
            if (accounts.length === 0) {
                const storedAccounts = await this.storage.listGitHubAccounts();
                console.log('[ServerGitAccountService] Found', storedAccounts.length, 'accounts in secure storage');
                if (storedAccounts.length > 0) {
                    // Clear any stale entries and re-hydrate
                    for (const account of storedAccounts) {
                        const token = await this.storage.getGitHubToken(account.username);
                        if (token) {
                            await this.upsertGitAccountRecord(account, token, 'github');
                        }
                    }
                    // Re-query after hydration
                    const requeriedAccounts = db_1.db.prepare(`
            SELECT
              ga.id,
              ga.alias,
              ga.username,
              ga.email,
              ga.avatar_url as avatarUrl,
              gs.type as provider
            FROM git_accounts ga
            INNER JOIN git_sources gs ON ga.source_id = gs.id
            ORDER BY ga.created_at DESC
          `).all();
                    return requeriedAccounts;
                }
            }
            return accounts;
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to get all git accounts:', error);
            return [];
        }
    }
    /**
     * Create a new global Git account and optionally link it to a server
     */
    async createGitAccount(accountInfo, token, provider = 'github', serverId) {
        try {
            // Save token to secure storage
            await this.storage.saveGitHubToken(accountInfo.username, token, accountInfo);
            const accountId = await this.upsertGitAccountRecord(accountInfo, token, provider);
            console.log('[ServerGitAccountService] Created git account:', accountId);
            // Link to server if provided
            if (serverId) {
                await this.linkAccountToServer(serverId, accountId, true);
            }
            return accountId;
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to create git account:', error);
            throw error;
        }
    }
    /**
     * Delete a Git account globally (removes from all servers)
     */
    async deleteGitAccount(gitAccountId) {
        try {
            // Get account info before deleting
            const account = db_1.db.prepare(`
        SELECT username FROM git_accounts WHERE id = ?
      `).get(gitAccountId);
            if (account) {
                // Delete token from secure storage
                await this.storage.deleteGitHubToken(account.username);
            }
            // Delete account (cascades to server_git_accounts and app_git_bindings)
            db_1.db.prepare(`
        DELETE FROM git_accounts WHERE id = ?
      `).run(gitAccountId);
            console.log('[ServerGitAccountService] Deleted git account:', gitAccountId);
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to delete git account:', error);
            throw error;
        }
    }
    /**
     * Check if an account is linked to a server
     */
    isAccountLinkedToServer(serverId, gitAccountId) {
        try {
            const link = db_1.db.prepare(`
        SELECT 1 FROM server_git_accounts
        WHERE server_id = ? AND git_account_id = ?
      `).get(serverId, gitAccountId);
            return !!link;
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to check account link:', error);
            return false;
        }
    }
    /**
     * Get git account ID by username and provider
     */
    async getGitAccountIdByUsername(username, provider = 'github') {
        try {
            // First try to hydrate from secure storage
            await this.hydrateAccountsFromSecureStorage(provider);
            const sourceId = this.getProviderSourceId(provider);
            const account = db_1.db.prepare(`
        SELECT id FROM git_accounts
        WHERE username = ? AND source_id = ?
        LIMIT 1
      `).get(username, sourceId);
            return account?.id || null;
        }
        catch (error) {
            console.error('[ServerGitAccountService] Failed to get git account ID by username:', error);
            return null;
        }
    }
}
exports.ServerGitAccountService = ServerGitAccountService;
exports.serverGitAccountService = new ServerGitAccountService();
//# sourceMappingURL=ServerGitAccountService.js.map