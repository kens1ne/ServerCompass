"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // 1. Registry credentials (server-scoped)
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_registry_credentials (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('dockerhub', 'ghcr', 'gitlab', 'ecr', 'gcr', 'custom')),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_password BLOB NOT NULL,
      last_validated_at INTEGER,
      is_valid INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      UNIQUE(server_id, url, username)
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_registry_credentials_server
    ON docker_registry_credentials(server_id);
  `);
    // 2. Docker stacks (enhanced from docker_compose_deployments)
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_stacks (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('template', 'paste', 'registry', 'pm2_migration')),
      template_id TEXT,
      compose_content TEXT NOT NULL,
      dockerfile_content TEXT,
      env_vars TEXT,
      stack_path TEXT DEFAULT '/root/server-compass/apps',
      registry_credential_id TEXT,
      build_on_deploy INTEGER DEFAULT 0,
      pull_policy TEXT DEFAULT 'missing' CHECK(pull_policy IN ('always', 'missing', 'never')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'deploying', 'running', 'partial', 'stopped', 'error')),
      last_deployed_at INTEGER,
      last_error TEXT,
      services_count INTEGER DEFAULT 0,

      -- CI/CD fields
      ci_enabled INTEGER DEFAULT 0,
      webhook_secret TEXT,
      webhook_url TEXT,
      current_image_digest TEXT,
      last_webhook_at INTEGER,
      github_repo TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (registry_credential_id) REFERENCES docker_registry_credentials(id) ON DELETE SET NULL,
      UNIQUE(server_id, project_name)
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_server ON docker_stacks(server_id);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_status ON docker_stacks(status);
    CREATE INDEX IF NOT EXISTS idx_docker_stacks_source ON docker_stacks(source_type);
  `);
    // 3. Stack deployment history
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_stack_deployments (
      id TEXT PRIMARY KEY,
      stack_id TEXT NOT NULL,
      triggered_by TEXT CHECK(triggered_by IN ('manual', 'redeploy', 'webhook', 'pm2_migration')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT CHECK(status IN ('pending', 'pulling', 'building', 'starting', 'success', 'failed')),
      pull_output TEXT,
      build_output TEXT,
      up_output TEXT,
      error_message TEXT,
      deployed_images TEXT,
      previous_compose_content TEXT,
      created_at INTEGER NOT NULL,

      FOREIGN KEY (stack_id) REFERENCES docker_stacks(id) ON DELETE CASCADE
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_stack ON docker_stack_deployments(stack_id);
    CREATE INDEX IF NOT EXISTS idx_stack_deployments_started ON docker_stack_deployments(started_at DESC);
  `);
    // 4. Compose templates
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_compose_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL CHECK(category IN ('nextjs', 'express', 'nestjs', 'static', 'python', 'go', 'database', 'fullstack', 'custom')),
      compose_content TEXT NOT NULL,
      dockerfile_content TEXT,
      env_hints TEXT,
      documentation TEXT,
      min_memory_mb INTEGER DEFAULT 512,
      icon TEXT,
      is_builtin INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_category ON docker_compose_templates(category);
  `);
    // 5. Reverse proxy configurations
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_proxy_configs (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      stack_id TEXT,
      domain TEXT NOT NULL,
      target_port INTEGER NOT NULL,
      proxy_type TEXT CHECK(proxy_type IN ('nginx', 'caddy')),
      ssl_enabled INTEGER DEFAULT 0,
      ssl_certificate_path TEXT,
      ssl_expires_at INTEGER,
      ssl_email TEXT,
      custom_config TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'error', 'disabled')),
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (stack_id) REFERENCES docker_stacks(id) ON DELETE SET NULL,
      UNIQUE(server_id, domain)
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proxy_configs_server ON docker_proxy_configs(server_id);
    CREATE INDEX IF NOT EXISTS idx_proxy_configs_stack ON docker_proxy_configs(stack_id);
  `);
    // 6. PM2 migration tracking
    db.exec(`
    CREATE TABLE IF NOT EXISTS pm2_migrations (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      pm2_app_name TEXT NOT NULL,
      pm2_config TEXT NOT NULL,
      stack_id TEXT,
      migration_status TEXT CHECK(migration_status IN ('pending', 'migrating', 'validating', 'completed', 'failed', 'rolled_back')),
      pm2_stopped_at INTEGER,
      docker_started_at INTEGER,
      health_check_passed INTEGER DEFAULT 0,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (stack_id) REFERENCES docker_stacks(id) ON DELETE SET NULL
    );
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pm2_migrations_server ON pm2_migrations(server_id);
    CREATE INDEX IF NOT EXISTS idx_pm2_migrations_status ON pm2_migrations(migration_status);
  `);
    // Add feature flag for Docker
    db.exec(`
    INSERT OR IGNORE INTO settings (key, value, updated_at)
    VALUES ('docker_deploy_enabled', 'true', ${Date.now()});
  `);
}
//# sourceMappingURL=021_enhanced_docker_support.js.map