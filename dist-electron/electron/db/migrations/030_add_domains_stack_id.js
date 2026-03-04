"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add stack_id field to domains table to support Docker stack associations
    // The deployment_id field references PM2-style deployments, while stack_id references docker_stacks
    db.exec(`
    ALTER TABLE domains ADD COLUMN stack_id TEXT REFERENCES docker_stacks(id) ON DELETE CASCADE;
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_domains_stack ON domains(stack_id);
  `);
    console.log('Added stack_id field to domains table');
}
//# sourceMappingURL=030_add_domains_stack_id.js.map