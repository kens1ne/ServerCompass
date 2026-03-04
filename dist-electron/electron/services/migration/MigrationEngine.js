"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrationEngine = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const MigrationScanEngine_1 = require("./MigrationScanEngine");
const MigrationImportEngine_1 = require("./MigrationImportEngine");
const MigrationVerifyEngine_1 = require("./MigrationVerifyEngine");
const MigrationRollbackEngine_1 = require("./MigrationRollbackEngine");
class MigrationEngineClass {
    scanEngine = new MigrationScanEngine_1.MigrationScanEngine();
    importEngine = new MigrationImportEngine_1.MigrationImportEngine();
    verifyEngine = new MigrationVerifyEngine_1.MigrationVerifyEngine();
    rollbackEngine = new MigrationRollbackEngine_1.MigrationRollbackEngine();
    async startMigration(input) {
        const migrationId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        // Create migration session
        db_1.db.prepare(`
      INSERT INTO server_migrations (id, source_server_id, target_server_id, migration_mode, status, scan_started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'scanning', ?, ?, ?)
    `).run(migrationId, input.sourceServerId, input.targetServerId ?? null, input.mode, now, now, now);
        try {
            // Detect and scan
            const result = await this.scanEngine.detectAndScan(migrationId, input.sourceServerId);
            // Persist discovered items
            const insertItem = db_1.db.prepare(`
        INSERT INTO server_migration_discovered_items
        (id, migration_id, source_server_id, item_type, remote_key, display_name, description,
         payload_json, provider_source, priority, depends_on, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            const insertMany = db_1.db.transaction((items) => {
                for (const item of items) {
                    insertItem.run(item.id, migrationId, input.sourceServerId, item.itemType, item.remoteKey, item.displayName, item.description ?? null, JSON.stringify(item.payload), item.providerSource, item.priority, item.dependsOn.length > 0 ? JSON.stringify(item.dependsOn) : null, now, now);
                }
            });
            insertMany(result.items);
            // Update migration status
            db_1.db.prepare(`
        UPDATE server_migrations
        SET status = 'scanned', provider = ?, provider_version = ?,
            scan_completed_at = ?, total_discovered = ?, updated_at = ?
        WHERE id = ?
      `).run(result.provider, result.providerVersion, Date.now(), result.items.length, Date.now(), migrationId);
            if (result.warnings.length > 0 || result.errors.length > 0) {
                db_1.db.prepare(`UPDATE server_migrations SET scan_log = ?, updated_at = ? WHERE id = ?`)
                    .run(JSON.stringify({ warnings: result.warnings, errors: result.errors }), Date.now(), migrationId);
            }
            return result;
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            db_1.db.prepare(`UPDATE server_migrations SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
                .run(errMsg, Date.now(), migrationId);
            throw err;
        }
    }
    /**
     * Prepares the migration (updates selections, sets status) synchronously,
     * then kicks off the async import in the background.
     * Returns immediately so the frontend can subscribe to progress events.
     */
    prepareMigration(input) {
        const migration = this.getMigration(input.migrationId);
        if (!migration)
            throw new Error('Migration not found');
        if (migration.status !== 'scanned' && migration.status !== 'configuring') {
            throw new Error(`Cannot execute migration in status: ${migration.status}`);
        }
        // Update item selections
        const updateSelection = db_1.db.prepare('UPDATE server_migration_discovered_items SET selected = ?, updated_at = ? WHERE id = ?');
        const updateMany = db_1.db.transaction((selection) => {
            for (const [itemId, selected] of Object.entries(selection)) {
                updateSelection.run(selected ? 1 : 0, Date.now(), itemId);
            }
        });
        updateMany(input.selection);
        // Count selected
        const selectedCount = db_1.db.prepare('SELECT COUNT(*) as count FROM server_migration_discovered_items WHERE migration_id = ? AND selected = 1').get(input.migrationId);
        const now = Date.now();
        db_1.db.prepare(`
      UPDATE server_migrations
      SET status = 'importing', total_selected = ?, import_started_at = ?, updated_at = ?
      WHERE id = ?
    `).run(selectedCount.count, now, now, input.migrationId);
        // Fire-and-forget: run the import in the background so the IPC handler
        // returns immediately and the frontend can mount the progress listener.
        this.runImportInBackground(input.migrationId, migration.migration_mode, migration.source_server_id);
    }
    runImportInBackground(migrationId, mode, sourceServerId) {
        (async () => {
            try {
                if (mode === 'same_server') {
                    await this.importEngine.importSelected(migrationId, sourceServerId);
                }
                // cross_server modes will use transferEngine (Phase 2)
                db_1.db.prepare(`
          UPDATE server_migrations SET status = 'verifying', import_completed_at = ?, updated_at = ? WHERE id = ?
        `).run(Date.now(), Date.now(), migrationId);
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                db_1.db.prepare(`UPDATE server_migrations SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
                    .run(errMsg, Date.now(), migrationId);
                console.error('[Migration] Background import failed:', errMsg);
            }
        })();
    }
    /**
     * Prepares verification state synchronously, then runs checks in the background.
     * Returns immediately so the frontend receives progress events in real-time.
     */
    prepareVerification(migrationId) {
        const migration = this.getMigration(migrationId);
        if (!migration)
            throw new Error('Migration not found');
        const now = Date.now();
        db_1.db.prepare(`UPDATE server_migrations SET verification_started_at = ?, updated_at = ? WHERE id = ?`)
            .run(now, now, migrationId);
        const targetServerId = migration.target_server_id || migration.source_server_id;
        this.runVerificationInBackground(migrationId, targetServerId);
    }
    runVerificationInBackground(migrationId, targetServerId) {
        (async () => {
            try {
                await this.verifyEngine.verifyAll(migrationId, targetServerId);
                db_1.db.prepare(`
          UPDATE server_migrations SET status = 'completed', verification_completed_at = ?, updated_at = ? WHERE id = ?
        `).run(Date.now(), Date.now(), migrationId);
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                db_1.db.prepare(`UPDATE server_migrations SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
                    .run(errMsg, Date.now(), migrationId);
                console.error('[Migration] Background verification failed:', errMsg);
            }
        })();
    }
    async rollback(migrationId) {
        const migration = this.getMigration(migrationId);
        if (!migration)
            throw new Error('Migration not found');
        db_1.db.prepare(`UPDATE server_migrations SET status = 'rolling_back', updated_at = ? WHERE id = ?`)
            .run(Date.now(), migrationId);
        await this.rollbackEngine.rollbackMigration(migrationId);
    }
    async getDecommissionPlan(migrationId) {
        const migration = this.getMigration(migrationId);
        if (!migration)
            return null;
        return this.scanEngine.getDecommissionPlan(migration.provider, migration.source_server_id);
    }
    async executeDecommissionStep(migrationId, stepId) {
        const migration = this.getMigration(migrationId);
        if (!migration)
            return { success: false, output: 'Migration not found' };
        const plan = await this.getDecommissionPlan(migrationId);
        if (!plan)
            return { success: false, output: 'No decommission plan' };
        const step = plan.steps.find(s => s.id === stepId);
        if (!step)
            return { success: false, output: 'Step not found' };
        return this.scanEngine.executeDecommissionStep(migration.provider, migration.source_server_id, step);
    }
    // Stub for Phase 2
    async getCutoverPlan(_migrationId) {
        throw new Error('Cross-server cutover is not yet implemented (Phase 2)');
    }
    async executeCutover(_migrationId) {
        throw new Error('Cross-server cutover is not yet implemented (Phase 2)');
    }
    // Session management
    getMigration(id) {
        return db_1.db.prepare('SELECT * FROM server_migrations WHERE id = ?').get(id) ?? null;
    }
    getDiscoveredItems(migrationId) {
        return db_1.db.prepare('SELECT * FROM server_migration_discovered_items WHERE migration_id = ? ORDER BY priority ASC').all(migrationId);
    }
    updateItemSelection(itemId, selected) {
        db_1.db.prepare('UPDATE server_migration_discovered_items SET selected = ?, updated_at = ? WHERE id = ?')
            .run(selected ? 1 : 0, Date.now(), itemId);
    }
    getMigrationsForServer(serverId) {
        return db_1.db.prepare('SELECT * FROM server_migrations WHERE source_server_id = ? ORDER BY created_at DESC').all(serverId);
    }
    cancelMigration(migrationId) {
        db_1.db.prepare(`UPDATE server_migrations SET status = 'cancelled', updated_at = ? WHERE id = ?`)
            .run(Date.now(), migrationId);
    }
    retryItem(itemId) {
        db_1.db.prepare(`
      UPDATE server_migration_discovered_items
      SET import_status = 'pending', error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), itemId);
    }
}
exports.migrationEngine = new MigrationEngineClass();
//# sourceMappingURL=MigrationEngine.js.map