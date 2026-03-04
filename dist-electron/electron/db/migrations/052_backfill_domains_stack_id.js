"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Backfill legacy domains rows where stack_id was not persisted.
    // We infer stack from deployment_id + project_name convention.
    db.exec(`
    UPDATE domains
    SET stack_id = (
      SELECT s.id
      FROM docker_stacks s
      WHERE s.server_id = domains.server_id
        AND domains.deployment_id IS NOT NULL
        AND s.project_name LIKE '%' || domains.deployment_id || '%'
      ORDER BY s.created_at DESC
      LIMIT 1
    )
    WHERE stack_id IS NULL
      AND deployment_id IS NOT NULL;
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_domains_stack ON domains(stack_id);
  `);
    console.log('Backfilled domains.stack_id for legacy rows');
}
//# sourceMappingURL=052_backfill_domains_stack_id.js.map