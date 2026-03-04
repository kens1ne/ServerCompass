"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 042: Add db_classification column for SQL vs NoSQL filtering
 *
 * This adds a classification column to distinguish between:
 * - 'relational' - SQL databases (PostgreSQL, MySQL)
 * - 'nosql' - Document/Key-Value/Search databases (MongoDB, Elasticsearch, etc.)
 *
 * The column is nullable since it only applies to database templates.
 */
function migrate(db) {
    console.log('[Migration 042] Adding db_classification column to docker_compose_templates');
    // Check if column already exists
    const columns = db.prepare(`PRAGMA table_info(docker_compose_templates)`).all();
    if (!columns.some((c) => c.name === 'db_classification')) {
        // Add db_classification column (nullable for non-database templates)
        // SQLite CHECK constraint allows NULL or specific values
        db.exec(`
      ALTER TABLE docker_compose_templates
      ADD COLUMN db_classification TEXT CHECK(db_classification IS NULL OR db_classification IN ('relational', 'nosql'));
    `);
        // Update existing database templates with 'relational' classification
        db.exec(`
      UPDATE docker_compose_templates
      SET db_classification = 'relational'
      WHERE id IN ('builtin-postgres', 'builtin-mysql', 'builtin-supabase', 'builtin-supabase-full');
    `);
        // Create index for filtering (partial index on non-null values)
        db.exec(`
      CREATE INDEX IF NOT EXISTS idx_templates_db_classification
      ON docker_compose_templates(db_classification)
      WHERE db_classification IS NOT NULL;
    `);
        console.log('[Migration 042] Added db_classification column and updated existing SQL templates');
    }
    else {
        console.log('[Migration 042] db_classification column already exists, skipping');
    }
}
//# sourceMappingURL=042_add_db_classification.js.map