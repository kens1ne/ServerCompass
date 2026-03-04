"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Create domains table
    db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      deployment_id TEXT,
      domain TEXT NOT NULL,
      port INTEGER NOT NULL,
      ssl_enabled INTEGER DEFAULT 1,
      https_redirect INTEGER DEFAULT 1,
      www_redirect INTEGER DEFAULT 1,
      certificate_resolver TEXT DEFAULT 'letsencrypt',

      -- Traefik-specific
      router_name TEXT NOT NULL,
      entrypoints TEXT DEFAULT 'websecure',

      -- Middleware support
      middlewares TEXT,

      -- Custom headers (JSON object)
      custom_headers TEXT,

      -- Status tracking
      dns_verified INTEGER DEFAULT 0,
      certificate_status TEXT,
      last_certificate_check INTEGER,

      -- Metadata
      proxy_type TEXT DEFAULT 'traefik',
      created_at INTEGER NOT NULL DEFAULT (cast(strftime('%s', 'now') as int) * 1000),
      updated_at INTEGER NOT NULL DEFAULT (cast(strftime('%s', 'now') as int) * 1000),

      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
      UNIQUE(domain, server_id)
    );
  `);
    // Create indexes
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_domains_server ON domains(server_id);
    CREATE INDEX IF NOT EXISTS idx_domains_deployment ON domains(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_domains_proxy_type ON domains(proxy_type);
  `);
    // Create domain_redirects table
    db.exec(`
    CREATE TABLE IF NOT EXISTS domain_redirects (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      source_domain TEXT NOT NULL,
      target_domain TEXT NOT NULL,
      redirect_type TEXT DEFAULT 'permanent',
      created_at INTEGER NOT NULL DEFAULT (cast(strftime('%s', 'now') as int) * 1000),

      FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
      UNIQUE(source_domain, domain_id)
    );
  `);
    console.log('Traefik domains tables created successfully');
}
//# sourceMappingURL=026_traefik_domains.js.map