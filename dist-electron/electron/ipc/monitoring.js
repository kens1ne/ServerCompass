"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMonitoringHandlers = registerMonitoringHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const MonitoringAgentService_1 = require("../services/MonitoringAgentService");
function registerMonitoringHandlers() {
    void MonitoringAgentService_1.monitoringAgentService.migrateNotificationChannelSecrets().catch((error) => {
        console.warn('[Monitoring] Notification channel secrets migration failed:', error);
    });
    // ============ Agent Configuration ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_CONFIG, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const config = MonitoringAgentService_1.monitoringAgentService.getConfig(serverId);
            if (!config) {
                return { success: true, data: null };
            }
            return {
                success: true,
                data: {
                    serverId: config.server_id,
                    enabled: Boolean(config.enabled),
                    intervalSeconds: config.interval_seconds,
                    retentionDays: config.retention_days,
                    agentInstalled: Boolean(config.agent_installed),
                    agentVersion: config.agent_version,
                    agentLastSeen: config.agent_last_seen,
                    logMaxLines: config.log_max_lines,
                    logMaxSizeMb: config.log_max_size_mb,
                    logRetentionDays: config.log_retention_days,
                },
            };
        }
        catch (error) {
            console.error('Error getting monitoring config:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_UPDATE_CONFIG, async (_event, input) => {
        try {
            const config = types_1.MonitoringUpdateConfigSchema.parse(input);
            MonitoringAgentService_1.monitoringAgentService.upsertConfig(config.serverId, {
                enabled: config.enabled !== undefined ? (config.enabled ? 1 : 0) : undefined,
                interval_seconds: config.intervalSeconds,
                retention_days: config.retentionDays,
                log_max_lines: config.logMaxLines,
                log_max_size_mb: config.logMaxSizeMb,
                log_retention_days: config.logRetentionDays,
            });
            return { success: true };
        }
        catch (error) {
            console.error('Error updating monitoring config:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Agent Status & Installation ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_AGENT_STATUS, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const status = await MonitoringAgentService_1.monitoringAgentService.getAgentStatus(serverId);
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Error getting agent status:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_INSTALL_AGENT, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            await MonitoringAgentService_1.monitoringAgentService.installAgent(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error installing monitoring agent:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_UNINSTALL_AGENT, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            await MonitoringAgentService_1.monitoringAgentService.uninstallAgent(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error uninstalling monitoring agent:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_PUSH_CONFIG, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const agentConfig = await MonitoringAgentService_1.monitoringAgentService.buildAgentConfig(serverId);
            await MonitoringAgentService_1.monitoringAgentService.pushConfig(serverId, agentConfig);
            return { success: true };
        }
        catch (error) {
            console.error('Error pushing monitoring config:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_AGENT_LOGS, async (_event, input) => {
        try {
            const { serverId, lines } = types_1.MonitoringGetLogsSchema.parse(input);
            const logs = await MonitoringAgentService_1.monitoringAgentService.getAgentLogs(serverId, lines);
            return { success: true, data: logs };
        }
        catch (error) {
            console.error('Error getting agent logs:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_TRIGGER_RUN, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const result = await MonitoringAgentService_1.monitoringAgentService.triggerManualRun(serverId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error triggering manual agent run:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_TEST_NOTIFICATION, async (_event, input) => {
        try {
            const { serverId, channel } = types_1.MonitoringTestNotificationSchema.parse(input);
            const result = await MonitoringAgentService_1.monitoringAgentService.sendTestNotification(serverId, channel);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error testing notification:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_TEST_NOTIFICATION_CHANNEL, async (_event, input) => {
        try {
            const { serverId, channelId, title, message, severity } = types_1.MonitoringTestNotificationChannelSchema.parse(input);
            const result = await MonitoringAgentService_1.monitoringAgentService.sendChannelTestNotification(serverId, {
                channelId,
                title,
                message,
                severity,
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error testing notification channel:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_SEND_NOTIFICATION, async (_event, input) => {
        try {
            const { serverId, severity, title, message, status } = types_1.MonitoringSendNotificationSchema.parse(input);
            const result = await MonitoringAgentService_1.monitoringAgentService.sendNotification(serverId, {
                severity,
                title,
                message,
                status,
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error sending notification:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_AGENT_SOURCE, async () => {
        try {
            const source = MonitoringAgentService_1.monitoringAgentService.getAgentSourceCode();
            return { success: true, data: source };
        }
        catch (error) {
            console.error('Error getting agent source code:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_CHECK_DEPENDENCIES, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const result = await MonitoringAgentService_1.monitoringAgentService.checkDependencies(serverId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error checking dependencies:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Alert Rules ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_ALERT_RULES, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const rules = MonitoringAgentService_1.monitoringAgentService.getAlertRules(serverId);
            return { success: true, data: rules };
        }
        catch (error) {
            console.error('Error getting alert rules:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_CREATE_ALERT_RULE, async (_event, input) => {
        try {
            const rule = types_1.MonitoringAlertRuleSchema.parse(input);
            const id = MonitoringAgentService_1.monitoringAgentService.createAlertRule(rule);
            return { success: true, data: { id } };
        }
        catch (error) {
            console.error('Error creating alert rule:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_UPDATE_ALERT_RULE, async (_event, input) => {
        try {
            const { id, ...updates } = types_1.MonitoringUpdateAlertRuleSchema.parse(input);
            MonitoringAgentService_1.monitoringAgentService.updateAlertRule(id, updates);
            return { success: true };
        }
        catch (error) {
            console.error('Error updating alert rule:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_DELETE_ALERT_RULE, async (_event, input) => {
        try {
            const { id } = types_1.MonitoringDeleteAlertRuleSchema.parse(input);
            MonitoringAgentService_1.monitoringAgentService.deleteAlertRule(id);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting alert rule:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_INIT_DEFAULT_RULES, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            MonitoringAgentService_1.monitoringAgentService.initializeDefaultRules(serverId);
            return { success: true };
        }
        catch (error) {
            console.error('Error initializing default rules:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Notification Channels ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_NOTIFICATION_CHANNELS, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const channels = await MonitoringAgentService_1.monitoringAgentService.getNotificationChannels(serverId);
            return { success: true, data: channels };
        }
        catch (error) {
            console.error('Error getting notification channels:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_CREATE_NOTIFICATION_CHANNEL, async (_event, input) => {
        try {
            const channel = types_1.MonitoringNotificationChannelSchema.parse(input);
            const id = await MonitoringAgentService_1.monitoringAgentService.createNotificationChannel(channel);
            return { success: true, data: { id } };
        }
        catch (error) {
            console.error('Error creating notification channel:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_UPDATE_NOTIFICATION_CHANNEL, async (_event, input) => {
        try {
            const { id, ...updates } = types_1.MonitoringUpdateNotificationChannelSchema.parse(input);
            await MonitoringAgentService_1.monitoringAgentService.updateNotificationChannel(id, updates);
            return { success: true };
        }
        catch (error) {
            console.error('Error updating notification channel:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_DELETE_NOTIFICATION_CHANNEL, async (_event, input) => {
        try {
            const { id } = types_1.MonitoringDeleteNotificationChannelSchema.parse(input);
            MonitoringAgentService_1.monitoringAgentService.deleteNotificationChannel(id);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting notification channel:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Alerts History ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_ALERTS, async (_event, input) => {
        try {
            const { serverId, status, limit } = types_1.MonitoringGetAlertsSchema.parse(input);
            const alerts = MonitoringAgentService_1.monitoringAgentService.getAlerts(serverId, { status, limit });
            return { success: true, data: alerts };
        }
        catch (error) {
            console.error('Error getting alerts:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_GET_ACTIVE_ALERT_COUNT, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const count = MonitoringAgentService_1.monitoringAgentService.getActiveAlertCount(serverId);
            return { success: true, data: count };
        }
        catch (error) {
            console.error('Error getting active alert count:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.MONITORING_SYNC_ALERTS, async (_event, input) => {
        try {
            const { serverId } = types_1.MonitoringServerIdSchema.parse(input);
            const result = await MonitoringAgentService_1.monitoringAgentService.syncAlertsFromVPS(serverId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error syncing alerts from VPS:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=monitoring.js.map