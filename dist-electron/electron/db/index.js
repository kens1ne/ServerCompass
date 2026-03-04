"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queries = exports.db = void 0;
exports.runMigrations = runMigrations;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
let _db = null;
// CRITICAL: SQL query logging - only enable in development when explicitly needed
// This prevents massive log noise in production
//
// WHY THIS MATTERS:
// =================
// Before this change, EVERY SQL query was logged to console:
//   [1] SELECT * FROM license_status WHERE id = 1
//   [1] SELECT * FROM settings WHERE key = 'max_log_size_mb'
//   [1] INSERT INTO commands (id, server_id, command, executed_at, exit_code, stdout, stderr)
//   ... (thousands more lines)
//
// IMPACT:
// - 95% of log output was SQL queries
// - Real errors (SSH failures, app crashes) were buried in noise
// - Console became unusable for debugging
// - Log files grew to 100MB+ in minutes
//
// SOLUTION:
// - Default: SQL logging OFF (clean logs)
// - Enable when needed: SQL_VERBOSE=true npm run dev:electron
//
// WHEN TO ENABLE:
// - Debugging database schema issues
// - Investigating query performance
// - Checking if migrations ran correctly
// - Analyzing database access patterns
//
// WHEN TO KEEP DISABLED (default):
// - Normal development (you want to see app errors, not every SELECT)
// - Production (no verbose logging in prod)
// - Testing (cleaner test output)
const SQL_VERBOSE_LOGGING = process.env.SQL_VERBOSE === 'true';
function initDatabase() {
    if (_db)
        return _db;
    const userDataPath = electron_1.app.getPath('userData');
    const dbPath = path_1.default.join(userDataPath, 'servercompass.db');
    // Ensure directory exists
    if (!fs_1.default.existsSync(userDataPath)) {
        fs_1.default.mkdirSync(userDataPath, { recursive: true });
    }
    // CRITICAL: Only enable verbose SQL logging when explicitly requested
    // Default: disabled to avoid log noise
    _db = new better_sqlite3_1.default(dbPath, SQL_VERBOSE_LOGGING ? { verbose: console.log } : undefined);
    // Enable foreign keys
    _db.pragma('foreign_keys = ON');
    return _db;
}
const columnExists = (table, column) => {
    const columns = exports.db.prepare(`PRAGMA table_info(${table})`).all();
    return columns.some((col) => col.name === column);
};
const ensureOneClickInstallationsTable = () => {
    const tableExists = exports.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='one_click_installations'").get();
    if (!tableExists) {
        console.log('[Schema fixup] Creating missing one_click_installations table');
        exports.db.exec(`
      CREATE TABLE IF NOT EXISTS one_click_installations (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        name TEXT NOT NULL,
        install_command_redacted TEXT NOT NULL,
        install_url TEXT NOT NULL,
        service_manager TEXT NOT NULL CHECK(service_manager IN ('docker', 'systemd', 'systemd-user', 'custom')),
        lifecycle_commands TEXT,
        discovery_config TEXT,
        systemd_main_unit TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','installing','installed','running','stopped','error','uninstalled')),
        installed_version TEXT,
        install_path TEXT,
        install_error TEXT,
        installed_at INTEGER,
        last_checked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      )
    `);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_one_click_server ON one_click_installations(server_id)`);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_one_click_status ON one_click_installations(status)`);
    }
};
const ensureServerGeolocationColumns = () => {
    const additions = [
        { name: 'country_code', sql: 'ALTER TABLE servers ADD COLUMN country_code TEXT;' },
        { name: 'org', sql: 'ALTER TABLE servers ADD COLUMN org TEXT;' },
        { name: 'timezone', sql: 'ALTER TABLE servers ADD COLUMN timezone TEXT;' },
    ];
    additions.forEach(({ name, sql }) => {
        if (!columnExists('servers', name)) {
            exports.db.exec(sql);
        }
    });
};
const ensureStagingEnvironmentsColumns = () => {
    // Ensure docker_stacks has staging environment columns
    const stackAdditions = [
        { name: 'environment_type', sql: "ALTER TABLE docker_stacks ADD COLUMN environment_type TEXT DEFAULT 'production';" },
        { name: 'parent_stack_id', sql: 'ALTER TABLE docker_stacks ADD COLUMN parent_stack_id TEXT REFERENCES docker_stacks(id) ON DELETE SET NULL;' },
        { name: 'subdomain_prefix', sql: 'ALTER TABLE docker_stacks ADD COLUMN subdomain_prefix TEXT;' },
        { name: 'auto_deploy_rules', sql: 'ALTER TABLE docker_stacks ADD COLUMN auto_deploy_rules TEXT;' },
        { name: 'ttl_days', sql: 'ALTER TABLE docker_stacks ADD COLUMN ttl_days INTEGER;' },
        { name: 'last_activity_at', sql: 'ALTER TABLE docker_stacks ADD COLUMN last_activity_at INTEGER;' },
    ];
    stackAdditions.forEach(({ name, sql }) => {
        if (!columnExists('docker_stacks', name)) {
            console.log(`[Schema fixup] Adding missing column: docker_stacks.${name}`);
            exports.db.exec(sql);
        }
    });
    // Ensure domains has is_primary column
    if (!columnExists('domains', 'is_primary')) {
        console.log('[Schema fixup] Adding missing column: domains.is_primary');
        exports.db.exec('ALTER TABLE domains ADD COLUMN is_primary INTEGER DEFAULT 0;');
    }
    // Create indexes if they don't exist
    exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_docker_stacks_parent ON docker_stacks(parent_stack_id) WHERE parent_stack_id IS NOT NULL`);
    exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_docker_stacks_env_type ON docker_stacks(environment_type) WHERE environment_type != 'production'`);
};
const ensureS3BackupTables = () => {
    const tableExists = (name) => exports.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!tableExists('backup_storage_configs')) {
        console.log('[Schema fixup] Creating missing backup_storage_configs table');
        exports.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_storage_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN (
          'aws', 'backblaze', 'wasabi', 'minio', 'r2',
          'do_spaces', 'vultr', 'hetzner', 'custom'
        )),
        bucket TEXT NOT NULL,
        region TEXT,
        endpoint TEXT,
        path_prefix TEXT NOT NULL DEFAULT 'servercompass-backups',
        encrypted_credentials BLOB NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        last_tested_at INTEGER,
        last_test_success INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_storage_default ON backup_storage_configs(is_default)`);
    }
    if (!tableExists('app_backup_schedules')) {
        console.log('[Schema fixup] Creating missing app_backup_schedules table');
        exports.db.exec(`
      CREATE TABLE IF NOT EXISTS app_backup_schedules (
        id TEXT PRIMARY KEY DEFAULT 'app-config',
        storage_config_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly', 'monthly')),
        time TEXT NOT NULL DEFAULT '02:00',
        day_of_week INTEGER CHECK(day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
        day_of_month INTEGER CHECK(day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)),
        timezone TEXT NOT NULL DEFAULT 'UTC',
        retention_count INTEGER NOT NULL DEFAULT 30,
        last_run_at INTEGER,
        last_run_status TEXT CHECK(last_run_status IS NULL OR last_run_status IN ('success', 'failed', 'partial', 'cancelled', 'blocked')),
        last_run_error TEXT,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (storage_config_id) REFERENCES backup_storage_configs(id) ON DELETE SET NULL
      )
    `);
        exports.db.exec(`INSERT OR IGNORE INTO app_backup_schedules (id, created_at, updated_at) VALUES ('app-config', ${Date.now()}, ${Date.now()})`);
    }
    if (!tableExists('server_backup_configs')) {
        console.log('[Schema fixup] Creating missing server_backup_configs table');
        exports.db.exec(`
      CREATE TABLE IF NOT EXISTS server_backup_configs (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL UNIQUE,
        storage_config_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly', 'monthly')),
        time TEXT NOT NULL DEFAULT '03:00',
        day_of_week INTEGER CHECK(day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
        day_of_month INTEGER CHECK(day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)),
        timezone TEXT NOT NULL DEFAULT 'UTC',
        retention_count INTEGER NOT NULL DEFAULT 7,
        backup_volumes INTEGER NOT NULL DEFAULT 1,
        backup_databases INTEGER NOT NULL DEFAULT 1,
        backup_compose_files INTEGER NOT NULL DEFAULT 1,
        backup_env_files INTEGER NOT NULL DEFAULT 1,
        backup_ssl_certs INTEGER NOT NULL DEFAULT 0,
        backup_cron_jobs INTEGER NOT NULL DEFAULT 0,
        stop_containers_for_consistency INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_run_status TEXT CHECK(last_run_status IS NULL OR last_run_status IN ('success', 'failed', 'partial', 'cancelled', 'blocked')),
        last_run_error TEXT,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (storage_config_id) REFERENCES backup_storage_configs(id) ON DELETE SET NULL
      )
    `);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_server_backup_server ON server_backup_configs(server_id)`);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_server_backup_next_run ON server_backup_configs(next_run_at) WHERE enabled = 1`);
    }
    if (!tableExists('server_backup_exclusions')) {
        console.log('[Schema fixup] Creating missing server_backup_exclusions table');
        exports.db.exec(`
      CREATE TABLE IF NOT EXISTS server_backup_exclusions (
        id TEXT PRIMARY KEY,
        server_backup_config_id TEXT NOT NULL,
        exclusion_type TEXT NOT NULL CHECK(exclusion_type IN ('stack', 'volume', 'database')),
        exclusion_value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (server_backup_config_id) REFERENCES server_backup_configs(id) ON DELETE CASCADE
      )
    `);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_exclusions_config ON server_backup_exclusions(server_backup_config_id)`);
    }
    if (!tableExists('backup_jobs')) {
        console.log('[Schema fixup] Creating missing backup_jobs table');
        exports.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL CHECK(job_type IN ('app_config', 'server_data')),
        server_id TEXT,
        storage_config_id TEXT,
        storage_config_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
          'pending', 'running', 'success', 'failed', 'partial', 'cancelled'
        )),
        triggered_by TEXT NOT NULL DEFAULT 'manual' CHECK(triggered_by IN ('manual', 'scheduled')),
        started_at INTEGER,
        completed_at INTEGER,
        s3_key TEXT,
        s3_keys TEXT,
        file_size_bytes INTEGER,
        total_size_bytes INTEGER,
        manifest TEXT,
        error_message TEXT,
        warnings TEXT,
        progress_percent INTEGER DEFAULT 0,
        current_phase TEXT,
        current_item TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
        FOREIGN KEY (storage_config_id) REFERENCES backup_storage_configs(id) ON DELETE SET NULL
      )
    `);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_jobs_type ON backup_jobs(job_type)`);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_jobs_server ON backup_jobs(server_id) WHERE server_id IS NOT NULL`);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_jobs_status ON backup_jobs(status)`);
        exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_jobs_created ON backup_jobs(created_at DESC)`);
    }
};
exports.db = new Proxy({}, {
    get(_target, prop) {
        const database = initDatabase();
        const value = database[prop];
        return typeof value === 'function' ? value.bind(database) : value;
    }
});
// Migration runner
function runMigrations() {
    const migrations = [
        require('./migrations/001_initial_schema').default,
        require('./migrations/002_cron_metadata').default,
        require('./migrations/003_command_logs_output').default,
        require('./migrations/004_deployment_history').default,
        require('./migrations/005_database_management').default,
        require('./migrations/006_auto_deploy').default,
        require('./migrations/007_cron_metadata_extended').default,
        require('./migrations/008_licensing').default,
        require('./migrations/009_gumroad_fields').default,
        require('./migrations/010_lemonsqueezy_migration').default,
        require('./migrations/011_git_connection_status').default,
        require('./migrations/012_server_display_order').default,
        require('./migrations/013_package_installation_status').default,
        require('./migrations/014_git_multi_account').default,
        require('./migrations/015_ssh_key_content').default,
        require('./migrations/016_server_geolocation').default,
        require('./migrations/017_github_actions').default,
        require('./migrations/018_drop_auto_deploy_tables').default,
        require('./migrations/019_deployment_logs').default,
        require('./migrations/020_local_upload_support').default,
        require('./migrations/021_enhanced_docker_support').default,
        require('./migrations/022_docker_git_integration').default,
        require('./migrations/023_add_github_source_type').default,
        require('./migrations/024_add_recommended_port').default,
        require('./migrations/025_add_cms_category').default,
        require('./migrations/026_traefik_domains').default,
        require('./migrations/027_add_deployment_logs_column').default,
        require('./migrations/028_buildpack_generation').default,
        require('./migrations/029_app_type_categories').default,
        require('./migrations/030_add_domains_stack_id').default,
        require('./migrations/031_deployment_fallback').default,
        require('./migrations/032_add_rollback_triggered_by').default,
        require('./migrations/033_deployment_git_commit').default,
        require('./migrations/034_deployment_git_commit_title').default,
        require('./migrations/036_add_key_path').default,
        require('./migrations/037_domain_security_features').default,
        require('./migrations/038_add_nocode_category').default,
        require('./migrations/039_add_analytics_category').default,
        require('./migrations/040_add_extra_categories').default,
        require('./migrations/041_cron_job_id').default,
        require('./migrations/042_add_db_classification').default,
        require('./migrations/043_monitoring_alerts').default,
        require('./migrations/044_local_builds').default,
        require('./migrations/045_notification_channel_secrets').default,
        require('./migrations/046_add_parent_categories').default,
        require('./migrations/047_add_template_variables').default,
        require('./migrations/048_notification_events').default,
        require('./migrations/049_secret_vault').default,
        require('./migrations/050_one_click_installations').default,
        require('./migrations/051_favorite_paths').default,
        require('./migrations/052_backfill_domains_stack_id').default,
        require('./migrations/053_s3_backup_configuration').default,
        require('./migrations/054_add_staging_environments').default,
        require('./migrations/055_add_build_location').default,
        require('./migrations/056_backfill_build_location').default,
        require('./migrations/057_add_upload_source_type').default,
        require('./migrations/058_deployment_build_location').default,
        require('./migrations/059_normalize_stack_paths').default,
        require('./migrations/060_expand_environment_types').default,
        require('./migrations/061_server_migration').default,
        require('./migrations/062_migration_source_type').default,
    ];
    const currentVersion = exports.db.pragma('user_version', { simple: true });
    for (let i = currentVersion; i < migrations.length; i++) {
        console.log(`Running migration ${i + 1}...`);
        migrations[i](exports.db);
        exports.db.pragma(`user_version = ${i + 1}`);
    }
    // Ensure schema drift (e.g., missed migrations on older installs) is fixed up
    ensureServerGeolocationColumns();
    ensureOneClickInstallationsTable();
    ensureS3BackupTables();
    ensureStagingEnvironmentsColumns();
    console.log(`Database migrations complete. Current version: ${exports.db.pragma('user_version', { simple: true })}`);
}
// Helper functions
exports.queries = {
    // Server queries
    getAllServers: () => {
        return exports.db.prepare('SELECT * FROM servers ORDER BY display_order ASC, created_at DESC').all();
    },
    getServerById: (id) => {
        return exports.db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    },
    createServer: (server) => {
        const now = Date.now();
        // Get the max display_order and add 1 for new server
        const maxOrderResult = exports.db.prepare('SELECT MAX(display_order) as max FROM servers').get();
        const displayOrder = (maxOrderResult.max ?? 0) + 1;
        return exports.db.prepare(`
      INSERT INTO servers (
        id, name, host, port, auth_type, username,
        encrypted_secret, status, last_check_in, display_order, key_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(server.id, server.name, server.host, server.port, server.auth_type, server.username, server.encrypted_secret, server.status, server.last_check_in, displayOrder, server.key_path ?? null, now, now);
    },
    updateServer: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE servers
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteServer: (id) => {
        return exports.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    },
    reorderServers: (serverIdsInOrder) => {
        const stmt = exports.db.prepare('UPDATE servers SET display_order = ? WHERE id = ?');
        const transaction = exports.db.transaction((ids) => {
            ids.forEach((id, index) => {
                stmt.run(index + 1, id);
            });
        });
        transaction(serverIdsInOrder);
    },
    // Package installation status queries
    getPackageInstallationStatus: (serverId) => {
        const result = exports.db.prepare('SELECT packages_installed, packages_checked_at FROM servers WHERE id = ?')
            .get(serverId);
        if (!result)
            return null;
        return {
            packagesInstalled: result.packages_installed === 1,
            checkedAt: result.packages_checked_at,
        };
    },
    setPackageInstallationStatus: (serverId, installed) => {
        return exports.db.prepare(`
      UPDATE servers
      SET packages_installed = ?, packages_checked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(installed ? 1 : 0, Date.now(), Date.now(), serverId);
    },
    resetPackageInstallationStatus: (serverId) => {
        return exports.db.prepare(`
      UPDATE servers
      SET packages_installed = 0, packages_checked_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), serverId);
    },
    // Deployment queries
    getDeploymentsByServer: (serverId) => {
        return exports.db.prepare('SELECT * FROM deployments WHERE server_id = ? ORDER BY started_at DESC')
            .all(serverId);
    },
    getDeploymentsByApp: (serverId, appName) => {
        return exports.db.prepare('SELECT * FROM deployments WHERE server_id = ? AND app_name = ? ORDER BY started_at DESC')
            .all(serverId, appName);
    },
    getDeploymentById: (id) => {
        return exports.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);
    },
    // Get unique app names with their latest deployment info for a server
    getAppsFromDeployments: (serverId) => {
        return exports.db.prepare(`
      SELECT
        app_name,
        MAX(started_at) as latest_deployment_at,
        (SELECT status FROM deployments d2
         WHERE d2.server_id = ? AND d2.app_name = d1.app_name
         ORDER BY started_at DESC LIMIT 1) as latest_status,
        (SELECT port FROM deployments d2
         WHERE d2.server_id = ? AND d2.app_name = d1.app_name
         ORDER BY started_at DESC LIMIT 1) as port,
        (SELECT working_directory FROM deployments d2
         WHERE d2.server_id = ? AND d2.app_name = d1.app_name
         ORDER BY started_at DESC LIMIT 1) as working_directory
      FROM deployments d1
      WHERE server_id = ? AND app_name IS NOT NULL
      GROUP BY app_name
      ORDER BY latest_deployment_at DESC
    `).all(serverId, serverId, serverId, serverId);
    },
    createDeployment: (deployment) => {
        return exports.db.prepare(`
      INSERT INTO deployments (
        id, server_id, repo_url, branch, commit_hash,
        env_summary, status, started_at, finished_at, log_path,
        app_name, build_command, start_command, port, runtime,
        deployment_source, working_directory, source_type,
        local_upload_size, local_upload_file_count, git_linked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(deployment.id, deployment.server_id, deployment.repo_url, deployment.branch, deployment.commit_hash, deployment.env_summary, deployment.status, deployment.started_at, deployment.finished_at ?? null, deployment.log_path, deployment.app_name ?? null, deployment.build_command ?? null, deployment.start_command ?? null, deployment.port ?? null, deployment.runtime ?? null, deployment.deployment_source ?? 'manual', deployment.working_directory ?? null, deployment.source_type ?? 'git', deployment.local_upload_size ?? null, deployment.local_upload_file_count ?? null, deployment.git_linked_at ?? null);
    },
    updateDeployment: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE deployments
      SET ${setClause}
      WHERE id = ?
    `).run(...values, id);
    },
    updateDeploymentLogs: (id, logs, errorMessage, logLineCount) => {
        return exports.db.prepare(`
      UPDATE deployments
      SET logs = ?, error_message = ?, log_line_count = ?
      WHERE id = ?
    `).run(logs, errorMessage ?? null, logLineCount ?? 0, id);
    },
    // Get apps deployed from local uploads
    getLocalApps: (serverId) => {
        return exports.db.prepare(`
      SELECT DISTINCT
        app_name,
        MAX(started_at) as latest_deployment_at,
        (SELECT source_type FROM deployments d2
         WHERE d2.server_id = ? AND d2.app_name = d1.app_name
         ORDER BY started_at DESC LIMIT 1) as source_type,
        (SELECT local_upload_size FROM deployments d2
         WHERE d2.server_id = ? AND d2.app_name = d1.app_name
         ORDER BY started_at DESC LIMIT 1) as local_upload_size,
        (SELECT local_upload_file_count FROM deployments d2
         WHERE d2.server_id = ? AND d2.app_name = d1.app_name
         ORDER BY started_at DESC LIMIT 1) as local_upload_file_count
      FROM deployments d1
      WHERE server_id = ? AND app_name IS NOT NULL AND source_type IN ('local', 'local-git-linked')
      GROUP BY app_name
      ORDER BY latest_deployment_at DESC
    `).all(serverId, serverId, serverId, serverId);
    },
    // Update app source type (used when linking Git to local app)
    updateAppSourceType: (serverId, appName, sourceType, gitLinkedAt) => {
        return exports.db.prepare(`
      UPDATE deployments
      SET source_type = ?, git_linked_at = ?
      WHERE server_id = ? AND app_name = ? AND id = (
        SELECT id FROM deployments
        WHERE server_id = ? AND app_name = ?
        ORDER BY started_at DESC
        LIMIT 1
      )
    `).run(sourceType, gitLinkedAt ?? null, serverId, appName, serverId, appName);
    },
    // Get latest deployment for an app
    getLatestDeploymentForApp: (serverId, appName) => {
        return exports.db.prepare(`
      SELECT * FROM deployments
      WHERE server_id = ? AND app_name = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(serverId, appName);
    },
    // Delete all app-related data (deployments, git bindings, github actions config)
    deleteAppData: (serverId, appName) => {
        // Delete deployments
        exports.db.prepare('DELETE FROM deployments WHERE server_id = ? AND app_name = ?')
            .run(serverId, appName);
        // Delete git bindings (from migration 014)
        exports.db.prepare('DELETE FROM app_git_bindings WHERE server_id = ? AND app_name = ?')
            .run(serverId, appName);
        // Delete GitHub Actions config (from migration 017)
        exports.db.prepare('DELETE FROM github_actions_config WHERE server_id = ? AND app_name = ?')
            .run(serverId, appName);
        console.log(`Deleted all data for app: ${appName} on server: ${serverId}`);
    },
    // Command queries
    createCommand: (command) => {
        return exports.db.prepare(`
      INSERT INTO commands (id, server_id, command, executed_at, exit_code, stdout, stderr)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(command.id, command.server_id, command.command, command.executed_at, command.exit_code, command.stdout, command.stderr);
    },
    getCommandsByServer: (serverId, limit = 100) => {
        return exports.db.prepare('SELECT * FROM commands WHERE server_id = ? ORDER BY executed_at DESC LIMIT ?')
            .all(serverId, limit);
    },
    getCommandsSize: (serverId) => {
        // Calculate total size in bytes
        const query = serverId
            ? 'SELECT SUM(LENGTH(command) + COALESCE(LENGTH(stdout), 0) + COALESCE(LENGTH(stderr), 0)) as total FROM commands WHERE server_id = ?'
            : 'SELECT SUM(LENGTH(command) + COALESCE(LENGTH(stdout), 0) + COALESCE(LENGTH(stderr), 0)) as total FROM commands';
        const result = serverId
            ? exports.db.prepare(query).get(serverId)
            : exports.db.prepare(query).get();
        return result.total || 0;
    },
    deleteOldestCommands: (serverId, count) => {
        return exports.db.prepare(`
      DELETE FROM commands
      WHERE id IN (
        SELECT id FROM commands
        WHERE server_id = ?
        ORDER BY executed_at ASC
        LIMIT ?
      )
    `).run(serverId, count);
    },
    deleteAllCommands: (serverId) => {
        return exports.db.prepare('DELETE FROM commands WHERE server_id = ?').run(serverId);
    },
    // Database queries
    getDatabasesByServer: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM databases
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId);
    },
    getDatabaseById: (id) => {
        return exports.db.prepare(`
      SELECT * FROM databases
      WHERE id = ?
    `).get(id);
    },
    createDatabase: (database) => {
        const createdAt = database.created_at ?? Date.now();
        const updatedAt = database.updated_at ?? createdAt;
        return exports.db.prepare(`
      INSERT INTO databases (
        id, server_id, name, type, status, access, version,
        encrypted_credentials, metadata, stats, last_error,
        provision_duration_ms, last_operation_id, created_at,
        updated_at, last_activity_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(database.id, database.server_id, database.name, database.type, database.status, database.access, database.version ?? null, database.encrypted_credentials ?? null, database.metadata ?? null, database.stats ?? null, database.last_error ?? null, database.provision_duration_ms ?? null, database.last_operation_id ?? null, createdAt, updatedAt, database.last_activity_at ?? null);
    },
    updateDatabase: (id, updates) => {
        const keys = Object.keys(updates);
        if (keys.length === 0) {
            return;
        }
        const setFragments = keys.map((key) => `${key} = ?`);
        const values = keys.map((key) => updates[key]);
        return exports.db.prepare(`
      UPDATE databases
      SET ${setFragments.join(', ')}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteDatabase: (id) => {
        return exports.db.prepare(`
      DELETE FROM databases
      WHERE id = ?
    `).run(id);
    },
    createDatabaseOperation: (operation) => {
        return exports.db.prepare(`
      INSERT INTO database_operations (
        id, database_id, server_id, type, status,
        started_at, finished_at, progress, summary,
        meta, error_message, log
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(operation.id, operation.database_id ?? null, operation.server_id, operation.type, operation.status, operation.started_at, operation.finished_at ?? null, operation.progress ?? null, operation.summary ?? null, operation.meta ?? null, operation.error_message ?? null, operation.log ?? null);
    },
    updateDatabaseOperation: (id, updates) => {
        const keys = Object.keys(updates);
        if (keys.length === 0) {
            return;
        }
        const setFragments = keys.map((key) => `${key} = ?`);
        const values = keys.map((key) => updates[key]);
        return exports.db.prepare(`
      UPDATE database_operations
      SET ${setFragments.join(', ')}
      WHERE id = ?
    `).run(...values, id);
    },
    getDatabaseOperationById: (id) => {
        return exports.db.prepare(`
      SELECT * FROM database_operations
      WHERE id = ?
    `).get(id);
    },
    getDatabaseOperationsByDatabase: (databaseId, limit = 50) => {
        return exports.db.prepare(`
      SELECT * FROM database_operations
      WHERE database_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(databaseId, limit);
    },
    getLatestDatabaseOperationForServer: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM database_operations
      WHERE server_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(serverId);
    },
    // Settings queries
    getSetting: (key) => {
        return exports.db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    },
    setSetting: (key, value) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
    `).run(key, value, now, value, now);
    },
    getAllSettings: () => {
        return exports.db.prepare('SELECT * FROM settings').all();
    },
    // Git connection status queries
    getGitConnectionStatus: (serverId) => {
        return exports.db.prepare('SELECT * FROM git_connection_status WHERE server_id = ?').get(serverId);
    },
    saveGitConnectionStatus: (status) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO git_connection_status (server_id, is_configured, username, key_path, raw_output, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        is_configured = ?,
        username = ?,
        key_path = ?,
        raw_output = ?,
        last_checked_at = ?
    `).run(status.serverId, status.isConfigured ? 1 : 0, status.username ?? null, status.keyPath ?? null, status.rawOutput ?? null, now, status.isConfigured ? 1 : 0, status.username ?? null, status.keyPath ?? null, status.rawOutput ?? null, now);
    },
    deleteGitConnectionStatus: (serverId) => {
        return exports.db.prepare('DELETE FROM git_connection_status WHERE server_id = ?').run(serverId);
    },
    // Docker Compose queries
    getDockerComposeDeployments: () => {
        return exports.db.prepare(`
      SELECT * FROM docker_compose_deployments
      ORDER BY created_at DESC
    `).all();
    },
    getDockerComposeDeploymentsByServer: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM docker_compose_deployments
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId);
    },
    getDockerComposeDeployment: (id) => {
        return exports.db.prepare(`
      SELECT * FROM docker_compose_deployments
      WHERE id = ?
    `).get(id);
    },
    createDockerComposeDeployment: (deployment) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_compose_deployments (
        id, server_id, project_name, compose_file_content, compose_file_path,
        registry_type, registry_url, registry_username, encrypted_registry_password,
        auto_deploy, webhook_secret, last_deployed_at, deployment_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(deployment.id, deployment.server_id, deployment.project_name, deployment.compose_file_content, deployment.compose_file_path || null, deployment.registry_type || null, deployment.registry_url || null, deployment.registry_username || null, deployment.encrypted_registry_password || null, deployment.auto_deploy || 0, deployment.webhook_secret || null, deployment.last_deployed_at || now, deployment.deployment_status || 'pending', deployment.created_at || now, deployment.updated_at || now);
    },
    updateDockerComposeDeployment: (id, updates) => {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
        values.push(Date.now()); // updated_at
        values.push(id);
        return exports.db.prepare(`
      UPDATE docker_compose_deployments
      SET ${fields.join(', ')}, updated_at = ?
      WHERE id = ?
    `).run(...values);
    },
    deleteDockerComposeDeployment: (id) => {
        return exports.db.prepare('DELETE FROM docker_compose_deployments WHERE id = ?').run(id);
    },
    // Docker container queries
    getDockerContainers: (deploymentId) => {
        return exports.db.prepare(`
      SELECT * FROM docker_compose_containers
      WHERE deployment_id = ?
      ORDER BY service_name
    `).all(deploymentId);
    },
    saveDockerContainers: (deploymentId, containers) => {
        // Clear existing containers
        exports.db.prepare('DELETE FROM docker_compose_containers WHERE deployment_id = ?').run(deploymentId);
        // Insert new containers
        const stmt = exports.db.prepare(`
      INSERT INTO docker_compose_containers (
        id, deployment_id, service_name, container_id, container_name,
        image, state, status, health, ports, cpu_percent, memory_usage,
        memory_limit, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        for (const container of containers) {
            stmt.run(container.id, deploymentId, container.service_name, container.container_id, container.container_name, container.image, container.state, container.status, container.health, container.ports, container.cpu_percent, container.memory_usage, container.memory_limit, Date.now());
        }
    },
    // ============================================
    // Docker Stack queries (enhanced Docker support)
    // ============================================
    // Docker Stacks
    getDockerStacks: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM docker_stacks
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId);
    },
    getDockerStackById: (id) => {
        return exports.db.prepare('SELECT * FROM docker_stacks WHERE id = ?').get(id);
    },
    getDockerStackByProjectName: (serverId, projectName) => {
        return exports.db.prepare(`
      SELECT * FROM docker_stacks
      WHERE server_id = ? AND project_name = ?
    `).get(serverId, projectName);
    },
    createDockerStack: (stack) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_stacks (
        id, server_id, project_name, source_type, template_id,
        compose_content, dockerfile_content, env_vars, stack_path,
        registry_credential_id, build_on_deploy, pull_policy, status,
        last_deployed_at, last_error, services_count, ci_enabled,
        webhook_secret, webhook_url, current_image_digest, last_webhook_at,
        github_repo, git_account_id, git_branch, git_clone_path, git_pull_on_redeploy,
        git_last_commit, generation_method, generation_config, nixpacks_version,
        has_pending_failure, last_successful_deployment_id, failed_compose_content,
        environment_type, parent_stack_id, subdomain_prefix, auto_deploy_rules,
        ttl_days, last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(stack.id, stack.server_id, stack.project_name, stack.source_type, stack.template_id, stack.compose_content, stack.dockerfile_content, stack.env_vars, stack.stack_path, stack.registry_credential_id, stack.build_on_deploy, stack.pull_policy, stack.status, stack.last_deployed_at, stack.last_error, stack.services_count, stack.ci_enabled || 0, stack.webhook_secret, stack.webhook_url, stack.current_image_digest, stack.last_webhook_at, stack.github_repo, stack.git_account_id, stack.git_branch, stack.git_clone_path, stack.git_pull_on_redeploy, stack.git_last_commit, stack.generation_method, stack.generation_config, stack.nixpacks_version, stack.has_pending_failure, stack.last_successful_deployment_id, stack.failed_compose_content, stack.environment_type, stack.parent_stack_id, stack.subdomain_prefix, stack.auto_deploy_rules, stack.ttl_days, stack.last_activity_at, now, now);
    },
    updateDockerStack: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE docker_stacks
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteDockerStack: (id) => {
        return exports.db.prepare('DELETE FROM docker_stacks WHERE id = ?').run(id);
    },
    /**
     * Update stack with generation metadata (buildpack/nixpacks info)
     */
    updateStackGenerationMetadata: (stackId, metadata) => {
        return exports.db.prepare(`
      UPDATE docker_stacks
      SET generation_method = ?,
          generation_config = ?,
          nixpacks_version = ?,
          updated_at = ?
      WHERE id = ?
    `).run(metadata.generation_method, metadata.generation_config || null, metadata.nixpacks_version || null, Date.now(), stackId);
    },
    /**
     * Get statistics on generation methods used
     */
    getGenerationMethodStats: (serverId) => {
        let sql = `
      SELECT
        generation_method,
        COUNT(*) as count
      FROM docker_stacks
    `;
        if (serverId) {
            sql += ` WHERE server_id = ?`;
        }
        sql += ` GROUP BY generation_method`;
        const stmt = exports.db.prepare(sql);
        return (serverId ? stmt.all(serverId) : stmt.all());
    },
    // Docker Stack Deployments (history)
    getDockerStackDeployments: (stackId, limit = 50) => {
        return exports.db.prepare(`
      SELECT * FROM docker_stack_deployments
      WHERE stack_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(stackId, limit);
    },
    // Get all deployments for a server (across all stacks) with stack info
    getDockerDeploymentsByServer: (serverId, limit = 50) => {
        return exports.db.prepare(`
      SELECT d.*, s.project_name, s.source_type
      FROM docker_stack_deployments d
      JOIN docker_stacks s ON d.stack_id = s.id
      WHERE s.server_id = ?
      ORDER BY d.started_at DESC
      LIMIT ?
    `).all(serverId, limit);
    },
    // Get a single deployment by ID
    getDockerStackDeploymentById: (deploymentId) => {
        return exports.db.prepare(`
      SELECT d.*, s.project_name, s.source_type
      FROM docker_stack_deployments d
      JOIN docker_stacks s ON d.stack_id = s.id
      WHERE d.id = ?
    `).get(deploymentId);
    },
    createDockerStackDeployment: (deployment) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_stack_deployments (
        id, stack_id, triggered_by, started_at, finished_at, status,
        pull_output, build_output, up_output, error_message,
        deployed_images, previous_compose_content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(deployment.id, deployment.stack_id, deployment.triggered_by, deployment.started_at, deployment.finished_at, deployment.status, deployment.pull_output, deployment.build_output, deployment.up_output, deployment.error_message, deployment.deployed_images, deployment.previous_compose_content, now);
    },
    updateDockerStackDeployment: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE docker_stack_deployments
      SET ${setClause}
      WHERE id = ?
    `).run(...values, id);
    },
    // Docker Registry Credentials
    getDockerRegistryCredentials: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM docker_registry_credentials
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId);
    },
    getDockerRegistryCredentialById: (id) => {
        return exports.db.prepare('SELECT * FROM docker_registry_credentials WHERE id = ?')
            .get(id);
    },
    createDockerRegistryCredential: (cred) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_registry_credentials (
        id, server_id, type, name, url, username, encrypted_password,
        last_validated_at, is_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cred.id, cred.server_id, cred.type, cred.name, cred.url, cred.username, cred.encrypted_password, cred.last_validated_at, cred.is_valid, now, now);
    },
    updateDockerRegistryCredential: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE docker_registry_credentials
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteDockerRegistryCredential: (id) => {
        return exports.db.prepare('DELETE FROM docker_registry_credentials WHERE id = ?').run(id);
    },
    // Docker Proxy Configs
    getDockerProxyConfigs: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM docker_proxy_configs
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId);
    },
    getDockerProxyConfigByDomain: (serverId, domain) => {
        return exports.db.prepare(`
      SELECT * FROM docker_proxy_configs
      WHERE server_id = ? AND domain = ?
    `).get(serverId, domain);
    },
    createDockerProxyConfig: (config) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_proxy_configs (
        id, server_id, stack_id, domain, target_port, proxy_type,
        ssl_enabled, ssl_certificate_path, ssl_expires_at, ssl_email,
        custom_config, status, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(config.id, config.server_id, config.stack_id, config.domain, config.target_port, config.proxy_type, config.ssl_enabled, config.ssl_certificate_path, config.ssl_expires_at, config.ssl_email, config.custom_config, config.status, config.last_error, now, now);
    },
    updateDockerProxyConfig: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE docker_proxy_configs
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteDockerProxyConfig: (id) => {
        return exports.db.prepare('DELETE FROM docker_proxy_configs WHERE id = ?').run(id);
    },
    // PM2 Migrations
    getPM2Migrations: (serverId) => {
        return exports.db.prepare(`
      SELECT * FROM pm2_migrations
      WHERE server_id = ?
      ORDER BY created_at DESC
    `).all(serverId);
    },
    getPM2MigrationById: (id) => {
        return exports.db.prepare('SELECT * FROM pm2_migrations WHERE id = ?').get(id);
    },
    createPM2Migration: (migration) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO pm2_migrations (
        id, server_id, pm2_app_name, pm2_config, stack_id, migration_status,
        pm2_stopped_at, docker_started_at, health_check_passed, error_message,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(migration.id, migration.server_id, migration.pm2_app_name, migration.pm2_config, migration.stack_id, migration.migration_status, migration.pm2_stopped_at, migration.docker_started_at, migration.health_check_passed, migration.error_message, now, migration.completed_at);
    },
    updatePM2Migration: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE pm2_migrations
      SET ${setClause}
      WHERE id = ?
    `).run(...values, id);
    },
    // Docker Compose Templates
    getDockerComposeTemplates: (category) => {
        if (category) {
            return exports.db.prepare(`
        SELECT * FROM docker_compose_templates
        WHERE category = ?
        ORDER BY name ASC
      `).all(category);
        }
        return exports.db.prepare(`
      SELECT * FROM docker_compose_templates
      ORDER BY category, name ASC
    `).all();
    },
    getDockerComposeTemplateById: (id) => {
        return exports.db.prepare('SELECT * FROM docker_compose_templates WHERE id = ?')
            .get(id);
    },
    createDockerComposeTemplate: (template) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_compose_templates (
        id, name, description, category, compose_content, dockerfile_content,
        env_hints, documentation, min_memory_mb, icon, recommended_port,
        app_type, subcategory, requires_build, volume_hints, ports_hints,
        is_builtin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(template.id, template.name, template.description, template.category, template.compose_content, template.dockerfile_content, template.env_hints, template.documentation, template.min_memory_mb, template.icon, template.recommended_port ?? null, template.app_type ?? 'app', template.subcategory ?? null, template.requires_build ?? 0, template.volume_hints ?? null, template.ports_hints ?? null, template.is_builtin, now, now);
    },
    upsertDockerComposeTemplate: (template) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO docker_compose_templates (
        id, name, description, category, compose_content, dockerfile_content,
        env_hints, documentation, min_memory_mb, icon, recommended_port,
        app_type, subcategory, requires_build, volume_hints, ports_hints,
        is_builtin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        category = excluded.category,
        compose_content = excluded.compose_content,
        dockerfile_content = excluded.dockerfile_content,
        env_hints = excluded.env_hints,
        documentation = excluded.documentation,
        min_memory_mb = excluded.min_memory_mb,
        icon = excluded.icon,
        recommended_port = excluded.recommended_port,
        app_type = excluded.app_type,
        subcategory = excluded.subcategory,
        requires_build = excluded.requires_build,
        volume_hints = excluded.volume_hints,
        ports_hints = excluded.ports_hints,
        is_builtin = excluded.is_builtin,
        updated_at = excluded.updated_at
    `).run(template.id, template.name, template.description, template.category, template.compose_content, template.dockerfile_content, template.env_hints, template.documentation, template.min_memory_mb, template.icon, template.recommended_port ?? null, template.app_type ?? 'app', template.subcategory ?? null, template.requires_build ?? 0, template.volume_hints ?? null, template.ports_hints ?? null, template.is_builtin, now, now);
    },
    updateDockerComposeTemplate: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at' && k !== 'is_builtin');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE docker_compose_templates
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteDockerComposeTemplate: (id) => {
        return exports.db.prepare('DELETE FROM docker_compose_templates WHERE id = ?').run(id);
    },
    // Alias functions for consistent naming
    getDockerStack: (id) => {
        return exports.db.prepare('SELECT * FROM docker_stacks WHERE id = ?').get(id);
    },
    getDockerRegistryCredential: (id) => {
        return exports.db.prepare('SELECT * FROM docker_registry_credentials WHERE id = ?')
            .get(id);
    },
    getDockerComposeTemplate: (id) => {
        return exports.db.prepare('SELECT * FROM docker_compose_templates WHERE id = ?')
            .get(id);
    },
    // Domain queries
    createDomain: (domain) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO domains (
        id, server_id, deployment_id, stack_id, domain, port, ssl_enabled,
        https_redirect, www_redirect, certificate_resolver, router_name,
        entrypoints, middlewares, custom_headers, dns_verified,
        certificate_status, last_certificate_check, proxy_type,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(domain.id, domain.server_id, domain.deployment_id, domain.stack_id, domain.domain, domain.port, domain.ssl_enabled, domain.https_redirect, domain.www_redirect, domain.certificate_resolver, domain.router_name, domain.entrypoints, domain.middlewares, domain.custom_headers, domain.dns_verified, domain.certificate_status, domain.last_certificate_check, domain.proxy_type, now, now);
    },
    getDomain: (id) => {
        return exports.db.prepare('SELECT * FROM domains WHERE id = ?').get(id);
    },
    getDomainsByServer: (serverId) => {
        return exports.db.prepare('SELECT * FROM domains WHERE server_id = ? ORDER BY created_at DESC')
            .all(serverId);
    },
    getDomainsByDeployment: (deploymentId) => {
        return exports.db.prepare('SELECT * FROM domains WHERE deployment_id = ? ORDER BY created_at DESC')
            .all(deploymentId);
    },
    getDomainByDomainName: (domain, serverId) => {
        return exports.db.prepare('SELECT * FROM domains WHERE domain = ? AND server_id = ?')
            .get(domain, serverId);
    },
    updateDomain: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE domains
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteDomain: (id) => {
        return exports.db.prepare('DELETE FROM domains WHERE id = ?').run(id);
    },
    checkDomainExists: (domain, serverId) => {
        const result = exports.db.prepare('SELECT id FROM domains WHERE domain = ? AND server_id = ?')
            .get(domain, serverId);
        return !!result;
    },
    // Domain redirect queries
    createRedirect: (redirect) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO domain_redirects (
        id, domain_id, source_domain, target_domain, redirect_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(redirect.id, redirect.domain_id, redirect.source_domain, redirect.target_domain, redirect.redirect_type, now);
    },
    getRedirectsByDomain: (domainId) => {
        return exports.db.prepare('SELECT * FROM domain_redirects WHERE domain_id = ?')
            .all(domainId);
    },
    deleteRedirectsByDomain: (domainId) => {
        return exports.db.prepare('DELETE FROM domain_redirects WHERE domain_id = ?').run(domainId);
    },
    // Secret Vault queries
    getAllSecretCollections: () => {
        return exports.db.prepare('SELECT * FROM secret_collections ORDER BY updated_at DESC').all();
    },
    getSecretCollectionById: (id) => {
        return exports.db.prepare('SELECT * FROM secret_collections WHERE id = ?').get(id);
    },
    createSecretCollection: (collection) => {
        return exports.db.prepare(`
      INSERT INTO secret_collections (
        id, name, description, tags, encrypted_data, secret_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(collection.id, collection.name, collection.description, collection.tags, collection.encrypted_data, collection.secret_count, collection.created_at, collection.updated_at);
    },
    updateSecretCollection: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'created_at');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE secret_collections
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteSecretCollection: (id) => {
        return exports.db.prepare('DELETE FROM secret_collections WHERE id = ?').run(id);
    },
    // Favorite Paths queries
    getFavoritePathsByServer: (serverId) => {
        return exports.db.prepare('SELECT * FROM favorite_paths WHERE server_id = ? ORDER BY display_order ASC, created_at ASC').all(serverId);
    },
    createFavoritePath: (fav) => {
        const now = Date.now();
        return exports.db.prepare(`
      INSERT INTO favorite_paths (id, server_id, name, path, display_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fav.id, fav.server_id, fav.name, fav.path, fav.display_order, now, now);
    },
    updateFavoritePath: (id, updates) => {
        const fields = Object.keys(updates).filter(k => k !== 'id');
        if (fields.length === 0)
            return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => updates[f]);
        return exports.db.prepare(`
      UPDATE favorite_paths
      SET ${setClause}, updated_at = ?
      WHERE id = ?
    `).run(...values, Date.now(), id);
    },
    deleteFavoritePath: (id) => {
        return exports.db.prepare('DELETE FROM favorite_paths WHERE id = ?').run(id);
    },
};
exports.default = exports.db;
//# sourceMappingURL=index.js.map