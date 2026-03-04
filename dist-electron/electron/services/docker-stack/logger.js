"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerStackLogger = void 0;
const electron_1 = require("electron");
/**
 * Central logger for Docker stack operations.
 * Handles UI delivery, EventEmitter forwarding, and deployment log buffering
 * so it can be tested independently of the main service class.
 */
class DockerStackLogger {
    windowProvider;
    eventEmitter;
    persistDeploymentLogs;
    deploymentLogs = new Map();
    persistTimers = new Map();
    constructor(options) {
        this.windowProvider = options.windowProvider;
        this.eventEmitter = options.eventEmitter;
        this.persistDeploymentLogs = options.persistDeploymentLogs;
    }
    emit(message, type = 'info', stackId, deploymentId) {
        const logEntry = {
            message,
            type,
            timestamp: Date.now(),
            stackId,
            deploymentId,
        };
        console.log(`[DockerStack] ${type.toUpperCase()}: ${message}`);
        if (deploymentId) {
            const logs = this.deploymentLogs.get(deploymentId) || [];
            const timestamp = new Date().toISOString();
            logs.push(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
            this.deploymentLogs.set(deploymentId, logs);
            if (this.persistDeploymentLogs) {
                this.schedulePersist(deploymentId);
            }
        }
        const targetWindow = this.windowProvider() || electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0];
        if (targetWindow?.webContents && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send('docker:stack:log', logEntry);
        }
        else {
            console.warn('[DockerStack] No valid window to send log to');
        }
        this.eventEmitter?.emit('log', logEntry);
    }
    schedulePersist(deploymentId) {
        if (this.persistTimers.has(deploymentId))
            return;
        const timer = setTimeout(() => {
            this.flushDeploymentLogs(deploymentId);
        }, 2000);
        this.persistTimers.set(deploymentId, timer);
    }
    flushDeploymentLogs(deploymentId) {
        const logs = this.deploymentLogs.get(deploymentId);
        if (logs && logs.length > 0 && this.persistDeploymentLogs) {
            this.persistDeploymentLogs(deploymentId, logs.join('\n'));
        }
        const timer = this.persistTimers.get(deploymentId);
        if (timer) {
            clearTimeout(timer);
            this.persistTimers.delete(deploymentId);
        }
    }
    initDeploymentLogs(deploymentId) {
        if (!this.deploymentLogs.has(deploymentId)) {
            this.deploymentLogs.set(deploymentId, []);
        }
    }
    saveDeploymentLogs(deploymentId) {
        this.flushDeploymentLogs(deploymentId);
        this.deploymentLogs.delete(deploymentId);
    }
}
exports.DockerStackLogger = DockerStackLogger;
//# sourceMappingURL=logger.js.map