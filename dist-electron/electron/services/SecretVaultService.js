"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.secretVaultService = void 0;
const crypto_1 = require("crypto");
const CredentialVault_1 = require("./CredentialVault");
const db_1 = require("../db");
const vault = new CredentialVault_1.CredentialVault();
class SecretVaultService {
    /**
     * Parse .env file content into key-value pairs.
     * Handles comments, empty lines, quoted values.
     */
    parseEnvContent(content) {
        const result = {};
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const equalIndex = trimmed.indexOf('=');
            if (equalIndex <= 0)
                continue;
            const key = trimmed.substring(0, equalIndex).trim();
            let value = trimmed.substring(equalIndex + 1).trim();
            // Remove surrounding quotes
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
                value = value.replace(/\\"/g, '"').replace(/\\'/g, "'");
            }
            if (key)
                result[key] = value;
        }
        return result;
    }
    /**
     * Create a new secret collection (encrypts secrets before storing)
     */
    async createCollection(input) {
        const id = (0, crypto_1.randomUUID)();
        const now = Date.now();
        const secretsJson = JSON.stringify(input.secrets);
        const encryptedData = await vault.encrypt(secretsJson);
        const secretCount = Object.keys(input.secrets).length;
        db_1.queries.createSecretCollection({
            id,
            name: input.name,
            description: input.description || null,
            tags: input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null,
            encrypted_data: encryptedData,
            secret_count: secretCount,
            created_at: now,
            updated_at: now,
        });
        return {
            id,
            name: input.name,
            description: input.description || null,
            tags: input.tags || [],
            secrets: Object.entries(input.secrets).map(([key, value]) => ({ key, value })),
            secretCount,
            createdAt: now,
            updatedAt: now,
        };
    }
    /**
     * Get all collections (metadata only, no decryption)
     */
    getAllCollections() {
        const rows = db_1.queries.getAllSecretCollections();
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            tags: row.tags ? JSON.parse(row.tags) : [],
            secretCount: row.secret_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }
    /**
     * Get a single collection with decrypted secrets
     */
    async getCollectionSecrets(id) {
        const row = db_1.queries.getSecretCollectionById(id);
        if (!row)
            return null;
        const decrypted = await vault.decrypt(row.encrypted_data);
        const secretsObj = JSON.parse(decrypted);
        return {
            id: row.id,
            name: row.name,
            description: row.description,
            tags: row.tags ? JSON.parse(row.tags) : [],
            secrets: Object.entries(secretsObj).map(([key, value]) => ({ key, value })),
            secretCount: row.secret_count,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    /**
     * Update a collection (re-encrypts secrets if provided)
     */
    async updateCollection(id, input) {
        const updates = { updated_at: Date.now() };
        if (input.name !== undefined)
            updates.name = input.name;
        if (input.description !== undefined)
            updates.description = input.description;
        if (input.tags !== undefined)
            updates.tags = input.tags.length > 0 ? JSON.stringify(input.tags) : null;
        if (input.secrets !== undefined) {
            const secretsJson = JSON.stringify(input.secrets);
            updates.encrypted_data = await vault.encrypt(secretsJson);
            updates.secret_count = Object.keys(input.secrets).length;
        }
        db_1.queries.updateSecretCollection(id, updates);
    }
    /**
     * Delete a collection
     */
    deleteCollection(id) {
        db_1.queries.deleteSecretCollection(id);
    }
    /**
     * Get secrets as Record<string, string> for import into env editors
     */
    async getSecretsAsRecord(id) {
        const row = db_1.queries.getSecretCollectionById(id);
        if (!row)
            return null;
        const decrypted = await vault.decrypt(row.encrypted_data);
        return JSON.parse(decrypted);
    }
}
exports.secretVaultService = new SecretVaultService();
//# sourceMappingURL=SecretVaultService.js.map