"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    console.log('[Migration 047] Adding variables column to docker_compose_templates');
    // Add the variables column as JSON text (nullable for backward compatibility)
    db.exec(`
    ALTER TABLE docker_compose_templates
    ADD COLUMN variables TEXT;
  `);
    console.log('[Migration 047] Migration complete');
}
//# sourceMappingURL=047_add_template_variables.js.map