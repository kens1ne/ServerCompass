"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // SQLite doesn't support modifying CHECK constraints directly
    // We need to recreate the table with the new constraint
    // Check if the old table has the recommended_port column
    const columns = db.prepare(`PRAGMA table_info(docker_compose_templates)`).all();
    const hasRecommendedPort = columns.some(col => col.name === 'recommended_port');
    // 1. Create new table with updated CHECK constraint
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_compose_templates_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL CHECK(category IN ('nextjs', 'express', 'nestjs', 'static', 'python', 'go', 'database', 'fullstack', 'custom', 'cms')),
      compose_content TEXT NOT NULL,
      dockerfile_content TEXT,
      env_hints TEXT,
      documentation TEXT,
      min_memory_mb INTEGER DEFAULT 512,
      icon TEXT,
      recommended_port INTEGER,
      is_builtin INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
    // 2. Copy data from old table to new table
    // Handle both cases: with and without recommended_port column
    if (hasRecommendedPort) {
        db.exec(`
      INSERT INTO docker_compose_templates_new (
        id, name, description, category, compose_content, dockerfile_content,
        env_hints, documentation, min_memory_mb, icon, recommended_port, is_builtin, created_at, updated_at
      )
      SELECT
        id,
        name,
        COALESCE(description, ''),
        category,
        compose_content,
        dockerfile_content,
        env_hints,
        documentation,
        COALESCE(min_memory_mb, 512),
        COALESCE(icon, '📦'),
        recommended_port,
        COALESCE(is_builtin, 1),
        COALESCE(created_at, ${Date.now()}),
        COALESCE(updated_at, created_at, ${Date.now()})
      FROM docker_compose_templates;
    `);
    }
    else {
        db.exec(`
      INSERT INTO docker_compose_templates_new (
        id, name, description, category, compose_content, dockerfile_content,
        env_hints, documentation, min_memory_mb, icon, recommended_port, is_builtin, created_at, updated_at
      )
      SELECT
        id,
        name,
        COALESCE(description, ''),
        category,
        compose_content,
        dockerfile_content,
        env_hints,
        documentation,
        COALESCE(min_memory_mb, 512),
        COALESCE(icon, '📦'),
        NULL,
        COALESCE(is_builtin, 1),
        COALESCE(created_at, ${Date.now()}),
        COALESCE(updated_at, created_at, ${Date.now()})
      FROM docker_compose_templates;
    `);
    }
    // 3. Drop old table
    db.exec(`DROP TABLE docker_compose_templates;`);
    // 4. Rename new table to original name
    db.exec(`ALTER TABLE docker_compose_templates_new RENAME TO docker_compose_templates;`);
    // 5. Recreate index
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_category ON docker_compose_templates(category);
  `);
    console.log('[Migration 025] Added cms category to docker_compose_templates');
}
//# sourceMappingURL=025_add_cms_category.js.map