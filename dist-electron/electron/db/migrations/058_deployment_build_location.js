"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Add build_location column to docker_stack_deployments table.
 * This tracks which build method was used for each deployment
 * (vps, local-build, github-actions).
 */
function migrate(db) {
    // Add build_location column to docker_stack_deployments
    db.exec(`
    ALTER TABLE docker_stack_deployments
    ADD COLUMN build_location TEXT DEFAULT NULL;
  `);
    // Backfill existing deployments from their parent stack's build_location
    db.exec(`
    UPDATE docker_stack_deployments
    SET build_location = (
      SELECT ds.build_location
      FROM docker_stacks ds
      WHERE ds.id = docker_stack_deployments.stack_id
    )
    WHERE build_location IS NULL;
  `);
}
//# sourceMappingURL=058_deployment_build_location.js.map