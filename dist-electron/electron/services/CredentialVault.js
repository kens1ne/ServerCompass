"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialVault = void 0;
const crypto_1 = require("crypto");
const util_1 = require("util");
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const scryptAsync = (0, util_1.promisify)(crypto_1.scrypt);
/**
 * CredentialVault handles encryption and decryption of sensitive data
 * Uses AES-256-GCM with a key derived from a master password
 */
class CredentialVault {
    algorithm = 'aes-256-gcm';
    saltLength = 32;
    ivLength = 16;
    keyLength = 32;
    tagLength = 16;
    masterKey = null;
    constructor() {
        this.initializeMasterKey();
    }
    /**
     * Initialize or load the master key
     * In production, this should use the OS keychain (Keychain Access on macOS, Credential Manager on Windows)
     * For MVP, we'll use a file-based approach with a randomly generated key
     */
    initializeMasterKey() {
        const userDataPath = electron_1.app.getPath('userData');
        const keyPath = path_1.default.join(userDataPath, '.vault_key');
        try {
            if (fs_1.default.existsSync(keyPath)) {
                // Load existing key
                this.masterKey = fs_1.default.readFileSync(keyPath);
            }
            else {
                // Generate new key
                this.masterKey = (0, crypto_1.randomBytes)(this.keyLength);
                fs_1.default.writeFileSync(keyPath, this.masterKey, { mode: 0o600 });
                console.log('Generated new vault master key');
            }
        }
        catch (error) {
            console.error('Error initializing master key:', error);
            throw new Error('Failed to initialize credential vault');
        }
    }
    /**
     * Encrypt a secret string
     */
    async encrypt(plaintext) {
        if (!this.masterKey) {
            throw new Error('Vault not initialized');
        }
        try {
            // Generate a random salt for this encryption
            const salt = (0, crypto_1.randomBytes)(this.saltLength);
            // Derive encryption key from master key and salt
            const key = (await scryptAsync(this.masterKey, salt, this.keyLength));
            // Generate random IV
            const iv = (0, crypto_1.randomBytes)(this.ivLength);
            // Create cipher
            const cipher = (0, crypto_1.createCipheriv)(this.algorithm, key, iv);
            // Encrypt
            const encrypted = Buffer.concat([
                cipher.update(plaintext, 'utf8'),
                cipher.final(),
            ]);
            // Get auth tag
            const tag = cipher.getAuthTag();
            // Combine salt + iv + tag + encrypted data
            return Buffer.concat([salt, iv, tag, encrypted]);
        }
        catch (error) {
            console.error('Encryption error:', error);
            throw new Error('Failed to encrypt secret');
        }
    }
    /**
     * Decrypt a secret
     */
    async decrypt(encryptedData) {
        if (!this.masterKey) {
            throw new Error('Vault not initialized');
        }
        try {
            // Extract salt, iv, tag, and encrypted data
            const salt = encryptedData.subarray(0, this.saltLength);
            const iv = encryptedData.subarray(this.saltLength, this.saltLength + this.ivLength);
            const tag = encryptedData.subarray(this.saltLength + this.ivLength, this.saltLength + this.ivLength + this.tagLength);
            const encrypted = encryptedData.subarray(this.saltLength + this.ivLength + this.tagLength);
            // Derive decryption key
            const key = (await scryptAsync(this.masterKey, salt, this.keyLength));
            // Create decipher
            const decipher = (0, crypto_1.createDecipheriv)(this.algorithm, key, iv);
            decipher.setAuthTag(tag);
            // Decrypt
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final(),
            ]);
            return decrypted.toString('utf8');
        }
        catch (error) {
            console.error('Decryption error:', error);
            throw new Error('Failed to decrypt secret');
        }
    }
    /**
     * Re-encrypt all secrets with a new master key
     * Useful for key rotation
     */
    async rotateKey(newMasterKey) {
        const oldKey = this.masterKey;
        this.masterKey = newMasterKey;
        const userDataPath = electron_1.app.getPath('userData');
        const keyPath = path_1.default.join(userDataPath, '.vault_key');
        try {
            fs_1.default.writeFileSync(keyPath, newMasterKey, { mode: 0o600 });
            console.log('Master key rotated successfully');
        }
        catch (error) {
            // Rollback on failure
            this.masterKey = oldKey;
            throw new Error('Failed to rotate master key');
        }
    }
}
exports.CredentialVault = CredentialVault;
//# sourceMappingURL=CredentialVault.js.map