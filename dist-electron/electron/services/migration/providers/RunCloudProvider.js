"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunCloudProvider = void 0;
const crypto_1 = require("crypto");
const BaseProvider_1 = require("./BaseProvider");
class RunCloudProvider extends BaseProvider_1.BaseProvider {
    providerId = 'runcloud';
    displayName = 'RunCloud';
    description = 'RunCloud server management panel with custom nginx (nginx-rc)';
    // ─── Detection ───────────────────────────────────────────────────
    async detect(serverId, sshService) {
        const [agentActive, nginxRcExists, apacheRcExists, runcloudDirExists] = await Promise.all([
            this.isServiceActive(serverId, sshService, 'runcloud-agent'),
            this.pathExists(serverId, sshService, '/etc/nginx-rc/'),
            this.pathExists(serverId, sshService, '/etc/apache2-rc/'),
            this.pathExists(serverId, sshService, '/etc/runcloud/'),
        ]);
        let confidence = 0;
        const metadata = {
            agentActive,
            nginxRcExists,
            apacheRcExists,
            runcloudDirExists,
        };
        if (agentActive && (nginxRcExists || apacheRcExists)) {
            confidence = 1.0;
        }
        else if (agentActive) {
            confidence = 0.7;
        }
        else if (runcloudDirExists) {
            confidence = 0.5;
        }
        // Try to get agent version
        if (confidence > 0) {
            const versionOutput = await this.safeExec(serverId, sshService, 'runcloud-agent --version 2>/dev/null || dpkg -s runcloud-agent 2>/dev/null | grep Version');
            if (versionOutput) {
                metadata.agentVersion = versionOutput.split('\n')[0].trim();
            }
        }
        return {
            provider: 'runcloud',
            version: metadata.agentVersion ?? null,
            confidence,
            metadata,
        };
    }
    // ─── Scan ────────────────────────────────────────────────────────
    async scan(ctx) {
        const items = [];
        const phases = [
            { id: 'nginx_sites', label: 'Nginx Sites (nginx-rc)', status: 'pending', itemsFound: 0 },
            { id: 'apache_sites', label: 'Apache Sites (apache2-rc)', status: 'pending', itemsFound: 0 },
            { id: 'databases', label: 'Databases', status: 'pending', itemsFound: 0 },
            { id: 'cron_jobs', label: 'Cron Jobs', status: 'pending', itemsFound: 0 },
            { id: 'pm2_apps', label: 'PM2 Apps', status: 'pending', itemsFound: 0 },
            { id: 'ssl_certs', label: 'SSL Certificates', status: 'pending', itemsFound: 0 },
        ];
        const emit = (phaseId, message) => {
            ctx.emitProgress({
                migrationId: ctx.migrationId,
                serverId: ctx.serverId,
                provider: 'runcloud',
                phase: phaseId,
                phases,
                message,
                totalItemsFound: items.length,
            });
        };
        // Phase 1: Nginx sites (RunCloud uses /etc/nginx-rc/)
        try {
            this.setPhaseStatus(phases, 'nginx_sites', 'running');
            emit('nginx_sites', 'Scanning RunCloud nginx sites...');
            const siteFiles = await this.safeExec(ctx.serverId, ctx.sshService, 'ls -1 /etc/nginx-rc/sites-enabled/ 2>/dev/null');
            if (siteFiles) {
                for (const filename of siteFiles.split('\n').filter(Boolean)) {
                    const content = await this.safeExec(ctx.serverId, ctx.sshService, `cat /etc/nginx-rc/sites-enabled/${filename} 2>/dev/null`);
                    if (!content)
                        continue;
                    const serverNames = this.extractNginxDirective(content, 'server_name');
                    const proxyPass = this.extractNginxDirective(content, 'proxy_pass');
                    const root = this.extractNginxDirective(content, 'root');
                    const sslCert = this.extractNginxDirective(content, 'ssl_certificate');
                    const fastcgiPass = this.extractNginxDirective(content, 'fastcgi_pass');
                    const displayName = serverNames || filename;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'nginx_site',
                        remoteKey: `runcloud:nginx:${filename}`,
                        displayName,
                        description: proxyPass
                            ? `Reverse proxy to ${proxyPass}`
                            : root
                                ? `Serves from ${root}`
                                : 'Nginx site configuration',
                        payload: {
                            filename,
                            configPath: `/etc/nginx-rc/sites-enabled/${filename}`,
                            serverName: serverNames,
                            proxyPass,
                            root,
                            sslCertificate: sslCert,
                            fastcgiPass,
                            rawConfig: content,
                        },
                        providerSource: 'runcloud',
                        priority: 10,
                        dependsOn: [],
                    });
                }
            }
            const found = items.filter(i => i.remoteKey.startsWith('runcloud:nginx:')).length;
            this.setPhaseStatus(phases, 'nginx_sites', found > 0 ? 'completed' : 'skipped', found);
            emit('nginx_sites', found > 0 ? `Found ${found} nginx sites` : 'No nginx sites found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'nginx_sites', 'failed');
            emit('nginx_sites', `Failed to scan nginx sites: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 2: Apache sites (RunCloud can use Apache — apache2-rc — for WordPress/PHP apps)
        try {
            this.setPhaseStatus(phases, 'apache_sites', 'running');
            emit('apache_sites', 'Scanning RunCloud Apache sites...');
            // RunCloud stores Apache vhosts in /etc/apache2-rc/sites-enabled/
            const apacheSiteFiles = await this.safeExec(ctx.serverId, ctx.sshService, 'ls -1 /etc/apache2-rc/sites-enabled/ 2>/dev/null');
            if (apacheSiteFiles) {
                for (const filename of apacheSiteFiles.split('\n').filter(Boolean)) {
                    // Skip default/catch-all configs
                    if (filename === '000-default.conf' || filename === 'default')
                        continue;
                    const content = await this.safeExec(ctx.serverId, ctx.sshService, `cat /etc/apache2-rc/sites-enabled/${filename} 2>/dev/null`);
                    if (!content)
                        continue;
                    const serverName = this.extractApacheDirective(content, 'ServerName');
                    const serverAlias = this.extractApacheDirective(content, 'ServerAlias');
                    const docRoot = this.extractApacheDirective(content, 'DocumentRoot');
                    const proxyPass = this.extractApacheDirective(content, 'ProxyPass');
                    const displayName = serverName || filename.replace(/\.conf$/, '');
                    // Check if an nginx-rc site with the same server name already exists
                    const isDuplicate = items.some(i => i.remoteKey.startsWith('runcloud:nginx:') &&
                        i.payload?.serverName === serverName);
                    if (isDuplicate)
                        continue;
                    let description = 'Apache virtual host';
                    if (docRoot)
                        description = `Serves from ${docRoot}`;
                    if (proxyPass)
                        description = `Reverse proxy to ${proxyPass}`;
                    items.push({
                        id: (0, crypto_1.randomUUID)(),
                        itemType: 'nginx_site', // Reuse nginx_site type — both are web server configs
                        remoteKey: `runcloud:apache:${filename}`,
                        displayName,
                        description,
                        payload: {
                            filename,
                            configPath: `/etc/apache2-rc/sites-enabled/${filename}`,
                            serverName: serverName || null,
                            serverAlias: serverAlias || null,
                            documentRoot: docRoot || null,
                            proxyPass: proxyPass || null,
                            webServer: 'apache',
                            rawConfig: content,
                        },
                        providerSource: 'runcloud',
                        priority: 10,
                        dependsOn: [],
                    });
                }
            }
            const found = items.filter(i => i.remoteKey.startsWith('runcloud:apache:')).length;
            this.setPhaseStatus(phases, 'apache_sites', found > 0 ? 'completed' : 'skipped', found);
            emit('apache_sites', found > 0 ? `Found ${found} Apache sites` : 'No Apache sites found');
        }
        catch (err) {
            this.setPhaseStatus(phases, 'apache_sites', 'failed');
            emit('apache_sites', `Failed to scan Apache sites: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 3: Databases (PostgreSQL + MySQL)
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
                        providerSource: 'runcloud',
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
                        providerSource: 'runcloud',
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
        // Phase 3: Cron jobs (filter out RunCloud-managed crons)
        try {
            this.setPhaseStatus(phases, 'cron_jobs', 'running');
            emit('cron_jobs', 'Scanning cron jobs...');
            const cronOutput = await this.safeExec(ctx.serverId, ctx.sshService, 'crontab -l 2>/dev/null');
            const cronCountBefore = items.length;
            if (cronOutput) {
                const runcloudPatterns = [
                    /runcloud/i,
                    /\/opt\/RunCloud\//i,
                    /\/etc\/runcloud\//i,
                ];
                for (const line of cronOutput.split('\n')) {
                    const trimmed = line.trim();
                    // Skip empty lines, comments, and RunCloud-managed crons
                    if (!trimmed || trimmed.startsWith('#'))
                        continue;
                    if (runcloudPatterns.some(p => p.test(trimmed)))
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
                        providerSource: 'runcloud',
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
        // Phase 4: PM2 apps
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
                            providerSource: 'runcloud',
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
        // Phase 5: SSL certificates
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
                        providerSource: 'runcloud',
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
        const agentActive = await this.isServiceActive(serverId, sshService, 'runcloud-agent');
        if (!agentActive)
            return null;
        return {
            provider: 'runcloud',
            steps: [
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Stop RunCloud agent',
                    command: 'systemctl stop runcloud-agent',
                    dangerous: false,
                    executed: false,
                },
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Disable RunCloud agent from starting on boot',
                    command: 'systemctl disable runcloud-agent',
                    dangerous: false,
                    executed: false,
                },
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Remove RunCloud agent package',
                    command: 'apt-get remove -y runcloud-agent',
                    dangerous: true,
                    executed: false,
                },
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Stop and remove RunCloud nginx (nginx-rc)',
                    command: 'systemctl stop nginx-rc && apt-get remove -y nginx-rc',
                    dangerous: true,
                    executed: false,
                },
                {
                    id: (0, crypto_1.randomUUID)(),
                    label: 'Install standard nginx',
                    command: 'apt-get install -y nginx',
                    dangerous: false,
                    executed: false,
                },
            ],
            warnings: [
                'This will permanently disconnect the server from the RunCloud dashboard.',
                'RunCloud uses a custom nginx path (/etc/nginx-rc/). Site configs will need to be migrated to standard /etc/nginx/ paths.',
                'Take a server snapshot before proceeding.',
            ],
        };
    }
    // ─── Private Helpers ─────────────────────────────────────────────
    extractNginxDirective(config, directive) {
        const regex = new RegExp(`^\\s*${directive}\\s+(.+?)\\s*;`, 'mi');
        const match = config.match(regex);
        return match ? match[1].trim() : '';
    }
    /**
     * Extract a directive value from Apache config content.
     * Apache directives don't end with semicolons.
     */
    extractApacheDirective(config, directive) {
        const regex = new RegExp(`^\\s*${directive}\\s+(.+)`, 'mi');
        const match = config.match(regex);
        if (!match)
            return '';
        // Strip quotes and trailing whitespace
        return match[1].trim().replace(/^["']|["']$/g, '');
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
exports.RunCloudProvider = RunCloudProvider;
//# sourceMappingURL=RunCloudProvider.js.map