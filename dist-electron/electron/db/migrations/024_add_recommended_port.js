"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add recommended_port column to docker_compose_templates table
    db.exec(`
    ALTER TABLE docker_compose_templates
    ADD COLUMN recommended_port INTEGER;
  `);
    console.log('[Migration 024] Added recommended_port to docker_compose_templates');
}
//# sourceMappingURL=024_add_recommended_port.js.map