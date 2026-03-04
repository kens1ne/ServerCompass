"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    console.log('[Migration 040] Adding extra_categories column to docker_compose_templates');
    // Add extra_categories column (JSON array of additional categories)
    db.exec(`
    ALTER TABLE docker_compose_templates ADD COLUMN extra_categories TEXT;
  `);
    console.log('[Migration 040] Added extra_categories column to docker_compose_templates');
}
//# sourceMappingURL=040_add_extra_categories.js.map