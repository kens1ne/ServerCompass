"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OneClickGetActionOptionsSchema = exports.OneClickExecuteActionSchema = exports.OneClickLogsSchema = exports.OneClickInstallationIdSchema = exports.OneClickServerIdSchema = exports.OneClickSendInputSchema = exports.OneClickInstallSchema = exports.OneClickPrereqSchema = exports.OneClickTemplateIdSchema = exports.ImportEnvFileSchema = exports.SecretCollectionIdSchema = exports.UpdateSecretCollectionSchema = exports.CreateSecretCollectionSchema = void 0;
const zod_1 = require("zod");
// Secret Vault schemas
exports.CreateSecretCollectionSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().max(500).optional(),
    tags: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    secrets: zod_1.z.record(zod_1.z.string(), zod_1.z.string()),
});
exports.UpdateSecretCollectionSchema = zod_1.z.object({
    id: zod_1.z.string(),
    updates: zod_1.z.object({
        name: zod_1.z.string().min(1).max(100).optional(),
        description: zod_1.z.string().max(500).nullable().optional(),
        tags: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
        secrets: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    }),
});
exports.SecretCollectionIdSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
exports.ImportEnvFileSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().max(500).optional(),
    tags: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    envContent: zod_1.z.string(),
});
// ============ One-Click Install Schemas ============
exports.OneClickTemplateIdSchema = zod_1.z.object({
    templateId: zod_1.z.string(),
});
exports.OneClickPrereqSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    templateId: zod_1.z.string(),
});
exports.OneClickInstallSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    templateId: zod_1.z.string(),
});
exports.OneClickSendInputSchema = zod_1.z.object({
    installationId: zod_1.z.string(),
    input: zod_1.z.string(),
});
exports.OneClickServerIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.OneClickInstallationIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    installationId: zod_1.z.string(),
});
exports.OneClickLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    installationId: zod_1.z.string(),
    lines: zod_1.z.number().optional(),
});
exports.OneClickExecuteActionSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    installationId: zod_1.z.string(),
    actionId: zod_1.z.string(),
    inputs: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
});
exports.OneClickGetActionOptionsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    templateId: zod_1.z.string(),
    actionId: zod_1.z.string(),
    inputName: zod_1.z.string(),
});
//# sourceMappingURL=secrets-one-click-schemas.js.map