"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function columnExists(db, table, column) {
    const rows = db.prepare(`PRAGMA table_info('${table}')`).all();
    return rows.some((row) => row.name === column);
}
function migrate(db) {
    const alterStatements = [];
    if (!columnExists(db, 'licenses', 'gumroad_purchase_id')) {
        alterStatements.push('ALTER TABLE licenses ADD COLUMN gumroad_purchase_id TEXT');
    }
    if (!columnExists(db, 'licenses', 'gumroad_product_id')) {
        alterStatements.push('ALTER TABLE licenses ADD COLUMN gumroad_product_id TEXT');
    }
    if (!columnExists(db, 'licenses', 'gumroad_order_number')) {
        alterStatements.push('ALTER TABLE licenses ADD COLUMN gumroad_order_number INTEGER');
    }
    if (!columnExists(db, 'licenses', 'gumroad_sale_timestamp')) {
        alterStatements.push('ALTER TABLE licenses ADD COLUMN gumroad_sale_timestamp TEXT');
    }
    if (!columnExists(db, 'licenses', 'last_verification_status')) {
        alterStatements.push('ALTER TABLE licenses ADD COLUMN last_verification_status TEXT');
    }
    if (!columnExists(db, 'licenses', 'next_verification_due')) {
        alterStatements.push('ALTER TABLE licenses ADD COLUMN next_verification_due DATETIME');
    }
    if (alterStatements.length > 0) {
        db.exec(alterStatements.join(';'));
    }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_licenses_gumroad_purchase ON licenses(gumroad_purchase_id);

    CREATE TABLE IF NOT EXISTS license_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT NOT NULL,
      verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verification_response TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      error_message TEXT,
      FOREIGN KEY (license_key) REFERENCES licenses(license_key)
    );

    CREATE INDEX IF NOT EXISTS idx_verifications_key_date
      ON license_verifications(license_key, verified_at);

    UPDATE licenses
    SET next_verification_due = datetime('now', '+7 days')
    WHERE next_verification_due IS NULL;
  `);
}
//# sourceMappingURL=009_gumroad_fields.js.map