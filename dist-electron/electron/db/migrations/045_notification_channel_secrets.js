"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    console.log('[Migration 045] Adding encrypted_secrets column to notification_channels');
    try {
        // Stores sensitive notification channel fields (e.g. webhook URLs, API keys, SMTP app passwords)
        // encrypted at rest using `CredentialVault` (AES-256-GCM). The plaintext values should NOT live
        // in `notification_channels.config` or be returned to the renderer.
        db.exec('ALTER TABLE notification_channels ADD COLUMN encrypted_secrets BLOB');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('duplicate column name')) {
            throw error;
        }
    }
    console.log('[Migration 045] notification_channels encrypted_secrets column ready');
}
//# sourceMappingURL=045_notification_channel_secrets.js.map