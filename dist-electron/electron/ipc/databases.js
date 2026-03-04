"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDatabaseHandlers = registerDatabaseHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const db_1 = require("../db");
const LicenseService_1 = require("../services/LicenseService");
const DatabaseService_1 = require("../services/DatabaseService");
const DatabaseImportService_1 = require("../services/DatabaseImportService");
const safeJsonParse = (raw) => {
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        console.warn('[database ipc] Failed to parse JSON payload', error);
        return null;
    }
};
const maskConnectionString = (value) => {
    if (!value)
        return value;
    const match = value.match(/^(.*:\/\/[^:]+):([^@]+)@(.*)$/);
    if (!match) {
        return value;
    }
    return `${match[1]}:***@${match[3]}`;
};
const requireDatabaseAccess = () => {
    const access = LicenseService_1.licenseService.canUseDatabases();
    if (!access.allowed) {
        throw new Error(access.reason || 'Database provisioning is available for licensed users.');
    }
};
const buildRendererDatabase = async (record) => {
    let connection = null;
    const metadata = safeJsonParse(record.metadata);
    const stats = safeJsonParse(record.stats);
    if (record.encrypted_credentials) {
        try {
            const credentials = await DatabaseService_1.databaseService.getCredentials(record.id);
            connection = {
                host: credentials.host,
                port: credentials.port,
                username: credentials.username,
                database: credentials.database,
                connectionStringMasked: maskConnectionString(credentials.connectionString) ?? credentials.connectionString,
            };
        }
        catch (error) {
            console.warn('[database ipc] Unable to decrypt credentials for database %s', record.id, error);
        }
    }
    return {
        id: record.id,
        serverId: record.server_id,
        name: record.name,
        type: record.type,
        status: record.status,
        access: record.access,
        version: record.version,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        lastActivityAt: record.last_activity_at ?? null,
        connection,
        extras: metadata?.extras ?? null,
        stats: stats ?? null,
        lastError: record.last_error,
    };
};
const buildStatusFromOperation = (record, operation) => {
    if (!operation) {
        return {
            status: record.status,
            error: record.last_error,
        };
    }
    const meta = safeJsonParse(operation.meta);
    const log = safeJsonParse(operation.log) ?? [];
    const lastEntry = [...log].reverse().find((entry) => entry.status === 'running' || entry.status === 'failed' || entry.status === 'success');
    const phaseIndex = lastEntry && meta?.phases
        ? meta.phases.findIndex((phase) => phase.name === lastEntry.phase)
        : undefined;
    return {
        status: record.status,
        currentPhase: lastEntry?.phase,
        phaseIndex: phaseIndex !== undefined && phaseIndex >= 0 ? phaseIndex + 1 : undefined,
        totalPhases: meta?.phases?.length,
        currentCommand: lastEntry?.command,
        commandStatus: lastEntry?.status,
        error: operation.error_message ?? record.last_error,
    };
};
function registerDatabaseHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_GET_BY_SERVER, async (_event, input) => {
        try {
            const { id } = types_1.ServerIdSchema.parse(input);
            const records = db_1.queries.getDatabasesByServer(id);
            const payload = await Promise.all(records.map((record) => buildRendererDatabase(record)));
            return { success: true, data: payload };
        }
        catch (error) {
            console.error('[database ipc] Failed to list databases', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_PREFLIGHT, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabasePreflightSchema.parse(input);
            const preflightPayload = {
                serverId: validated.serverId,
                name: validated.name ?? `db-${Date.now()}`,
                type: validated.type,
                engineVersion: validated.engineVersion,
                access: validated.access,
                requestedPort: validated.requestedPort,
                advanced: validated.advanced,
            };
            const result = await DatabaseService_1.databaseService.runPreflight(preflightPayload);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[database ipc] Preflight failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_CREATE, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const parsed = types_1.CreateDatabaseSchema.parse(input);
            const name = parsed.name;
            const createPayload = {
                serverId: parsed.serverId,
                name,
                type: parsed.type,
                engineVersion: parsed.engineVersion,
                access: parsed.access,
                requestedPort: parsed.requestedPort,
                advanced: parsed.advanced,
            };
            const result = await DatabaseService_1.databaseService.createDatabase(createPayload);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[database ipc] Create database failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_STATUS, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseIdSchema.parse(input);
            const record = db_1.queries.getDatabaseById(validated.databaseId);
            if (!record || record.server_id !== validated.serverId) {
                throw new Error('Database not found');
            }
            const operation = record.last_operation_id ? db_1.queries.getDatabaseOperationById(record.last_operation_id) : undefined;
            return { success: true, data: buildStatusFromOperation(record, operation) };
        }
        catch (error) {
            console.error('[database ipc] Status lookup failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_ROTATE, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseRotateSchema.parse(input);
            const payload = await DatabaseService_1.databaseService.rotateCredentials(validated.databaseId);
            return { success: true, data: payload };
        }
        catch (error) {
            console.error('[database ipc] Rotate credentials failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_TOGGLE_ACCESS, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseToggleAccessSchema.parse(input);
            const result = await DatabaseService_1.databaseService.updateExternalAccess({
                serverId: validated.serverId,
                databaseId: validated.databaseId,
                enabled: validated.enabled,
                cidrAllowList: validated.cidrAllowList,
                reason: validated.reason,
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[database ipc] Toggle access failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_DELETE, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseDeleteSchema.parse(input);
            const result = await DatabaseService_1.databaseService.deleteDatabase(validated.databaseId, validated.force ?? false);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[database ipc] Delete database failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_CREDENTIALS, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseCredentialsSchema.parse(input);
            const credentials = await DatabaseService_1.databaseService.getCredentials(validated.databaseId);
            return { success: true, data: credentials };
        }
        catch (error) {
            console.error('[database ipc] Fetch credentials failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_LOGS, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseLogsSchema.parse(input);
            const record = db_1.queries.getDatabaseById(validated.databaseId);
            if (!record) {
                throw new Error('Database not found');
            }
            const operations = db_1.queries.getDatabaseOperationsByDatabase(record.id, validated.limit ?? 50);
            const latest = operations[0];
            const logEntries = safeJsonParse(latest?.log) ?? [];
            return { success: true, data: logEntries };
        }
        catch (error) {
            console.error('[database ipc] Fetch logs failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_VERIFY, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseVerifySchema.parse(input);
            const record = db_1.queries.getDatabaseById(validated.databaseId);
            if (!record) {
                throw new Error('Database not found');
            }
            // For the initial implementation, verification simply checks decrypted credentials exist
            await DatabaseService_1.databaseService.getCredentials(record.id);
            return { success: true, data: { connectionOk: true } };
        }
        catch (error) {
            console.error('[database ipc] Verification failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_RETRY, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseRetrySchema.parse(input);
            const record = db_1.queries.getDatabaseById(validated.databaseId);
            if (!record || record.server_id !== validated.serverId) {
                throw new Error('Database not found');
            }
            const { operationId } = await DatabaseService_1.databaseService.retryProvision(record.id);
            return {
                success: true,
                data: {
                    status: 'provisioning',
                    operationId,
                    databaseId: record.id,
                },
            };
        }
        catch (error) {
            console.error('[database ipc] Retry provisioning failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_IMPORT_PREVIEW, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseImportPreviewSchema.parse(input);
            const result = await DatabaseImportService_1.databaseImportService.previewCsv(validated);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[database import ipc] Preview failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_IMPORT_TABLES, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseImportListTablesSchema.parse(input);
            const tables = await DatabaseImportService_1.databaseImportService.listTables(validated.serverId, validated.databaseId);
            return { success: true, data: tables };
        }
        catch (error) {
            console.error('[database import ipc] List tables failed', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DATABASES_IMPORT_START, async (_event, input) => {
        try {
            requireDatabaseAccess();
            const validated = types_1.DatabaseImportStartSchema.parse(input);
            const summary = await DatabaseImportService_1.databaseImportService.startImport(validated);
            return { success: true, data: summary };
        }
        catch (error) {
            console.error('[database import ipc] Start import failed', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=databases.js.map