"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistryService = void 0;
exports.createRegistryService = createRegistryService;
const crypto_1 = require("crypto");
const db_1 = require("../db");
// Registry URL mapping
const REGISTRY_URLS = {
    dockerhub: '', // Default registry, no URL needed
    ghcr: 'ghcr.io',
    gitlab: 'registry.gitlab.com',
    ecr: '', // Dynamic: {account}.dkr.ecr.{region}.amazonaws.com
    gcr: 'gcr.io',
    custom: '', // User-provided
};
class RegistryService {
    credentialVault;
    sshService;
    constructor(credentialVault, sshService) {
        this.credentialVault = credentialVault;
        this.sshService = sshService;
    }
    /**
     * Get the registry URL for a given type
     */
    getRegistryUrl(type, customUrl) {
        if (type === 'custom' || type === 'ecr') {
            return customUrl || '';
        }
        return REGISTRY_URLS[type];
    }
    /**
     * Save registry credentials for a server
     */
    async saveCredentials(serverId, input) {
        const id = `registry-${(0, crypto_1.randomUUID)()}`;
        const url = this.getRegistryUrl(input.type, input.url);
        // Encrypt the password
        const encryptedPassword = await this.credentialVault.encrypt(input.password);
        // Store in database
        const stmt = db_1.db.prepare(`
      INSERT INTO docker_registry_credentials (
        id, server_id, type, name, url, username, encrypted_password,
        is_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
        const now = Date.now();
        stmt.run(id, serverId, input.type, input.name, url, input.username, encryptedPassword, now, now);
        return id;
    }
    /**
     * Get credentials by ID (without decrypted password)
     */
    getCredentials(serverId, registryId) {
        const result = db_1.queries.getDockerRegistryCredential(registryId);
        if (result && result.server_id === serverId) {
            return result;
        }
        return null;
    }
    /**
     * Get credentials with decrypted password
     */
    async getCredentialsWithPassword(serverId, registryId) {
        const creds = this.getCredentials(serverId, registryId);
        if (!creds)
            return null;
        try {
            const password = await this.credentialVault.decrypt(creds.encrypted_password);
            return { ...creds, password };
        }
        catch (error) {
            console.error('Failed to decrypt registry password:', error);
            return creds;
        }
    }
    /**
     * List all credentials for a server
     */
    listCredentials(serverId) {
        return db_1.queries.getDockerRegistryCredentials(serverId);
    }
    /**
     * Update registry credentials
     */
    async updateCredentials(serverId, registryId, updates) {
        const existing = this.getCredentials(serverId, registryId);
        if (!existing) {
            throw new Error('Registry credentials not found');
        }
        const updateFields = ['updated_at = ?'];
        const values = [Date.now()];
        if (updates.name !== undefined) {
            updateFields.push('name = ?');
            values.push(updates.name);
        }
        if (updates.type !== undefined) {
            updateFields.push('type = ?');
            values.push(updates.type);
            // Update URL if type changed
            updateFields.push('url = ?');
            values.push(this.getRegistryUrl(updates.type, updates.url));
        }
        if (updates.url !== undefined) {
            updateFields.push('url = ?');
            values.push(updates.url);
        }
        if (updates.username !== undefined) {
            updateFields.push('username = ?');
            values.push(updates.username);
        }
        if (updates.password !== undefined) {
            const encryptedPassword = await this.credentialVault.encrypt(updates.password);
            updateFields.push('encrypted_password = ?');
            values.push(encryptedPassword);
        }
        values.push(registryId);
        const stmt = db_1.db.prepare(`
      UPDATE docker_registry_credentials
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `);
        stmt.run(...values);
    }
    /**
     * Delete registry credentials
     */
    deleteCredentials(serverId, registryId) {
        const existing = this.getCredentials(serverId, registryId);
        if (!existing) {
            throw new Error('Registry credentials not found');
        }
        db_1.queries.deleteDockerRegistryCredential(registryId);
    }
    /**
     * Test registry connection via SSH
     */
    async testConnection(serverId, creds) {
        const url = this.getRegistryUrl(creds.type, creds.url);
        try {
            // Build the docker login command
            const loginCmd = url
                ? `echo "${this.escapeForShell(creds.password)}" | docker login ${url} -u "${this.escapeForShell(creds.username)}" --password-stdin 2>&1`
                : `echo "${this.escapeForShell(creds.password)}" | docker login -u "${this.escapeForShell(creds.username)}" --password-stdin 2>&1`;
            const result = await this.sshService.executeCommand(serverId, loginCmd);
            // Logout after testing
            if (url) {
                await this.sshService.executeCommand(serverId, `docker logout ${url} 2>&1 || true`);
            }
            else {
                await this.sshService.executeCommand(serverId, 'docker logout 2>&1 || true');
            }
            if (result.exitCode === 0) {
                return {
                    success: true,
                    message: 'Successfully authenticated with registry',
                };
            }
            // Parse common error messages
            const output = result.stderr || result.stdout;
            if (output.includes('unauthorized') || output.includes('401')) {
                return {
                    success: false,
                    message: 'Invalid credentials',
                    details: 'Username or password is incorrect',
                };
            }
            if (output.includes('not found') || output.includes('404')) {
                return {
                    success: false,
                    message: 'Registry not found',
                    details: `Could not connect to registry at ${url || 'Docker Hub'}`,
                };
            }
            return {
                success: false,
                message: 'Failed to authenticate',
                details: output,
            };
        }
        catch (error) {
            return {
                success: false,
                message: 'Connection failed',
                details: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Login to registry on server
     */
    async loginToRegistry(serverId, registryId) {
        const creds = await this.getCredentialsWithPassword(serverId, registryId);
        if (!creds || !creds.password) {
            throw new Error('Registry credentials not found or could not be decrypted');
        }
        const url = creds.url;
        const loginCmd = url
            ? `echo "${this.escapeForShell(creds.password)}" | docker login ${url} -u "${this.escapeForShell(creds.username)}" --password-stdin`
            : `echo "${this.escapeForShell(creds.password)}" | docker login -u "${this.escapeForShell(creds.username)}" --password-stdin`;
        const result = await this.sshService.executeCommand(serverId, loginCmd);
        if (result.exitCode === 0) {
            // Update last validated timestamp
            const stmt = db_1.db.prepare(`
        UPDATE docker_registry_credentials
        SET last_validated_at = ?, is_valid = 1, updated_at = ?
        WHERE id = ?
      `);
            const now = Date.now();
            stmt.run(now, now, registryId);
            return true;
        }
        // Mark as invalid
        const stmt = db_1.db.prepare(`
      UPDATE docker_registry_credentials
      SET is_valid = 0, updated_at = ?
      WHERE id = ?
    `);
        stmt.run(Date.now(), registryId);
        return false;
    }
    /**
     * Logout from registry on server
     */
    async logoutFromRegistry(serverId, registryId) {
        const creds = this.getCredentials(serverId, registryId);
        if (!creds) {
            throw new Error('Registry credentials not found');
        }
        const logoutCmd = creds.url
            ? `docker logout ${creds.url}`
            : 'docker logout';
        await this.sshService.executeCommand(serverId, logoutCmd);
    }
    /**
     * Validate all credentials for a server
     */
    async validateAllCredentials(serverId) {
        const results = new Map();
        const credentials = this.listCredentials(serverId);
        for (const cred of credentials) {
            try {
                const isValid = await this.loginToRegistry(serverId, cred.id);
                results.set(cred.id, isValid);
                // Logout after validation
                if (isValid) {
                    await this.logoutFromRegistry(serverId, cred.id);
                }
            }
            catch {
                results.set(cred.id, false);
            }
        }
        return results;
    }
    /**
     * Escape special characters for shell commands
     */
    escapeForShell(str) {
        return str.replace(/([\\$"`])/g, '\\$1');
    }
    /**
     * Get registry display name
     */
    getRegistryDisplayName(type) {
        switch (type) {
            case 'dockerhub':
                return 'Docker Hub';
            case 'ghcr':
                return 'GitHub Container Registry';
            case 'gitlab':
                return 'GitLab Container Registry';
            case 'ecr':
                return 'Amazon ECR';
            case 'gcr':
                return 'Google Container Registry';
            case 'custom':
                return 'Custom Registry';
            default:
                return type;
        }
    }
    /**
     * Parse ECR URL to extract account and region
     */
    parseECRUrl(url) {
        // Format: {account}.dkr.ecr.{region}.amazonaws.com
        const match = url.match(/^(\d+)\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/);
        if (match) {
            return { account: match[1], region: match[2] };
        }
        return null;
    }
    /**
     * Build ECR URL from account and region
     */
    buildECRUrl(account, region) {
        return `${account}.dkr.ecr.${region}.amazonaws.com`;
    }
}
exports.RegistryService = RegistryService;
// Factory function to create RegistryService with dependencies
function createRegistryService(credentialVault, sshService) {
    return new RegistryService(credentialVault, sshService);
}
//# sourceMappingURL=RegistryService.js.map