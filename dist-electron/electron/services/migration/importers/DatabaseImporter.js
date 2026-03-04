"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseImporter = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../../../db");
class DatabaseImporter {
    async import(item, serverId, payload) {
        const dbName = payload.name || payload.databaseName || item.display_name;
        // Providers use different field names: engine (RunCloud), type (Coolify), dbType (Dokploy)
        const rawType = payload.engine || payload.type || payload.dbType || 'postgres';
        // Normalize: 'postgresql' → 'postgres', 'mariadb' → 'mysql' (to match CHECK constraint)
        const dbType = rawType === 'postgresql' ? 'postgres' : rawType === 'mariadb' ? 'mysql' : rawType;
        // Only postgres, mysql, supabase pass the databases CHECK constraint.
        // Redis, MongoDB, etc. are snapshot-only for now — needs manual provisioning.
        const supportedTypes = ['postgres', 'mysql', 'supabase'];
        if (!supportedTypes.includes(dbType)) {
            return {
                itemId: item.id,
                success: true,
                rollbackData: { type: 'noop', reason: `${dbType} database is snapshot-only (manual provisioning needed)` },
            };
        }
        // Check for existing record
        const existing = db_1.db.prepare('SELECT id FROM databases WHERE server_id = ? AND name = ?').get(serverId, dbName);
        if (existing) {
            return {
                itemId: item.id,
                success: true,
                localRecordType: 'databases',
                localRecordId: existing.id,
                rollbackData: { type: 'noop', reason: 'Database record already existed' },
            };
        }
        const databaseId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        db_1.db.prepare(`
      INSERT INTO databases (id, server_id, name, type, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'needs_attention', ?, ?)
    `).run(databaseId, serverId, dbName, dbType, now, now);
        return {
            itemId: item.id,
            success: true,
            localRecordType: 'databases',
            localRecordId: databaseId,
            rollbackData: { type: 'delete_database_record', databaseId },
        };
    }
}
exports.DatabaseImporter = DatabaseImporter;
//# sourceMappingURL=DatabaseImporter.js.map