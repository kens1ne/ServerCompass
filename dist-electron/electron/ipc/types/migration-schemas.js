"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationRetryItemSchema = exports.MigrationGetHistorySchema = exports.MigrationCancelSchema = exports.MigrationExecuteCutoverSchema = exports.MigrationGetCutoverPlanSchema = exports.MigrationExecuteDecommissionStepSchema = exports.MigrationGetDecommissionPlanSchema = exports.MigrationRollbackSchema = exports.MigrationVerifySchema = exports.MigrationExecuteSchema = exports.MigrationSelectItemsSchema = exports.MigrationGetItemsSchema = exports.MigrationGetSessionSchema = exports.MigrationStartSchema = void 0;
const zod_1 = require("zod");
// ============ Migration Schemas ============
exports.MigrationStartSchema = zod_1.z.object({
    sourceServerId: zod_1.z.string(),
    targetServerId: zod_1.z.string().optional(),
    mode: zod_1.z.enum(['same_server', 'cross_server_staging', 'cross_server_bluegreen']),
});
exports.MigrationGetSessionSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationGetItemsSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationSelectItemsSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
    selection: zod_1.z.record(zod_1.z.string(), zod_1.z.boolean()),
});
exports.MigrationExecuteSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
    selection: zod_1.z.record(zod_1.z.string(), zod_1.z.boolean()),
});
exports.MigrationVerifySchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationRollbackSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationGetDecommissionPlanSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationExecuteDecommissionStepSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
    stepId: zod_1.z.string(),
});
exports.MigrationGetCutoverPlanSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationExecuteCutoverSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationCancelSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
});
exports.MigrationGetHistorySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.MigrationRetryItemSchema = zod_1.z.object({
    migrationId: zod_1.z.string(),
    itemId: zod_1.z.string(),
});
//# sourceMappingURL=migration-schemas.js.map