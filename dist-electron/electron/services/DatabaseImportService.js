"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseImportService = exports.DatabaseImportService = void 0;
const electron_1 = require("electron");
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const types_1 = require("../ipc/types");
const db_1 = require("../db");
const DatabaseService_1 = require("./DatabaseService");
const SSHService_1 = require("./SSHService");
const DEFAULT_SAMPLE_SIZE = 25;
const CHUNK_LIMIT_BYTES = 512 * 1024; // 512KB
const DEFAULT_SCHEMA = 'public';
class DatabaseImportService extends events_1.EventEmitter {
    async previewCsv(input) {
        const record = this.getDatabaseRecord(input.databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        if (record.type !== 'postgres') {
            throw new Error('CSV preview currently supports PostgreSQL databases only');
        }
        const stats = await fs_1.default.promises.stat(input.filePath);
        const chunk = await this.readFileChunk(input.filePath);
        const delimiter = input.delimiter ?? this.detectDelimiter(chunk);
        const rows = this.parseCsv(chunk, delimiter);
        const sampleSize = input.sampleSize ?? DEFAULT_SAMPLE_SIZE;
        const previewRows = rows.slice(0, sampleSize);
        if (previewRows.length === 0) {
            return {
                delimiter,
                hasHeader: input.hasHeader ?? true,
                rowSample: [],
                totalPreviewRows: 0,
                columns: [],
                fileSize: stats.size,
                warnings: ['File appears to be empty'],
            };
        }
        const hasHeader = input.hasHeader ?? this.detectHasHeader(previewRows);
        const headerRow = hasHeader ? previewRows[0] : this.generateFallbackHeader(previewRows[0].length);
        const dataRows = hasHeader ? previewRows.slice(1) : previewRows;
        const columns = headerRow.map((header, index) => {
            const columnValues = dataRows.map((row) => row[index] ?? '');
            const inferredType = this.inferColumnType(columnValues);
            const sanitizedName = this.sanitizeColumnName(header);
            const nullable = columnValues.some((value) => value === '' || value === null || value === undefined);
            return {
                index,
                header,
                sanitizedName,
                inferredType,
                nullable,
                samples: columnValues.slice(0, 5),
            };
        });
        const warnings = this.collectPreviewWarnings(previewRows, columns);
        return {
            delimiter,
            hasHeader,
            rowSample: previewRows,
            totalPreviewRows: previewRows.length,
            columns,
            fileSize: stats.size,
            warnings,
        };
    }
    async listTables(serverId, databaseId) {
        const record = this.getDatabaseRecord(databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        if (record.type !== 'postgres') {
            throw new Error('Listing tables is currently supported for PostgreSQL databases only');
        }
        const credentials = await DatabaseService_1.databaseService.getCredentials(databaseId);
        const schema = DEFAULT_SCHEMA;
        const sql = `
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${schema}'
      ORDER BY table_name, ordinal_position;
    `;
        const result = await this.runPsql(serverId, credentials, sql, { raw: true });
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || 'Failed to list tables');
        }
        const tables = new Map();
        for (const line of result.stdout.split('\n')) {
            if (!line.trim())
                continue;
            const [tableName, columnName, dataType, nullableFlag] = line.split('|');
            if (!tables.has(tableName)) {
                tables.set(tableName, []);
            }
            tables.get(tableName).push({
                name: columnName,
                dataType,
                nullable: nullableFlag === 'YES',
            });
        }
        return Array.from(tables.entries()).map(([name, columns]) => ({
            name,
            columns,
        }));
    }
    async startImport(input) {
        const record = this.getDatabaseRecord(input.databaseId);
        if (!record) {
            throw new Error('Database not found');
        }
        if (record.type !== 'postgres') {
            throw new Error('Import is currently implemented for PostgreSQL databases only');
        }
        if (input.format !== 'csv') {
            throw new Error(`Unsupported format: ${input.format}`);
        }
        if (!fs_1.default.existsSync(input.filePath)) {
            throw new Error('Selected file no longer exists');
        }
        const mapping = input.mapping.filter((column) => column.targetColumn);
        if (mapping.length === 0) {
            throw new Error('No columns selected for import');
        }
        const operationId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        db_1.queries.createDatabaseOperation({
            id: operationId,
            database_id: record.id,
            server_id: input.serverId,
            type: 'import',
            status: 'running',
            started_at: now,
            finished_at: null,
            progress: 0,
            summary: null,
            meta: JSON.stringify({
                format: input.format,
                table: input.options.tableName,
                mode: input.options.mode,
            }),
            error_message: null,
            log: '[]',
        });
        const logEntries = [];
        const credentials = await DatabaseService_1.databaseService.getCredentials(record.id);
        const startTime = Date.now();
        let insertedRows = 0;
        const schema = input.options.schema || DEFAULT_SCHEMA;
        const qualifiedTable = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(input.options.tableName)}`;
        const remoteDir = `/tmp/servercompass-imports/${record.id}`;
        const remoteFileName = `${operationId}-${path_1.default.basename(input.filePath)}`;
        const remoteFilePath = `${remoteDir}/${remoteFileName}`;
        try {
            await this.emitAndLogProgress(operationId, logEntries, {
                serverId: input.serverId,
                databaseId: record.id,
                operationId,
                stage: 'uploading',
                percent: 5,
                message: 'Uploading file…',
            });
            await SSHService_1.sshService.uploadFile(input.serverId, input.filePath, remoteFilePath, (transferred, total) => {
                const percent = total > 0 ? Math.min(40, Math.round((transferred / total) * 30) + 5) : 10;
                this.emitProgress({
                    serverId: input.serverId,
                    databaseId: record.id,
                    operationId,
                    stage: 'uploading',
                    percent,
                    message: 'Uploading file…',
                    details: { transferred, total },
                });
            });
            await this.emitAndLogProgress(operationId, logEntries, {
                serverId: input.serverId,
                databaseId: record.id,
                operationId,
                stage: 'preparing',
                percent: 45,
                message: 'Preparing target table…',
                details: { table: qualifiedTable, mode: input.options.mode },
            });
            if (input.options.mode === 'create') {
                const createSql = this.buildCreateTableSql(schema, input.options.tableName, mapping);
                const result = await this.runPsql(input.serverId, credentials, createSql);
                if (result.exitCode !== 0) {
                    throw new Error(result.stderr || 'Failed to create table');
                }
            }
            else if (input.options.mode === 'replace') {
                const truncateSql = `TRUNCATE TABLE ${qualifiedTable};`;
                const result = await this.runPsql(input.serverId, credentials, truncateSql);
                if (result.exitCode !== 0) {
                    throw new Error(result.stderr || 'Failed to truncate table');
                }
            }
            await this.emitAndLogProgress(operationId, logEntries, {
                serverId: input.serverId,
                databaseId: record.id,
                operationId,
                stage: 'importing',
                percent: 60,
                message: 'Importing rows…',
                details: { table: qualifiedTable },
            });
            const copySql = this.buildCopySql(schema, input.options.tableName, remoteFilePath, mapping, input.options);
            const copyResult = await this.runPsql(input.serverId, credentials, copySql);
            if (copyResult.exitCode !== 0) {
                throw new Error(copyResult.stderr || 'Import command failed');
            }
            insertedRows = this.parseInsertedRows(copyResult.stdout);
            await this.emitAndLogProgress(operationId, logEntries, {
                serverId: input.serverId,
                databaseId: record.id,
                operationId,
                stage: 'cleanup',
                percent: 90,
                message: 'Cleaning up temporary files…',
            });
            await SSHService_1.sshService.executeCommand(input.serverId, `rm -f "${remoteFilePath.replace(/"/g, '\\"')}"`);
            await this.emitAndLogProgress(operationId, logEntries, {
                serverId: input.serverId,
                databaseId: record.id,
                operationId,
                stage: 'completed',
                percent: 100,
                message: `Imported ${insertedRows} rows into ${qualifiedTable}`,
                details: { insertedRows },
            });
            const durationMs = Date.now() - startTime;
            db_1.queries.updateDatabaseOperation(operationId, {
                status: 'succeeded',
                finished_at: Date.now(),
                progress: 100,
                summary: `Imported ${insertedRows} rows`,
                log: JSON.stringify(logEntries),
            });
            db_1.queries.updateDatabase(record.id, {
                last_activity_at: Date.now(),
                last_operation_id: record.last_operation_id,
            });
            return {
                operationId,
                insertedRows,
                durationMs,
                tableName: input.options.tableName,
                mode: input.options.mode,
            };
        }
        catch (error) {
            db_1.queries.updateDatabaseOperation(operationId, {
                status: 'failed',
                finished_at: Date.now(),
                progress: 100,
                error_message: String(error),
                log: JSON.stringify(logEntries),
            });
            await this.emitAndLogProgress(operationId, logEntries, {
                serverId: input.serverId,
                databaseId: record.id,
                operationId,
                stage: 'failed',
                percent: 100,
                message: 'Import failed',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    getDatabaseRecord(databaseId) {
        return db_1.queries.getDatabaseById(databaseId);
    }
    async emitAndLogProgress(operationId, logEntries, event) {
        logEntries.push({
            timestamp: Date.now(),
            stage: event.stage,
            status: event.stage === 'failed' ? 'failed' : event.stage === 'completed' ? 'success' : 'running',
            message: event.message,
            details: event.details,
            error: event.error,
        });
        this.emitProgress(event);
        db_1.queries.updateDatabaseOperation(operationId, {
            progress: Math.min(event.percent, 100),
            log: JSON.stringify(logEntries),
        });
    }
    emitProgress(event) {
        const windows = electron_1.BrowserWindow.getAllWindows();
        for (const window of windows) {
            window.webContents.send(types_1.IPC_CHANNELS.DATABASE_IMPORT_PROGRESS, event);
        }
        this.emit('progress', event);
    }
    async readFileChunk(filePath) {
        const stream = fs_1.default.createReadStream(filePath, {
            encoding: 'utf-8',
            highWaterMark: CHUNK_LIMIT_BYTES,
        });
        let chunk = '';
        for await (const piece of stream) {
            chunk += piece;
            if (chunk.length >= CHUNK_LIMIT_BYTES) {
                break;
            }
        }
        stream.close();
        return chunk;
    }
    detectDelimiter(sample) {
        const candidates = [',', '\t', ';', '|'];
        const lines = sample.split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) {
            return ',';
        }
        let bestDelimiter = ',';
        let bestScore = -1;
        for (const delimiter of candidates) {
            const counts = lines.map((line) => line.split(delimiter).length);
            const consistency = this.calculateConsistencyScore(counts);
            if (consistency > bestScore) {
                bestScore = consistency;
                bestDelimiter = delimiter;
            }
        }
        return bestDelimiter;
    }
    detectHasHeader(rows) {
        if (rows.length < 2)
            return true;
        const header = rows[0];
        const secondRow = rows[1];
        const numericHeaderCount = header.filter((value) => this.looksNumeric(value)).length;
        const numericSecondRowCount = secondRow.filter((value) => this.looksNumeric(value)).length;
        return numericHeaderCount < numericSecondRowCount;
    }
    generateFallbackHeader(columnCount) {
        const headers = [];
        for (let i = 0; i < columnCount; i += 1) {
            headers.push(`column_${i + 1}`);
        }
        return headers;
    }
    parseCsv(sample, delimiter) {
        const rows = [];
        let current = '';
        let currentRow = [];
        let inQuotes = false;
        for (let i = 0; i < sample.length; i += 1) {
            const char = sample[i];
            if (char === '"') {
                if (inQuotes && sample[i + 1] === '"') {
                    current += '"';
                    i += 1;
                }
                else {
                    inQuotes = !inQuotes;
                }
                continue;
            }
            if (char === delimiter && !inQuotes) {
                currentRow.push(current);
                current = '';
                continue;
            }
            if ((char === '\n' || char === '\r') && !inQuotes) {
                if (char === '\r' && sample[i + 1] === '\n') {
                    i += 1;
                }
                currentRow.push(current);
                if (currentRow.some((value) => value.trim().length > 0)) {
                    rows.push(currentRow);
                }
                currentRow = [];
                current = '';
                continue;
            }
            current += char;
        }
        if (current.length > 0 || currentRow.length > 0) {
            currentRow.push(current);
            if (currentRow.some((value) => value.trim().length > 0)) {
                rows.push(currentRow);
            }
        }
        return rows;
    }
    inferColumnType(values) {
        let currentType = 'integer';
        for (const rawValue of values) {
            const value = rawValue.trim();
            if (value === '' || value.toLowerCase() === 'null') {
                continue;
            }
            if (currentType === 'integer') {
                if (this.isInteger(value)) {
                    currentType = this.isBigInt(value) ? 'bigint' : 'integer';
                    continue;
                }
                currentType = 'decimal';
            }
            if (currentType === 'bigint') {
                if (this.isInteger(value) && this.isBigInt(value)) {
                    continue;
                }
                currentType = 'decimal';
            }
            if (currentType === 'decimal') {
                if (this.isDecimal(value)) {
                    continue;
                }
                currentType = 'boolean';
            }
            if (currentType === 'boolean') {
                if (this.isBoolean(value)) {
                    continue;
                }
                currentType = 'date';
            }
            if (currentType === 'date') {
                if (this.isDate(value)) {
                    continue;
                }
                currentType = 'timestamp';
            }
            if (currentType === 'timestamp') {
                if (this.isTimestamp(value)) {
                    continue;
                }
                return 'text';
            }
        }
        return currentType;
    }
    collectPreviewWarnings(rows, columns) {
        const warnings = [];
        const expectedLength = rows[0]?.length ?? 0;
        rows.forEach((row, index) => {
            if (row.length !== expectedLength) {
                warnings.push(`Row ${index + 1} has ${row.length} columns but expected ${expectedLength}.`);
            }
        });
        const duplicateHeaders = this.findDuplicates(columns.map((column) => column.header));
        for (const header of duplicateHeaders) {
            warnings.push(`Duplicate column header detected: “${header}”`);
        }
        return warnings;
    }
    calculateConsistencyScore(counts) {
        if (counts.length === 0)
            return 0;
        const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
        const variance = counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length;
        return -variance;
    }
    looksNumeric(value) {
        return /^-?\d*\.?\d+$/.test(value.trim());
    }
    isInteger(value) {
        return /^-?\d+$/.test(value);
    }
    isBigInt(value) {
        return /^-?\d{10,}$/.test(value);
    }
    isDecimal(value) {
        return /^-?\d+(\.\d+)?$/.test(value);
    }
    isBoolean(value) {
        const normalized = value.toLowerCase();
        return ['true', 'false', '1', '0', 'yes', 'no'].includes(normalized);
    }
    isDate(value) {
        return /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{2}\/\d{2}\/\d{4}$/.test(value);
    }
    isTimestamp(value) {
        return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/.test(value);
    }
    sanitizeColumnName(name) {
        const trimmed = name.trim().replace(/\s+/g, '_').toLowerCase();
        const cleaned = trimmed.replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '').replace(/_+$/, '');
        if (!cleaned) {
            return 'column';
        }
        if (/^\d/.test(cleaned)) {
            return `col_${cleaned}`;
        }
        return cleaned;
    }
    findDuplicates(values) {
        const seen = new Set();
        const duplicates = new Set();
        for (const value of values) {
            const key = value.trim().toLowerCase();
            if (seen.has(key)) {
                duplicates.add(value);
            }
            else {
                seen.add(key);
            }
        }
        return Array.from(duplicates);
    }
    buildCreateTableSql(schema, tableName, mapping) {
        const columnsSql = mapping
            .map((column) => {
            const type = this.mapToPostgresType(column.dataType ?? 'text');
            const nullable = column.nullable === false ? 'NOT NULL' : '';
            return `${this.quoteIdentifier(column.targetColumn)} ${type} ${nullable}`.trim();
        })
            .join(',\n  ');
        return `CREATE TABLE ${this.quoteIdentifier(schema)}.${this.quoteIdentifier(tableName)} (\n  ${columnsSql}\n);`;
    }
    buildCopySql(schema, tableName, remoteFilePath, mapping, options) {
        const columns = mapping.map((column) => this.quoteIdentifier(column.targetColumn)).join(', ');
        const copyOptions = [
            'FORMAT csv',
            options.hasHeader ? 'HEADER' : '',
            options.delimiter && options.delimiter !== ',' ? `DELIMITER '${this.escapeSqlLiteral(options.delimiter)}'` : '',
            options.quoteChar && options.quoteChar !== '"' ? `QUOTE '${this.escapeSqlLiteral(options.quoteChar)}'` : '',
            options.escapeChar && options.escapeChar !== options.quoteChar
                ? `ESCAPE '${this.escapeSqlLiteral(options.escapeChar)}'`
                : '',
            options.nullAs ? `NULL '${this.escapeSqlLiteral(options.nullAs)}'` : '',
        ]
            .filter(Boolean)
            .join(', ');
        const table = `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(tableName)}`;
        const fileLiteral = this.escapeSqlLiteral(remoteFilePath);
        return `\\COPY ${table} (${columns}) FROM '${fileLiteral}' WITH (${copyOptions});`;
    }
    mapToPostgresType(type) {
        const normalized = type.toLowerCase();
        switch (normalized) {
            case 'integer':
                return 'INTEGER';
            case 'bigint':
                return 'BIGINT';
            case 'decimal':
            case 'numeric':
            case 'float':
                return 'DECIMAL';
            case 'boolean':
                return 'BOOLEAN';
            case 'date':
                return 'DATE';
            case 'timestamp':
            case 'timestamptz':
                return 'TIMESTAMP';
            default:
                return 'TEXT';
        }
    }
    escapeSqlLiteral(value) {
        return value.replace(/'/g, "''");
    }
    quoteIdentifier(identifier) {
        return `"${identifier.replace(/"/g, '""')}"`;
    }
    async runPsql(serverId, credentials, sql, options = {}) {
        const passwordEnv = `PGPASSWORD='${credentials.password.replace(/'/g, `'\\''`)}'`;
        const sanitizedSql = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim();
        const command = `${passwordEnv} psql -h localhost -p ${credentials.port} -U ${credentials.username} -d ${credentials.database} -v ON_ERROR_STOP=1 ${options.raw ? '-At -F"|" ' : ''}-c "${sanitizedSql}"`;
        return SSHService_1.sshService.executeCommand(serverId, command);
    }
    parseInsertedRows(stdout) {
        const match = stdout.match(/COPY\s+(\d+)/i);
        if (!match) {
            return 0;
        }
        return Number.parseInt(match[1], 10) || 0;
    }
}
exports.DatabaseImportService = DatabaseImportService;
exports.databaseImportService = new DatabaseImportService();
//# sourceMappingURL=DatabaseImportService.js.map