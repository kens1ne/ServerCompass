"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add ssh_public_key_content column to server_git_accounts
    // This stores the actual public key content to detect duplicates across accounts
    db.exec(`
    ALTER TABLE server_git_accounts
    ADD COLUMN ssh_public_key_content TEXT;
  `);
    // Add index for faster duplicate lookups
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_git_accounts_key_content
    ON server_git_accounts(ssh_public_key_content);
  `);
}
//# sourceMappingURL=015_ssh_key_content.js.map