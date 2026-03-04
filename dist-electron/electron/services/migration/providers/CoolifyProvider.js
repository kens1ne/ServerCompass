"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoolifyProvider = void 0;
const crypto_1 = require("crypto");
const BaseProvider_1 = require("./BaseProvider");
class CoolifyProvider extends BaseProvider_1.BaseProvider {
    providerId = 'coolify';
    displayName = 'Coolify';
    description = 'Open-source PaaS (Coolify v4) with built-in PostgreSQL database';
    // ─── Detection ─────────────────────────────────────────────────
    async detect(serverId, sshService) {
        let confidence = 0;
        let version = null;
        const metadata = {};
        // Check if coolify-db container is running
        const dbContainerRunning = await this.dockerContainerExists(serverId, sshService, 'coolify-db');
        metadata.dbContainerRunning = dbContainerRunning;
        // Check if /data/coolify/ directory exists
        const dataPathExists = await this.pathExists(serverId, sshService, '/data/coolify/');
        metadata.dataPathExists = dataPathExists;
        // Check for Docker labels with coolify.*
        const coolifyLabels = await this.safeExec(serverId, sshService, 'docker ps --format "{{.Labels}}" 2>/dev/null | grep -c "coolify" || echo "0"');
        const labelCount = parseInt(coolifyLabels, 10) || 0;
        metadata.coolifyLabelCount = labelCount;
        // Confidence scoring
        if (dbContainerRunning && dataPathExists) {
            confidence = 0.95;
        }
        else if (labelCount > 0) {
            confidence = 0.7;
        }
        else if (dataPathExists) {
            confidence = 0.5;
        }
        // Try to detect Coolify version
        if (confidence > 0) {
            const versionOutput = await this.safeExec(serverId, sshService, 'cat /data/coolify/source/.env 2>/dev/null | grep -i "COOLIFY_VERSION\\|APP_VERSION" | head -1 | cut -d= -f2');
            if (versionOutput) {
                version = versionOutput.trim();
                metadata.version = version;
            }
        }
        return {
            provider: 'coolify',
            version,
            confidence,
            metadata,
        };
    }
    // ─── Scan ─────────────────────────────────────────────────────
    async scan(ctx) {
        const { migrationId, serverId, sshService, emitProgress } = ctx;
        const items = [];
        const phases = [
            { id: 'find-db', label: 'Locating PostgreSQL container', status: 'pending', itemsFound: 0 },
            { id: 'applications', label: 'Scanning applications', status: 'pending', itemsFound: 0 },
            { id: 'services', label: 'Scanning services', status: 'pending', itemsFound: 0 },
            { id: 'databases', label: 'Scanning databases', status: 'pending', itemsFound: 0 },
            { id: 'scheduled-tasks', label: 'Scanning scheduled tasks', status: 'pending', itemsFound: 0 },
        ];
        const emit = (phaseId, message) => {
            const progress = {
                migrationId,
                serverId,
                provider: 'coolify',
                phase: phaseId,
                phases,
                message,
                totalItemsFound: items.length,
            };
            emitProgress(progress);
        };
        // Phase 1: Find PostgreSQL container
        const phaseFind = phases[0];
        phaseFind.status = 'running';
        emit('find-db', 'Locating Coolify PostgreSQL container...');
        let dbContainer;
        try {
            const containerOutput = await this.safeExec(serverId, sshService, 'docker ps --filter "name=coolify" --filter "ancestor=postgres" --format "{{.Names}}" 2>/dev/null');
            dbContainer = containerOutput.split('\n').filter(Boolean)[0] || '';
            if (!dbContainer) {
                // Fallback: try common name directly
                const fallbackExists = await this.dockerContainerExists(serverId, sshService, 'coolify-db');
                dbContainer = fallbackExists ? 'coolify-db' : '';
            }
            if (!dbContainer) {
                phaseFind.status = 'failed';
                emit('find-db', 'Could not find Coolify PostgreSQL container');
                return items;
            }
            phaseFind.status = 'completed';
            emit('find-db', `Found PostgreSQL container: ${dbContainer}`);
        }
        catch (err) {
            phaseFind.status = 'failed';
            emit('find-db', `Error locating PostgreSQL container: ${err instanceof Error ? err.message : String(err)}`);
            return items;
        }
        // Phase 2: Extract applications
        const phaseApps = phases[1];
        phaseApps.status = 'running';
        emit('applications', 'Extracting applications from Coolify database...');
        try {
            const appsOutput = await this.safeExec(serverId, sshService, `docker exec ${dbContainer} psql -U coolify -d coolify -t -A -F '|' -c "SELECT id, uuid, name, fqdn, git_repository, git_branch, build_pack, REPLACE(COALESCE(docker_compose_raw, ''), chr(10), '{{NL}}'), ports_exposes, status FROM applications WHERE deleted_at IS NULL"`);
            const apps = this.parseApplications(appsOutput);
            for (const app of apps) {
                const compose = app.dockerComposeRaw || this.generateComposeFromApp(app);
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'coolify_project',
                    remoteKey: `coolify-app-${app.uuid}`,
                    displayName: app.name || `App ${app.uuid}`,
                    description: this.buildAppDescription(app),
                    payload: {
                        coolifyId: app.id,
                        coolifyUuid: app.uuid,
                        fqdn: app.fqdn,
                        gitRepository: app.gitRepository,
                        gitBranch: app.gitBranch,
                        buildPack: app.buildPack,
                        dockerCompose: compose,
                        portsExposes: app.portsExposes,
                        status: app.status,
                        sourceType: 'coolify_application',
                    },
                    providerSource: 'coolify',
                    priority: 10,
                    dependsOn: [],
                };
                items.push(item);
            }
            phaseApps.itemsFound = apps.length;
            phaseApps.status = 'completed';
            emit('applications', `Found ${apps.length} application(s)`);
        }
        catch (err) {
            phaseApps.status = 'failed';
            emit('applications', `Error scanning applications: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 3: Extract services (docker compose one-click apps)
        const phaseServices = phases[2];
        phaseServices.status = 'running';
        emit('services', 'Extracting services from Coolify database...');
        try {
            const servicesOutput = await this.safeExec(serverId, sshService, `docker exec ${dbContainer} psql -U coolify -d coolify -t -A -F '|' -c "SELECT id, uuid, name, REPLACE(COALESCE(docker_compose_raw, ''), chr(10), '{{NL}}'), service_type, status FROM services WHERE deleted_at IS NULL"`);
            const services = this.parseServices(servicesOutput);
            for (const svc of services) {
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'docker_stack',
                    remoteKey: `coolify-svc-${svc.uuid}`,
                    displayName: svc.name || svc.serviceType || `Service ${svc.uuid}`,
                    description: `Coolify service (${svc.serviceType || 'compose'}) - Status: ${svc.status || 'unknown'}`,
                    payload: {
                        coolifyId: svc.id,
                        coolifyUuid: svc.uuid,
                        serviceType: svc.serviceType,
                        dockerCompose: svc.dockerComposeRaw || '',
                        status: svc.status,
                        sourceType: 'coolify_service',
                    },
                    providerSource: 'coolify',
                    priority: 20,
                    dependsOn: [],
                };
                items.push(item);
            }
            phaseServices.itemsFound = services.length;
            phaseServices.status = 'completed';
            emit('services', `Found ${services.length} service(s)`);
        }
        catch (err) {
            phaseServices.status = 'failed';
            emit('services', `Error scanning services: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 4: Extract databases
        const phaseDbs = phases[3];
        phaseDbs.status = 'running';
        emit('databases', 'Extracting databases from Coolify database...');
        try {
            const dbsOutput = await this.safeExec(serverId, sshService, `docker exec ${dbContainer} psql -U coolify -d coolify -t -A -F '|' -c "SELECT id, name, 'postgres' as type, postgres_user, postgres_db, public_port, status FROM standalone_postgresqls WHERE deleted_at IS NULL UNION ALL SELECT id, name, 'mysql' as type, mysql_user, mysql_database, public_port, status FROM standalone_mysqls WHERE deleted_at IS NULL"`);
            const databases = this.parseDatabases(dbsOutput);
            for (const db of databases) {
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'database',
                    remoteKey: `coolify-db-${db.id}`,
                    displayName: db.name || `${db.type} database`,
                    description: `${db.type.toUpperCase()} database "${db.database || db.name}" - Port: ${db.publicPort || 'internal'} - Status: ${db.status || 'unknown'}`,
                    payload: {
                        coolifyId: db.id,
                        dbType: db.type,
                        dbUser: db.user,
                        dbName: db.database,
                        publicPort: db.publicPort,
                        status: db.status,
                        sourceType: 'coolify_database',
                    },
                    providerSource: 'coolify',
                    priority: 5,
                    dependsOn: [],
                };
                items.push(item);
            }
            phaseDbs.itemsFound = databases.length;
            phaseDbs.status = 'completed';
            emit('databases', `Found ${databases.length} database(s)`);
        }
        catch (err) {
            phaseDbs.status = 'failed';
            emit('databases', `Error scanning databases: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Phase 5: Extract scheduled tasks
        const phaseTasks = phases[4];
        phaseTasks.status = 'running';
        emit('scheduled-tasks', 'Extracting scheduled tasks from Coolify database...');
        try {
            const tasksOutput = await this.safeExec(serverId, sshService, `docker exec ${dbContainer} psql -U coolify -d coolify -t -A -F '|' -c "SELECT id, name, command, frequency FROM scheduled_tasks WHERE deleted_at IS NULL AND enabled = true"`);
            const tasks = this.parseScheduledTasks(tasksOutput);
            for (const task of tasks) {
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'cron_job',
                    remoteKey: `coolify-task-${task.id}`,
                    displayName: task.name || `Scheduled task ${task.id}`,
                    description: `Schedule: ${task.frequency} - Command: ${task.command}`,
                    payload: {
                        coolifyId: task.id,
                        command: task.command,
                        frequency: task.frequency,
                        sourceType: 'coolify_scheduled_task',
                    },
                    providerSource: 'coolify',
                    priority: 30,
                    dependsOn: [],
                };
                items.push(item);
            }
            phaseTasks.itemsFound = tasks.length;
            phaseTasks.status = 'completed';
            emit('scheduled-tasks', `Found ${tasks.length} scheduled task(s)`);
        }
        catch (err) {
            phaseTasks.status = 'failed';
            emit('scheduled-tasks', `Error scanning scheduled tasks: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Final progress emit
        emit('complete', `Scan complete. Found ${items.length} total item(s).`);
        return items;
    }
    // ─── Decommission ─────────────────────────────────────────────
    async getDecommissionPlan(_serverId, _sshService) {
        return {
            provider: 'coolify',
            steps: [
                {
                    id: 'backup-coolify-db',
                    label: 'Backup Coolify database',
                    command: 'docker exec coolify-db pg_dump -U coolify coolify > /tmp/coolify_backup_$(date +%Y%m%d).sql',
                    dangerous: false,
                    executed: false,
                },
                {
                    id: 'stop-coolify',
                    label: 'Stop Coolify containers',
                    command: 'cd /data/coolify/source && docker compose -f docker-compose.yml -f docker-compose.prod.yml down',
                    dangerous: false,
                    executed: false,
                },
                {
                    id: 'remove-coolify',
                    label: 'Remove Coolify containers and data',
                    command: 'cd /data/coolify/source && docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v && rm -rf /data/coolify',
                    dangerous: true,
                    executed: false,
                },
            ],
            warnings: [
                'Stopping Coolify will make all Coolify-managed apps unavailable.',
                'A DB backup will be created before removal.',
                'Coolify Traefik proxy will also stop.',
            ],
        };
    }
    // ─── Parsing Helpers ──────────────────────────────────────────
    parseApplications(output) {
        if (!output.trim())
            return [];
        return output
            .trim()
            .split('\n')
            .filter(line => line.trim().length > 0 && line.includes('|'))
            .map(line => {
            const parts = line.split('|');
            return {
                id: parts[0] || '',
                uuid: parts[1] || '',
                name: parts[2] || '',
                fqdn: parts[3] || '',
                gitRepository: parts[4] || '',
                gitBranch: parts[5] || '',
                buildPack: parts[6] || '',
                dockerComposeRaw: (parts[7] || '').replaceAll('{{NL}}', '\n'),
                portsExposes: parts[8] || '',
                status: parts[9] || '',
            };
        })
            .filter(app => /^\d+$/.test(app.id));
    }
    parseServices(output) {
        if (!output.trim())
            return [];
        return output
            .trim()
            .split('\n')
            .filter(line => line.trim().length > 0 && line.includes('|'))
            .map(line => {
            const parts = line.split('|');
            return {
                id: parts[0] || '',
                uuid: parts[1] || '',
                name: parts[2] || '',
                dockerComposeRaw: (parts[3] || '').replaceAll('{{NL}}', '\n'),
                serviceType: parts[4] || '',
                status: parts[5] || '',
            };
        })
            .filter(svc => /^\d+$/.test(svc.id));
    }
    parseDatabases(output) {
        if (!output.trim())
            return [];
        return output
            .trim()
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => {
            const parts = line.split('|');
            return {
                id: parts[0] || '',
                name: parts[1] || '',
                type: parts[2] || '',
                user: parts[3] || '',
                database: parts[4] || '',
                publicPort: parts[5] || '',
                status: parts[6] || '',
            };
        })
            .filter(db => /^\d+$/.test(db.id));
    }
    parseScheduledTasks(output) {
        if (!output.trim())
            return [];
        return output
            .trim()
            .split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => {
            const parts = line.split('|');
            return {
                id: parts[0] || '',
                name: parts[1] || '',
                command: parts[2] || '',
                frequency: parts[3] || '',
            };
        })
            .filter(task => /^\d+$/.test(task.id));
    }
    // ─── Compose Generation ────────────────────────────────────────
    generateComposeFromApp(app) {
        const ports = app.portsExposes?.split(',').map(p => p.trim()).filter(Boolean) || ['3000'];
        const name = (app.name || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const image = `${name}:latest`;
        return [
            'services:',
            `  ${name}:`,
            `    image: ${image}`,
            '    ports:',
            ...ports.map(p => `      - "${p}:${p}"`),
            '    restart: unless-stopped',
        ].join('\n');
    }
    buildAppDescription(app) {
        const parts = [];
        if (app.buildPack) {
            parts.push(`Build: ${app.buildPack}`);
        }
        if (app.gitRepository) {
            const repo = app.gitRepository;
            const branch = app.gitBranch ? `@${app.gitBranch}` : '';
            parts.push(`Repo: ${repo}${branch}`);
        }
        if (app.fqdn) {
            parts.push(`Domain: ${app.fqdn}`);
        }
        if (app.status) {
            parts.push(`Status: ${app.status}`);
        }
        return parts.join(' | ') || 'Coolify application';
    }
}
exports.CoolifyProvider = CoolifyProvider;
//# sourceMappingURL=CoolifyProvider.js.map