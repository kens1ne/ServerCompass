"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationVerifyEngine = void 0;
const electron_1 = require("electron");
const db_1 = require("../../db");
const SSHService_1 = require("../SSHService");
class MigrationVerifyEngine {
    async verifyAll(migrationId, targetServerId) {
        const items = db_1.db.prepare(`
      SELECT * FROM server_migration_discovered_items
      WHERE migration_id = ? AND import_status = 'imported'
      ORDER BY priority ASC
    `).all(migrationId);
        const checks = [];
        // Brief delay to let the frontend mount and subscribe to progress events.
        await new Promise(resolve => setTimeout(resolve, 100));
        this.emitProgress({
            migrationId,
            currentIndex: 0,
            totalItems: items.length,
            currentItemName: '',
            phase: 'starting',
            checks,
        });
        // Handle zero-items case: emit completed immediately
        if (items.length === 0) {
            this.emitProgress({
                migrationId,
                currentIndex: 0,
                totalItems: 0,
                currentItemName: '',
                phase: 'completed',
                checks,
            });
            return;
        }
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const check = await this.verifyItem(item, targetServerId);
            checks.push(check);
            // Update item verification status
            db_1.db.prepare(`
        UPDATE server_migration_discovered_items
        SET verification_status = ?, verification_message = ?, updated_at = ?
        WHERE id = ?
      `).run(check.status, check.message, Date.now(), item.id);
            if (check.status === 'healthy') {
                db_1.db.prepare(`UPDATE server_migrations SET total_verified = total_verified + 1, updated_at = ? WHERE id = ?`)
                    .run(Date.now(), migrationId);
            }
            this.emitProgress({
                migrationId,
                currentIndex: i + 1,
                totalItems: items.length,
                currentItemName: item.display_name,
                phase: i === items.length - 1 ? 'completed' : 'checking',
                checks,
            });
        }
    }
    async verifyItem(item, serverId) {
        const payload = JSON.parse(item.payload_json);
        const providerSource = (item.provider_source ?? '').toString().toLowerCase();
        const payloadSourceType = typeof payload.sourceType === 'string'
            ? String(payload.sourceType)
            : typeof payload.source_type === 'string'
                ? String(payload.source_type)
                : '';
        const isCoolifyItem = providerSource === 'coolify' ||
            payloadSourceType.startsWith('coolify_') ||
            item.item_type === 'coolify_project';
        const isDokployItem = providerSource === 'dokploy' ||
            payloadSourceType.startsWith('dokploy_') ||
            item.item_type === 'dokploy_project';
        const isManagedPlatformItem = isCoolifyItem || isDokployItem;
        const shellEscape = (value) => {
            return `'${value.replace(/'/g, `'\\''`)}'`;
        };
        const sqlLiteral = (value) => {
            return `'${value.replace(/'/g, "''")}'`;
        };
        const resolveCoolifyDbContainer = async () => {
            // Prefer the canonical container name used in docs and our fake setup.
            const exists = await SSHService_1.sshService.executeCommand(serverId, 'docker ps --filter "name=^coolify-db$" --format "{{.Names}}" 2>/dev/null');
            if (exists.exitCode === 0 && exists.stdout.trim())
                return 'coolify-db';
            // Fallback: look for any postgres container with "coolify" in its name.
            const detected = await SSHService_1.sshService.executeCommand(serverId, 'docker ps --filter "name=coolify" --filter "ancestor=postgres" --format "{{.Names}}" 2>/dev/null | head -1');
            return detected.exitCode === 0 && detected.stdout.trim() ? detected.stdout.trim() : null;
        };
        const execCoolifyPsql = async (sql) => {
            const dbContainer = await resolveCoolifyDbContainer();
            if (!dbContainer) {
                return { exitCode: 1, stdout: '', stderr: 'Coolify DB container not found' };
            }
            return SSHService_1.sshService.executeCommand(serverId, `docker exec ${dbContainer} psql -U coolify -d coolify -t -A -c ${shellEscape(sql)} 2>/dev/null`);
        };
        const parseDockerPsStates = (stdout) => {
            return stdout
                .trim()
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => {
                // We format docker output with `|` delimiters, but be tolerant of older
                // `\t`-style outputs (literal or actual tabs).
                const parts = line.includes('|')
                    ? line.split('|')
                    : line.includes('\t')
                        ? line.split('\t')
                        : line.includes('\\t')
                            ? line.split('\\t')
                            : [line];
                const [name, state, status] = parts;
                return {
                    name: (name || '').trim(),
                    state: (state || '').trim(),
                    status: (status || '').trim(),
                };
            })
                .filter(row => row.name.length > 0);
        };
        const baseCheck = {
            itemId: item.id,
            itemName: item.display_name,
            checkType: 'process_running',
            status: 'checking',
            message: 'Checking...',
        };
        try {
            switch (item.item_type) {
                case 'docker_container': {
                    const containerId = typeof payload.containerId === 'string'
                        ? String(payload.containerId)
                        : null;
                    const containerName = typeof payload.name === 'string'
                        ? String(payload.name)
                        : null;
                    const containerRef = containerId || containerName || item.display_name;
                    if (!containerRef) {
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: 'skipped',
                            message: 'No container identifier available',
                        };
                    }
                    const result = await SSHService_1.sshService.executeCommand(serverId, `docker inspect -f "{{.Name}}|{{.State.Status}}|{{.State.Running}}{{if .State.Health}}|{{.State.Health.Status}}{{end}}" ${shellEscape(containerRef)} 2>/dev/null`);
                    if (result.exitCode !== 0 || !result.stdout.trim()) {
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: isManagedPlatformItem ? 'skipped' : 'unhealthy',
                            message: isManagedPlatformItem
                                ? 'Source platform record imported (no container found)'
                                : 'Container not found',
                        };
                    }
                    const [rawName, stateRaw, runningRaw, healthRaw] = result.stdout.trim().split('|');
                    const state = (stateRaw || '').trim();
                    const running = (runningRaw || '').trim().toLowerCase() === 'true';
                    const health = (healthRaw || '').trim();
                    if (!running) {
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: 'unhealthy',
                            message: 'Container not running',
                            details: `${(rawName || '').replace(/^\//, '')}\t${state || ''}${health ? `\t${health}` : ''}`,
                        };
                    }
                    if (health && health !== 'healthy') {
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: 'unhealthy',
                            message: `Container health: ${health}`,
                            details: `${(rawName || '').replace(/^\//, '')}\t${state || ''}\t${health}`,
                        };
                    }
                    return {
                        ...baseCheck,
                        checkType: 'docker_healthy',
                        status: 'healthy',
                        message: 'Container running',
                    };
                }
                case 'docker_stack': {
                    const stackName = typeof payload.name === 'string'
                        ? String(payload.name)
                        : typeof payload.projectName === 'string'
                            ? String(payload.projectName)
                            : item.display_name;
                    if (!stackName) {
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: 'skipped',
                            message: 'No stack name available',
                        };
                    }
                    // Best-effort: verify by Docker Compose project label when available.
                    const labelFilter = `label=com.docker.compose.project=${stackName}`;
                    const psAll = await SSHService_1.sshService.executeCommand(serverId, `docker ps -a --filter ${shellEscape(labelFilter)} --format "{{.Names}}|{{.State}}|{{.Status}}" 2>/dev/null`);
                    const rows = psAll.exitCode === 0 ? parseDockerPsStates(psAll.stdout) : [];
                    if (rows.length === 0) {
                        // Managed platform stacks may not map cleanly to a compose project name.
                        if (isManagedPlatformItem) {
                            const fallbackName = (item.display_name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
                            const fallback = await SSHService_1.sshService.executeCommand(serverId, `docker ps --format "{{.Names}}|{{.State}}|{{.Status}}" 2>/dev/null | grep -i ${shellEscape(fallbackName)} || true`);
                            const fallbackRows = parseDockerPsStates(fallback.stdout);
                            if (fallbackRows.length === 0) {
                                return {
                                    ...baseCheck,
                                    checkType: 'docker_healthy',
                                    status: 'skipped',
                                    message: 'Source platform record imported (no running containers found)',
                                };
                            }
                            const allRunning = fallbackRows.every(r => r.state === 'running');
                            return {
                                ...baseCheck,
                                checkType: 'docker_healthy',
                                status: allRunning ? 'healthy' : 'unhealthy',
                                message: allRunning ? 'All containers running' : 'Some containers not running',
                                details: fallback.stdout.trim(),
                            };
                        }
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: 'unhealthy',
                            message: 'No containers found for compose project',
                            details: `Project: ${stackName}`,
                        };
                    }
                    const allRunning = rows.every(r => r.state === 'running');
                    return {
                        ...baseCheck,
                        checkType: 'docker_healthy',
                        status: allRunning ? 'healthy' : 'unhealthy',
                        message: allRunning ? 'All containers running' : 'Some containers not running',
                        details: psAll.stdout.trim(),
                    };
                }
                case 'coolify_project':
                case 'dokploy_project': {
                    const containerName = (item.display_name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    const result = await SSHService_1.sshService.executeCommand(serverId, `docker ps --format "{{.Names}}|{{.State}}|{{.Status}}" 2>/dev/null | grep -i ${shellEscape(containerName)} || true`);
                    const rows = parseDockerPsStates(result.stdout);
                    if (rows.length === 0) {
                        return {
                            ...baseCheck,
                            checkType: 'docker_healthy',
                            status: 'skipped',
                            message: 'Source platform record imported (no running container found)',
                        };
                    }
                    const allRunning = rows.every(r => r.state === 'running');
                    return {
                        ...baseCheck,
                        checkType: 'docker_healthy',
                        status: allRunning ? 'healthy' : 'unhealthy',
                        message: allRunning ? 'Container running' : 'Container not running',
                        details: result.stdout.trim(),
                    };
                }
                case 'pm2_app': {
                    const appName = typeof payload.name === 'string' ? String(payload.name) : item.display_name;
                    if (!appName) {
                        return { ...baseCheck, status: 'skipped', message: 'No PM2 app name available' };
                    }
                    const list = await SSHService_1.sshService.executeCommand(serverId, 'pm2 jlist 2>/dev/null');
                    if (list.exitCode !== 0 || !list.stdout.trim()) {
                        return { ...baseCheck, status: 'skipped', message: 'PM2 not available on target server' };
                    }
                    let processes = [];
                    try {
                        processes = JSON.parse(list.stdout);
                    }
                    catch {
                        return { ...baseCheck, status: 'skipped', message: 'Unable to parse PM2 process list' };
                    }
                    const proc = processes.find(p => p?.name === appName);
                    if (!proc) {
                        return { ...baseCheck, status: 'unhealthy', message: 'PM2 process not found' };
                    }
                    const status = proc?.pm2_env?.status;
                    const isOnline = status === 'online';
                    return {
                        ...baseCheck,
                        status: isOnline ? 'healthy' : 'unhealthy',
                        message: isOnline ? 'PM2 process online' : `PM2 status: ${String(status ?? 'unknown')}`,
                    };
                }
                case 'database': {
                    const dbType = payload.type || payload.dbType || payload.engine;
                    const dbName = payload.dbName || payload.name || payload.databaseName;
                    // For Coolify databases, check inside the coolify-db container
                    if (isCoolifyItem && payloadSourceType === 'coolify_database') {
                        const coolifyIdRaw = payload.coolifyId;
                        const coolifyId = typeof coolifyIdRaw === 'number'
                            ? coolifyIdRaw
                            : typeof coolifyIdRaw === 'string' && /^\d+$/.test(coolifyIdRaw)
                                ? parseInt(coolifyIdRaw, 10)
                                : null;
                        if (dbType === 'postgres' || dbType === 'postgresql') {
                            const where = coolifyId !== null
                                ? `id = ${coolifyId}`
                                : `name = ${sqlLiteral(String(item.display_name || dbName || ''))}`;
                            const result = await execCoolifyPsql(`SELECT 1 FROM standalone_postgresqls WHERE ${where} AND deleted_at IS NULL LIMIT 1`);
                            return {
                                ...baseCheck,
                                checkType: 'db_connection',
                                status: result.exitCode === 0 && result.stdout.trim() ? 'healthy' : 'unhealthy',
                                message: result.exitCode === 0 && result.stdout.trim()
                                    ? 'Database record verified in Coolify'
                                    : 'Database record not found in Coolify',
                            };
                        }
                        else if (dbType === 'mysql' || dbType === 'mariadb') {
                            const where = coolifyId !== null
                                ? `id = ${coolifyId}`
                                : `name = ${sqlLiteral(String(item.display_name || dbName || ''))}`;
                            const result = await execCoolifyPsql(`SELECT 1 FROM standalone_mysqls WHERE ${where} AND deleted_at IS NULL LIMIT 1`);
                            return {
                                ...baseCheck,
                                checkType: 'db_connection',
                                status: result.exitCode === 0 && result.stdout.trim() ? 'healthy' : 'unhealthy',
                                message: result.exitCode === 0 && result.stdout.trim()
                                    ? 'Database record verified in Coolify'
                                    : 'Database record not found in Coolify',
                            };
                        }
                        return { ...baseCheck, status: 'skipped', message: 'Unknown database type' };
                    }
                    // For host-level databases
                    if (dbType === 'postgres' || dbType === 'postgresql') {
                        const name = dbName ? String(dbName).trim() : '';
                        if (!name) {
                            return { ...baseCheck, status: 'skipped', message: 'No database name available' };
                        }
                        const result = await SSHService_1.sshService.executeCommand(serverId, `sudo -n -u postgres psql -d ${shellEscape(name)} -c "SELECT 1" 2>/dev/null`);
                        return {
                            ...baseCheck,
                            checkType: 'db_connection',
                            status: result.exitCode === 0 ? 'healthy' : 'unhealthy',
                            message: result.exitCode === 0 ? 'Database connection successful' : 'Database connection failed',
                        };
                    }
                    else if (dbType === 'mysql' || dbType === 'mariadb') {
                        const name = dbName ? String(dbName).trim() : '';
                        if (!name) {
                            return { ...baseCheck, status: 'skipped', message: 'No database name available' };
                        }
                        const result = await SSHService_1.sshService.executeCommand(serverId, `mysql -e "SELECT 1" ${shellEscape(name)} 2>/dev/null`);
                        return {
                            ...baseCheck,
                            checkType: 'db_connection',
                            status: result.exitCode === 0 ? 'healthy' : 'unhealthy',
                            message: result.exitCode === 0 ? 'Database connection successful' : 'Database connection failed',
                        };
                    }
                    return { ...baseCheck, status: 'skipped', message: 'Unknown database type' };
                }
                case 'cron_job': {
                    // For Coolify scheduled tasks, verify the record still exists in Coolify DB
                    if (isCoolifyItem && payloadSourceType === 'coolify_scheduled_task') {
                        const coolifyIdRaw = payload.coolifyId;
                        const coolifyId = typeof coolifyIdRaw === 'number'
                            ? coolifyIdRaw
                            : typeof coolifyIdRaw === 'string' && /^\d+$/.test(coolifyIdRaw)
                                ? parseInt(coolifyIdRaw, 10)
                                : null;
                        const result = coolifyId === null
                            ? { exitCode: 1, stdout: '', stderr: 'Missing Coolify task id' }
                            : await execCoolifyPsql(`SELECT 1 FROM scheduled_tasks WHERE id = ${coolifyId} AND deleted_at IS NULL AND enabled = true LIMIT 1`);
                        return {
                            ...baseCheck,
                            checkType: 'cron_active',
                            status: result.exitCode === 0 && result.stdout.trim() ? 'healthy' : 'unhealthy',
                            message: result.exitCode === 0 && result.stdout.trim()
                                ? 'Scheduled task verified in Coolify'
                                : 'Scheduled task not found in Coolify',
                        };
                    }
                    // For system crontab entries
                    const cronLine = payload.schedule
                        ? `${payload.schedule} ${payload.command}`
                        : payload.line;
                    const signature = payload.jobSignature || cronLine;
                    const result = await SSHService_1.sshService.executeCommand(serverId, `crontab -l 2>/dev/null | grep -F "${signature}"`);
                    return {
                        ...baseCheck,
                        checkType: 'cron_active',
                        status: result.exitCode === 0 && result.stdout.trim() ? 'healthy' : 'unhealthy',
                        message: result.exitCode === 0 ? 'Cron entry verified' : 'Cron entry not found',
                    };
                }
                case 'nginx_site':
                case 'domain':
                case 'ssl_certificate':
                case 'ansible_role':
                case 'systemd_service':
                case 'env_file':
                    return { ...baseCheck, status: 'skipped', message: 'Snapshot-only item, no verification needed' };
                default:
                    return { ...baseCheck, status: 'skipped', message: `No verification for ${item.item_type}` };
            }
        }
        catch (err) {
            return {
                ...baseCheck,
                status: 'unhealthy',
                message: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    emitProgress(progress) {
        electron_1.BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed())
                w.webContents.send('migration:verifyProgress', progress);
        });
    }
}
exports.MigrationVerifyEngine = MigrationVerifyEngine;
//# sourceMappingURL=MigrationVerifyEngine.js.map