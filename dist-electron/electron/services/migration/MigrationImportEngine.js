"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationImportEngine = void 0;
const electron_1 = require("electron");
const db_1 = require("../../db");
const SSHService_1 = require("../SSHService");
const DockerStackImporter_1 = require("./importers/DockerStackImporter");
const DatabaseImporter_1 = require("./importers/DatabaseImporter");
const CronImporter_1 = require("./importers/CronImporter");
class MigrationImportEngine {
    dockerStackImporter = new DockerStackImporter_1.DockerStackImporter(SSHService_1.sshService);
    databaseImporter = new DatabaseImporter_1.DatabaseImporter();
    cronImporter = new CronImporter_1.CronImporter();
    async importSelected(migrationId, serverId) {
        // Load selected items sorted by priority.
        // Include 'imported' items that may have hollow docker_stacks records (from a previous
        // code version that didn't write compose files). The DockerStackImporter handles
        // upgrading hollow records via its idempotency check.
        const items = db_1.db.prepare(`
      SELECT di.* FROM server_migration_discovered_items di
      WHERE di.migration_id = ? AND di.selected = 1
        AND (
          di.import_status = 'pending'
          OR (di.import_status = 'imported' AND di.local_record_type = 'docker_stacks'
              AND di.local_record_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM docker_stacks ds
                WHERE ds.id = di.local_record_id
                  AND (ds.compose_content IS NULL OR ds.compose_content = '')
              ))
        )
      ORDER BY di.priority ASC
    `).all(migrationId);
        const totalItems = items.length;
        // Brief delay to let the frontend mount and subscribe to progress events.
        // The IPC handler returns immediately (fire-and-forget), so the renderer
        // needs a tick to transition to ImportProgressStep and register listeners.
        await new Promise(resolve => setTimeout(resolve, 100));
        // Ensure the standard ServerCompass folder exists for imported stacks.
        // This avoids later runtime checks failing with `cd: ... No such file or directory`
        // when the user opens imported apps.
        try {
            await SSHService_1.sshService.executeCommand(serverId, [
                'mkdir -p ~/server-compass/apps',
                // Optional convenience: allow referencing the same path as `/server-compass/...` on root servers.
                'if [ "$(id -u)" = "0" ] && [ ! -e "/server-compass" ]; then ln -s ~/server-compass /server-compass; fi',
            ].join(' && '));
        }
        catch {
            // Best-effort only; migrations can still import records without remote filesystem writes.
        }
        this.emitProgress({ migrationId, phase: 'starting', totalItems, currentIndex: 0, message: `Importing ${totalItems} items...` });
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            this.emitProgress({
                migrationId,
                phase: 'importing',
                currentItem: item.display_name,
                currentIndex: i,
                totalItems,
                message: `Importing ${item.display_name}...`,
            });
            // Mark as importing
            db_1.db.prepare(`UPDATE server_migration_discovered_items SET import_status = 'importing', updated_at = ? WHERE id = ?`)
                .run(Date.now(), item.id);
            let result;
            try {
                result = await this.importItem(item, serverId);
            }
            catch (err) {
                result = {
                    itemId: item.id,
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
            // Update item status
            const now = Date.now();
            if (result.success) {
                db_1.db.prepare(`
          UPDATE server_migration_discovered_items
          SET import_status = 'imported', local_record_type = ?, local_record_id = ?,
              rollback_data = ?, updated_at = ?
          WHERE id = ?
        `).run(result.localRecordType ?? null, result.localRecordId ?? null, result.rollbackData ? JSON.stringify(result.rollbackData) : null, now, item.id);
            }
            else {
                db_1.db.prepare(`
          UPDATE server_migration_discovered_items
          SET import_status = 'failed', error_message = ?, retry_count = retry_count + 1, updated_at = ?
          WHERE id = ?
        `).run(result.error ?? 'Unknown error', now, item.id);
            }
            // Update migration counts
            if (result.success) {
                db_1.db.prepare(`UPDATE server_migrations SET total_imported = total_imported + 1, updated_at = ? WHERE id = ?`)
                    .run(now, migrationId);
            }
            else {
                db_1.db.prepare(`UPDATE server_migrations SET total_failed = total_failed + 1, updated_at = ? WHERE id = ?`)
                    .run(now, migrationId);
            }
        }
        this.emitProgress({ migrationId, phase: 'completed', totalItems, message: 'Import completed' });
    }
    async importItem(item, serverId) {
        const payload = JSON.parse(item.payload_json);
        switch (item.item_type) {
            // Items with real Docker compose content → full import with VPS file write
            case 'docker_stack':
            case 'coolify_project':
            case 'dokploy_project':
                return this.dockerStackImporter.import(item, serverId, payload);
            // Standalone containers → generate minimal compose, then same flow
            case 'docker_container':
                return this.dockerStackImporter.importContainer(item, serverId, payload);
            // Items without Docker compose — snapshot-only
            case 'pm2_app':
            case 'nginx_site':
                return {
                    itemId: item.id,
                    success: true,
                    rollbackData: { type: 'noop', reason: `${item.item_type} is snapshot-only (Dockerfile generation needed — Phase 2)` },
                };
            case 'database':
                return this.databaseImporter.import(item, serverId, payload);
            case 'cron_job':
                return this.cronImporter.import(item, serverId, payload);
            case 'systemd_service':
            case 'domain':
            case 'ssl_certificate':
            case 'ansible_role':
            case 'env_file':
                // Snapshot-only items — mark as imported but no record created
                return {
                    itemId: item.id,
                    success: true,
                    rollbackData: { type: 'noop', reason: `${item.item_type} is snapshot-only` },
                };
            default:
                return { itemId: item.id, success: false, error: `Unknown item type: ${item.item_type}` };
        }
    }
    emitProgress(progress) {
        electron_1.BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed())
                w.webContents.send('migration:importProgress', progress);
        });
    }
}
exports.MigrationImportEngine = MigrationImportEngine;
//# sourceMappingURL=MigrationImportEngine.js.map