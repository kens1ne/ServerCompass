"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add packages_installed column to servers table
    // 0 = not checked/not installed, 1 = all essential packages installed
    db.exec(`
    ALTER TABLE servers ADD COLUMN packages_installed INTEGER DEFAULT 0;
  `);
    // Add packages_checked_at column to track when last checked
    db.exec(`
    ALTER TABLE servers ADD COLUMN packages_checked_at INTEGER DEFAULT NULL;
  `);
    console.log('Package installation status tracking added to servers table');
}
//# sourceMappingURL=013_package_installation_status.js.map