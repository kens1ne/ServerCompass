"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerOneClickHandlers = registerOneClickHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const OneClickService_1 = require("../services/OneClickService");
function registerOneClickHandlers() {
    // ============ Templates ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_GET_TEMPLATES, async () => {
        try {
            const templates = OneClickService_1.oneClickService.getTemplates();
            return { success: true, data: templates };
        }
        catch (error) {
            console.error('Error getting one-click templates:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_GET_TEMPLATE, async (_event, input) => {
        try {
            const { templateId } = types_1.OneClickTemplateIdSchema.parse(input);
            const template = OneClickService_1.oneClickService.getTemplate(templateId);
            return { success: true, data: template };
        }
        catch (error) {
            console.error('Error getting one-click template:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Prerequisites ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_CHECK_PREREQUISITES, async (_event, input) => {
        try {
            const { serverId, templateId } = types_1.OneClickPrereqSchema.parse(input);
            const result = await OneClickService_1.oneClickService.checkPrerequisites(serverId, templateId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error checking prerequisites:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Installation ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_INSTALL, async (_event, input) => {
        try {
            const { serverId, templateId } = types_1.OneClickInstallSchema.parse(input);
            const window = electron_1.BrowserWindow.getAllWindows()[0];
            if (!window)
                throw new Error('No browser window available');
            const result = await OneClickService_1.oneClickService.install(serverId, templateId, window);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error starting one-click install:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_SEND_INPUT, async (_event, input) => {
        try {
            const { installationId, input: userInput } = types_1.OneClickSendInputSchema.parse(input);
            OneClickService_1.oneClickService.sendInput(installationId, userInput);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error sending input:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Queries ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_GET_INSTALLATIONS, async (_event, input) => {
        try {
            const { serverId } = types_1.OneClickServerIdSchema.parse(input);
            const installations = OneClickService_1.oneClickService.getInstallations(serverId);
            return { success: true, data: installations };
        }
        catch (error) {
            console.error('Error getting installations:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_GET_INSTALLATION, async (_event, input) => {
        try {
            const { installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            const installation = OneClickService_1.oneClickService.getInstallation(installationId);
            return { success: true, data: installation };
        }
        catch (error) {
            console.error('Error getting installation:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Lifecycle ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_START, async (_event, input) => {
        try {
            const { serverId, installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            const result = await OneClickService_1.oneClickService.start(serverId, installationId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error starting service:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_STOP, async (_event, input) => {
        try {
            const { serverId, installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            const result = await OneClickService_1.oneClickService.stop(serverId, installationId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error stopping service:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_RESTART, async (_event, input) => {
        try {
            const { serverId, installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            const result = await OneClickService_1.oneClickService.restart(serverId, installationId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error restarting service:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_STATUS, async (_event, input) => {
        try {
            const { serverId, installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            const status = await OneClickService_1.oneClickService.getStatus(serverId, installationId);
            return { success: true, data: status };
        }
        catch (error) {
            console.error('Error getting status:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_LOGS, async (_event, input) => {
        try {
            const { serverId, installationId, lines } = types_1.OneClickLogsSchema.parse(input);
            const logs = await OneClickService_1.oneClickService.getLogs(serverId, installationId, lines);
            return { success: true, data: logs };
        }
        catch (error) {
            console.error('Error getting logs:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_UPDATE, async (_event, input) => {
        try {
            const { serverId, installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            const result = await OneClickService_1.oneClickService.update(serverId, installationId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error updating service:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_UNINSTALL, async (_event, input) => {
        try {
            const { serverId, installationId } = types_1.OneClickInstallationIdSchema.parse(input);
            await OneClickService_1.oneClickService.uninstall(serverId, installationId);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error uninstalling service:', error);
            return { success: false, error: String(error) };
        }
    });
    // ============ Actions ============
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_GET_ACTIONS, async (_event, input) => {
        try {
            const { templateId } = types_1.OneClickTemplateIdSchema.parse(input);
            const actions = OneClickService_1.oneClickService.getActions(templateId);
            return { success: true, data: actions };
        }
        catch (error) {
            console.error('Error getting actions:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_EXECUTE_ACTION, async (_event, input) => {
        try {
            const { serverId, installationId, actionId, inputs } = types_1.OneClickExecuteActionSchema.parse(input);
            const result = await OneClickService_1.oneClickService.executeAction(serverId, installationId, actionId, inputs);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error executing action:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.ONE_CLICK_GET_ACTION_OPTIONS, async (_event, input) => {
        try {
            const { serverId, templateId, actionId, inputName } = types_1.OneClickGetActionOptionsSchema.parse(input);
            const options = await OneClickService_1.oneClickService.getActionOptions(serverId, templateId, actionId, inputName);
            return { success: true, data: options };
        }
        catch (error) {
            console.error('Error getting action options:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=one-click.js.map