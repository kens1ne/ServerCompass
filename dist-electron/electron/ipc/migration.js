"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMigrationHandlers = registerMigrationHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const MigrationEngine_1 = require("../services/migration/MigrationEngine");
function registerMigrationHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_START, async (_event, input) => {
        try {
            const validated = types_1.MigrationStartSchema.parse(input);
            const result = await MigrationEngine_1.migrationEngine.startMigration(validated);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[Migration] Start failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_GET_SESSION, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationGetSessionSchema.parse(input);
            const session = MigrationEngine_1.migrationEngine.getMigration(migrationId);
            return { success: true, data: session };
        }
        catch (error) {
            console.error('[Migration] Get session failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_GET_ITEMS, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationGetItemsSchema.parse(input);
            const items = MigrationEngine_1.migrationEngine.getDiscoveredItems(migrationId);
            return { success: true, data: items };
        }
        catch (error) {
            console.error('[Migration] Get items failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_SELECT_ITEMS, async (_event, input) => {
        try {
            const { selection } = types_1.MigrationSelectItemsSchema.parse(input);
            for (const [itemId, selected] of Object.entries(selection)) {
                MigrationEngine_1.migrationEngine.updateItemSelection(itemId, selected);
            }
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Select items failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_EXECUTE, async (_event, input) => {
        try {
            const validated = types_1.MigrationExecuteSchema.parse(input);
            // prepareMigration is synchronous: updates DB selections/status then
            // kicks off the async import in the background. Returns immediately
            // so the frontend can mount its progress listener before events fire.
            MigrationEngine_1.migrationEngine.prepareMigration(validated);
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Execute failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_VERIFY, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationVerifySchema.parse(input);
            // prepareVerification is synchronous: updates DB timestamps then
            // kicks off the async verification in the background. Returns immediately
            // so the frontend receives progress events in real-time.
            MigrationEngine_1.migrationEngine.prepareVerification(migrationId);
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Verify failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_ROLLBACK, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationRollbackSchema.parse(input);
            await MigrationEngine_1.migrationEngine.rollback(migrationId);
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Rollback failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_GET_DECOMMISSION_PLAN, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationGetDecommissionPlanSchema.parse(input);
            const plan = await MigrationEngine_1.migrationEngine.getDecommissionPlan(migrationId);
            return { success: true, data: plan };
        }
        catch (error) {
            console.error('[Migration] Get decommission plan failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_EXECUTE_DECOMMISSION_STEP, async (_event, input) => {
        try {
            const { migrationId, stepId } = types_1.MigrationExecuteDecommissionStepSchema.parse(input);
            const result = await MigrationEngine_1.migrationEngine.executeDecommissionStep(migrationId, stepId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[Migration] Execute decommission step failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_GET_CUTOVER_PLAN, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationGetCutoverPlanSchema.parse(input);
            const plan = await MigrationEngine_1.migrationEngine.getCutoverPlan(migrationId);
            return { success: true, data: plan };
        }
        catch (error) {
            console.error('[Migration] Get cutover plan failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_EXECUTE_CUTOVER, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationExecuteCutoverSchema.parse(input);
            await MigrationEngine_1.migrationEngine.executeCutover(migrationId);
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Execute cutover failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_CANCEL, async (_event, input) => {
        try {
            const { migrationId } = types_1.MigrationCancelSchema.parse(input);
            MigrationEngine_1.migrationEngine.cancelMigration(migrationId);
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Cancel failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_GET_HISTORY, async (_event, input) => {
        try {
            const { serverId } = types_1.MigrationGetHistorySchema.parse(input);
            const history = MigrationEngine_1.migrationEngine.getMigrationsForServer(serverId);
            return { success: true, data: history };
        }
        catch (error) {
            console.error('[Migration] Get history failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MIGRATION_RETRY_ITEM, async (_event, input) => {
        try {
            const { itemId } = types_1.MigrationRetryItemSchema.parse(input);
            MigrationEngine_1.migrationEngine.retryItem(itemId);
            return { success: true, data: null };
        }
        catch (error) {
            console.error('[Migration] Retry item failed:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
//# sourceMappingURL=migration.js.map