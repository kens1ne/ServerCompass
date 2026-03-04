"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMetricsHandlers = registerMetricsHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const MetricsService_1 = require("../services/MetricsService");
function registerMetricsHandlers() {
    /**
     * Get quick metrics - Stage 1 of progressive loading.
     * Returns essential CPU/Memory/Disk/Network data in a single fast SSH call.
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.METRICS_GET_QUICK, async (_event, input) => {
        try {
            const { serverId } = types_1.GetMetricsSchema.parse(input);
            const metrics = await MetricsService_1.metricsService.getQuickMetrics(serverId);
            return { success: true, data: metrics };
        }
        catch (error) {
            console.error('Error fetching quick metrics:', error);
            return { success: false, error: String(error) };
        }
    });
    /**
     * Get full metrics - Stage 2 of progressive loading.
     * Returns complete metrics including system info, health, alerts, and filesystems.
     */
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.METRICS_GET, async (_event, input) => {
        try {
            const { serverId } = types_1.GetMetricsSchema.parse(input);
            const metrics = await MetricsService_1.metricsService.getMetrics(serverId);
            return { success: true, data: metrics };
        }
        catch (error) {
            console.error('Error fetching server metrics:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=metrics.js.map