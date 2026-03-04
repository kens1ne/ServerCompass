"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add security features columns to domains table
    db.exec(`
    -- Security headers configuration (JSON)
    ALTER TABLE domains ADD COLUMN security_headers TEXT;

    -- Rate limiting
    ALTER TABLE domains ADD COLUMN rate_limit_enabled INTEGER DEFAULT 0;
    ALTER TABLE domains ADD COLUMN rate_limit_average INTEGER DEFAULT 100;
    ALTER TABLE domains ADD COLUMN rate_limit_burst INTEGER DEFAULT 50;

    -- Basic authentication
    ALTER TABLE domains ADD COLUMN basic_auth_enabled INTEGER DEFAULT 0;
    ALTER TABLE domains ADD COLUMN basic_auth_users TEXT;

    -- IP whitelist (JSON array of allowed IPs/CIDRs)
    ALTER TABLE domains ADD COLUMN ip_whitelist_enabled INTEGER DEFAULT 0;
    ALTER TABLE domains ADD COLUMN ip_whitelist TEXT;
  `);
    console.log('Domain security features columns added successfully');
}
//# sourceMappingURL=037_domain_security_features.js.map