"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Create table for Docker Compose deployments
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_compose_deployments (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      project_name TEXT NOT NULL,

      -- Compose configuration
      compose_file_content TEXT NOT NULL,  -- The actual docker-compose.yml
      compose_file_path TEXT DEFAULT '/opt/servercompass/{project_name}/docker-compose.yml',

      -- Registry configuration
      registry_type TEXT CHECK(registry_type IN ('ghcr', 'gitlab', 'dockerhub', 'self_hosted', 'custom')),
      registry_url TEXT,
      registry_username TEXT,
      encrypted_registry_password BLOB,  -- Encrypted with CredentialVault

      -- Deployment settings
      auto_deploy INTEGER DEFAULT 0,
      webhook_secret TEXT,

      -- Status
      last_deployed_at INTEGER,
      deployment_status TEXT CHECK(deployment_status IN ('pending', 'deploying', 'running', 'failed', 'stopped')),

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      UNIQUE(server_id, project_name)
    );
  `);
    // Create indexes for Docker Compose deployments
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_compose_deployments_server
    ON docker_compose_deployments(server_id);

    CREATE INDEX IF NOT EXISTS idx_docker_compose_deployments_project
    ON docker_compose_deployments(project_name);

    CREATE INDEX IF NOT EXISTS idx_docker_compose_deployments_status
    ON docker_compose_deployments(deployment_status);
  `);
    // Create table for deployment logs and history
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_compose_deployment_logs (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,

      -- Deployment details
      triggered_by TEXT CHECK(triggered_by IN ('manual', 'webhook', 'auto')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT CHECK(status IN ('pending', 'pulling', 'starting', 'success', 'failed')),

      -- Logs
      pull_output TEXT,
      up_output TEXT,
      error_message TEXT,

      -- Image versions deployed (JSON array of {service: string, image: string, digest: string})
      deployed_images TEXT,

      created_at INTEGER NOT NULL,

      FOREIGN KEY (deployment_id) REFERENCES docker_compose_deployments(id) ON DELETE CASCADE
    );
  `);
    // Create indexes for deployment logs
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_compose_logs_deployment
    ON docker_compose_deployment_logs(deployment_id);

    CREATE INDEX IF NOT EXISTS idx_docker_compose_logs_started
    ON docker_compose_deployment_logs(started_at DESC);
  `);
    // Create table for container status (refreshed periodically)
    db.exec(`
    CREATE TABLE IF NOT EXISTS docker_compose_containers (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,

      -- Container info
      service_name TEXT NOT NULL,  -- From docker-compose.yml
      container_id TEXT,
      container_name TEXT,
      image TEXT,

      -- Status
      state TEXT,  -- running, exited, restarting, etc.
      status TEXT,  -- Docker status message
      health TEXT,  -- healthy, unhealthy, null

      -- Ports
      ports TEXT,  -- JSON array of port mappings

      -- Resources (updated periodically)
      cpu_percent TEXT,
      memory_usage TEXT,
      memory_limit TEXT,

      updated_at INTEGER NOT NULL,

      FOREIGN KEY (deployment_id) REFERENCES docker_compose_deployments(id) ON DELETE CASCADE
    );
  `);
    // Create indexes for containers
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_docker_compose_containers_deployment
    ON docker_compose_containers(deployment_id);

    CREATE INDEX IF NOT EXISTS idx_docker_compose_containers_state
    ON docker_compose_containers(state);
  `);
    // Add Docker support to existing deployments table
    // This allows tracking both PM2 and Docker deployments in the same history
    db.exec(`
    ALTER TABLE deployments
    ADD COLUMN deployment_type TEXT DEFAULT 'pm2'
    CHECK(deployment_type IN ('pm2', 'docker'));
  `);
    db.exec(`
    ALTER TABLE deployments
    ADD COLUMN docker_compose_deployment_id TEXT
    REFERENCES docker_compose_deployments(id) ON DELETE SET NULL;
  `);
    // Create index for deployment type queries
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_deployments_type
    ON deployments(deployment_type);
  `);
}
//# sourceMappingURL=016_docker_compose_support.js.map