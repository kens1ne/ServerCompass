"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    console.log('[Migration 038] Adding nocode category to docker_compose_templates');
    // SQLite doesn't support modifying CHECK constraints directly
    // We need to recreate the table with the new constraint
    // 1. Create new table with updated CHECK constraint (includes nocode)
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_compose_templates_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL CHECK(category IN ('nextjs', 'express', 'nestjs', 'static', 'python', 'go', 'database', 'fullstack', 'custom', 'cms', 'nocode')),
      compose_content TEXT NOT NULL,
      dockerfile_content TEXT,
      env_hints TEXT,
      documentation TEXT,
      min_memory_mb INTEGER DEFAULT 512,
      icon TEXT,
      recommended_port INTEGER,
      app_type TEXT DEFAULT 'app' CHECK(app_type IN ('app', 'service', 'database')),
      subcategory TEXT,
      requires_build INTEGER DEFAULT 0,
      volume_hints TEXT,
      ports_hints TEXT,
      is_builtin INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
    // 2. Copy data from old table to new table
    db.exec(`
    INSERT INTO docker_compose_templates_new (
      id, name, description, category, compose_content, dockerfile_content,
      env_hints, documentation, min_memory_mb, icon, recommended_port,
      app_type, subcategory, requires_build, volume_hints, ports_hints,
      is_builtin, created_at, updated_at
    )
    SELECT
      id, name, description, category, compose_content, dockerfile_content,
      env_hints, documentation, min_memory_mb, icon, recommended_port,
      app_type, subcategory, requires_build, volume_hints, ports_hints,
      is_builtin, created_at, updated_at
    FROM docker_compose_templates;
  `);
    // 3. Drop old table
    db.exec(`DROP TABLE docker_compose_templates;`);
    // 4. Rename new table to original name
    db.exec(`ALTER TABLE docker_compose_templates_new RENAME TO docker_compose_templates;`);
    // 5. Recreate indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_category ON docker_compose_templates(category);
    CREATE INDEX IF NOT EXISTS idx_templates_app_type ON docker_compose_templates(app_type);
    CREATE INDEX IF NOT EXISTS idx_templates_subcategory ON docker_compose_templates(subcategory);
  `);
    console.log('[Migration 038] Added nocode category to docker_compose_templates');
}
//# sourceMappingURL=038_add_nocode_category.js.map