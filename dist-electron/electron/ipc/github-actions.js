"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGitHubActionsHandlers = registerGitHubActionsHandlers;
const electron_1 = require("electron");
const GitHubActionsService_1 = require("../services/GitHubActionsService");
const zod_1 = require("zod");
const LicenseService_1 = require("../services/LicenseService");
// Zod schemas for validation
const enableGitHubActionsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    repoOwner: zod_1.z.string(),
    repoName: zod_1.z.string(),
    branch: zod_1.z.string(),
    workingDirectory: zod_1.z.string(),
    installCommand: zod_1.z.string(),
    buildCommand: zod_1.z.string(),
});
const disableGitHubActionsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
});
const getConfigSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
});
const getWorkflowRunsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    perPage: zod_1.z.number().optional(),
    page: zod_1.z.number().optional(),
});
const triggerManualDeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
});
const syncWorkflowSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
});
const updateConfigSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    updates: zod_1.z.object({
        branch: zod_1.z.string().optional(),
        workingDirectory: zod_1.z.string().optional(),
        installCommand: zod_1.z.string().optional(),
        buildCommand: zod_1.z.string().optional(),
    }),
});
function registerGitHubActionsHandlers() {
    // Enable GitHub Actions deployment
    electron_1.ipcMain.handle('github-actions:enable', async (_event, params) => {
        try {
            const validated = enableGitHubActionsSchema.parse(params);
            // Check license access
            const access = LicenseService_1.licenseService.canUseAutoDeploy();
            if (!access.allowed) {
                return {
                    success: false,
                    error: access.reason || 'GitHub Actions deployment requires a license.'
                };
            }
            await GitHubActionsService_1.githubActionsService.enableGitHubActions(validated);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error enabling GitHub Actions:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Disable GitHub Actions deployment
    electron_1.ipcMain.handle('github-actions:disable', async (_event, params) => {
        try {
            const validated = disableGitHubActionsSchema.parse(params);
            await GitHubActionsService_1.githubActionsService.disable(validated.serverId, validated.appName);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error disabling GitHub Actions:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Get GitHub Actions configuration
    electron_1.ipcMain.handle('github-actions:get-config', async (_event, params) => {
        try {
            const validated = getConfigSchema.parse(params);
            const config = GitHubActionsService_1.githubActionsService.getConfig(validated.serverId, validated.appName);
            return { success: true, data: config };
        }
        catch (error) {
            console.error('Error getting GitHub Actions config:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Check if GitHub Actions is enabled
    electron_1.ipcMain.handle('github-actions:is-enabled', async (_event, params) => {
        try {
            const validated = getConfigSchema.parse(params);
            const isEnabled = GitHubActionsService_1.githubActionsService.isEnabled(validated.serverId, validated.appName);
            return { success: true, data: isEnabled };
        }
        catch (error) {
            console.error('Error checking GitHub Actions status:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Get workflow runs
    electron_1.ipcMain.handle('github-actions:get-workflow-runs', async (_event, params) => {
        try {
            const validated = getWorkflowRunsSchema.parse(params);
            const runs = await GitHubActionsService_1.githubActionsService.getWorkflowRuns(validated.serverId, validated.appName, {
                per_page: validated.perPage,
                page: validated.page,
            });
            return { success: true, data: runs };
        }
        catch (error) {
            console.error('Error getting workflow runs:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Trigger manual deployment
    electron_1.ipcMain.handle('github-actions:trigger-deploy', async (_event, params) => {
        try {
            const validated = triggerManualDeploySchema.parse(params);
            // Check license access
            const access = LicenseService_1.licenseService.canUseAutoDeploy();
            if (!access.allowed) {
                return {
                    success: false,
                    error: access.reason || 'Manual deployment requires a license.'
                };
            }
            await GitHubActionsService_1.githubActionsService.triggerManualDeploy(validated.serverId, validated.appName);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error triggering manual deployment:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Sync workflow file
    electron_1.ipcMain.handle('github-actions:sync-workflow', async (_event, params) => {
        try {
            const validated = syncWorkflowSchema.parse(params);
            const result = await GitHubActionsService_1.githubActionsService.syncWorkflow(validated.serverId, validated.appName);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error syncing workflow:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
    // Update configuration
    electron_1.ipcMain.handle('github-actions:update-config', async (_event, params) => {
        try {
            const validated = updateConfigSchema.parse(params);
            await GitHubActionsService_1.githubActionsService.updateConfig(validated.serverId, validated.appName, validated.updates);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error updating GitHub Actions config:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    });
}
//# sourceMappingURL=github-actions.js.map