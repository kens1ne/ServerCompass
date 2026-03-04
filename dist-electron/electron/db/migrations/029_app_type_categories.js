"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    console.log('[Migration 029] Adding app_type, requires_build, and metadata to docker_compose_templates');
    const columns = db.prepare(`PRAGMA table_info(docker_compose_templates)`).all();
    const hasColumn = (name) => columns.some((col) => col.name === name);
    // Add new metadata columns if they don't exist yet
    if (!hasColumn('app_type')) {
        db.exec(`
      ALTER TABLE docker_compose_templates
      ADD COLUMN app_type TEXT DEFAULT 'app'
      CHECK(app_type IN ('app', 'service', 'database'));
    `);
    }
    if (!hasColumn('subcategory')) {
        db.exec(`
      ALTER TABLE docker_compose_templates
      ADD COLUMN subcategory TEXT;
    `);
    }
    if (!hasColumn('requires_build')) {
        db.exec(`
      ALTER TABLE docker_compose_templates
      ADD COLUMN requires_build INTEGER DEFAULT 0;
    `);
    }
    if (!hasColumn('volume_hints')) {
        db.exec(`
      ALTER TABLE docker_compose_templates
      ADD COLUMN volume_hints TEXT;
    `);
    }
    if (!hasColumn('ports_hints')) {
        db.exec(`
      ALTER TABLE docker_compose_templates
      ADD COLUMN ports_hints TEXT;
    `);
    }
    // Indexes for filtering by type and subcategory
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_app_type
    ON docker_compose_templates(app_type);
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_subcategory
    ON docker_compose_templates(subcategory);
  `);
    // Backfill app_type and requires_build based on existing categories
    db.exec(`
    UPDATE docker_compose_templates
    SET app_type = 'app', requires_build = 1
    WHERE (app_type IS NULL OR app_type = '') AND category IN ('nextjs', 'express', 'nestjs', 'python', 'go', 'static', 'fullstack', 'custom');
  `);
    db.exec(`
    UPDATE docker_compose_templates
    SET app_type = 'database', requires_build = 0
    WHERE category = 'database';
  `);
    db.exec(`
    UPDATE docker_compose_templates
    SET app_type = 'service', requires_build = 0
    WHERE category = 'cms';
  `);
    console.log('[Migration 029] Completed');
}
//# sourceMappingURL=029_app_type_categories.js.map