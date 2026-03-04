"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitoringGetAlertsSchema = exports.MonitoringDeleteNotificationChannelSchema = exports.MonitoringUpdateNotificationChannelSchema = exports.MonitoringNotificationChannelSchema = exports.MonitoringDeleteAlertRuleSchema = exports.MonitoringUpdateAlertRuleSchema = exports.MonitoringAlertRuleSchema = exports.MonitoringSendNotificationSchema = exports.MonitoringTestNotificationChannelSchema = exports.MonitoringTestNotificationSchema = exports.MonitoringGetLogsSchema = exports.MonitoringUpdateConfigSchema = exports.MonitoringServerIdSchema = exports.LocalDockerValidateContextSchema = exports.LocalDockerGetBuildsSchema = exports.LocalDockerCleanupSchema = exports.LocalDockerCancelSchema = exports.LocalDockerDeploySchema = exports.LocalDockerStreamSchema = exports.LocalDockerBuildSchema = exports.LocalDockerCheckResultSchema = exports.LocalDockerCheckSchema = void 0;
const zod_1 = require("zod");
// ============ Local Docker Build Schemas ============
exports.LocalDockerCheckSchema = zod_1.z.object({});
exports.LocalDockerCheckResultSchema = zod_1.z.object({
    available: zod_1.z.boolean(),
    status: zod_1.z.enum(['available', 'not_installed', 'not_running']),
    version: zod_1.z.string().optional(),
    platform: zod_1.z.enum(['mac', 'windows', 'linux']).optional(),
    error: zod_1.z.string().optional(),
    downloadUrl: zod_1.z.string().optional(),
});
exports.LocalDockerBuildSchema = zod_1.z.object({
    buildId: zod_1.z.string().optional(), // Optional: frontend can provide buildId to subscribe to events before build starts
    projectPath: zod_1.z.string(),
    dockerfilePath: zod_1.z.string().optional(),
    imageName: zod_1.z.string(),
    imageTag: zod_1.z.string().default('latest'),
    platform: zod_1.z.string().default('linux/amd64'),
    buildArgs: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    noCache: zod_1.z.boolean().default(false),
});
exports.LocalDockerStreamSchema = zod_1.z.object({
    streamId: zod_1.z.string().optional(), // Optional: frontend can provide streamId to subscribe to events before stream starts
    imageName: zod_1.z.string(),
    imageTag: zod_1.z.string(),
    serverId: zod_1.z.string(),
    useCompression: zod_1.z.boolean().default(false),
});
exports.LocalDockerDeploySchema = zod_1.z.object({
    projectPath: zod_1.z.string(),
    serverId: zod_1.z.string(),
    appName: zod_1.z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*[a-z0-9]$|^[a-z0-9]$/, 'App name must start/end with alphanumeric and contain only lowercase letters, numbers, hyphens, and underscores'),
    // Build options
    dockerfilePath: zod_1.z.string().optional(),
    platform: zod_1.z.string().default('linux/amd64'),
    buildArgs: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    noCache: zod_1.z.boolean().default(false),
    // Deploy options
    port: zod_1.z.number().int().min(1).max(65535),
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    domain: zod_1.z.string().optional(),
    // Cleanup options
    cleanupLocalImage: zod_1.z.boolean().default(true),
    useCompression: zod_1.z.boolean().default(false),
});
exports.LocalDockerCancelSchema = zod_1.z.object({
    buildId: zod_1.z.string().optional(),
    streamId: zod_1.z.string().optional(),
});
exports.LocalDockerCleanupSchema = zod_1.z.object({
    imageName: zod_1.z.string(),
    imageTag: zod_1.z.string(),
});
exports.LocalDockerGetBuildsSchema = zod_1.z.object({
    serverId: zod_1.z.string().optional(),
    limit: zod_1.z.number().int().positive().default(20).optional(),
});
exports.LocalDockerValidateContextSchema = zod_1.z.object({
    projectPath: zod_1.z.string(),
});
// ============ Monitoring Schemas ============
exports.MonitoringServerIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.MonitoringUpdateConfigSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    enabled: zod_1.z.boolean().optional(),
    intervalSeconds: zod_1.z.number().int().min(30).max(3600).optional(),
    retentionDays: zod_1.z.number().int().min(1).max(365).optional(),
    logMaxLines: zod_1.z.number().int().min(100).max(100000).optional(),
    logMaxSizeMb: zod_1.z.number().int().min(1).max(1000).optional(),
    logRetentionDays: zod_1.z.number().int().min(1).max(365).optional(),
});
exports.MonitoringGetLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    lines: zod_1.z.number().int().min(1).max(10000).default(100).optional(),
});
exports.MonitoringTestNotificationSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    channel: zod_1.z.enum(['slack', 'discord', 'email', 'webhook']),
});
exports.MonitoringTestNotificationChannelSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    channelId: zod_1.z.string().min(1),
    title: zod_1.z.string().min(1).max(120),
    message: zod_1.z.string().min(1).max(2000),
    severity: zod_1.z.enum(['critical', 'warning', 'info']).default('info').optional(),
});
exports.MonitoringSendNotificationSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    severity: zod_1.z.enum(['critical', 'warning', 'info']).default('info'),
    title: zod_1.z.string().min(1),
    message: zod_1.z.string().min(1),
    status: zod_1.z.string().optional(),
});
exports.MonitoringAlertRuleSchema = zod_1.z.object({
    serverId: zod_1.z.string().nullable(),
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().max(500).optional(),
    metric: zod_1.z.enum(['cpu_usage', 'memory_usage', 'disk_usage', 'load_1m', 'load_5m', 'load_15m']),
    operator: zod_1.z.enum(['>', '<', '>=', '<=', '==', '!=']),
    threshold: zod_1.z.number(),
    durationSeconds: zod_1.z.number().int().min(0).max(3600).default(0).optional(),
    cooldownSeconds: zod_1.z.number().int().min(0).max(86400).default(300).optional(),
    severity: zod_1.z.enum(['critical', 'warning', 'info']),
    notifyOnFiring: zod_1.z.boolean().default(true).optional(),
    notifyOnResolved: zod_1.z.boolean().default(true).optional(),
    notificationChannels: zod_1.z.array(zod_1.z.string()).default([]).optional(),
});
exports.MonitoringUpdateAlertRuleSchema = zod_1.z.object({
    id: zod_1.z.string(),
    name: zod_1.z.string().min(1).max(100).optional(),
    description: zod_1.z.string().max(500).nullable().optional(),
    enabled: zod_1.z.boolean().optional(),
    metric: zod_1.z.enum(['cpu_usage', 'memory_usage', 'disk_usage', 'load_1m', 'load_5m', 'load_15m']).optional(),
    operator: zod_1.z.enum(['>', '<', '>=', '<=', '==', '!=']).optional(),
    threshold: zod_1.z.number().optional(),
    durationSeconds: zod_1.z.number().int().min(0).max(3600).optional(),
    cooldownSeconds: zod_1.z.number().int().min(0).max(86400).optional(),
    severity: zod_1.z.enum(['critical', 'warning', 'info']).optional(),
    notifyOnFiring: zod_1.z.boolean().optional(),
    notifyOnResolved: zod_1.z.boolean().optional(),
    notificationChannels: zod_1.z.array(zod_1.z.string()).optional(),
});
exports.MonitoringDeleteAlertRuleSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
exports.MonitoringNotificationChannelSchema = zod_1.z.object({
    serverId: zod_1.z.string().nullable(),
    name: zod_1.z.string().min(1).max(100),
    type: zod_1.z.enum(['slack', 'discord', 'email', 'webhook']),
    config: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()),
});
exports.MonitoringUpdateNotificationChannelSchema = zod_1.z.object({
    id: zod_1.z.string(),
    name: zod_1.z.string().min(1).max(100).optional(),
    enabled: zod_1.z.boolean().optional(),
    config: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    lastTestAt: zod_1.z.number().optional(),
    lastTestStatus: zod_1.z.string().optional(),
});
exports.MonitoringDeleteNotificationChannelSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
exports.MonitoringGetAlertsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    status: zod_1.z.enum(['pending', 'firing', 'resolved']).optional(),
    limit: zod_1.z.number().int().min(1).max(1000).default(50).optional(),
});
//# sourceMappingURL=local-docker-monitoring.js.map