"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseService = exports.DatabaseService = void 0;
const electron_1 = require("electron");
const events_1 = require("events");
const crypto_1 = require("crypto");
const types_1 = require("../ipc/types");
const db_1 = require("../db");
const SSHService_1 = require("./SSHService");
const CredentialVault_1 = require("./CredentialVault");
const POSTGRES_DEFAULT_PORT = 5432;
const MYSQL_DEFAULT_PORT = 3306;
const SUPABASE_STUDIO_PORT = 8000;
class DatabaseService extends events_1.EventEmitter {
    vault;
    constructor() {
        super();
        this.vault = new CredentialVault_1.CredentialVault();
    }
    /**
     * Find an available port starting from the preferred port
     * Checks both running processes and existing database records to avoid conflicts
     */
    async findAvailablePort(serverId, preferredPort, maxAttempts = 100) {
        // Get all existing databases on this server to check for port conflicts
        const existingDatabases = db_1.queries.getDatabasesByServer(serverId);
        const usedPorts = new Set();
        for (const db of existingDatabases) {
            if (db.encrypted_credentials) {
                try {
                    const credentials = JSON.parse(await this.vault.decrypt(db.encrypted_credentials));
                    usedPorts.add(credentials.port);
                }
                catch (error) {
                    console.warn('[DatabaseService] Failed to decrypt credentials when checking ports', error);
                }
            }
        }
        let port = preferredPort;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Check if port is already assigned to a database
            if (usedPorts.has(port)) {
                port++;
                if (port <= 1023) {
                    port = 1024;
                }
                else if (port > 65535) {
                    port = 1024;
                }
                continue;
            }
            // Check if port is currently in use on the server
            const portCheck = await SSHService_1.sshService.executeCommand(serverId, `if ss -tulpn | grep -q ":${port} "; then echo "used"; else echo "free"; fi`);
            if (portCheck.stdout.trim() === 'free') {
                return port;
            }
            // Try next port
            port++;
            // Skip well-known ports (1-1023) and wrap around if we exceed 65535
            if (port <= 1023) {
                port = 1024;
            }
            else if (port > 65535) {
                port = 1024;
            }
        }
        throw new Error(`Could not find an available port after ${maxAttempts} attempts`);
    }
    /**
     * Run lightweight checks before provisioning begins
     */
    async runPreflight(input) {
        const result = {
            passed: true,
            checks: {
                disk: { passed: true, message: 'Enough disk space available' },
                ram: { passed: true, message: 'Sufficient memory detected' },
                ports: { passed: true, message: 'Required ports are available' },
                deps: { passed: true, message: 'Dependencies ready' },
                network: { passed: true, message: 'Network connectivity looks good' },
            },
        };
        try {
            const serverId = input.serverId;
            const requiredDiskGb = input.type === 'supabase' ? 15 : 5;
            const disk = await SSHService_1.sshService.executeCommand(serverId, `df -BG --output=avail / | tail -1 | tr -dc '0-9'`);
            const availableDisk = Number.parseInt(disk.stdout, 10);
            result.checks.disk.available = availableDisk;
            result.checks.disk.required = requiredDiskGb;
            if (!Number.isFinite(availableDisk) || availableDisk < requiredDiskGb) {
                result.checks.disk = {
                    passed: false,
                    message: `This server needs a bit more space (${requiredDiskGb} GB required)`,
                    available: availableDisk,
                    required: requiredDiskGb,
                    details: disk.stdout,
                };
                result.passed = false;
            }
        }
        catch (error) {
            result.checks.disk = {
                passed: false,
                message: 'Unable to verify available disk space right now',
                details: String(error),
            };
            result.passed = false;
        }
        try {
            const ram = await SSHService_1.sshService.executeCommand(input.serverId, `free -m | awk 'NR==2 { print $2" "$7 }'`);
            const [totalStr, freeStr] = ram.stdout.trim().split(' ');
            const totalMb = Number.parseInt(totalStr, 10);
            const freeMb = Number.parseInt(freeStr, 10);
            const requiredRamMb = input.type === 'supabase' ? 2048 : 1024;
            result.checks.ram.available = totalMb;
            result.checks.ram.required = requiredRamMb;
            if (!Number.isFinite(totalMb) || totalMb < requiredRamMb) {
                result.checks.ram = {
                    passed: false,
                    message: `At least ${Math.ceil(requiredRamMb / 1024)} GB RAM is recommended`,
                    available: totalMb,
                    required: requiredRamMb,
                    details: ram.stdout,
                };
                result.passed = false;
            }
            else if (freeMb < requiredRamMb / 2) {
                result.checks.ram = {
                    passed: true,
                    message: 'Memory is a little tight—closing unused apps helps speed up setup',
                    available: totalMb,
                    required: requiredRamMb,
                    details: ram.stdout,
                };
            }
        }
        catch (error) {
            result.checks.ram = {
                passed: false,
                message: 'Unable to verify memory right now',
                details: String(error),
            };
            result.passed = false;
        }
        try {
            const requiredPort = input.requestedPort ??
                (input.type === 'postgres'
                    ? POSTGRES_DEFAULT_PORT
                    : input.type === 'mysql'
                        ? MYSQL_DEFAULT_PORT
                        : SUPABASE_STUDIO_PORT);
            const portCheck = await SSHService_1.sshService.executeCommand(input.serverId, `if ss -tulpn | grep -q ":${requiredPort} "; then echo "used"; else echo "free"; fi`);
            const available = portCheck.stdout.trim() !== 'used';
            if (!available) {
                // Port is in use, find an available alternative
                try {
                    const assignedPort = await this.findAvailablePort(input.serverId, requiredPort);
                    result.assignedPort = assignedPort;
                    result.checks.ports = {
                        passed: true,
                        message: `Port ${requiredPort} was in use, assigned port ${assignedPort} instead`,
                        available: assignedPort,
                        required: requiredPort,
                    };
                }
                catch (error) {
                    // Could not find an available port
                    result.checks.ports = {
                        passed: false,
                        message: `Port ${requiredPort} is in use and no alternative ports are available`,
                        available: 'used',
                        required: requiredPort,
                        details: String(error),
                    };
                    result.passed = false;
                }
            }
            else {
                // Requested port is available
                result.assignedPort = requiredPort;
                result.checks.ports = {
                    passed: true,
                    message: 'All set—required ports are available',
                    available: 'free',
                    required: requiredPort,
                };
            }
        }
        catch (error) {
            result.checks.ports = {
                passed: false,
                message: 'Unable to confirm port availability right now',
                details: String(error),
            };
            result.passed = false;
        }
        try {
            if (input.type === 'supabase') {
                const dockerCheck = await SSHService_1.sshService.executeCommand(input.serverId, `command -v docker || echo "missing"`);
                const dockerComposeCheck = await SSHService_1.sshService.executeCommand(input.serverId, `command -v docker-compose || docker compose version >/dev/null 2>&1 || echo "missing"`);
                if (dockerCheck.stdout.trim() === 'missing') {
                    result.checks.deps = {
                        passed: false,
                        message: 'Supabase needs Docker to run its services',
                        details: dockerCheck.stderr || dockerCheck.stdout,
                    };
                    result.passed = false;
                }
                else if (dockerComposeCheck.stdout.trim() === 'missing') {
                    result.checks.deps = {
                        passed: false,
                        message: 'Docker Compose is required to start Supabase',
                        details: dockerComposeCheck.stderr || dockerComposeCheck.stdout,
                    };
                    result.passed = false;
                }
            }
            else {
                result.checks.deps = {
                    passed: true,
                    message: 'Server has everything needed',
                };
            }
        }
        catch (error) {
            result.checks.deps = {
                passed: false,
                message: 'Unable to verify dependencies right now',
                details: String(error),
            };
            result.passed = false;
        }
        try {
            const network = await SSHService_1.sshService.executeCommand(input.serverId, 'curl -Is https://www.postgresql.org >/dev/null 2>&1 && echo "ok" || echo "unreachable"');
            const ok = network.stdout.trim() === 'ok';
            result.checks.network = {
                passed: ok,
                message: ok
                    ? 'Server can reach required download servers'
                    : 'Network looks restricted—try again or check firewall rules',
            };
            result.passed = result.passed && ok;
        }
        catch (error) {
            result.checks.network = {
                passed: false,
                message: 'Unable to verify network connectivity right now',
                details: String(error),
            };
            result.passed = false;
        }
        return result;
    }
    /**
     * Create a database and kick off provisioning
     */
    async createDatabase(input) {
        const databaseId = (0, crypto_1.randomUUID)();
        const operationId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        const databaseRecord = {
            id: databaseId,
            server_id: input.serverId,
            name: input.name,
            type: input.type,
            status: 'creating',
            access: input.access ?? 'internal',
            version: input.engineVersion ?? null,
            encrypted_credentials: null,
            metadata: null,
            stats: null,
            last_error: null,
            provision_duration_ms: null,
            last_operation_id: operationId,
            last_activity_at: now,
        };
        db_1.queries.createDatabase({
            ...databaseRecord,
            created_at: now,
            updated_at: now,
        });
        const operationRecord = {
            id: operationId,
            database_id: databaseId,
            server_id: input.serverId,
            type: 'provision',
            status: 'pending',
            started_at: now,
            finished_at: null,
            progress: 0,
            summary: null,
            meta: null,
            error_message: null,
            log: '[]',
        };
        db_1.queries.createDatabaseOperation(operationRecord);
        // Kick off provisioning asynchronously
        setImmediate(() => {
            this.provisionDatabase(databaseId, operationId, input, null).catch((error) => {
                console.error('[DatabaseService] Provisioning failed:', error);
            });
        });
        return { databaseId };
    }
    async retryProvision(databaseId) {
        const record = db_1.queries.getDatabaseById(databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        let existingCredentials = null;
        if (record.encrypted_credentials) {
            try {
                existingCredentials = JSON.parse(await this.vault.decrypt(record.encrypted_credentials));
            }
            catch (error) {
                console.warn('[DatabaseService] Unable to reuse credentials for retry', error);
            }
        }
        const input = {
            serverId: record.server_id,
            name: record.name,
            type: record.type,
            engineVersion: record.version ?? undefined,
            access: record.access,
            requestedPort: existingCredentials?.port,
        };
        const operationId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        db_1.queries.createDatabaseOperation({
            id: operationId,
            database_id: record.id,
            server_id: record.server_id,
            type: 'provision',
            status: 'pending',
            started_at: now,
            finished_at: null,
            progress: 0,
            summary: null,
            meta: null,
            error_message: null,
            log: '[]',
        });
        db_1.queries.updateDatabase(record.id, {
            status: 'creating',
            last_operation_id: operationId,
            last_error: null,
            last_activity_at: now,
        });
        setImmediate(() => {
            this.provisionDatabase(record.id, operationId, input, existingCredentials).catch((error) => {
                console.error('[DatabaseService] Retry provisioning failed:', error);
            });
        });
        return { operationId };
    }
    /**
     * Rotate password / credentials for a database
     */
    async rotateCredentials(databaseId) {
        const record = db_1.queries.getDatabaseById(databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        if (!record.encrypted_credentials) {
            throw new Error('Database is not ready yet');
        }
        const credentials = JSON.parse(await this.vault.decrypt(record.encrypted_credentials));
        credentials.password = this.generatePassword();
        credentials.connectionString = this.buildConnectionString(credentials);
        await this.applyPasswordRotation(record, credentials);
        const encrypted = await this.vault.encrypt(JSON.stringify(credentials));
        db_1.queries.updateDatabase(databaseId, {
            encrypted_credentials: encrypted,
            last_activity_at: Date.now(),
        });
        if (record.type === 'postgres' && credentials.username === 'postgres') {
            const siblings = db_1.queries.getDatabasesByServer(record.server_id);
            for (const sibling of siblings) {
                if (sibling.id === record.id ||
                    sibling.type !== 'postgres' ||
                    !sibling.encrypted_credentials) {
                    continue;
                }
                try {
                    const siblingCredentials = JSON.parse(await this.vault.decrypt(sibling.encrypted_credentials));
                    siblingCredentials.password = credentials.password;
                    siblingCredentials.connectionString = this.buildConnectionString(siblingCredentials);
                    const siblingEncrypted = await this.vault.encrypt(JSON.stringify(siblingCredentials));
                    db_1.queries.updateDatabase(sibling.id, {
                        encrypted_credentials: siblingEncrypted,
                        last_activity_at: Date.now(),
                    });
                }
                catch (error) {
                    console.warn('[DatabaseService] Failed to propagate rotated postgres credentials to sibling database', sibling.id, error);
                }
            }
        }
        return {
            password: credentials.password,
            connectionString: credentials.connectionString,
            extras: credentials.extras,
        };
    }
    /**
     * Toggle public access settings
     */
    async updateExternalAccess(input) {
        const record = db_1.queries.getDatabaseById(input.databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        // Apply firewall and configuration changes based on database type
        try {
            if (record.type === 'postgres') {
                await this.togglePostgresAccess(record.server_id, input.enabled);
            }
            else if (record.type === 'mysql') {
                await this.toggleMySQLAccess(record.server_id, input.enabled);
            }
            else if (record.type === 'supabase') {
                // Supabase runs in Docker and typically has its own networking
                console.warn('[DatabaseService] Supabase access toggle not yet fully implemented');
            }
            db_1.queries.updateDatabase(record.id, {
                access: input.enabled ? 'public' : 'internal',
                metadata: input.cidrAllowList?.length
                    ? JSON.stringify({
                        ...(record.metadata ? JSON.parse(record.metadata) : {}),
                        cidrAllowList: input.cidrAllowList,
                        lastAccessToggleReason: input.reason,
                        lastAccessToggleAt: Date.now(),
                    })
                    : record.metadata,
                last_activity_at: Date.now(),
            });
            return { success: true };
        }
        catch (error) {
            console.error('[DatabaseService] Failed to toggle access:', error);
            throw new Error(`Failed to toggle database access: ${String(error)}`);
        }
    }
    async togglePostgresAccess(serverId, enablePublic) {
        if (enablePublic) {
            // Enable public access
            // 1. Add remote access rule to pg_hba.conf
            await SSHService_1.sshService.executeCommand(serverId, `sudo bash -c "grep -qxF \\"host    all    all    0.0.0.0/0    md5\\" /etc/postgresql/*/main/pg_hba.conf || echo \\"host    all    all    0.0.0.0/0    md5\\" >> /etc/postgresql/*/main/pg_hba.conf"`);
            // 2. Configure PostgreSQL to listen on all interfaces
            await SSHService_1.sshService.executeCommand(serverId, `sudo sed -i "s/^#\\\\?listen_addresses = .*/listen_addresses = '*'/" /etc/postgresql/*/main/postgresql.conf`);
            // 3. Open firewall port
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw allow 5432/tcp || true`);
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw reload || true`);
        }
        else {
            // Disable public access (revert to internal only)
            // 1. Remove remote access rule from pg_hba.conf
            await SSHService_1.sshService.executeCommand(serverId, `sudo sed -i '/^host    all    all    0.0.0.0\\/0    md5$/d' /etc/postgresql/*/main/pg_hba.conf`);
            // 2. Configure PostgreSQL to listen only on localhost
            await SSHService_1.sshService.executeCommand(serverId, `sudo sed -i "s/^#\\\\?listen_addresses = .*/listen_addresses = 'localhost'/" /etc/postgresql/*/main/postgresql.conf`);
            // 3. Close firewall port
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw delete allow 5432/tcp || true`);
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw reload || true`);
        }
        // 4. Restart PostgreSQL to apply changes
        await SSHService_1.sshService.executeCommand(serverId, `sudo systemctl restart postgresql`);
    }
    async toggleMySQLAccess(serverId, enablePublic) {
        if (enablePublic) {
            // Enable public access for MySQL
            // 1. Update bind-address to allow external connections
            await SSHService_1.sshService.executeCommand(serverId, `sudo sed -i "s/^bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/mysql.conf.d/mysqld.cnf || sudo sed -i "s/^bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/my.cnf || true`);
            // 2. Open firewall port
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw allow 3306/tcp || true`);
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw reload || true`);
        }
        else {
            // Disable public access (revert to internal only)
            // 1. Update bind-address to localhost only
            await SSHService_1.sshService.executeCommand(serverId, `sudo sed -i "s/^bind-address.*/bind-address = 127.0.0.1/" /etc/mysql/mysql.conf.d/mysqld.cnf || sudo sed -i "s/^bind-address.*/bind-address = 127.0.0.1/" /etc/mysql/my.cnf || true`);
            // 2. Close firewall port
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw delete allow 3306/tcp || true`);
            await SSHService_1.sshService.executeCommand(serverId, `sudo ufw reload || true`);
        }
        // 3. Restart MySQL to apply changes
        await SSHService_1.sshService.executeCommand(serverId, `sudo systemctl restart mysql`);
    }
    /**
     * Delete database resources
     */
    async deleteDatabase(databaseId, force = false) {
        const record = db_1.queries.getDatabaseById(databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        db_1.queries.updateDatabase(databaseId, {
            status: 'removing',
            last_activity_at: Date.now(),
        });
        try {
            await this.teardownDatabase(record, force);
            db_1.queries.deleteDatabase(databaseId);
            return { success: true };
        }
        catch (error) {
            db_1.queries.updateDatabase(databaseId, {
                status: 'needs_attention',
                last_error: String(error),
                last_activity_at: Date.now(),
            });
            return { success: false };
        }
    }
    async getCredentials(databaseId) {
        const record = db_1.queries.getDatabaseById(databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        if (!record.encrypted_credentials) {
            throw new Error('Database is not ready yet');
        }
        const credentials = JSON.parse(await this.vault.decrypt(record.encrypted_credentials));
        return credentials;
    }
    /**
     * Internal: orchestrate provisioning flow
     */
    async provisionDatabase(databaseId, operationId, input, existingCredentials) {
        const databaseRecord = db_1.queries.getDatabaseById(databaseId);
        const operationRecord = db_1.queries.getDatabaseOperationById(operationId);
        if (!databaseRecord || !operationRecord) {
            console.error('[DatabaseService] Database or operation record missing');
            return;
        }
        let reuseCredentials = existingCredentials ?? null;
        if (!reuseCredentials && databaseRecord.encrypted_credentials) {
            try {
                reuseCredentials = JSON.parse(await this.vault.decrypt(databaseRecord.encrypted_credentials));
            }
            catch (error) {
                console.warn('[DatabaseService] Failed to decrypt existing credentials for reuse', error);
            }
        }
        const credentials = await this.prepareCredentials(databaseRecord, input, reuseCredentials);
        const phases = this.buildPhases(databaseRecord.type, credentials, input);
        const context = {
            database: databaseRecord,
            operation: operationRecord,
            input,
            credentials,
            phases,
        };
        const totalCommands = phases.reduce((count, phase) => count + phase.commands.length, 0);
        let completedCommands = 0;
        let currentLog = [];
        db_1.queries.updateDatabase(databaseId, {
            status: 'provisioning',
            last_activity_at: Date.now(),
        });
        db_1.queries.updateDatabaseOperation(operationId, {
            status: 'running',
            log: JSON.stringify(currentLog),
            meta: JSON.stringify({
                phases: phases.map((phase) => ({
                    name: phase.name,
                    commands: phase.commands.map((command) => command.label),
                })),
            }),
        });
        try {
            for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
                const phase = phases[phaseIndex];
                for (const command of phase.commands) {
                    const commandLabel = command.label;
                    const logEntry = {
                        timestamp: Date.now(),
                        phase: phase.name,
                        command: commandLabel,
                        status: 'running',
                    };
                    currentLog.push(logEntry);
                    this.emitProgress({
                        databaseId,
                        serverId: input.serverId,
                        timestamp: Date.now(),
                        currentPhase: phase.name,
                        phaseIndex: phaseIndex + 1,
                        totalPhases: phases.length,
                        currentCommand: commandLabel,
                        commandStatus: 'running',
                        percentComplete: Math.round((completedCommands / totalCommands) * 100),
                    });
                    if (command.skipIf) {
                        const shouldSkip = await command.skipIf();
                        if (shouldSkip) {
                            logEntry.status = 'success';
                            logEntry.output = 'Skipped (already satisfied)';
                            completedCommands += 1;
                            continue;
                        }
                    }
                    try {
                        const result = await SSHService_1.sshService.executeCommand(input.serverId, command.command);
                        logEntry.status = 'success';
                        logEntry.output = this.truncateOutput(result.stdout || result.stderr);
                        if (command.parser) {
                            await command.parser({ stdout: result.stdout, stderr: result.stderr }, context);
                        }
                        completedCommands += 1;
                        this.emitProgress({
                            databaseId,
                            serverId: input.serverId,
                            timestamp: Date.now(),
                            currentPhase: phase.name,
                            phaseIndex: phaseIndex + 1,
                            totalPhases: phases.length,
                            currentCommand: commandLabel,
                            commandStatus: 'success',
                            commandOutput: this.truncateOutput(result.stdout || result.stderr),
                            percentComplete: Math.round((completedCommands / totalCommands) * 100),
                        });
                    }
                    catch (error) {
                        logEntry.status = 'failed';
                        logEntry.error = String(error);
                        this.emitProgress({
                            databaseId,
                            serverId: input.serverId,
                            timestamp: Date.now(),
                            currentPhase: phase.name,
                            phaseIndex: phaseIndex + 1,
                            totalPhases: phases.length,
                            currentCommand: commandLabel,
                            commandStatus: 'failed',
                            commandOutput: error?.stderr || error?.stdout || String(error),
                            percentComplete: Math.round((completedCommands / totalCommands) * 100),
                            error: {
                                code: 'COMMAND_FAILED',
                                message: `Setup hit a snag while running “${commandLabel}”`,
                                details: error,
                            },
                        });
                        throw error;
                    }
                    finally {
                        db_1.queries.updateDatabaseOperation(operationId, {
                            log: JSON.stringify(currentLog),
                            progress: Math.round((completedCommands / totalCommands) * 100),
                        });
                    }
                }
            }
            const encrypted = await this.vault.encrypt(JSON.stringify(credentials));
            const completedAt = Date.now();
            db_1.queries.updateDatabase(databaseId, {
                status: 'active',
                encrypted_credentials: encrypted,
                last_activity_at: completedAt,
                provision_duration_ms: completedAt - operationRecord.started_at,
                stats: JSON.stringify({
                    createdDurationMs: completedAt - operationRecord.started_at,
                    access: input.access ?? 'internal',
                }),
                metadata: credentials.extras
                    ? JSON.stringify({
                        extras: credentials.extras,
                    })
                    : null,
            });
            db_1.queries.updateDatabaseOperation(operationId, {
                status: 'succeeded',
                finished_at: completedAt,
                log: JSON.stringify(currentLog),
                progress: 100,
                summary: 'Database ready',
            });
            this.emitProgress({
                databaseId,
                serverId: input.serverId,
                timestamp: completedAt,
                currentPhase: 'Complete',
                phaseIndex: phases.length,
                totalPhases: phases.length,
                commandStatus: 'success',
                percentComplete: 100,
            });
        }
        catch (error) {
            const failedAt = Date.now();
            db_1.queries.updateDatabase(databaseId, {
                status: 'needs_attention',
                last_error: String(error),
                last_activity_at: failedAt,
            });
            db_1.queries.updateDatabaseOperation(operationId, {
                status: 'failed',
                finished_at: failedAt,
                error_message: String(error),
                log: JSON.stringify(currentLog),
            });
        }
    }
    async prepareCredentials(database, input, existing) {
        const server = db_1.queries.getServerById(database.server_id);
        const host = server?.host ?? '127.0.0.1';
        const sanitizedName = (existing?.database ?? input.name)
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_');
        const defaultPort = database.type === 'postgres'
            ? POSTGRES_DEFAULT_PORT
            : database.type === 'mysql'
                ? MYSQL_DEFAULT_PORT
                : SUPABASE_STUDIO_PORT;
        let username;
        let resolvedPassword = undefined;
        if (database.type === 'postgres') {
            username = 'postgres';
            if (existing?.username === 'postgres' && existing.password) {
                resolvedPassword = existing.password;
            }
            if (!resolvedPassword) {
                const serverDatabases = db_1.queries.getDatabasesByServer(database.server_id);
                for (const sibling of serverDatabases) {
                    if (sibling.id === database.id ||
                        sibling.type !== 'postgres' ||
                        !sibling.encrypted_credentials) {
                        continue;
                    }
                    try {
                        const siblingCredentials = JSON.parse(await this.vault.decrypt(sibling.encrypted_credentials));
                        if (siblingCredentials.username === 'postgres' && siblingCredentials.password) {
                            resolvedPassword = siblingCredentials.password;
                            break;
                        }
                    }
                    catch (error) {
                        console.warn('[DatabaseService] Failed to reuse postgres credentials from sibling database', error);
                    }
                }
            }
            if (!resolvedPassword) {
                resolvedPassword = this.generatePassword();
            }
        }
        else {
            username = existing?.username ?? `${database.type}_${Math.random().toString(36).slice(2, 8)}`;
            resolvedPassword = existing?.password;
            if (!resolvedPassword) {
                resolvedPassword = this.generatePassword();
            }
        }
        const password = resolvedPassword ?? this.generatePassword();
        const credentials = {
            username,
            password,
            database: sanitizedName,
            host,
            port: existing?.port ?? input.requestedPort ?? defaultPort,
            engine: database.type,
            connectionString: '',
            extras: existing?.extras ? { ...existing.extras } : undefined,
        };
        if (database.type === 'supabase') {
            const workspacePath = credentials.extras?.workspacePath ?? `~/supabase-${sanitizedName}`;
            credentials.extras = {
                apiUrl: credentials.extras?.apiUrl ?? `http://${host}:${SUPABASE_STUDIO_PORT}`,
                studioUrl: credentials.extras?.studioUrl ?? `http://${host}:${SUPABASE_STUDIO_PORT}`,
                serviceRoleKey: credentials.extras?.serviceRoleKey ?? this.generateHexKey(32),
                anonKey: credentials.extras?.anonKey ?? this.generateHexKey(16),
                workspacePath,
            };
        }
        credentials.connectionString = this.buildConnectionString(credentials);
        if (database.type === 'supabase' && credentials.extras?.apiUrl) {
            credentials.connectionString = String(credentials.extras.apiUrl);
        }
        return credentials;
    }
    buildConnectionString(credentials) {
        if (credentials.engine === 'postgres') {
            return `postgresql://${credentials.username}:${credentials.password}@${credentials.host}:${credentials.port}/${credentials.database}`;
        }
        if (credentials.engine === 'mysql') {
            return `mysql://${credentials.username}:${credentials.password}@${credentials.host}:${credentials.port}/${credentials.database}`;
        }
        return credentials.extras?.apiUrl
            ? String(credentials.extras.apiUrl)
            : `http://${credentials.host}:${credentials.port}`;
    }
    buildPhases(type, credentials, input) {
        switch (type) {
            case 'postgres':
                return this.buildPostgresPhases(credentials, input);
            case 'mysql':
                return this.buildMysqlPhases(credentials, input);
            case 'supabase':
                return this.buildSupabasePhases(credentials, input);
            default:
                throw new Error(`Unsupported database type: ${type}`);
        }
    }
    buildPostgresPhases(credentials, input) {
        const isPublic = input.access === 'public';
        return [
            {
                name: 'Preparing server',
                commands: [
                    {
                        label: 'Update package lists',
                        command: 'sudo apt-get update',
                    },
                    {
                        label: 'Install PostgreSQL',
                        command: `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib`,
                    },
                ],
            },
            {
                name: 'Securing PostgreSQL',
                commands: [
                    {
                        label: 'Ensure PostgreSQL service is running',
                        command: 'sudo systemctl enable --now postgresql',
                    },
                    {
                        label: 'Ensure postgres user password',
                        command: `sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '${credentials.password}';"`,
                    },
                    {
                        label: 'Verify postgres password',
                        command: `PGPASSWORD='${credentials.password}' psql -U postgres -h localhost -d postgres -c '\\q'`,
                    },
                    {
                        label: 'Check PostgreSQL version',
                        command: `sudo -u postgres psql -c "SELECT version();"`,
                    },
                ],
            },
            {
                name: 'Configuring database & network',
                commands: [
                    {
                        label: 'Create application database',
                        command: `sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${credentials.database}'" | grep -q 1 || sudo -u postgres createdb ${credentials.database} -O postgres`,
                    },
                    {
                        label: isPublic ? 'Allow network clients' : 'Ensure internal-only access',
                        command: isPublic
                            ? `sudo bash -c "grep -qxF \\"host    all    all    0.0.0.0/0    md5\\" /etc/postgresql/*/main/pg_hba.conf || echo \\"host    all    all    0.0.0.0/0    md5\\" >> /etc/postgresql/*/main/pg_hba.conf"`
                            : `sudo sed -i '/^host    all    all    0.0.0.0\\/0    md5$/d' /etc/postgresql/*/main/pg_hba.conf || true`,
                    },
                    {
                        label: isPublic ? 'Listen on all interfaces' : 'Listen on localhost only',
                        command: isPublic
                            ? `sudo sed -i "s/^#\\?listen_addresses = .*/listen_addresses = '*'/" /etc/postgresql/*/main/postgresql.conf`
                            : `sudo sed -i "s/^#\\?listen_addresses = .*/listen_addresses = 'localhost'/" /etc/postgresql/*/main/postgresql.conf`,
                    },
                    {
                        label: isPublic ? 'Open firewall port' : 'Ensure firewall port closed',
                        command: isPublic
                            ? `sudo ufw allow 5432/tcp || true`
                            : `sudo ufw delete allow 5432/tcp 2>/dev/null || true`,
                    },
                    {
                        label: 'Reload firewall',
                        command: `sudo ufw reload || true`,
                    },
                    {
                        label: 'Restart PostgreSQL service',
                        command: 'sudo systemctl restart postgresql',
                    },
                    {
                        label: 'Verify connection',
                        command: `PGPASSWORD=${credentials.password} psql "postgresql://${credentials.username}:${credentials.password}@localhost:${credentials.port}/${credentials.database}" -c "SELECT 1;"`,
                    },
                ],
            },
        ];
    }
    buildMysqlPhases(credentials, input) {
        const isPublic = input.access === 'public';
        return [
            {
                name: 'Preparing server',
                commands: [
                    {
                        label: 'Update package lists',
                        command: 'sudo apt-get update',
                    },
                    {
                        label: 'Install MySQL server',
                        command: `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server`,
                    },
                ],
            },
            {
                name: 'Configuring database',
                commands: [
                    {
                        label: 'Create database user',
                        command: `sudo mysql -e "CREATE USER IF NOT EXISTS '${credentials.username}'@'%' IDENTIFIED BY '${credentials.password}'; FLUSH PRIVILEGES;"`,
                    },
                    {
                        label: 'Create database',
                        command: `sudo mysql -e "CREATE DATABASE IF NOT EXISTS \\\`${credentials.database}\\\`;"`,
                    },
                    {
                        label: 'Grant database privileges',
                        command: `sudo mysql -e "GRANT ALL PRIVILEGES ON \\\`${credentials.database}\\\`.* TO '${credentials.username}'@'%'; FLUSH PRIVILEGES;"`,
                    },
                ],
            },
            {
                name: 'Configuring network access',
                commands: [
                    {
                        label: isPublic ? 'Configure for public access' : 'Configure for internal-only access',
                        command: isPublic
                            ? `sudo sed -i "s/^bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/mysql.conf.d/mysqld.cnf || sudo sed -i "s/^bind-address.*/bind-address = 0.0.0.0/" /etc/mysql/my.cnf || true`
                            : `sudo sed -i "s/^bind-address.*/bind-address = 127.0.0.1/" /etc/mysql/mysql.conf.d/mysqld.cnf || sudo sed -i "s/^bind-address.*/bind-address = 127.0.0.1/" /etc/mysql/my.cnf || true`,
                    },
                    {
                        label: isPublic ? 'Open firewall port' : 'Ensure firewall port closed',
                        command: isPublic
                            ? `sudo ufw allow 3306/tcp || true`
                            : `sudo ufw delete allow 3306/tcp 2>/dev/null || true`,
                    },
                    {
                        label: 'Reload firewall',
                        command: `sudo ufw reload || true`,
                    },
                ],
            },
            {
                name: 'Starting database',
                commands: [
                    {
                        label: 'Restart MySQL service',
                        command: 'sudo systemctl restart mysql',
                    },
                    {
                        label: 'Verify connection',
                        command: `mysql --connect-timeout=5 -u${credentials.username} -p${credentials.password} -h127.0.0.1 -e "SELECT 1;"`,
                    },
                ],
            },
        ];
    }
    buildSupabasePhases(credentials, _input) {
        const workspacePath = credentials.extras?.workspacePath ?? `~/supabase-${credentials.database}`;
        return [
            {
                name: 'Preparing server',
                commands: [
                    {
                        label: 'Install required packages',
                        command: 'sudo apt-get update && sudo apt-get install -y curl unzip',
                    },
                    {
                        label: 'Ensure Docker is installed',
                        command: 'command -v docker || curl -fsSL https://get.docker.com | sh',
                    },
                    {
                        label: 'Start Docker service',
                        command: 'sudo systemctl enable --now docker',
                    },
                    {
                        label: 'Ensure docker-compose plugin',
                        command: 'docker compose version >/dev/null 2>&1 || sudo apt-get install -y docker-compose-plugin',
                    },
                ],
            },
            {
                name: 'Configuring Supabase',
                commands: [
                    {
                        label: 'Download Supabase docker compose bundle',
                        command: `mkdir -p ${workspacePath} && cd ${workspacePath} && (
  curl -fsSL https://supabase.com/docker/docker-compose.yml -o docker-compose.yml ||
  curl -fsSL https://raw.githubusercontent.com/supabase/supabase/docker/docker-compose.yml -o docker-compose.yml ||
  curl -fsSL https://raw.githubusercontent.com/supabase/supabase/main/docker/docker-compose.yml -o docker-compose.yml ||
  curl -fsSL https://raw.githubusercontent.com/supabase/supabase/develop/docker/docker-compose.yml -o docker-compose.yml
)`,
                    },
                    {
                        label: 'Generate service keys',
                        command: `cd ${workspacePath} && cat <<'EOF' > .env
SUPABASE_URL=http://${credentials.host}:${SUPABASE_STUDIO_PORT}
SUPABASE_ANON_KEY=${credentials.extras?.anonKey}
SUPABASE_SERVICE_ROLE_KEY=${credentials.extras?.serviceRoleKey}
POSTGRES_PASSWORD=${credentials.password}
POSTGRES_DB=${credentials.database}
POSTGRES_USER=${credentials.username}
EOF`,
                    },
                ],
            },
            {
                name: 'Starting services',
                commands: [
                    {
                        label: 'Launch Supabase stack',
                        command: `cd ${workspacePath} && sudo docker compose up -d`,
                    },
                    {
                        label: 'Wait for Supabase Studio',
                        command: `timeout 300 bash -c 'until curl -s http://127.0.0.1:${SUPABASE_STUDIO_PORT} >/dev/null; do sleep 3; done'`,
                    },
                ],
            },
        ];
    }
    async applyPasswordRotation(record, credentials) {
        let result;
        switch (record.type) {
            case 'postgres':
                result = await SSHService_1.sshService.executeCommand(record.server_id, `sudo -u postgres psql -c "ALTER USER ${credentials.username} WITH PASSWORD '${credentials.password}';"`);
                if (result.exitCode !== 0) {
                    const errorMsg = result.stderr || result.stdout || 'Unknown error';
                    console.error('[DatabaseService] PostgreSQL password rotation failed:', errorMsg);
                    throw new Error(`Failed to rotate PostgreSQL password: ${errorMsg}`);
                }
                console.log('[DatabaseService] PostgreSQL password rotated successfully');
                break;
            case 'mysql':
                result = await SSHService_1.sshService.executeCommand(record.server_id, `sudo mysql -e "ALTER USER '${credentials.username}'@'%' IDENTIFIED BY '${credentials.password}'; FLUSH PRIVILEGES;"`);
                if (result.exitCode !== 0) {
                    const errorMsg = result.stderr || result.stdout || 'Unknown error';
                    console.error('[DatabaseService] MySQL password rotation failed:', errorMsg);
                    throw new Error(`Failed to rotate MySQL password: ${errorMsg}`);
                }
                console.log('[DatabaseService] MySQL password rotated successfully');
                break;
            case 'supabase':
                // TODO: rotate keys via supabase configuration
                console.warn('[DatabaseService] Supabase password rotation not yet implemented');
                break;
            default:
                throw new Error(`Unsupported database type: ${record.type}`);
        }
    }
    async teardownDatabase(record, force) {
        const metadata = record.metadata ? JSON.parse(record.metadata) : undefined;
        if (record.type === 'postgres') {
            await SSHService_1.sshService.executeCommand(record.server_id, `sudo systemctl stop postgresql`);
            if (force) {
                await SSHService_1.sshService.executeCommand(record.server_id, `sudo apt-get remove -y --purge postgresql* && sudo rm -rf /var/lib/postgresql`);
            }
        }
        else if (record.type === 'mysql') {
            await SSHService_1.sshService.executeCommand(record.server_id, `sudo systemctl stop mysql`);
            if (force) {
                await SSHService_1.sshService.executeCommand(record.server_id, `sudo apt-get remove -y --purge mysql-server mysql-client mysql-common && sudo rm -rf /etc/mysql /var/lib/mysql`);
            }
        }
        else if (record.type === 'supabase') {
            const sanitizedName = record.name.replace(/[^a-z0-9_]/gi, '_');
            const workspacePath = metadata?.extras?.workspacePath ??
                `~/supabase-${sanitizedName}`;
            await SSHService_1.sshService.executeCommand(record.server_id, `docker compose -f ${workspacePath}/docker-compose.yml down || true`);
            if (force) {
                await SSHService_1.sshService.executeCommand(record.server_id, `rm -rf ${workspacePath}`);
            }
        }
    }
    emitProgress(event) {
        const windows = electron_1.BrowserWindow.getAllWindows();
        for (const window of windows) {
            window.webContents.send(types_1.IPC_CHANNELS.DATABASE_PROGRESS, event);
        }
        this.emit('progress', event);
    }
    truncateOutput(output) {
        const trimmed = output.trim();
        if (trimmed.length <= 400) {
            return trimmed;
        }
        return `${trimmed.slice(0, 400)}…`;
    }
    generatePassword() {
        return (0, crypto_1.randomBytes)(24)
            .toString('base64')
            .replace(/[^a-zA-Z0-9]/g, '')
            .slice(0, 24);
    }
    generateHexKey(bytes) {
        return (0, crypto_1.randomBytes)(bytes).toString('hex');
    }
}
exports.DatabaseService = DatabaseService;
exports.databaseService = new DatabaseService();
//# sourceMappingURL=DatabaseService.js.map