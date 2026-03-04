"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitAccountService = exports.GitAccountService = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const CredentialVault_1 = require("./CredentialVault");
const SSHService_1 = require("./SSHService");
const REQUIRED_GITHUB_SCOPES = ['repo', 'workflow', 'read:org', 'admin:public_key'];
// GitHub scope hierarchy - parent scopes that include child scopes
const GITHUB_SCOPE_HIERARCHY = {
    'admin:org': ['write:org', 'read:org'],
    'write:org': ['read:org'],
    'admin:public_key': ['write:public_key', 'read:public_key'],
    'write:public_key': ['read:public_key'],
};
class GitAccountService {
    vault = new CredentialVault_1.CredentialVault();
    /**
     * Check if a required scope is satisfied by the granted scopes
     * Takes into account GitHub's scope hierarchy
     */
    hasScopeOrParent(grantedScopes, requiredScope) {
        // Direct match
        if (grantedScopes.includes(requiredScope)) {
            return true;
        }
        // Check if any granted scope is a parent that includes the required scope
        for (const grantedScope of grantedScopes) {
            const children = GITHUB_SCOPE_HIERARCHY[grantedScope];
            if (children && children.includes(requiredScope)) {
                return true;
            }
        }
        return false;
    }
    async validateToken(provider, token) {
        if (provider !== 'github') {
            throw new Error(`Provider ${provider} is not supported yet`);
        }
        const { data, headers } = await this.githubRequest(token, '/user');
        const scopesHeader = headers.get('x-oauth-scopes') ?? '';
        const scopes = scopesHeader
            .split(',')
            .map(scope => scope.trim())
            .filter(Boolean);
        // Check if each required scope is satisfied
        const missingScopes = REQUIRED_GITHUB_SCOPES.filter(requiredScope => !this.hasScopeOrParent(scopes, requiredScope));
        if (missingScopes.length > 0) {
            throw new Error(`Token is missing required scopes: ${missingScopes.join(', ')}`);
        }
        return { user: data, scopes };
    }
    /**
     * Read SSH public key content from a server
     */
    async readSSHPublicKey(serverId, sshKeyPath) {
        try {
            const result = await SSHService_1.sshService.executeCommand(serverId, `cat ${sshKeyPath}`);
            const content = result.stdout.trim();
            return content || null;
        }
        catch (error) {
            console.warn('[GitAccountService] Failed to read SSH key:', error);
            return null;
        }
    }
    /**
     * Check if an SSH public key is already used by another account on this server
     * Returns the account info if duplicate found, null otherwise
     */
    async checkSSHKeyDuplicate(serverId, sshKeyPath, excludeAccountId) {
        if (!sshKeyPath) {
            return { isDuplicate: false };
        }
        const keyContent = await this.readSSHPublicKey(serverId, sshKeyPath);
        if (!keyContent) {
            return { isDuplicate: false };
        }
        const query = excludeAccountId
            ? `
        SELECT ga.id, ga.alias, ga.username, sga.ssh_public_key_content
        FROM server_git_accounts sga
        JOIN git_accounts ga ON ga.id = sga.git_account_id
        WHERE sga.server_id = ?
          AND sga.ssh_public_key_content = ?
          AND sga.git_account_id != ?
        LIMIT 1
      `
            : `
        SELECT ga.id, ga.alias, ga.username, sga.ssh_public_key_content
        FROM server_git_accounts sga
        JOIN git_accounts ga ON ga.id = sga.git_account_id
        WHERE sga.server_id = ?
          AND sga.ssh_public_key_content = ?
        LIMIT 1
      `;
        const params = excludeAccountId ? [serverId, keyContent, excludeAccountId] : [serverId, keyContent];
        const existing = db_1.db.prepare(query).get(...params);
        if (existing) {
            return {
                isDuplicate: true,
                existingAccount: {
                    accountId: existing.id,
                    alias: existing.alias,
                    username: existing.username,
                },
            };
        }
        return { isDuplicate: false };
    }
    async createAccount(options) {
        const { serverId, provider, alias, token, sshKeyPath } = options;
        const { id: sourceId } = this.getProviderSource(provider);
        const validation = await this.validateToken(provider, token);
        // Validate SSH key exists (both public and private)
        if (sshKeyPath) {
            const privateKeyPath = sshKeyPath.endsWith('.pub') ? sshKeyPath.slice(0, -4) : sshKeyPath;
            const publicKeyPath = sshKeyPath.endsWith('.pub') ? sshKeyPath : `${sshKeyPath}.pub`;
            // Check if private key exists
            const privateKeyCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${privateKeyPath} && echo "exists" || echo "not exists"`);
            if (privateKeyCheck.stdout.trim() !== 'exists') {
                throw new Error(`SSH private key not found at ${privateKeyPath}. Make sure both the private key and public key (.pub) exist on the server.`);
            }
            // Check if public key exists
            const publicKeyCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${publicKeyPath} && echo "exists" || echo "not exists"`);
            if (publicKeyCheck.stdout.trim() !== 'exists') {
                throw new Error(`SSH public key not found at ${publicKeyPath}. Make sure both the private key and public key (.pub) exist on the server.`);
            }
        }
        // Check for duplicate SSH key
        if (sshKeyPath) {
            const duplicateCheck = await this.checkSSHKeyDuplicate(serverId, sshKeyPath);
            if (duplicateCheck.isDuplicate && duplicateCheck.existingAccount) {
                throw new Error(`SSH key is already used by account "${duplicateCheck.existingAccount.alias}" (@${duplicateCheck.existingAccount.username}). GitHub requires unique SSH keys for each account.`);
            }
        }
        const encryptedToken = await this.vault.encrypt(token);
        const baseAlias = this.sanitizeHostAlias(`github-${validation.user.login}`);
        const hostAlias = this.ensureUniqueHostAlias(baseAlias);
        const now = Date.now();
        const insertAccount = db_1.db.prepare(`
      INSERT INTO git_accounts (
        id, source_id, alias, username, email, avatar_url,
        scopes, host_alias, encrypted_token, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const accountId = (0, crypto_1.randomUUID)();
        insertAccount.run(accountId, sourceId, alias.trim(), validation.user.login, validation.user.email ?? null, validation.user.avatar_url ?? null, JSON.stringify(validation.scopes), hostAlias, encryptedToken, now, now);
        // Read SSH key content if provided
        const sshKeyContent = sshKeyPath ? await this.readSSHPublicKey(serverId, sshKeyPath) : null;
        const linkStmt = db_1.db.prepare(`
      INSERT INTO server_git_accounts (server_id, git_account_id, ssh_key_path, ssh_public_key_content, is_default, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
        const isFirstAccount = this.isFirstAccountForServer(serverId);
        linkStmt.run(serverId, accountId, sshKeyPath ?? null, sshKeyContent, isFirstAccount ? 1 : 0, now);
        // Configure SSH + Git on the target server
        await this.configureSSHForAccount(serverId, {
            username: validation.user.login,
            alias: alias.trim(),
            hostAlias,
            sshKeyPath,
            isDefault: isFirstAccount, // First account becomes default
        });
        if (sshKeyPath) {
            await this.uploadSSHKey(serverId, sshKeyPath, token);
        }
        return this.mapAccount(this.getAccountRow(accountId), this.getServerAccountRow(serverId, accountId));
    }
    async listAccounts(serverId, provider) {
        const rows = db_1.db
            .prepare(`
        SELECT ga.*, gs.type as provider_type, sga.ssh_key_path, sga.ssh_public_key_content, sga.is_default
        FROM git_accounts ga
        JOIN git_sources gs ON ga.source_id = gs.id
        JOIN server_git_accounts sga ON ga.id = sga.git_account_id
        WHERE sga.server_id = ? ${provider ? 'AND gs.type = ?' : ''}
        ORDER BY ga.created_at DESC
      `)
            .all(provider ? [serverId, provider] : [serverId]);
        if (rows.length === 0) {
            return [];
        }
        const connections = this.getConnectionsForServer(serverId);
        return rows.map(row => this.mapAccount(row, {
            server_id: serverId,
            git_account_id: row.id,
            ssh_key_path: row.ssh_key_path,
            ssh_public_key_content: row.ssh_public_key_content,
            is_default: row.is_default,
        }, connections[row.id] ?? []));
    }
    async getRepositories(gitAccountId, page = 1, perPage = 30) {
        const row = this.getAccountRow(gitAccountId);
        const token = await this.getToken(row);
        const searchParams = new URLSearchParams({
            per_page: String(Math.max(1, Math.min(perPage, 100))),
            page: String(Math.max(1, page)),
            sort: 'updated',
            direction: 'desc',
        });
        const { data } = await this.githubRequest(token, `/user/repos?${searchParams.toString()}`);
        db_1.db.prepare('UPDATE git_accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), gitAccountId);
        return data.map(repo => ({
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            full_name: repo.full_name,
            description: repo.description,
            url: repo.html_url,
            sshUrl: repo.ssh_url,
            defaultBranch: repo.default_branch,
            default_branch: repo.default_branch,
            isPrivate: repo.private,
            private: repo.private,
        }));
    }
    async bindApp(input) {
        const stmt = db_1.db.prepare(`
      INSERT INTO app_git_bindings (id, server_id, app_name, git_account_id, repository, branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, app_name) DO UPDATE SET
        git_account_id = excluded.git_account_id,
        repository = excluded.repository,
        branch = excluded.branch,
        last_sync_status = NULL,
        last_sync_at = NULL
    `);
        stmt.run((0, crypto_1.randomUUID)(), input.serverId, input.appName, input.gitAccountId, input.repository, input.branch, Date.now());
    }
    async getAccountMappings(serverId) {
        const rows = db_1.db
            .prepare(`
        SELECT
          agb.server_id,
          agb.app_name,
          agb.repository,
          agb.branch,
          ga.id as git_account_id,
          ga.alias,
          ga.username,
          gs.type as provider_type
        FROM app_git_bindings agb
        JOIN git_accounts ga ON ga.id = agb.git_account_id
        JOIN git_sources gs ON gs.id = ga.source_id
        WHERE agb.server_id = ?
        ORDER BY agb.app_name
      `)
            .all(serverId);
        return rows.map(row => ({
            serverId: row.server_id,
            appName: row.app_name,
            repository: row.repository,
            branch: row.branch,
            gitAccountId: row.git_account_id,
            accountAlias: row.alias,
            accountUsername: row.username,
            provider: row.provider_type,
        }));
    }
    async setDefaultAccount(serverId, gitAccountId) {
        // Get all accounts for this server before the update
        const allServerAccounts = db_1.db.prepare(`
      SELECT sga.*, ga.username, ga.alias, ga.host_alias
      FROM server_git_accounts sga
      JOIN git_accounts ga ON ga.id = sga.git_account_id
      WHERE sga.server_id = ?
    `).all(serverId);
        // Update the database
        const stmt = db_1.db.prepare(`
      UPDATE server_git_accounts
      SET is_default = CASE WHEN git_account_id = ? THEN 1 ELSE 0 END
      WHERE server_id = ?
    `);
        stmt.run(gitAccountId, serverId);
        // Regenerate SSH configs for all accounts on this server
        // This ensures the new default gets github.com and old default loses it
        for (const account of allServerAccounts) {
            if (account.ssh_key_path) {
                const isNowDefault = account.git_account_id === gitAccountId;
                await this.configureSSHForAccount(serverId, {
                    username: account.username,
                    alias: account.alias,
                    hostAlias: account.host_alias ?? this.sanitizeHostAlias(account.username),
                    sshKeyPath: account.ssh_key_path,
                    isDefault: isNowDefault,
                });
            }
        }
    }
    async updateAccount(options) {
        const { accountId, serverId, alias, token, sshKeyPath } = options;
        const row = this.getAccountRow(accountId);
        const serverAccountRow = this.getServerAccountRow(serverId, accountId);
        // Validate SSH key exists if it's being changed
        if (sshKeyPath !== undefined && sshKeyPath !== serverAccountRow.ssh_key_path && sshKeyPath) {
            const privateKeyPath = sshKeyPath.endsWith('.pub') ? sshKeyPath.slice(0, -4) : sshKeyPath;
            const publicKeyPath = sshKeyPath.endsWith('.pub') ? sshKeyPath : `${sshKeyPath}.pub`;
            // Check if private key exists
            const privateKeyCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${privateKeyPath} && echo "exists" || echo "not exists"`);
            if (privateKeyCheck.stdout.trim() !== 'exists') {
                throw new Error(`SSH private key not found at ${privateKeyPath}. Make sure both the private key and public key (.pub) exist on the server.`);
            }
            // Check if public key exists
            const publicKeyCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${publicKeyPath} && echo "exists" || echo "not exists"`);
            if (publicKeyCheck.stdout.trim() !== 'exists') {
                throw new Error(`SSH public key not found at ${publicKeyPath}. Make sure both the private key and public key (.pub) exist on the server.`);
            }
        }
        // Check for duplicate SSH key if path is being changed
        if (sshKeyPath !== undefined && sshKeyPath !== serverAccountRow.ssh_key_path && sshKeyPath) {
            const duplicateCheck = await this.checkSSHKeyDuplicate(serverId, sshKeyPath, accountId);
            if (duplicateCheck.isDuplicate && duplicateCheck.existingAccount) {
                throw new Error(`SSH key is already used by account "${duplicateCheck.existingAccount.alias}" (@${duplicateCheck.existingAccount.username}). GitHub requires unique SSH keys for each account.`);
            }
        }
        // If token is being updated, validate it
        if (token) {
            const provider = this.getProviderType(row.source_id);
            const validation = await this.validateToken(provider, token);
            const encryptedToken = await this.vault.encrypt(token);
            // Update account with new token and user info
            db_1.db.prepare(`
        UPDATE git_accounts
        SET encrypted_token = ?,
            username = ?,
            email = ?,
            avatar_url = ?,
            scopes = ?,
            alias = COALESCE(?, alias),
            last_used_at = ?
        WHERE id = ?
      `).run(encryptedToken, validation.user.login, validation.user.email ?? null, validation.user.avatar_url ?? null, JSON.stringify(validation.scopes), alias?.trim() ?? null, Date.now(), accountId);
            // If SSH key is provided with new token, upload it
            if (sshKeyPath !== undefined) {
                await this.uploadSSHKey(serverId, sshKeyPath, token);
            }
        }
        else if (alias) {
            // Only update alias if no token update
            db_1.db.prepare('UPDATE git_accounts SET alias = ?, last_used_at = ? WHERE id = ?')
                .run(alias.trim(), Date.now(), accountId);
        }
        // Update SSH key path if changed
        if (sshKeyPath !== undefined && sshKeyPath !== serverAccountRow.ssh_key_path) {
            // Read new SSH key content
            const sshKeyContent = sshKeyPath ? await this.readSSHPublicKey(serverId, sshKeyPath) : null;
            db_1.db.prepare('UPDATE server_git_accounts SET ssh_key_path = ?, ssh_public_key_content = ? WHERE server_id = ? AND git_account_id = ?')
                .run(sshKeyPath || null, sshKeyContent, serverId, accountId);
            // Reconfigure SSH on server if key changed
            const updatedRow = this.getAccountRow(accountId);
            const updatedServerRow = this.getServerAccountRow(serverId, accountId);
            await this.configureSSHForAccount(serverId, {
                username: updatedRow.username,
                alias: alias?.trim() ?? updatedRow.alias,
                hostAlias: updatedRow.host_alias ?? this.sanitizeHostAlias(updatedRow.username),
                sshKeyPath: sshKeyPath || undefined,
                isDefault: updatedServerRow.is_default === 1,
            });
            // Upload new SSH key if token is available
            if (sshKeyPath) {
                try {
                    const currentToken = await this.getToken(updatedRow);
                    await this.uploadSSHKey(serverId, sshKeyPath, currentToken);
                }
                catch (error) {
                    console.warn('[GitAccountService] Could not upload new SSH key:', error);
                }
            }
        }
        return this.mapAccount(this.getAccountRow(accountId), this.getServerAccountRow(serverId, accountId));
    }
    async deleteAccount(accountId) {
        const row = this.getAccountRow(accountId);
        const servers = this.getServersForAccount(accountId);
        const deleteStmt = db_1.db.prepare('DELETE FROM git_accounts WHERE id = ?');
        deleteStmt.run(accountId);
        await Promise.all(servers.map(server => this.cleanupServerConfiguration(server.server_id, row.host_alias ?? this.sanitizeHostAlias(row.username))));
    }
    async revokeAccess(accountId) {
        const row = this.getAccountRow(accountId);
        try {
            const token = await this.getToken(row);
            await this.deleteUploadedKeys(token);
        }
        catch (error) {
            console.warn('[GitAccountService] Failed to revoke remote keys:', error);
        }
        db_1.db.prepare('UPDATE git_accounts SET encrypted_token = x\'\', last_used_at = ? WHERE id = ?').run(Date.now(), accountId);
    }
    async checkAccountStatus(accountId) {
        try {
            const row = this.getAccountRow(accountId);
            const token = await this.getToken(row);
            const { data } = await this.githubRequest(token, '/user');
            db_1.db.prepare('UPDATE git_accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), accountId);
            return {
                isValid: true,
                accountInfo: {
                    username: data.login,
                    email: data.email ?? null,
                    avatarUrl: data.avatar_url ?? null,
                },
            };
        }
        catch (error) {
            return {
                isValid: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Test SSH key connection to GitHub
     */
    async testSSHKey(serverId, accountId) {
        try {
            const row = this.getAccountRow(accountId);
            const serverAccountRow = this.getServerAccountRow(serverId, accountId);
            if (!serverAccountRow.ssh_key_path) {
                return {
                    isValid: false,
                    message: 'No SSH key configured for this account',
                };
            }
            const hostAlias = row.host_alias ?? this.sanitizeHostAlias(row.username);
            const expectedUsername = row.username;
            // Regenerate SSH config to ensure it's up to date with the current SSH key path
            // This fixes any mismatch between the database and the SSH config file
            await this.configureSSHForAccount(serverId, {
                username: row.username,
                alias: row.alias,
                hostAlias: hostAlias,
                sshKeyPath: serverAccountRow.ssh_key_path || undefined,
                isDefault: serverAccountRow.is_default === 1,
            });
            // Test SSH connection to GitHub using the host alias
            const result = await SSHService_1.sshService.executeCommand(serverId, `ssh -T -o StrictHostKeyChecking=no -o ConnectTimeout=10 git@${hostAlias} 2>&1 || true`);
            const output = result.stdout.trim();
            // GitHub returns: "Hi username! You've successfully authenticated..."
            const successMatch = output.match(/Hi ([^!]+)!/);
            if (successMatch) {
                const authenticatedUsername = successMatch[1];
                // Validate that the authenticated username matches the account username
                if (authenticatedUsername !== expectedUsername) {
                    return {
                        isValid: false,
                        message: `SSH key belongs to wrong GitHub account. Expected @${expectedUsername}, but authenticated as @${authenticatedUsername}. Please select the correct SSH key for this account.`,
                        username: authenticatedUsername,
                    };
                }
                return {
                    isValid: true,
                    message: 'SSH key is working correctly',
                    username: authenticatedUsername,
                };
            }
            // Check for common error patterns
            if (output.includes('Permission denied')) {
                return {
                    isValid: false,
                    message: `SSH key permission denied. The key may not be uploaded to GitHub or is incorrect. Make sure the private key exists at ${serverAccountRow.ssh_key_path || 'the configured path'} on your server.`,
                };
            }
            if (output.includes('no such identity') || output.includes('No such file')) {
                return {
                    isValid: false,
                    message: `SSH private key not found at ${serverAccountRow.ssh_key_path || 'the configured path'}. Please verify the key file exists on your server or edit this account to select a valid SSH key.`,
                };
            }
            if (output.includes('Connection timed out') || output.includes('Connection refused')) {
                return {
                    isValid: false,
                    message: 'Cannot connect to GitHub. Check your server network connection.',
                };
            }
            return {
                isValid: false,
                message: `SSH test failed: ${output.substring(0, 200)}`,
            };
        }
        catch (error) {
            return {
                isValid: false,
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Detect repositories with mismatched host aliases
     * Scans common directories for Git repos and checks if their remote URLs use old/incorrect host aliases
     */
    async detectMismatchedRepositories(serverId, accountId) {
        try {
            const row = this.getAccountRow(accountId);
            const currentHostAlias = row.host_alias ?? this.sanitizeHostAlias(row.username);
            // Find all git repositories in common locations
            const findReposCmd = `
        find ~ -maxdepth 3 -type d -name ".git" 2>/dev/null | while read gitdir; do
          repo_path="\${gitdir%/.git}"
          echo "$repo_path"
        done
      `;
            const findResult = await SSHService_1.sshService.executeCommand(serverId, findReposCmd);
            const repoPaths = findResult.stdout
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);
            const mismatchedRepos = [];
            // Check each repository's remote URL
            for (const repoPath of repoPaths) {
                try {
                    const remoteUrlCmd = `cd "${repoPath}" && git remote get-url origin 2>/dev/null || echo ""`;
                    const remoteResult = await SSHService_1.sshService.executeCommand(serverId, remoteUrlCmd);
                    const currentUrl = remoteResult.stdout.trim();
                    if (!currentUrl)
                        continue;
                    // Check if URL uses a github host alias (not the current one)
                    const githubAliasMatch = currentUrl.match(/git@(github-[^:]+):(.*)/);
                    if (githubAliasMatch) {
                        const [, urlHostAlias, gitRepoPath] = githubAliasMatch;
                        // If it's a different host alias, it's a mismatch
                        if (urlHostAlias !== currentHostAlias) {
                            const expectedUrl = `git@${currentHostAlias}:${gitRepoPath}`;
                            mismatchedRepos.push({
                                path: repoPath, // Use the filesystem path, not the git repo path
                                currentUrl,
                                expectedUrl,
                            });
                        }
                    }
                }
                catch (error) {
                    // Skip repositories that can't be checked
                    console.warn(`Failed to check repository at ${repoPath}:`, error);
                }
            }
            return {
                mismatchedRepos,
                totalScanned: repoPaths.length,
            };
        }
        catch (error) {
            console.error('Error detecting mismatched repositories:', error);
            return {
                mismatchedRepos: [],
                totalScanned: 0,
            };
        }
    }
    /**
     * Fix repository remote URLs to use the correct host alias
     */
    async fixRepositoryRemotes(serverId, accountId, repoPaths) {
        const row = this.getAccountRow(accountId);
        const currentHostAlias = row.host_alias ?? this.sanitizeHostAlias(row.username);
        const failed = [];
        let fixed = 0;
        for (const repoPath of repoPaths) {
            try {
                // Get current remote URL
                const getCurrentUrlCmd = `cd "${repoPath}" && git remote get-url origin 2>/dev/null || echo ""`;
                const currentUrlResult = await SSHService_1.sshService.executeCommand(serverId, getCurrentUrlCmd);
                const currentUrl = currentUrlResult.stdout.trim();
                if (!currentUrl) {
                    failed.push({ path: repoPath, error: 'No remote URL found' });
                    continue;
                }
                // Extract repo path from current URL
                const githubAliasMatch = currentUrl.match(/git@github-[^:]+:(.*)/);
                if (!githubAliasMatch) {
                    failed.push({ path: repoPath, error: 'URL does not match GitHub alias pattern' });
                    continue;
                }
                const repoPathPart = githubAliasMatch[1];
                const newUrl = `git@${currentHostAlias}:${repoPathPart}`;
                // Update the remote URL
                const updateCmd = `cd "${repoPath}" && git remote set-url origin "${newUrl}"`;
                await SSHService_1.sshService.executeCommand(serverId, updateCmd);
                fixed++;
            }
            catch (error) {
                failed.push({
                    path: repoPath,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return { fixed, failed };
    }
    async cloneWithAccount(serverId, gitAccountId, repository, targetPath, branch) {
        const row = this.getAccountRow(gitAccountId);
        const serverAccountRow = this.getServerAccountRow(serverId, gitAccountId);
        const hostAlias = row.host_alias ?? this.sanitizeHostAlias(row.username);
        // Check if SSH key is configured for this server
        if (!serverAccountRow.ssh_key_path) {
            throw new Error(`No SSH key configured for GitHub account "@${row.username}" on this server. ` +
                `Please go to Server Settings > Git Accounts and configure an SSH key for this account, ` +
                `or use a different account that has an SSH key set up.`);
        }
        // Ensure SSH config is set up on the server before cloning
        await this.configureSSHForAccount(serverId, {
            username: row.username,
            alias: row.alias,
            hostAlias: hostAlias,
            sshKeyPath: serverAccountRow.ssh_key_path,
            isDefault: serverAccountRow.is_default === 1,
        });
        const remoteUrl = this.toHostAliasUrl(row, repository);
        const escapedPath = targetPath.replace(/"/g, '\\"');
        const escapedBranch = branch.replace(/"/g, '');
        const result = await SSHService_1.sshService.executeCommand(serverId, `
      if [ -d "${escapedPath}/.git" ]; then
        cd "${escapedPath}"
        git fetch origin "${escapedBranch}" 2>&1
        git checkout "${escapedBranch}" 2>&1
        git pull origin "${escapedBranch}" 2>&1
      else
        # Ensure parent directory exists
        mkdir -p "$(dirname "${escapedPath}")"
        # Remove target directory if it exists to prevent nested clone
        rm -rf "${escapedPath}"
        # Clone directly into target path
        git clone -b "${escapedBranch}" ${remoteUrl} "${escapedPath}" 2>&1
      fi
    `);
        // Check if the command failed
        if (result.exitCode !== 0) {
            const errorOutput = result.stderr || result.stdout || 'Unknown error';
            throw new Error(`Git clone/pull failed: ${errorOutput}`);
        }
    }
    async switchRepoAccount(serverId, repoPath, gitAccountId, repository) {
        const row = this.getAccountRow(gitAccountId);
        const remoteUrl = this.toHostAliasUrl(row, repository);
        const escapedPath = repoPath.replace(/"/g, '\\"');
        await SSHService_1.sshService.executeCommand(serverId, `
      if [ -d "${escapedPath}/.git" ]; then
        cd "${escapedPath}"
        git remote set-url origin ${remoteUrl}
      fi
    `);
    }
    // Helpers
    getProviderSource(provider) {
        const row = db_1.db
            .prepare('SELECT id FROM git_sources WHERE type = ? LIMIT 1')
            .get(provider);
        if (!row) {
            throw new Error(`Git provider ${provider} is not initialized`);
        }
        return row;
    }
    isFirstAccountForServer(serverId) {
        const row = db_1.db
            .prepare('SELECT COUNT(*) as count FROM server_git_accounts WHERE server_id = ?')
            .get(serverId);
        return (row?.count ?? 0) === 0;
    }
    getServersForAccount(accountId) {
        return db_1.db
            .prepare('SELECT * FROM server_git_accounts WHERE git_account_id = ?')
            .all(accountId);
    }
    getAccountRow(accountId) {
        const row = db_1.db
            .prepare('SELECT * FROM git_accounts WHERE id = ? LIMIT 1')
            .get(accountId);
        if (!row) {
            throw new Error('Git account not found');
        }
        return row;
    }
    getServerAccountRow(serverId, accountId) {
        const row = db_1.db
            .prepare('SELECT * FROM server_git_accounts WHERE server_id = ? AND git_account_id = ? LIMIT 1')
            .get(serverId, accountId);
        if (!row) {
            throw new Error('Git account is not linked to this server');
        }
        return row;
    }
    getConnectionsForServer(serverId) {
        const rows = db_1.db
            .prepare(`
        SELECT git_account_id, app_name, repository, branch
        FROM app_git_bindings
        WHERE server_id = ?
      `)
            .all(serverId);
        return rows.reduce((acc, row) => {
            acc[row.git_account_id] = acc[row.git_account_id] ?? [];
            acc[row.git_account_id].push({
                app_name: row.app_name,
                repository: row.repository,
                branch: row.branch,
            });
            return acc;
        }, {});
    }
    mapAccount(row, link, connectedApps) {
        const scopes = row.scopes ? JSON.parse(row.scopes) : [];
        const provider = row.provider_type ?? this.getProviderType(row.source_id);
        const status = row.encrypted_token.length === 0 ? 'revoked' : 'active';
        return {
            id: row.id,
            provider,
            alias: row.alias,
            username: row.username,
            email: row.email,
            avatarUrl: row.avatar_url ?? undefined,
            scopes,
            hostAlias: row.host_alias ?? this.sanitizeHostAlias(row.username),
            sshKeyPath: link.ssh_key_path ?? undefined,
            isDefault: link.is_default === 1,
            status,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at ?? undefined,
            connectedApps: (connectedApps ?? []).map(app => ({
                appName: app.app_name,
                repository: app.repository,
                branch: app.branch,
            })),
        };
    }
    getProviderType(sourceId) {
        const row = db_1.db
            .prepare('SELECT type FROM git_sources WHERE id = ?')
            .get(sourceId);
        if (!row) {
            throw new Error('Unknown git provider');
        }
        return row.type;
    }
    sanitizeHostAlias(value) {
        return value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }
    ensureUniqueHostAlias(base) {
        let candidate = base;
        const exists = (alias) => {
            const row = db_1.db.prepare('SELECT 1 FROM git_accounts WHERE host_alias = ? LIMIT 1').get(alias);
            return Boolean(row);
        };
        while (exists(candidate)) {
            candidate = `${base}-${(0, crypto_1.randomUUID)().slice(0, 4)}`;
        }
        return candidate;
    }
    async getToken(row) {
        if (!row.encrypted_token || row.encrypted_token.length === 0) {
            throw new Error('Token has been revoked for this account');
        }
        return this.vault.decrypt(row.encrypted_token);
    }
    async configureSSHForAccount(serverId, options) {
        const privateKeyPath = options.sshKeyPath?.endsWith('.pub')
            ? options.sshKeyPath.slice(0, -4)
            : options.sshKeyPath;
        const identityFile = privateKeyPath ?? `~/.ssh/id_ed25519_${options.username}`;
        // For default account, create a github.com entry so terminal users can use git@github.com
        // This MUST come first in the config file to take precedence
        const defaultBlock = options.isDefault ? `
# Server Compass DEFAULT GitHub account: ${options.alias} (${options.username})
# This allows: git clone git@github.com:owner/repo.git
Host github.com
  HostName github.com
  User git
  IdentityFile ${identityFile}
  IdentitiesOnly yes
  AddKeysToAgent yes

` : '';
        // Always create the host alias entry (for Server Compass internal use)
        const hostAliasBlock = `
# Server Compass GitHub account: ${options.alias} (${options.username})
Host ${options.hostAlias}
  HostName github.com
  User git
  IdentityFile ${identityFile}
  IdentitiesOnly yes
  AddKeysToAgent yes

`;
        await SSHService_1.sshService.executeCommand(serverId, `
      mkdir -p ~/.ssh
      chmod 700 ~/.ssh
      touch ~/.ssh/config
      chmod 600 ~/.ssh/config
      touch ~/.ssh/known_hosts
      chmod 644 ~/.ssh/known_hosts

      # Add GitHub's host keys to known_hosts if not already present
      if ! grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null; then
        ssh-keyscan -t ed25519,rsa,ecdsa github.com >> ~/.ssh/known_hosts 2>/dev/null || true
      fi

      # Remove old SSH config entry for this host alias if it exists
      # Use a more robust sed pattern that handles missing blank lines
      if [ -f ~/.ssh/config ]; then
        # Remove the comment line and the Host block (up to and including AddKeysToAgent line)
        sed -i "/# Server Compass GitHub account:.*${options.username}/,/AddKeysToAgent yes/d" ~/.ssh/config 2>/dev/null || true
      fi

      # Always remove any existing github.com entry managed by Server Compass
      # This ensures we don't have duplicate entries
      if [ -f ~/.ssh/config ]; then
        sed -i "/# Server Compass DEFAULT GitHub account:/,/AddKeysToAgent yes/d" ~/.ssh/config 2>/dev/null || true
      fi

      # Add the github.com entry FIRST (only for default account)
      # This ensures it takes precedence when git commands use git@github.com
      ${options.isDefault ? `cat <<'EOF' >> ~/.ssh/config
${defaultBlock}
EOF` : ''}

      # Add the host alias entry (always)
      cat <<'EOF' >> ~/.ssh/config
${hostAliasBlock}
EOF
    `);
    }
    async uploadSSHKey(serverId, sshKeyPath, token) {
        try {
            const result = await SSHService_1.sshService.executeCommand(serverId, `cat ${sshKeyPath}`);
            const publicKey = result.stdout.trim();
            if (!publicKey) {
                throw new Error('SSH key is empty');
            }
            await this.githubRequest(token, '/user/keys', {
                method: 'POST',
                body: JSON.stringify({
                    title: `ServerCompass-${serverId}-${Date.now()}`,
                    key: publicKey,
                }),
            });
        }
        catch (error) {
            console.warn('[GitAccountService] Failed to upload SSH key:', error);
        }
    }
    async cleanupServerConfiguration(serverId, hostAlias) {
        await SSHService_1.sshService.executeCommand(serverId, `
      if [ -f ~/.ssh/config ]; then
        sed -i '/Host ${hostAlias}/,/^$/d' ~/.ssh/config || true
      fi
      rm -f ~/.gitconfig-${hostAlias} || true
    `);
    }
    async deleteUploadedKeys(token) {
        const { data } = await this.githubRequest(token, '/user/keys');
        await Promise.all(data
            .filter(key => key.title?.startsWith('ServerCompass'))
            .map(key => this.githubRequest(token, `/user/keys/${key.id}`, { method: 'DELETE' }).catch(() => undefined)));
    }
    async githubRequest(token, path, init = {}) {
        const response = await fetch(`https://api.github.com${path}`, {
            ...init,
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'User-Agent': 'ServerCompass',
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            },
        });
        const text = await response.text();
        if (!response.ok) {
            const message = text || response.statusText;
            throw new Error(`GitHub API error (${response.status}): ${message}`);
        }
        return {
            data: text ? JSON.parse(text) : undefined,
            headers: response.headers,
        };
    }
    toHostAliasUrl(row, repository) {
        const sanitizedAlias = row.host_alias ?? this.sanitizeHostAlias(row.username);
        const cleaned = repository
            .replace(/^https:\/\/github\.com\//i, '')
            .replace(/^git@github\.com:/i, '')
            .replace(/\.git$/i, '')
            .trim();
        if (!cleaned) {
            throw new Error('Repository path is required (owner/name)');
        }
        return `git@${sanitizedAlias}:${cleaned}.git`;
    }
    // Utility Methods (migrated from GitHubService)
    async listSSHKeys(serverId) {
        try {
            const result = await SSHService_1.sshService.executeCommand(serverId, 'find ~/.ssh -name "*.pub" -type f 2>/dev/null || true');
            const keys = result.stdout
                .split('\n')
                .filter(line => line.trim())
                .map(path => ({
                path: path.trim(),
                filename: path.split('/').pop() || '',
            }));
            return keys;
        }
        catch (error) {
            console.error('[GitAccountService] Error listing SSH keys:', error);
            return [];
        }
    }
    /**
     * Generate a deployment-specific SSH key pair for GitHub Actions
     * Returns both private and public key content
     */
    async generateDeploymentSSHKey(serverId, appName) {
        try {
            // Sanitize app name for use in filename
            const sanitizedAppName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const keyName = `id_ed25519_deploy_${sanitizedAppName}`;
            const keyPath = `~/.ssh/${keyName}`;
            const publicKeyPath = `${keyPath}.pub`;
            console.log(`[GitAccountService] Generating deployment SSH key for ${appName} at ${keyPath}`);
            // Generate Ed25519 SSH key pair
            await SSHService_1.sshService.executeCommand(serverId, `
        mkdir -p ~/.ssh
        chmod 700 ~/.ssh

        # Generate key if it doesn't exist
        if [ ! -f ${keyPath} ]; then
          ssh-keygen -t ed25519 -f ${keyPath} -N "" -C "servercompass-deploy-${sanitizedAppName}"
          chmod 600 ${keyPath}
          chmod 644 ${publicKeyPath}
        fi
      `);
            // Read private key content
            const privateKeyResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${keyPath}`);
            const privateKey = privateKeyResult.stdout.trim();
            if (!privateKey) {
                throw new Error('Failed to read generated private key');
            }
            // Read public key content
            const publicKeyResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${publicKeyPath}`);
            const publicKey = publicKeyResult.stdout.trim();
            if (!publicKey) {
                throw new Error('Failed to read generated public key');
            }
            // Add public key to authorized_keys to allow GitHub Actions to SSH in
            console.log(`[GitAccountService] Adding public key to authorized_keys...`);
            await SSHService_1.sshService.executeCommand(serverId, `
        # Ensure authorized_keys exists
        touch ~/.ssh/authorized_keys
        chmod 600 ~/.ssh/authorized_keys

        # Add key if not already present
        if ! grep -Fq "${publicKey}" ~/.ssh/authorized_keys; then
          echo "${publicKey}" >> ~/.ssh/authorized_keys
          echo "✅ Public key added to authorized_keys"
        else
          echo "ℹ️  Public key already in authorized_keys"
        fi
      `);
            console.log(`[GitAccountService] Successfully generated deployment SSH key`);
            console.log(`[GitAccountService] Debug - Key details:`);
            console.log(`  - Private key length: ${privateKey?.length || 0} chars`);
            console.log(`  - Private key starts with: ${privateKey?.substring(0, 50) || 'NULL'}...`);
            console.log(`  - Public key length: ${publicKey?.length || 0} chars`);
            console.log(`  - Public key: ${publicKey?.substring(0, 80) || 'NULL'}...`);
            console.log(`  - Key path: ${keyPath}`);
            return {
                privateKey,
                publicKey,
                keyPath,
            };
        }
        catch (error) {
            console.error('[GitAccountService] Failed to generate deployment SSH key:', error);
            throw new Error(`Failed to generate deployment SSH key: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async detectFramework(serverId, repoUrl, branch = 'main') {
        const appName = repoUrl.split('/').pop()?.replace('.git', '') || 'app';
        const tempPath = `/tmp/framework-detect-${Date.now()}-${appName}`;
        try {
            // Clone repository to temp location
            await SSHService_1.sshService.executeCommand(serverId, `git clone --depth 1 --branch ${branch} ${repoUrl} ${tempPath}`);
            // Check for Next.js
            const nextConfigCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${tempPath}/next.config.js -o -f ${tempPath}/next.config.ts -o -f ${tempPath}/next.config.mjs && echo "found" || echo "not found"`);
            const isNextJs = nextConfigCheck.stdout.trim() === 'found';
            // Check package.json for additional detection
            const packageJsonCheck = await SSHService_1.sshService.executeCommand(serverId, `cat ${tempPath}/package.json 2>/dev/null || echo "{}"`);
            let packageJson = {};
            try {
                packageJson = JSON.parse(packageJsonCheck.stdout);
            }
            catch (e) {
                console.warn('Could not parse package.json');
            }
            // Detect frameworks from dependencies
            const hasNextDependency = packageJson.dependencies?.next || packageJson.devDependencies?.next;
            const hasReact = packageJson.dependencies?.react || packageJson.devDependencies?.react;
            const hasVue = packageJson.dependencies?.vue || packageJson.devDependencies?.vue;
            const hasExpress = packageJson.dependencies?.express;
            const hasFastify = packageJson.dependencies?.fastify;
            const hasNestJS = packageJson.dependencies?.['@nestjs/core'];
            // Extract port from package.json
            const port = this.extractPortFromPackageJson(packageJson);
            // Detect package manager
            const packageManager = await this.detectPackageManager(serverId, tempPath);
            // Cleanup temp directory
            await SSHService_1.sshService.executeCommand(serverId, `rm -rf ${tempPath}`).catch(() => {
                console.warn('Could not cleanup temp directory:', tempPath);
            });
            // Determine framework
            let framework = 'unknown';
            if (isNextJs || hasNextDependency) {
                framework = 'nextjs';
            }
            else if (hasNestJS) {
                framework = 'nestjs';
            }
            else if (hasFastify) {
                framework = 'fastify';
            }
            else if (hasExpress) {
                framework = 'express';
            }
            else if (hasReact) {
                framework = 'react';
            }
            else if (hasVue) {
                framework = 'vue';
            }
            else if (packageJson.dependencies || packageJson.devDependencies) {
                framework = 'node';
            }
            return {
                framework,
                detected: framework !== 'unknown',
                port,
                packageManager,
            };
        }
        catch (error) {
            // Cleanup on error
            await SSHService_1.sshService.executeCommand(serverId, `rm -rf ${tempPath}`).catch(() => { });
            console.error('Error detecting framework:', error);
            throw error;
        }
    }
    async parsePackageJson(serverId, repoPath) {
        try {
            const result = await SSHService_1.sshService.executeCommand(serverId, `cat ${repoPath}/package.json 2>/dev/null || echo "{}"`);
            let packageJson = {};
            try {
                packageJson = JSON.parse(result.stdout);
            }
            catch (e) {
                console.warn('Could not parse package.json');
                return {};
            }
            const port = this.extractPortFromPackageJson(packageJson);
            const packageManager = await this.detectPackageManager(serverId, repoPath);
            return { port, packageManager };
        }
        catch (error) {
            console.error('Error parsing package.json:', error);
            return {};
        }
    }
    extractPortFromPackageJson(packageJson) {
        // Check env section
        if (packageJson.env?.PORT) {
            return parseInt(packageJson.env.PORT, 10);
        }
        // Check scripts for port references
        const scripts = packageJson.scripts || {};
        for (const script of Object.values(scripts)) {
            if (typeof script === 'string') {
                // Look for -p 3000, --port 3000, or PORT=3000
                const portMatch = script.match(/(?:^|\s)(?:-p|--port)\s+(\d+)|PORT=(\d+)/);
                if (portMatch) {
                    const port = parseInt(portMatch[1] || portMatch[2], 10);
                    if (port >= 1000 && port <= 65535) {
                        return port;
                    }
                }
            }
        }
        // Default ports by framework
        if (packageJson.dependencies?.next || packageJson.devDependencies?.next) {
            return 3000;
        }
        return undefined;
    }
    async detectPackageManager(serverId, projectPath) {
        // Check for lock files
        const pnpmCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${projectPath}/pnpm-lock.yaml && echo "found" || echo "not found"`);
        if (pnpmCheck.stdout.trim() === 'found')
            return 'pnpm';
        const yarnCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${projectPath}/yarn.lock && echo "found" || echo "not found"`);
        if (yarnCheck.stdout.trim() === 'found')
            return 'yarn';
        // Default to npm
        return 'npm';
    }
}
exports.GitAccountService = GitAccountService;
exports.gitAccountService = new GitAccountService();
//# sourceMappingURL=GitAccountService.js.map