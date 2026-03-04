"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTraefikHandlers = registerTraefikHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const TraefikService_1 = require("../services/TraefikService");
const TraefikDomainService_1 = require("../services/TraefikDomainService");
const ReverseProxyDetector_1 = require("../services/ReverseProxyDetector");
const SSHService_1 = require("../services/SSHService");
const traefikService = new TraefikService_1.TraefikService();
const domainService = new TraefikDomainService_1.TraefikDomainService();
function registerTraefikHandlers() {
    /**
     * Setup Traefik on a server
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_SETUP, async (_, input) => {
        try {
            const validated = types_1.SetupTraefikSchema.parse(input);
            await traefikService.setupTraefik(validated.serverId, validated.email);
            return {
                success: true,
                data: { message: 'Traefik installed successfully' },
            };
        }
        catch (error) {
            console.error('Traefik setup error:', error);
            return {
                success: false,
                error: error.message || 'Failed to setup Traefik',
            };
        }
    });
    /**
     * Check if Traefik is installed
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_IS_INSTALLED, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            const isInstalled = await traefikService.isTraefikInstalled(validated.serverId);
            return {
                success: true,
                data: { isInstalled },
            };
        }
        catch (error) {
            console.error('Traefik check error:', error);
            return {
                success: false,
                error: error.message || 'Failed to check Traefik status',
            };
        }
    });
    /**
     * Get Traefik version
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_GET_VERSION, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            const version = await traefikService.getTraefikVersion(validated.serverId);
            return {
                success: true,
                data: { version },
            };
        }
        catch (error) {
            console.error('Get Traefik version error:', error);
            return {
                success: false,
                error: error.message || 'Failed to get Traefik version',
            };
        }
    });
    /**
     * Restart Traefik
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_RESTART, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            await traefikService.restartTraefik(validated.serverId);
            return {
                success: true,
                data: { message: 'Traefik restarted successfully' },
            };
        }
        catch (error) {
            console.error('Restart Traefik error:', error);
            return {
                success: false,
                error: error.message || 'Failed to restart Traefik',
            };
        }
    });
    /**
     * Get Traefik logs
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_GET_LOGS, async (_, input) => {
        try {
            const validated = types_1.GetTraefikLogsSchema.parse(input);
            const logs = await traefikService.getTraefikLogs(validated.serverId, validated.lines || 100);
            return {
                success: true,
                data: { logs },
            };
        }
        catch (error) {
            console.error('Get Traefik logs error:', error);
            return {
                success: false,
                error: error.message || 'Failed to get Traefik logs',
            };
        }
    });
    /**
     * Configure domain with Traefik
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_CONFIGURE, async (_, input) => {
        try {
            const validated = types_1.ConfigureTraefikDomainSchema.parse(input);
            const configured = await domainService.configureDomain(validated);
            return {
                success: true,
                data: {
                    domainId: configured.domainId,
                    stackAssociated: configured.stackAssociated,
                    stackId: configured.stackId,
                    message: 'Domain configured successfully',
                },
            };
        }
        catch (error) {
            console.error('Configure domain error:', error);
            return {
                success: false,
                error: error.message || 'Failed to configure domain',
            };
        }
    });
    /**
     * Update domain configuration
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_UPDATE, async (_, input) => {
        console.log(`[IPC.TRAEFIK_DOMAIN_UPDATE] Received input:`, JSON.stringify(input, null, 2));
        try {
            const validated = types_1.UpdateDomainSchema.parse(input);
            console.log(`[IPC.TRAEFIK_DOMAIN_UPDATE] Validated input:`, JSON.stringify(validated, null, 2));
            const result = await domainService.updateDomain(validated.domainId, validated);
            // Check if the result indicates a redeploy is needed
            if (result.requiresRedeploy) {
                console.log(`[IPC.TRAEFIK_DOMAIN_UPDATE] Port change requires redeploy - returning requiresRedeploy=true`);
                return {
                    success: true,
                    data: {
                        requiresRedeploy: true,
                        currentPort: result.currentPort,
                        newPort: result.newPort,
                        message: result.message,
                    },
                };
            }
            console.log(`[IPC.TRAEFIK_DOMAIN_UPDATE] Update completed successfully`);
            return {
                success: true,
                data: { message: 'Domain updated successfully' },
            };
        }
        catch (error) {
            console.error('[IPC.TRAEFIK_DOMAIN_UPDATE] Update domain error:', error);
            return {
                success: false,
                error: error.message || 'Failed to update domain',
            };
        }
    });
    /**
     * Delete domain
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_DELETE, async (_, input) => {
        try {
            const validated = types_1.DeleteDomainSchema.parse(input);
            await domainService.deleteDomain(validated.domainId);
            return {
                success: true,
                data: { message: 'Domain deleted successfully' },
            };
        }
        catch (error) {
            console.error('Delete domain error:', error);
            return {
                success: false,
                error: error.message || 'Failed to delete domain',
            };
        }
    });
    /**
     * List domains for a server
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_LIST, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            const domains = await domainService.getDomainsByServer(validated.serverId);
            return {
                success: true,
                data: domains,
            };
        }
        catch (error) {
            console.error('List domains error:', error);
            return {
                success: false,
                error: error.message || 'Failed to list domains',
            };
        }
    });
    /**
     * Get domain by ID
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_GET, async (_, domainId) => {
        try {
            const domain = await domainService.getDomainById(domainId);
            if (!domain) {
                return {
                    success: false,
                    error: 'Domain not found',
                };
            }
            return {
                success: true,
                data: domain,
            };
        }
        catch (error) {
            console.error('Get domain error:', error);
            return {
                success: false,
                error: error.message || 'Failed to get domain',
            };
        }
    });
    /**
     * Get certificate info for a domain
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_CERTIFICATE_INFO, async (_, input) => {
        try {
            const validated = types_1.GetCertificateInfoSchema.parse(input);
            const certInfo = await traefikService.getCertificateInfo(validated.serverId, validated.domain);
            return {
                success: true,
                data: certInfo,
            };
        }
        catch (error) {
            console.error('Get certificate info error:', error);
            return {
                success: false,
                error: error.message || 'Failed to get certificate info',
            };
        }
    });
    /**
     * Get Traefik configuration (including email)
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_GET_CONFIG, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            const config = await traefikService.getTraefikConfig(validated.serverId);
            return {
                success: true,
                data: config,
            };
        }
        catch (error) {
            console.error('Get Traefik config error:', error);
            return {
                success: false,
                error: error.message || 'Failed to get Traefik config',
            };
        }
    });
    /**
     * Update Traefik email configuration
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_UPDATE_EMAIL, async (_, input) => {
        try {
            const validated = types_1.UpdateTraefikEmailSchema.parse(input);
            await traefikService.updateTraefikEmail(validated.serverId, validated.email);
            return {
                success: true,
                data: { message: 'Email updated successfully' },
            };
        }
        catch (error) {
            console.error('Update Traefik email error:', error);
            return {
                success: false,
                error: error.message || 'Failed to update Traefik email',
            };
        }
    });
    /**
     * Remove global HTTP-to-HTTPS redirect from Traefik config
     * This allows per-domain Force HTTPS settings to work
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_REMOVE_GLOBAL_REDIRECT, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            const removed = await traefikService.removeGlobalHttpRedirect(validated.serverId);
            return {
                success: true,
                data: { removed, message: removed ? 'Global HTTP redirect removed' : 'No global redirect found' },
            };
        }
        catch (error) {
            console.error('Remove global HTTP redirect error:', error);
            return {
                success: false,
                error: error.message || 'Failed to remove global HTTP redirect',
            };
        }
    });
    /**
     * Detect existing reverse proxies on the server
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TRAEFIK_DETECT_REVERSE_PROXY, async (_, input) => {
        try {
            const validated = types_1.ServerIdOnlySchema.parse(input);
            const client = await SSHService_1.sshService.connect(validated.serverId);
            if (!client) {
                return {
                    success: false,
                    error: 'Failed to establish SSH connection',
                };
            }
            const detection = await ReverseProxyDetector_1.ReverseProxyDetector.detect(client);
            return {
                success: true,
                data: detection,
            };
        }
        catch (error) {
            console.error('Detect reverse proxy error:', error);
            return {
                success: false,
                error: error.message || 'Failed to detect reverse proxy',
            };
        }
    });
}
//# sourceMappingURL=traefik.js.map