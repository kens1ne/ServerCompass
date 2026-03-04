"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration: Add buildpack generation tracking fields to docker_stacks table.
 *
 * This migration adds:
 * - generation_method: How the Dockerfile was generated ('template', 'nixpacks', 'manual')
 * - generation_config: JSON string storing Nixpacks configuration overrides
 * - nixpacks_version: Version of Nixpacks used for generation
 */
function migrate(db) {
    console.log('Running migration: 028_buildpack_generation');
    // Add generation_method column with CHECK constraint
    db.exec(`
    ALTER TABLE docker_stacks
    ADD COLUMN generation_method TEXT
    CHECK(generation_method IS NULL OR generation_method IN ('template', 'nixpacks', 'manual'));
  `);
    // Add generation_config column (JSON string)
    db.exec(`
    ALTER TABLE docker_stacks
    ADD COLUMN generation_config TEXT;
  `);
    // Add nixpacks_version column
    db.exec(`
    ALTER TABLE docker_stacks
    ADD COLUMN nixpacks_version TEXT;
  `);
    // Create index for filtering by generation method
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_generation_method
    ON docker_stacks(generation_method);
  `);
    // Set existing stacks to 'template' method for backwards compatibility
    db.exec(`
    UPDATE docker_stacks
    SET generation_method = 'template'
    WHERE generation_method IS NULL;
  `);
    console.log('✅ Migration 028_buildpack_generation completed');
}
//# sourceMappingURL=028_buildpack_generation.js.map