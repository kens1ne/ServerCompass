"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RawVpsProvider = void 0;
const crypto_1 = require("crypto");
const BaseProvider_1 = require("./BaseProvider");
// Container name prefixes belonging to known management tools — skip during Docker scan
const MANAGEMENT_CONTAINER_PREFIXES = [
    'coolify',
    'dokploy',
    'runcloud',
    'forge-',
    'caprover',
    'portainer',
    'traefik', // Often managed by control panels
    'watchtower',
];
// System databases to exclude from PostgreSQL/MySQL scans
const POSTGRES_SYSTEM_DBS = new Set([
    'postgres', 'template0', 'template1', 'coolify', 'dokploy',
]);
const MYSQL_SYSTEM_DBS = new Set([
    'information_schema', 'mysql', 'performance_schema', 'sys',
]);
// Common system systemd services to exclude (display-only phase)
const SYSTEM_SERVICES = new Set([
    // Core system
    'acpid', 'apparmor', 'apport', 'atd', 'blk-availability',
    'console-setup', 'cron', 'crond', 'dbus', 'dm-event',
    'e2scrub_reap', 'emergency', 'finalrd', 'fstrim',
    'grub-common', 'grub-initrd-fallback', 'irqbalance',
    'iscsid', 'keyboard-setup', 'kmod-static-nodes',
    'lvm2-lvmpolld', 'lvm2-monitor', 'lvm2-pvscan@',
    'multipathd', 'polkit', 'rescue', 'rsyslog', 'setvtrgb',
    'ua-timer', 'vgauth',
    // Cloud / VM guest agents
    'cloud-config', 'cloud-final', 'cloud-init', 'cloud-init-local',
    'open-vm-tools', 'qemu-guest-agent', 'walinuxagent',
    // Networking
    'networkd-dispatcher', 'networking', 'NetworkManager',
    // SSH
    'ssh', 'sshd',
    // Firewall / Security
    'fail2ban', 'firewalld', 'iptables', 'nftables', 'ufw',
    // Snap / Package managers
    'snapd', 'snapd-apparmor', 'snapd-seeded',
    // Boot / Plymouth
    'plymouth', 'plymouth-quit', 'plymouth-quit-wait', 'plymouth-read-write',
    // Docker / Containers
    'containerd', 'docker',
    // systemd built-in (catch-all prefix handled separately, but list known ones)
    'systemd-ask-password-console', 'systemd-ask-password-wall',
    'systemd-binfmt', 'systemd-fsck-root', 'systemd-journal-flush',
    'systemd-journald', 'systemd-logind', 'systemd-machine-id-commit',
    'systemd-modules-load', 'systemd-networkd', 'systemd-networkd-wait-online',
    'systemd-random-seed', 'systemd-remount-fs', 'systemd-resolved',
    'systemd-sysctl', 'systemd-sysusers', 'systemd-timesyncd',
    'systemd-tmpfiles-clean', 'systemd-tmpfiles-setup',
    'systemd-tmpfiles-setup-dev', 'systemd-udev-settle',
    'systemd-udev-trigger', 'systemd-udevd', 'systemd-update-utmp',
    'systemd-update-utmp-runlevel', 'systemd-user-sessions',
    // User session services
    'user-runtime-dir@', 'user@',
    // Auto-updates
    'unattended-upgrades', 'apt-daily', 'apt-daily-upgrade',
    // Mail
    'postfix', 'exim4', 'sendmail',
    // Process supervisors (generic — user apps tracked via PM2/Docker)
    'supervisor', 'supervisord',
    // Monitoring / logging agents
    'sysstat', 'rsyslog', 'auditd', 'collectd',
    // Management panel agents (handled by their own providers, skip in raw_vps)
    'runcloud-agent', 'cleavr-agent', 'ploi-agent',
    // RunCloud / Forge / ServerPilot custom services
    'nginx-rc', 'apache2-rc', 'litespeed',
    // PHP-FPM (RunCloud-managed or system — not user apps)
    'php81rc-fpm', 'php82rc-fpm', 'php83rc-fpm', 'php84rc-fpm',
    'php7.4-fpm', 'php8.0-fpm', 'php8.1-fpm', 'php8.2-fpm', 'php8.3-fpm', 'php8.4-fpm',
    // Database engines (discovered via dedicated DB scan phases)
    'mariadb', 'mysql', 'mysqld', 'postgresql', 'postgresql@',
    'redis', 'redis-server', 'memcached', 'mongod', 'mongodb',
    // Web servers (discovered via nginx/Apache scan phases)
    'nginx', 'apache2', 'httpd', 'caddy',
    // Misc infrastructure
    'chronyd', 'ntpd', 'smartd', 'lxd-agent', 'accounts-daemon',
    'udisks2', 'ModemManager', 'thermald', 'power-profiles-daemon',
    'packagekit', 'tuned',
]);
// Prefix patterns for systemd services to always exclude
const SYSTEM_SERVICE_PREFIXES = [
    'systemd-', 'user@', 'user-runtime-dir@', 'getty@', 'serial-getty@',
    'snap.', 'snap-', 'lvm2-', 'php', // php*-fpm variants
];
class RawVpsProvider extends BaseProvider_1.BaseProvider {
    providerId = 'raw_vps';
    displayName = 'Raw VPS';
    description = 'Scan for services running directly on the server without a management tool';
    async detect(_serverId, _sshService) {
        // Always returns lowest confidence — this is the fallback/supplemental provider
        return {
            provider: 'raw_vps',
            version: null,
            confidence: 0.1,
            metadata: {},
        };
    }
    async scan(ctx) {
        const allItems = [];
        const phases = [
            { id: 'nginx', label: 'Nginx Sites', status: 'pending', itemsFound: 0 },
            { id: 'pm2', label: 'PM2 Applications', status: 'pending', itemsFound: 0 },
            { id: 'docker_containers', label: 'Docker Containers', status: 'pending', itemsFound: 0 },
            { id: 'docker_stacks', label: 'Docker Compose Stacks', status: 'pending', itemsFound: 0 },
            { id: 'postgres', label: 'PostgreSQL Databases', status: 'pending', itemsFound: 0 },
            { id: 'mysql', label: 'MySQL Databases', status: 'pending', itemsFound: 0 },
            { id: 'cron', label: 'Cron Jobs', status: 'pending', itemsFound: 0 },
            { id: 'ssl', label: 'SSL Certificates', status: 'pending', itemsFound: 0 },
            { id: 'systemd', label: 'Systemd Services', status: 'pending', itemsFound: 0 },
        ];
        const emit = (phaseId, message) => {
            ctx.emitProgress({
                migrationId: ctx.migrationId,
                serverId: ctx.serverId,
                provider: 'raw_vps',
                phase: phaseId,
                phases,
                message,
                totalItemsFound: allItems.length,
            });
        };
        const markPhase = (phaseId, status, itemsFound) => {
            const phase = phases.find(p => p.id === phaseId);
            if (phase) {
                phase.status = status;
                if (itemsFound !== undefined)
                    phase.itemsFound = itemsFound;
            }
        };
        // ── Phase 1: Nginx Sites ──────────────────────────────────────
        try {
            markPhase('nginx', 'running');
            emit('nginx', 'Scanning Nginx sites...');
            const items = await this.scanNginxSites(ctx);
            allItems.push(...items);
            markPhase('nginx', 'completed', items.length);
            emit('nginx', `Found ${items.length} Nginx site(s)`);
        }
        catch (err) {
            markPhase('nginx', 'failed');
            emit('nginx', `Nginx scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 2: PM2 Applications ─────────────────────────────────
        try {
            markPhase('pm2', 'running');
            emit('pm2', 'Scanning PM2 applications...');
            const items = await this.scanPM2Apps(ctx);
            allItems.push(...items);
            markPhase('pm2', 'completed', items.length);
            emit('pm2', `Found ${items.length} PM2 app(s)`);
        }
        catch (err) {
            markPhase('pm2', 'failed');
            emit('pm2', `PM2 scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 3: Docker Containers ────────────────────────────────
        try {
            markPhase('docker_containers', 'running');
            emit('docker_containers', 'Scanning Docker containers...');
            const items = await this.scanDockerContainers(ctx);
            allItems.push(...items);
            markPhase('docker_containers', 'completed', items.length);
            emit('docker_containers', `Found ${items.length} Docker container(s)`);
        }
        catch (err) {
            markPhase('docker_containers', 'failed');
            emit('docker_containers', `Docker container scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 4: Docker Compose Stacks ────────────────────────────
        try {
            markPhase('docker_stacks', 'running');
            emit('docker_stacks', 'Scanning Docker Compose stacks...');
            const items = await this.scanDockerStacks(ctx);
            allItems.push(...items);
            markPhase('docker_stacks', 'completed', items.length);
            emit('docker_stacks', `Found ${items.length} Docker Compose stack(s)`);
        }
        catch (err) {
            markPhase('docker_stacks', 'failed');
            emit('docker_stacks', `Docker Compose scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 5: PostgreSQL Databases ─────────────────────────────
        try {
            markPhase('postgres', 'running');
            emit('postgres', 'Scanning PostgreSQL databases...');
            const items = await this.scanPostgresDatabases(ctx);
            allItems.push(...items);
            markPhase('postgres', 'completed', items.length);
            emit('postgres', `Found ${items.length} PostgreSQL database(s)`);
        }
        catch (err) {
            markPhase('postgres', 'failed');
            emit('postgres', `PostgreSQL scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 6: MySQL Databases ──────────────────────────────────
        try {
            markPhase('mysql', 'running');
            emit('mysql', 'Scanning MySQL databases...');
            const items = await this.scanMysqlDatabases(ctx);
            allItems.push(...items);
            markPhase('mysql', 'completed', items.length);
            emit('mysql', `Found ${items.length} MySQL database(s)`);
        }
        catch (err) {
            markPhase('mysql', 'failed');
            emit('mysql', `MySQL scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 7: Cron Jobs ────────────────────────────────────────
        try {
            markPhase('cron', 'running');
            emit('cron', 'Scanning cron jobs...');
            const items = await this.scanCronJobs(ctx);
            allItems.push(...items);
            markPhase('cron', 'completed', items.length);
            emit('cron', `Found ${items.length} cron job(s)`);
        }
        catch (err) {
            markPhase('cron', 'failed');
            emit('cron', `Cron scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 8: SSL Certificates ─────────────────────────────────
        try {
            markPhase('ssl', 'running');
            emit('ssl', 'Scanning SSL certificates...');
            const items = await this.scanSSLCertificates(ctx);
            allItems.push(...items);
            markPhase('ssl', 'completed', items.length);
            emit('ssl', `Found ${items.length} SSL certificate(s)`);
        }
        catch (err) {
            markPhase('ssl', 'failed');
            emit('ssl', `SSL scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 9: Systemd Services (display-only) ──────────────────
        try {
            markPhase('systemd', 'running');
            emit('systemd', 'Scanning systemd services...');
            const items = await this.scanSystemdServices(ctx);
            allItems.push(...items);
            markPhase('systemd', 'completed', items.length);
            emit('systemd', `Found ${items.length} custom systemd service(s)`);
        }
        catch (err) {
            markPhase('systemd', 'failed');
            emit('systemd', `Systemd scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return allItems;
    }
    async getDecommissionPlan(_serverId, _sshService) {
        // No management agent to remove on a raw VPS
        return null;
    }
    // ─── Private Scan Methods ──────────────────────────────────────
    async scanNginxSites(ctx) {
        const items = [];
        const listing = await this.safeExec(ctx.serverId, ctx.sshService, 'ls -1 /etc/nginx/sites-enabled/ 2>/dev/null');
        if (!listing)
            return items;
        const siteNames = listing.split('\n').map(s => s.trim()).filter(Boolean);
        for (const siteName of siteNames) {
            if (siteName === 'default')
                continue;
            const configContent = await this.safeExec(ctx.serverId, ctx.sshService, `cat /etc/nginx/sites-enabled/${siteName} 2>/dev/null`);
            if (!configContent)
                continue;
            const serverName = this.extractNginxDirective(configContent, 'server_name') || siteName;
            const proxyPass = this.extractNginxDirective(configContent, 'proxy_pass');
            const root = this.extractNginxDirective(configContent, 'root');
            const sslCert = this.extractNginxDirective(configContent, 'ssl_certificate');
            const fastcgiPass = this.extractNginxDirective(configContent, 'fastcgi_pass');
            let description = serverName;
            if (proxyPass)
                description += ` → ${proxyPass}`;
            else if (fastcgiPass)
                description += ` (PHP-FPM: ${fastcgiPass})`;
            else if (root)
                description += ` (static: ${root})`;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'nginx_site',
                remoteKey: `nginx:${siteName}`,
                displayName: serverName !== siteName ? `${serverName} (${siteName})` : siteName,
                description,
                payload: {
                    fileName: siteName,
                    serverName,
                    proxyPass: proxyPass || null,
                    root: root || null,
                    sslCertificate: sslCert || null,
                    fastcgiPass: fastcgiPass || null,
                    configContent,
                },
                providerSource: 'raw_vps',
                priority: 30,
                dependsOn: [],
            });
        }
        return items;
    }
    async scanPM2Apps(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'pm2 jlist 2>/dev/null');
        if (!output)
            return items;
        let apps;
        try {
            apps = JSON.parse(output);
        }
        catch {
            return items;
        }
        if (!Array.isArray(apps))
            return items;
        for (const app of apps) {
            const name = String(app.name ?? 'unknown');
            const pm2Id = app.pm_id ?? app.pmId ?? null;
            const status = String(app.pm2_env && typeof app.pm2_env === 'object'
                ? app.pm2_env.status ?? 'unknown'
                : 'unknown');
            const pm2Env = (app.pm2_env ?? {});
            const script = String(pm2Env.pm_exec_path ?? pm2Env.script ?? '');
            const cwd = String(pm2Env.pm_cwd ?? pm2Env.cwd ?? '');
            const interpreter = String(pm2Env.exec_interpreter ?? '');
            const nodeVersion = String(pm2Env.node_version ?? '');
            const restarts = Number(pm2Env.restart_time ?? 0);
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'pm2_app',
                remoteKey: `pm2:${name}`,
                displayName: name,
                description: `PM2 app (${status}) — ${script || 'unknown script'}`,
                payload: {
                    name,
                    pm2Id,
                    status,
                    script,
                    cwd,
                    interpreter,
                    nodeVersion,
                    restarts,
                },
                providerSource: 'raw_vps',
                priority: 20,
                dependsOn: [],
            });
        }
        return items;
    }
    async scanDockerContainers(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, `docker ps --format '{{json .}}' 2>/dev/null`);
        if (!output)
            return items;
        const lines = output.split('\n').filter(Boolean);
        for (const line of lines) {
            let container;
            try {
                container = JSON.parse(line);
            }
            catch {
                continue;
            }
            const name = String(container.Names ?? container.names ?? '');
            const image = String(container.Image ?? container.image ?? '');
            const status = String(container.Status ?? container.status ?? '');
            const ports = String(container.Ports ?? container.ports ?? '');
            const containerId = String(container.ID ?? container.id ?? '');
            // Skip management tool containers
            if (this.isManagementContainer(name))
                continue;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'docker_container',
                remoteKey: `docker-container:${name}`,
                displayName: name,
                description: `${image} (${status})`,
                payload: {
                    containerId,
                    name,
                    image,
                    status,
                    ports,
                },
                providerSource: 'raw_vps',
                priority: 10,
                dependsOn: [],
            });
        }
        return items;
    }
    async scanDockerStacks(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'docker compose ls --format json 2>/dev/null');
        if (!output)
            return items;
        let stacks;
        try {
            stacks = JSON.parse(output);
        }
        catch {
            return items;
        }
        if (!Array.isArray(stacks))
            return items;
        for (const stack of stacks) {
            const name = String(stack.Name ?? stack.name ?? '');
            const status = String(stack.Status ?? stack.status ?? '');
            const configFiles = String(stack.ConfigFiles ?? stack.configFiles ?? '');
            // Skip management tool stacks
            if (this.isManagementContainer(name))
                continue;
            // Try to read the compose file content
            let composeContent = '';
            if (configFiles) {
                const primaryFile = configFiles.split(',')[0].trim();
                if (primaryFile) {
                    composeContent = await this.safeExec(ctx.serverId, ctx.sshService, `cat "${primaryFile}" 2>/dev/null`);
                }
            }
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'docker_stack',
                remoteKey: `docker-stack:${name}`,
                displayName: name,
                description: `Docker Compose stack (${status})`,
                payload: {
                    name,
                    status,
                    configFiles,
                    composeContent: composeContent || null,
                },
                providerSource: 'raw_vps',
                priority: 10,
                dependsOn: [],
            });
        }
        return items;
    }
    async scanPostgresDatabases(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'sudo -n -u postgres psql -t -c "SELECT datname FROM pg_database WHERE datistemplate = false;" 2>/dev/null');
        if (!output)
            return items;
        const dbNames = output.split('\n').map(s => s.trim()).filter(Boolean);
        for (const dbName of dbNames) {
            if (POSTGRES_SYSTEM_DBS.has(dbName))
                continue;
            // Get approximate size
            const sizeOutput = await this.safeExec(ctx.serverId, ctx.sshService, `sudo -n -u postgres psql -t -c "SELECT pg_database_size('${dbName}');" 2>/dev/null`);
            const sizeBytes = parseInt(sizeOutput.trim(), 10) || 0;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'database',
                remoteKey: `postgres:${dbName}`,
                displayName: dbName,
                description: `PostgreSQL database${sizeBytes > 0 ? ` (${this.formatBytes(sizeBytes)})` : ''}`,
                payload: {
                    engine: 'postgresql',
                    name: dbName,
                    sizeBytes,
                },
                providerSource: 'raw_vps',
                priority: 40,
                dependsOn: [],
                estimatedSize: sizeBytes || undefined,
            });
        }
        return items;
    }
    async scanMysqlDatabases(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'mysql -N -e "SHOW DATABASES;" 2>/dev/null');
        if (!output)
            return items;
        const dbNames = output.split('\n').map(s => s.trim()).filter(Boolean);
        for (const dbName of dbNames) {
            if (MYSQL_SYSTEM_DBS.has(dbName))
                continue;
            // Get approximate size
            const sizeOutput = await this.safeExec(ctx.serverId, ctx.sshService, `mysql -N -e "SELECT SUM(data_length + index_length) FROM information_schema.tables WHERE table_schema = '${dbName}';" 2>/dev/null`);
            const sizeBytes = parseInt(sizeOutput.trim(), 10) || 0;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'database',
                remoteKey: `mysql:${dbName}`,
                displayName: dbName,
                description: `MySQL database${sizeBytes > 0 ? ` (${this.formatBytes(sizeBytes)})` : ''}`,
                payload: {
                    engine: 'mysql',
                    name: dbName,
                    sizeBytes,
                },
                providerSource: 'raw_vps',
                priority: 40,
                dependsOn: [],
                estimatedSize: sizeBytes || undefined,
            });
        }
        return items;
    }
    async scanCronJobs(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'crontab -l 2>/dev/null');
        if (!output)
            return items;
        const lines = output.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            // A cron line has at least 6 parts: 5 schedule fields + command
            const parts = trimmed.split(/\s+/);
            if (parts.length < 6)
                continue;
            const schedule = parts.slice(0, 5).join(' ');
            const command = parts.slice(5).join(' ');
            // Use a truncated command as display name
            const displayCmd = command.length > 60 ? command.substring(0, 57) + '...' : command;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'cron_job',
                remoteKey: `cron:${schedule}:${command}`,
                displayName: displayCmd,
                description: `Schedule: ${schedule}`,
                payload: {
                    schedule,
                    command,
                    user: 'root',
                    rawLine: trimmed,
                },
                providerSource: 'raw_vps',
                priority: 50,
                dependsOn: [],
            });
        }
        return items;
    }
    async scanSSLCertificates(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'ls /etc/letsencrypt/live/ 2>/dev/null');
        if (!output)
            return items;
        const dirs = output.split('\n').map(s => s.trim()).filter(Boolean);
        for (const dir of dirs) {
            if (dir === 'README')
                continue;
            // Check certificate expiry
            const expiryOutput = await this.safeExec(ctx.serverId, ctx.sshService, `openssl x509 -enddate -noout -in /etc/letsencrypt/live/${dir}/cert.pem 2>/dev/null`);
            const expiryMatch = expiryOutput.match(/notAfter=(.+)/);
            const expiresAt = expiryMatch ? expiryMatch[1].trim() : null;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'ssl_certificate',
                remoteKey: `ssl:${dir}`,
                displayName: dir,
                description: `Let's Encrypt certificate${expiresAt ? ` (expires: ${expiresAt})` : ''}`,
                payload: {
                    domain: dir,
                    provider: 'letsencrypt',
                    path: `/etc/letsencrypt/live/${dir}/`,
                    expiresAt,
                },
                providerSource: 'raw_vps',
                priority: 60,
                dependsOn: [],
            });
        }
        return items;
    }
    async scanSystemdServices(ctx) {
        const items = [];
        const output = await this.safeExec(ctx.serverId, ctx.sshService, 'systemctl list-units --type=service --state=active --no-pager --no-legend 2>/dev/null');
        if (!output)
            return items;
        const lines = output.split('\n').filter(Boolean);
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4)
                continue;
            // Format: UNIT LOAD ACTIVE SUB DESCRIPTION...
            const unitName = parts[0];
            const serviceName = unitName.replace(/\.service$/, '');
            const sub = parts[3] || '';
            const description = parts.slice(4).join(' ');
            // Skip common system / infrastructure services
            if (SYSTEM_SERVICES.has(serviceName))
                continue;
            // Skip services matching known system prefixes
            if (SYSTEM_SERVICE_PREFIXES.some(prefix => serviceName.startsWith(prefix)))
                continue;
            items.push({
                id: (0, crypto_1.randomUUID)(),
                itemType: 'systemd_service',
                remoteKey: `systemd:${serviceName}`,
                displayName: serviceName,
                description: description || `Systemd service (${sub})`,
                payload: {
                    unitName,
                    serviceName,
                    subState: sub,
                    description,
                },
                providerSource: 'raw_vps',
                priority: 70,
                dependsOn: [],
            });
        }
        return items;
    }
    // ─── Utility Methods ──────────────────────────────────────────
    /**
     * Extract a directive value from Nginx config content.
     * Returns the first match or null.
     */
    extractNginxDirective(config, directive) {
        // Match `directive value;` — value may be quoted or unquoted
        const regex = new RegExp(`^\\s*${directive}\\s+([^;]+);`, 'm');
        const match = config.match(regex);
        if (!match)
            return null;
        // Return the value, stripping surrounding quotes and trimming
        return match[1].trim().replace(/^["']|["']$/g, '');
    }
    /**
     * Check if a container name belongs to a known management tool.
     */
    isManagementContainer(name) {
        const lower = name.toLowerCase();
        return MANAGEMENT_CONTAINER_PREFIXES.some(prefix => lower.startsWith(prefix));
    }
    /**
     * Format byte count into human-readable string.
     */
    formatBytes(bytes) {
        if (bytes < 1024)
            return `${bytes} B`;
        if (bytes < 1024 * 1024)
            return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024)
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
}
exports.RawVpsProvider = RawVpsProvider;
//# sourceMappingURL=RawVpsProvider.js.map