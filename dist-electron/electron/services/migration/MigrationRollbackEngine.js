"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationRollbackEngine = void 0;
const db_1 = require("../../db");
const SSHService_1 = require("../SSHService");
class MigrationRollbackEngine {
    async rollbackMigration(migrationId) {
        // Get all imported items in reverse priority order
        const items = db_1.db.prepare(`
      SELECT * FROM server_migration_discovered_items
      WHERE migration_id = ? AND import_status = 'imported' AND rollback_data IS NOT NULL
      ORDER BY priority DESC
    `).all(migrationId);
        const logs = [];
        for (const item of items) {
            try {
                const action = JSON.parse(item.rollback_data);
                const result = await this.executeRollbackAction(action);
                logs.push(`[${item.display_name}] ${result.success ? 'Rolled back' : 'Failed: ' + result.message}`);
                db_1.db.prepare(`
          UPDATE server_migration_discovered_items
          SET import_status = 'rolled_back', updated_at = ?
          WHERE id = ?
        `).run(Date.now(), item.id);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logs.push(`[${item.display_name}] Rollback error: ${msg}`);
            }
        }
        // Update migration status
        db_1.db.prepare(`
      UPDATE server_migrations
      SET status = 'rolled_back', rollback_log = ?, updated_at = ?
      WHERE id = ?
    `).run(logs.join('\n'), Date.now(), migrationId);
    }
    async executeRollbackAction(action) {
        switch (action.type) {
            case 'delete_stack': {
                // Read stack record first to get serverId for SSH
                const stack = db_1.db.prepare('SELECT server_id, project_name FROM docker_stacks WHERE id = ?')
                    .get(action.stackId);
                if (stack) {
                    try {
                        await SSHService_1.sshService.executeCommand(stack.server_id, `cd /root/server-compass/apps/${action.projectName} && docker compose down -v 2>/dev/null; rm -rf /root/server-compass/apps/${action.projectName}`);
                    }
                    catch { /* best effort */ }
                }
                // Delete database record
                db_1.db.prepare('DELETE FROM docker_stacks WHERE id = ?').run(action.stackId);
                return { success: true, message: 'Stack deleted' };
            }
            case 'delete_database_record': {
                db_1.db.prepare('DELETE FROM databases WHERE id = ?').run(action.databaseId);
                return { success: true, message: 'Database record deleted' };
            }
            case 'remove_cron': {
                try {
                    // Remove the cron line from crontab
                    await SSHService_1.sshService.executeCommand(action.serverId, `crontab -l 2>/dev/null | grep -v -F "${action.cronLine}" | crontab -`);
                }
                catch { /* best effort */ }
                return { success: true, message: 'Cron entry removed' };
            }
            case 'delete_domain': {
                db_1.db.prepare('DELETE FROM domains WHERE id = ?').run(action.domainId);
                return { success: true, message: 'Domain record deleted' };
            }
            case 'remove_directory': {
                try {
                    await SSHService_1.sshService.executeCommand(action.serverId, `rm -rf ${action.path}`);
                }
                catch { /* best effort */ }
                return { success: true, message: 'Directory removed' };
            }
            case 'restore_compose': {
                db_1.db.prepare('UPDATE docker_stacks SET compose_content = ? WHERE id = ?')
                    .run(action.previousContent, action.stackId);
                return { success: true, message: 'Compose content restored' };
            }
            case 'noop':
                return { success: true, message: action.reason };
            default:
                return { success: false, message: 'Unknown rollback action type' };
        }
    }
}
exports.MigrationRollbackEngine = MigrationRollbackEngine;
//# sourceMappingURL=MigrationRollbackEngine.js.map