"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DokployProvider = void 0;
const crypto_1 = require("crypto");
const BaseProvider_1 = require("./BaseProvider");
// ─── Provider Implementation ─────────────────────────────────────
class DokployProvider extends BaseProvider_1.BaseProvider {
    providerId = 'dokploy';
    displayName = 'Dokploy';
    description = 'Dokploy PaaS — Docker Swarm-based deployment platform with PostgreSQL metadata store';
    // ─── Detection ───────────────────────────────────────────────
    async detect(serverId, sshService) {
        const metadata = {};
        let confidence = 0;
        // Check 1: dokploy-postgres container running
        const postgresContainer = await this.safeExec(serverId, sshService, 'docker ps --filter "name=dokploy-postgres" --format "{{.Names}}" 2>/dev/null');
        const hasPostgresContainer = postgresContainer.length > 0;
        metadata.postgresContainer = hasPostgresContainer;
        // Check 2: /etc/dokploy/ directory exists
        const dokployDir = await this.pathExists(serverId, sshService, '/etc/dokploy');
        metadata.dokployDir = dokployDir;
        // Check 3: Docker Swarm with dokploy-network
        const dokployNetwork = await this.safeExec(serverId, sshService, 'docker network ls --filter "name=dokploy-network" --format "{{.Name}}" 2>/dev/null');
        const hasDokployNetwork = dokployNetwork.length > 0;
        metadata.dokployNetwork = hasDokployNetwork;
        // Confidence scoring
        if (hasPostgresContainer && dokployDir) {
            confidence = 0.95;
        }
        else if (hasDokployNetwork && !hasPostgresContainer && !dokployDir) {
            // Only Swarm with dokploy-network, no postgres or directory
            confidence = 0.7;
        }
        else if (dokployDir && !hasPostgresContainer) {
            confidence = 0.5;
        }
        else if (hasPostgresContainer && !dokployDir) {
            confidence = 0.7;
        }
        else {
            confidence = 0.0;
        }
        // Try to get Dokploy version if detected
        if (confidence > 0) {
            const versionOutput = await this.safeExec(serverId, sshService, 'docker inspect dokploy --format "{{.Config.Image}}" 2>/dev/null');
            if (versionOutput) {
                const versionMatch = versionOutput.match(/:(.+)$/);
                metadata.version = versionMatch ? versionMatch[1] : versionOutput;
            }
        }
        return {
            provider: 'dokploy',
            version: metadata.version || null,
            confidence,
            metadata,
        };
    }
    // ─── Scan ────────────────────────────────────────────────────
    async scan(ctx) {
        const { migrationId, serverId, sshService, emitProgress } = ctx;
        const items = [];
        const phases = [
            { id: 'find_postgres', label: 'Finding PostgreSQL container', status: 'pending', itemsFound: 0 },
            { id: 'applications', label: 'Extracting applications', status: 'pending', itemsFound: 0 },
            { id: 'compose', label: 'Extracting compose apps', status: 'pending', itemsFound: 0 },
            { id: 'domains', label: 'Extracting domains', status: 'pending', itemsFound: 0 },
            { id: 'databases', label: 'Extracting databases', status: 'pending', itemsFound: 0 },
        ];
        const emit = (phaseId, message) => {
            const progress = {
                migrationId,
                serverId,
                provider: 'dokploy',
                phase: phaseId,
                phases: [...phases],
                message,
                totalItemsFound: items.length,
            };
            emitProgress(progress);
        };
        const updatePhase = (id, status, itemsFound) => {
            const phase = phases.find(p => p.id === id);
            if (phase) {
                phase.status = status;
                if (itemsFound !== undefined)
                    phase.itemsFound = itemsFound;
            }
        };
        // ── Phase 1: Find PostgreSQL container ID ──────────────────
        updatePhase('find_postgres', 'running');
        emit('find_postgres', 'Looking for dokploy-postgres container...');
        let containerId = '';
        try {
            containerId = await this.safeExec(serverId, sshService, 'docker ps -q -f name=dokploy-postgres 2>/dev/null');
            // Take only first line if multiple results
            containerId = containerId.split('\n')[0]?.trim() || '';
        }
        catch {
            // handled below
        }
        if (!containerId) {
            updatePhase('find_postgres', 'failed');
            emit('find_postgres', 'Could not find dokploy-postgres container');
            // Mark remaining phases as skipped
            for (const p of phases) {
                if (p.status === 'pending') {
                    updatePhase(p.id, 'skipped');
                }
            }
            emit('find_postgres', 'Scan aborted: PostgreSQL container not found');
            return items;
        }
        updatePhase('find_postgres', 'completed');
        emit('find_postgres', `Found PostgreSQL container: ${containerId.substring(0, 12)}`);
        // ── Phase 2: Extract applications ──────────────────────────
        updatePhase('applications', 'running');
        emit('applications', 'Querying Dokploy applications...');
        try {
            const appQuery = `docker exec ${containerId} psql -U dokploy -d dokploy -t -A -F '|' -c "SELECT \\"applicationId\\", name, \\"appName\\", \\"sourceType\\", \\"buildType\\", repository, owner, branch, dockerfile, \\"dockerImage\\", env, \\"applicationStatus\\" FROM application"`;
            const appOutput = await this.safeExec(serverId, sshService, appQuery);
            const apps = this.parseApplications(appOutput);
            for (const app of apps) {
                const composeYaml = this.generateComposeFromApp(app);
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'dokploy_project',
                    remoteKey: `dokploy-app-${app.applicationId}`,
                    displayName: app.name || app.appName,
                    description: this.buildAppDescription(app),
                    payload: {
                        applicationId: app.applicationId,
                        name: app.name,
                        appName: app.appName,
                        sourceType: app.sourceType,
                        buildType: app.buildType,
                        repository: app.repository,
                        owner: app.owner,
                        branch: app.branch,
                        dockerfile: app.dockerfile,
                        dockerImage: app.dockerImage,
                        env: app.env,
                        applicationStatus: app.applicationStatus,
                        generatedCompose: composeYaml,
                    },
                    providerSource: 'dokploy',
                    priority: 10,
                    dependsOn: [],
                };
                items.push(item);
            }
            updatePhase('applications', 'completed', apps.length);
            emit('applications', `Found ${apps.length} application(s)`);
        }
        catch (err) {
            updatePhase('applications', 'failed');
            emit('applications', `Failed to extract applications: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 3: Extract compose apps ──────────────────────────
        updatePhase('compose', 'running');
        emit('compose', 'Querying Dokploy compose apps...');
        try {
            const composeQuery = `docker exec ${containerId} psql -U dokploy -d dokploy -t -A -F '|' -c "SELECT \\"composeId\\", name, \\"appName\\", \\"composeFile\\", env, \\"composeStatus\\", \\"sourceType\\" FROM compose"`;
            const composeOutput = await this.safeExec(serverId, sshService, composeQuery);
            const composeApps = this.parseComposeApps(composeOutput);
            for (const comp of composeApps) {
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'docker_stack',
                    remoteKey: `dokploy-compose-${comp.composeId}`,
                    displayName: comp.name || comp.appName,
                    description: `Compose app (${comp.sourceType || 'unknown source'}) - Status: ${comp.composeStatus || 'unknown'}`,
                    payload: {
                        composeId: comp.composeId,
                        name: comp.name,
                        appName: comp.appName,
                        composeFile: comp.composeFile,
                        env: comp.env,
                        composeStatus: comp.composeStatus,
                        sourceType: comp.sourceType,
                    },
                    providerSource: 'dokploy',
                    priority: 10,
                    dependsOn: [],
                };
                items.push(item);
            }
            updatePhase('compose', 'completed', composeApps.length);
            emit('compose', `Found ${composeApps.length} compose app(s)`);
        }
        catch (err) {
            updatePhase('compose', 'failed');
            emit('compose', `Failed to extract compose apps: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 4: Extract domains ───────────────────────────────
        updatePhase('domains', 'running');
        emit('domains', 'Querying Dokploy domains...');
        try {
            const domainQuery = `docker exec ${containerId} psql -U dokploy -d dokploy -t -A -F '|' -c "SELECT \\"domainId\\", host, https, port, \\"domainType\\", \\"applicationId\\", \\"composeId\\" FROM domain"`;
            const domainOutput = await this.safeExec(serverId, sshService, domainQuery);
            const domains = this.parseDomains(domainOutput);
            for (const domain of domains) {
                // Build dependency: link domain to its parent application or compose app
                const dependsOn = [];
                if (domain.applicationId) {
                    const parentApp = items.find(i => i.remoteKey === `dokploy-app-${domain.applicationId}`);
                    if (parentApp)
                        dependsOn.push(parentApp.id);
                }
                if (domain.composeId) {
                    const parentCompose = items.find(i => i.remoteKey === `dokploy-compose-${domain.composeId}`);
                    if (parentCompose)
                        dependsOn.push(parentCompose.id);
                }
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'domain',
                    remoteKey: `dokploy-domain-${domain.domainId}`,
                    displayName: domain.host,
                    description: `${domain.https === 'true' ? 'HTTPS' : 'HTTP'} - Port ${domain.port || 'auto'} (${domain.domainType || 'default'})`,
                    payload: {
                        domainId: domain.domainId,
                        host: domain.host,
                        https: domain.https === 'true',
                        port: domain.port ? parseInt(domain.port, 10) : null,
                        domainType: domain.domainType,
                        applicationId: domain.applicationId || null,
                        composeId: domain.composeId || null,
                    },
                    providerSource: 'dokploy',
                    priority: 20,
                    dependsOn,
                };
                items.push(item);
            }
            updatePhase('domains', 'completed', domains.length);
            emit('domains', `Found ${domains.length} domain(s)`);
        }
        catch (err) {
            updatePhase('domains', 'failed');
            emit('domains', `Failed to extract domains: ${err instanceof Error ? err.message : String(err)}`);
        }
        // ── Phase 5: Extract databases ─────────────────────────────
        updatePhase('databases', 'running');
        emit('databases', 'Querying Dokploy databases...');
        try {
            // PostgreSQL databases
            const pgQuery = `docker exec ${containerId} psql -U dokploy -d dokploy -t -A -F '|' -c "SELECT \\"postgresId\\", name, \\"databaseName\\", \\"databaseUser\\", \\"dockerImage\\" FROM postgres"`;
            const pgOutput = await this.safeExec(serverId, sshService, pgQuery);
            const pgDbs = this.parsePostgresDatabases(pgOutput);
            for (const db of pgDbs) {
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'database',
                    remoteKey: `dokploy-pg-${db.postgresId}`,
                    displayName: db.name,
                    description: `PostgreSQL - ${db.databaseName} (user: ${db.databaseUser}, image: ${db.dockerImage || 'default'})`,
                    payload: {
                        postgresId: db.postgresId,
                        name: db.name,
                        databaseName: db.databaseName,
                        databaseUser: db.databaseUser,
                        dockerImage: db.dockerImage,
                        engine: 'postgresql',
                    },
                    providerSource: 'dokploy',
                    priority: 5,
                    dependsOn: [],
                };
                items.push(item);
            }
            // MySQL databases
            const mysqlQuery = `docker exec ${containerId} psql -U dokploy -d dokploy -t -A -F '|' -c "SELECT \\"mysqlId\\", name, \\"databaseName\\", \\"databaseUser\\", \\"dockerImage\\" FROM mysql"`;
            const mysqlOutput = await this.safeExec(serverId, sshService, mysqlQuery);
            const mysqlDbs = this.parseMysqlDatabases(mysqlOutput);
            for (const db of mysqlDbs) {
                const item = {
                    id: (0, crypto_1.randomUUID)(),
                    itemType: 'database',
                    remoteKey: `dokploy-mysql-${db.mysqlId}`,
                    displayName: db.name,
                    description: `MySQL - ${db.databaseName} (user: ${db.databaseUser}, image: ${db.dockerImage || 'default'})`,
                    payload: {
                        mysqlId: db.mysqlId,
                        name: db.name,
                        databaseName: db.databaseName,
                        databaseUser: db.databaseUser,
                        dockerImage: db.dockerImage,
                        engine: 'mysql',
                    },
                    providerSource: 'dokploy',
                    priority: 5,
                    dependsOn: [],
                };
                items.push(item);
            }
            const totalDbs = pgDbs.length + mysqlDbs.length;
            updatePhase('databases', 'completed', totalDbs);
            emit('databases', `Found ${pgDbs.length} PostgreSQL and ${mysqlDbs.length} MySQL database(s)`);
        }
        catch (err) {
            updatePhase('databases', 'failed');
            emit('databases', `Failed to extract databases: ${err instanceof Error ? err.message : String(err)}`);
        }
        emit('databases', `Scan complete. Found ${items.length} total item(s)`);
        return items;
    }
    // ─── Decommission Plan ───────────────────────────────────────
    async getDecommissionPlan(_serverId, _sshService) {
        const steps = [
            {
                id: (0, crypto_1.randomUUID)(),
                label: 'Backup Dokploy PostgreSQL database',
                command: 'docker exec $(docker ps -q -f name=dokploy-postgres) pg_dump -U dokploy dokploy > /tmp/dokploy_backup_$(date +%Y%m%d).sql',
                dangerous: false,
                executed: false,
            },
            {
                id: (0, crypto_1.randomUUID)(),
                label: 'Stop all non-Dokploy services',
                command: 'docker service ls --format "{{.Name}}" | grep -v "^dokploy" | xargs -r docker service rm',
                dangerous: true,
                executed: false,
            },
            {
                id: (0, crypto_1.randomUUID)(),
                label: 'Remove Dokploy stack',
                command: 'docker stack rm dokploy',
                dangerous: true,
                executed: false,
            },
            {
                id: (0, crypto_1.randomUUID)(),
                label: 'Leave Docker Swarm',
                command: 'docker swarm leave --force',
                dangerous: true,
                executed: false,
            },
        ];
        return {
            provider: 'dokploy',
            steps,
            warnings: [
                'Removing Dokploy will stop all services managed by it.',
                'Leaving Docker Swarm converts the host to standalone Docker mode.',
                'A PostgreSQL backup will be created at /tmp/dokploy_backup_<date>.sql before removal.',
            ],
        };
    }
    // ─── Private Helpers: Parsing ────────────────────────────────
    /**
     * Parse pipe-delimited psql output into application records.
     * Each row has 12 columns separated by '|'.
     */
    parseApplications(output) {
        if (!output.trim())
            return [];
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
            const cols = line.split('|');
            if (cols.length < 12)
                return null;
            return {
                applicationId: cols[0],
                name: cols[1],
                appName: cols[2],
                sourceType: cols[3],
                buildType: cols[4],
                repository: cols[5],
                owner: cols[6],
                branch: cols[7],
                dockerfile: cols[8],
                dockerImage: cols[9],
                env: cols[10],
                applicationStatus: cols[11],
            };
        })
            .filter((app) => app !== null);
    }
    /**
     * Parse pipe-delimited psql output into compose records.
     * Each row has 7 columns separated by '|'.
     */
    parseComposeApps(output) {
        if (!output.trim())
            return [];
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
            const cols = line.split('|');
            if (cols.length < 7)
                return null;
            return {
                composeId: cols[0],
                name: cols[1],
                appName: cols[2],
                composeFile: cols[3],
                env: cols[4],
                composeStatus: cols[5],
                sourceType: cols[6],
            };
        })
            .filter((comp) => comp !== null);
    }
    /**
     * Parse pipe-delimited psql output into domain records.
     * Each row has 7 columns separated by '|'.
     */
    parseDomains(output) {
        if (!output.trim())
            return [];
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
            const cols = line.split('|');
            if (cols.length < 7)
                return null;
            return {
                domainId: cols[0],
                host: cols[1],
                https: cols[2],
                port: cols[3],
                domainType: cols[4],
                applicationId: cols[5],
                composeId: cols[6],
            };
        })
            .filter((d) => d !== null);
    }
    /**
     * Parse pipe-delimited psql output into PostgreSQL database records.
     * Each row has 5 columns separated by '|'.
     */
    parsePostgresDatabases(output) {
        if (!output.trim())
            return [];
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
            const cols = line.split('|');
            if (cols.length < 5)
                return null;
            return {
                postgresId: cols[0],
                name: cols[1],
                databaseName: cols[2],
                databaseUser: cols[3],
                dockerImage: cols[4],
            };
        })
            .filter((d) => d !== null);
    }
    /**
     * Parse pipe-delimited psql output into MySQL database records.
     * Each row has 5 columns separated by '|'.
     */
    parseMysqlDatabases(output) {
        if (!output.trim())
            return [];
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
            const cols = line.split('|');
            if (cols.length < 5)
                return null;
            return {
                mysqlId: cols[0],
                name: cols[1],
                databaseName: cols[2],
                databaseUser: cols[3],
                dockerImage: cols[4],
            };
        })
            .filter((d) => d !== null);
    }
    /**
     * Generate a minimal Docker Compose YAML for a non-compose Dokploy application.
     */
    generateComposeFromApp(app) {
        const name = (app.appName || app.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const image = app.dockerImage || `${name}:latest`;
        return `services:\n  ${name}:\n    image: ${image}\n    restart: unless-stopped`;
    }
    /**
     * Build a human-readable description string for an application.
     */
    buildAppDescription(app) {
        const parts = [];
        if (app.sourceType)
            parts.push(`Source: ${app.sourceType}`);
        if (app.buildType)
            parts.push(`Build: ${app.buildType}`);
        if (app.repository && app.owner) {
            parts.push(`Repo: ${app.owner}/${app.repository}`);
        }
        else if (app.repository) {
            parts.push(`Repo: ${app.repository}`);
        }
        if (app.branch)
            parts.push(`Branch: ${app.branch}`);
        if (app.applicationStatus)
            parts.push(`Status: ${app.applicationStatus}`);
        if (app.dockerImage)
            parts.push(`Image: ${app.dockerImage}`);
        return parts.length > 0 ? parts.join(' | ') : 'Dokploy application';
    }
}
exports.DokployProvider = DokployProvider;
//# sourceMappingURL=DokployProvider.js.map