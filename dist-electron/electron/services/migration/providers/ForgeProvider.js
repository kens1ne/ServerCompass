"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForgeProvider = void 0;
const crypto_1 = require("crypto");
const BaseProvider_1 = require("./BaseProvider");
class ForgeProvider extends BaseProvider_1.BaseProvider {
    providerId = 'forge';
    displayName = 'Laravel Forge';
    description = 'Laravel Forge server management with daemon and /home/forge/ structure';
    // ─── Detection ───────────────────────────────────────────────────
    async detect(serverId, sshService) {
        const [daemonActive, forgeHomeExists] = await Promise.all([
            this.isServiceActive(serverId, sshService, 'forge-daemon'),
            this.pathExists(serverId, sshService, '/home/forge/'),
        ]);
        let confidence = 0;
        const metadata = {
            daemonActive,
            forgeHomeExists,
        };
        if (daemonActive && forgeHomeExists) {
            confidence = 1.0;
        }
        else if (daemonActive) {
            confidence = 0.7;
        }
        else if (forgeHomeExists) {
            confidence = 0.5;
        }
        // Try to get daemon version or Forge marker
        if (confidence > 0) {
            const forgeVersion = await this.safeExec(serverId, sshService, 'cat /home/forge/.forge/provision-version 2>/dev/null || echo ""');
            if (forgeVersion) {
                metadata.provisionVersion = forgeVersion.trim();
            }
        }
        return {
            provider: 'forge',
            version: metadata.provisionVersion ?? null,
            confidence,
            metadata,
        };
    }
    // ─── Scan ────────────────────────────────────────────────────────
    async scan(ctx) {
        const items = [];
        const phases = [
            { id: 'nginx_sites', label: 'Nginx Sites', status: 'pending', itemsFound: 0 },
            { id: 'pm2_apps', label: 'PM2 Apps', status: 'pending', itemsFound: 0 },
            { id: 'supervisor', label: 'Supervisor Programs', status: 'pending', itemsFound: 0 },
            { id: 'databases', label: 'Databases', status: 'pending', itemsFound: 0 },
            { id: 'cron_jobs', label: 'Cron Jobs', status: 'pending', itemsFound: 0 },
            { id: 'ssl_certs', label: 'SSL Certificates', status: 'pending', itemsFound: 0 },
        ];
        const emit = (phaseId, message) => {
            ctx.emitProgress({
                migrationId: ctx.migrationId,
                serverId: ctx.serverId,
                provider: 'forge',
                phase: phaseId,
                phases,
                message,
                totalItemsFound: items.length,
            });
        };
        // Phase 1: Nginx sites (standard path)
        try {
            this.setPhaseStatus(phases, 'nginx_sites', 'running');
            emit('nginx_sites', 'Scanning Forge nginx sites...');
            const siteFiles = await this.safeExec(ctx.serverId, ctx.sshService, 'ls -1 /etc/nginx/sites-enabled/ 2>/dev/null');
            if (siteFiles) {
                for (const filename of siteFiles.split('\n').filter(Boolean)) {
                    const trimmedFilename = filename.trim();
                    if (!trimmedFilename || trimmedFilename === 'default')
                        continue;
                    const content = await this.safeExec(ctx.serverId, ctx.sshService, `cat /etc/nginx/sites-enabled/${trimmedFilename} 2>/dev/null`);
                    if (!content)
                        continue;
                    const serverNames = this.extractNginxDirective(content, 'server_name');
                    const proxyPass = this.extractNginxDirective(content, 'proxy_pass');
                    const root = this.extractNginxDirective(content, 'root');
                    const sslCert = this.extractNginxDirective(content, 'ssl_certificate');
                    const fastcgiPass = this.extractNginxDirective(content, 'fastcgi_pass');
                    const displayName = serverNames || trimmedFilename;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'nginx_site',
                        remoteKey: `forge:nginx:${trimmedFilename}`,
                        displayName,
                        description: proxyPass
                            ? `Reverse proxy to ${proxyPass}`
                            : root
                                ? `Serves from ${root}`
                                : 'Nginx site configuration',
                        payload: {
                            filename: trimmedFilename,
                            configPath: `/etc/nginx/sites-enabled/${trimmedFilename}`,
                            serverName: serverNames,
                            proxyPass,
                            root,
                            sslCertificate: sslCert,
                            fastcgiPass,
                            rawConfig: content,
                        },
                        providerSource: 'forge',
                        priority: 10,
                        dependsOn: [],
                    });
                }
            }
            const found = items.filter(i => i.remoteKey.startsWith('forge:nginx:')).length;
            this.setPhaseStatus(phases, 'nginx_sites', found > 0 ? 'completed' : 'skipped', found);
            emit('nginx_sites', found > 0 ? `Found ${found} nginx sites` : 'No nginx sites found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'nginx_sites', 'failed');
            emit('nginx_sites', `Failed to scan nginx sites: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 2: PM2 apps
        try {
            this.setPhaseStatus(phases, 'pm2_apps', 'running');
            emit('pm2_apps', 'Scanning PM2 apps...');
            const pm2CountBefore = items.length;
            const pm2Output = await this.safeExec(ctx.serverId, ctx.sshService, 'pm2 jlist 2>/dev/null');
            if (pm2Output) {
                try {
                    const apps = JSON.parse(pm2Output);
                    for (const app of apps) {
                        const env = app.pm2_env ?? {};
                        items.push({
                            id: (0, crypto_1.randomUUID)(),
                            itemType: 'pm2_app',
                            remoteKey: `pm2:${app.name}`,
                            displayName: `PM2: ${app.name}`,
                            description: `Status: ${env.status ?? 'unknown'}, CWD: ${env.pm_cwd ?? 'unknown'}`,
                            payload: {
                                name: app.name,
                                status: env.status,
                                cwd: env.pm_cwd,
                                interpreter: env.exec_interpreter,
                                script: env.pm_exec_path,
                                nodeVersion: env.node_version,
                                execMode: env.exec_mode,
                                instances: env.instances,
                                memory: app.monit?.memory,
                                cpu: app.monit?.cpu,
                            },
                            providerSource: 'forge',
                            priority: 15,
                            dependsOn: [],
                        });
                    }
                }
                catch {
                    // pm2 jlist returned non-JSON output, skip
                }
            }
            const pm2Count = items.length - pm2CountBefore;
            this.setPhaseStatus(phases, 'pm2_apps', pm2Count > 0 ? 'completed' : 'skipped', pm2Count);
            emit('pm2_apps', pm2Count > 0 ? `Found ${pm2Count} PM2 apps` : 'No PM2 apps found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'pm2_apps', 'failed');
            emit('pm2_apps', `Failed to scan PM2 apps: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 3: Supervisor programs
        try {
            this.setPhaseStatus(phases, 'supervisor', 'running');
            emit('supervisor', 'Scanning Supervisor programs...');
            const supCountBefore = items.length;
            const supOutput = await this.safeExec(ctx.serverId, ctx.sshService, 'supervisorctl status 2>/dev/null');
            if (supOutput) {
                for (const line of supOutput.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    // Format: "program_name    RUNNING   pid 12345, uptime 1:23:45"
                    // or:     "program_name    STOPPED   Not started"
                    const match = trimmed.match(/^(\S+)\s+(RUNNING|STOPPED|STARTING|FATAL|EXITED|BACKOFF|UNKNOWN)\s*(.*)/i);
                    if (!match)
                        continue;
                    const [, name, status, details] = match;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'systemd_service',
                        remoteKey: `supervisor:${name}`,
                        displayName: `Supervisor: ${name}`,
                        description: `Status: ${status}${details ? ` - ${details.trim()}` : ''}`,
                        payload: {
                            name,
                            manager: 'supervisor',
                            status: status.toLowerCase(),
                            details: details?.trim() || null,
                        },
                        providerSource: 'forge',
                        priority: 15,
                        dependsOn: [],
                    });
                }
            }
            const supCount = items.length - supCountBefore;
            this.setPhaseStatus(phases, 'supervisor', supCount > 0 ? 'completed' : 'skipped', supCount);
            emit('supervisor', supCount > 0 ? `Found ${supCount} Supervisor programs` : 'No Supervisor programs found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'supervisor', 'failed');
            emit('supervisor', `Failed to scan Supervisor programs: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 4: Databases (PostgreSQL + MySQL)
        try {
            this.setPhaseStatus(phases, 'databases', 'running');
            emit('databases', 'Scanning databases...');
            const dbCountBefore = items.length;
            // MySQL databases
            const mysqlDbs = await this.safeExec(ctx.serverId, ctx.sshService, "mysql -N -e \"SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema','mysql','performance_schema','sys','phpmyadmin')\" 2>/dev/null");
            if (mysqlDbs) {
                for (const db of mysqlDbs.split('\n').filter(Boolean)) {
                    const dbName = db.trim();
                    if (!dbName)
                        continue;
                    const sizeResult = await this.safeExec(ctx.serverId, ctx.sshService, `mysql -N -e "SELECT ROUND(SUM(data_length + index_length)) FROM information_schema.tables WHERE table_schema = '${dbName}'" 2>/dev/null`);
                    const sizeBytes = parseInt(sizeResult, 10) || 0;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'database',
                        remoteKey: `mysql:${dbName}`,
                        displayName: `MySQL: ${dbName}`,
                        description: sizeBytes > 0 ? `Size: ${this.formatBytes(sizeBytes)}` : 'MySQL database',
                        payload: { engine: 'mysql', name: dbName, sizeBytes },
                        providerSource: 'forge',
                        priority: 20,
                        dependsOn: [],
                        estimatedSize: sizeBytes,
                    });
                }
            }
            // PostgreSQL databases
            const pgDbs = await this.safeExec(ctx.serverId, ctx.sshService, "sudo -u postgres psql -t -A -c \"SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres')\" 2>/dev/null");
            if (pgDbs) {
                for (const db of pgDbs.split('\n').filter(Boolean)) {
                    const dbName = db.trim();
                    if (!dbName)
                        continue;
                    const sizeResult = await this.safeExec(ctx.serverId, ctx.sshService, `sudo -u postgres psql -t -A -c "SELECT pg_database_size('${dbName}')" 2>/dev/null`);
                    const sizeBytes = parseInt(sizeResult, 10) || 0;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'database',
                        remoteKey: `postgresql:${dbName}`,
                        displayName: `PostgreSQL: ${dbName}`,
                        description: sizeBytes > 0 ? `Size: ${this.formatBytes(sizeBytes)}` : 'PostgreSQL database',
                        payload: { engine: 'postgresql', name: dbName, sizeBytes },
                        providerSource: 'forge',
                        priority: 20,
                        dependsOn: [],
                        estimatedSize: sizeBytes,
                    });
                }
            }
            const dbCount = items.length - dbCountBefore;
            this.setPhaseStatus(phases, 'databases', dbCount > 0 ? 'completed' : 'skipped', dbCount);
            emit('databases', dbCount > 0 ? `Found ${dbCount} databases` : 'No databases found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'databases', 'failed');
            emit('databases', `Failed to scan databases: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 5: Cron jobs (filter out Forge-managed crons)
        try {
            this.setPhaseStatus(phases, 'cron_jobs', 'running');
            emit('cron_jobs', 'Scanning cron jobs...');
            const cronOutput = await this.safeExec(ctx.serverId, ctx.sshService, 'crontab -l 2>/dev/null');
            const cronCountBefore = items.length;
            if (cronOutput) {
                const forgePatterns = [
                    /forge/i,
                    /\/home\/forge\/\.forge\//i,
                    /\/home\/forge\/.*artisan schedule:run/i,
                ];
                for (const line of cronOutput.split('\n')) {
                    const trimmed = line.trim();
                    // Skip empty lines, comments, and Forge-managed crons
                    if (!trimmed || trimmed.startsWith('#'))
                        continue;
                    if (forgePatterns.some(p => p.test(trimmed)))
                        continue;
                    // Validate it looks like a cron entry (starts with a schedule pattern)
                    if (!/^[@*0-9]/.test(trimmed))
                        continue;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'cron_job',
                        remoteKey: `cron:root:${trimmed}`,
                        displayName: this.summarizeCron(trimmed),
                        description: trimmed,
                        payload: { user: 'root', schedule: trimmed, raw: trimmed },
                        providerSource: 'forge',
                        priority: 30,
                        dependsOn: [],
                    });
                }
            }
            const cronCount = items.length - cronCountBefore;
            this.setPhaseStatus(phases, 'cron_jobs', cronCount > 0 ? 'completed' : 'skipped', cronCount);
            emit('cron_jobs', cronCount > 0 ? `Found ${cronCount} cron jobs` : 'No user cron jobs found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'cron_jobs', 'failed');
            emit('cron_jobs', `Failed to scan cron jobs: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 6: SSL certificates
        try {
            this.setPhaseStatus(phases, 'ssl_certs', 'running');
            emit('ssl_certs', 'Scanning SSL certificates...');
            const sslCountBefore = items.length;
            const certDirs = await this.safeExec(ctx.serverId, ctx.sshService, 'ls /etc/letsencrypt/live/ 2>/dev/null');
            if (certDirs) {
                for (const dir of certDirs.split('\n').filter(Boolean)) {
                    const domain = dir.trim();
                    if (!domain || domain === 'README')
                        continue;
                    const expiryOutput = await this.safeExec(ctx.serverId, ctx.sshService, `openssl x509 -enddate -noout -in /etc/letsencrypt/live/${domain}/cert.pem 2>/dev/null`);
                    const expiry = expiryOutput.replace('notAfter=', '').trim() || null;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'ssl_certificate',
                        remoteKey: `ssl:letsencrypt:${domain}`,
                        displayName: `SSL: ${domain}`,
                        description: expiry ? `Expires: ${expiry}` : 'Let\'s Encrypt certificate',
                        payload: {
                            domain,
                            certPath: `/etc/letsencrypt/live/${domain}/`,
                            issuer: 'letsencrypt',
                            expiry,
                        },
                        providerSource: 'forge',
                        priority: 40,
                        dependsOn: [],
                    });
                }
            }
            const sslCount = items.length - sslCountBefore;
            this.setPhaseStatus(phases, 'ssl_certs', sslCount > 0 ? 'completed' : 'skipped', sslCount);
            emit('ssl_certs', sslCount > 0 ? `Found ${sslCount} SSL certificates` : 'No SSL certificates found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'ssl_certs', 'failed');
            emit('ssl_certs', `Failed to scan SSL certificates: ${err instanceof Error ? err.message : String(err)}`);
        }
        return items;
    }
    // ─── Decommission Plan ───────────────────────────────────────────
    async getDecommissionPlan(serverId, sshService) {
        const daemonActive = await this.isServiceActive(serverId, sshService, 'forge-daemon');
        if (!daemonActive)
            return null;
        return {
            provider: 'forge',
            steps: [
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Stop Forge daemon',
                    command: 'systemctl stop forge-daemon',
                    dangerous: false,
                    executed: false,
                },
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Disable Forge daemon from starting on boot',
                    command: 'systemctl disable forge-daemon',
                    dangerous: false,
                    executed: false,
                },
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Review Forge SSH keys',
                    command: 'grep -l "forge" /home/forge/.ssh/authorized_keys 2>/dev/null && echo "Forge SSH key found"',
                    dangerous: false,
                    executed: false,
                },
            ],
            warnings: [
                'This will permanently disconnect the server from the Laravel Forge dashboard.',
                'Review SSH authorized_keys in /home/forge/.ssh/ to remove Forge-specific keys.',
                'Supervisor workers managed by Forge will continue running independently.',
            ],
        };
    }
    // ─── Private Helpers ─────────────────────────────────────────────
    extractNginxDirective(config, directive) {
        const regex = new RegExp(`^\\s*${directive}\\s+(.+?)\\s*;`, 'mi');
        const match = config.match(regex);
        return match ? match[1].trim() : '';
    }
    summarizeCron(cronLine) {
        const parts = cronLine.split(/\s+/);
        if (parts.length < 6)
            return cronLine.substring(0, 60);
        const command = parts.slice(5).join(' ');
        // Take the last path segment or first meaningful word
        const basename = command.split('/').pop()?.split(' ')[0] ?? command;
        return basename.substring(0, 60);
    }
    setPhaseStatus(phases, phaseId, status, itemsFound) {
        const phase = phases.find(p => p.id === phaseId);
        if (phase) {
            phase.status = status;
            if (itemsFound !== undefined)
                phase.itemsFound = itemsFound;
        }
    }
    formatBytes(bytes) {
        if (bytes === 0)
            return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
    }
}
exports.ForgeProvider = ForgeProvider;
//# sourceMappingURL=ForgeProvider.js.map