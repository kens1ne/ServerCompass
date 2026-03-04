"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CronImporter = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../../../db");
class CronImporter {
    async import(item, serverId, payload) {
        const schedule = payload.schedule || '';
        const command = payload.command || '';
        const jobSignature = payload.jobSignature || `${schedule} ${command}`.trim();
        // Check for existing cron metadata
        const existing = db_1.db.prepare('SELECT id FROM cron_metadata WHERE server_id = ? AND job_signature = ?').get(serverId, jobSignature);
        if (existing) {
            return {
                itemId: item.id,
                success: true,
                localRecordType: 'cron_metadata',
                localRecordId: existing.id,
                rollbackData: { type: 'noop', reason: 'Cron metadata already existed' },
            };
        }
        const cronId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        db_1.db.prepare(`
      INSERT INTO cron_metadata (id, server_id, job_signature, label, category, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'imported', 'Imported via migration', ?, ?)
    `).run(cronId, serverId, jobSignature, item.display_name, now, now);
        return {
            itemId: item.id,
            success: true,
            localRecordType: 'cron_metadata',
            localRecordId: cronId,
            rollbackData: { type: 'remove_cron', serverId, cronLine: jobSignature, user: 'root' },
        };
    }
}
exports.CronImporter = CronImporter;
//# sourceMappingURL=CronImporter.js.map