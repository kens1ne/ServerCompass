"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add countryCode, org, and timezone columns to servers table for geolocation data
    db.exec(`
    ALTER TABLE servers ADD COLUMN country_code TEXT;
  `);
    db.exec(`
    ALTER TABLE servers ADD COLUMN org TEXT;
  `);
    db.exec(`
    ALTER TABLE servers ADD COLUMN timezone TEXT;
  `);
    console.log('Server geolocation columns added successfully');
}
//# sourceMappingURL=016_server_geolocation.js.map