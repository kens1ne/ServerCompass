"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerStackService = void 0;
exports.createDockerStackService = createDockerStackService;
const events_1 = require("events");
const RegistryService_1 = require("./RegistryService");
const NixpacksService_1 = require("./NixpacksService");
const TraefikDynamicRouter_1 = require("./TraefikDynamicRouter");
const TraefikService_1 = require("./TraefikService");
const ZeroDowntimeDeployer_1 = require("./docker-stack/ZeroDowntimeDeployer");
const logger_1 = require("./docker-stack/logger");
const db_1 = require("../db");
const deploy_1 = require("./docker-stack/deploy");
const redeploy_1 = require("./docker-stack/redeploy");
const rollback_1 = require("./docker-stack/rollback");
const zeroDowntime_1 = require("./docker-stack/zeroDowntime");
const buildLocation_1 = require("./docker-stack/buildLocation");
const runtime_1 = require("./docker-stack/runtime");
const containers_1 = require("./docker-stack/containers");
const deploymentDb_1 = require("./docker-stack/deploymentDb");
const env_1 = require("./docker-stack/env");
const system_1 = require("./docker-stack/system");
class DockerStackService extends events_1.EventEmitter {
    sshService;
    registryService;
    nixpacksService;
    traefikRouter;
    traefikService;
    zeroDowntimeDeployer;
    mainWindow = null;
    logger;
    constructor(sshService, credentialVault) {
        super();
        this.sshService = sshService;
        this.registryService = (0, RegistryService_1.createRegistryService)(credentialVault, sshService);
        this.nixpacksService = new NixpacksService_1.NixpacksService(sshService);
        this.traefikRouter = (0, TraefikDynamicRouter_1.createTraefikDynamicRouter)(sshService);
        this.traefikService = new TraefikService_1.TraefikService(sshService);
        this.zeroDowntimeDeployer = (0, ZeroDowntimeDeployer_1.createZeroDowntimeDeployer)(sshService, this.traefikRouter);
        this.logger = new logger_1.DockerStackLogger({
            windowProvider: () => this.mainWindow,
            eventEmitter: this,
            persistDeploymentLogs: this.persistDeploymentLogs.bind(this),
        });
    }
    setMainWindow(window) {
        this.mainWindow = window;
        this.zeroDowntimeDeployer.setMainWindow(window);
    }
    emitLog(message, type = 'info', stackId, deploymentId) {
        this.logger.emit(message, type, stackId, deploymentId);
    }
    saveDeploymentLogs(deploymentId) {
        this.logger.saveDeploymentLogs(deploymentId);
    }
    initDeploymentLogs(deploymentId) {
        this.logger.initDeploymentLogs(deploymentId);
    }
    persistDeploymentLogs(deploymentId, logsText) {
        const stmt = db_1.db.prepare(`
      UPDATE docker_stack_deployments SET logs = ? WHERE id = ?
    `);
        stmt.run(logsText, deploymentId);
    }
    buildContext() {
        const emitLog = this.emitLog.bind(this);
        const upload = (serverId, path, content) => (0, system_1.uploadFile)(this.sshService, serverId, path, content);
        return {
            sshService: this.sshService,
            registryService: this.registryService,
            nixpacksService: this.nixpacksService,
            traefikService: this.traefikService,
            zeroDowntimeDeployer: this.zeroDowntimeDeployer,
            emitLog,
            initDeploymentLogs: this.initDeploymentLogs.bind(this),
            saveDeploymentLogs: this.saveDeploymentLogs.bind(this),
            uploadFile: upload,
            ensureDockerInstalled: (serverId) => (0, system_1.ensureDockerInstalled)(this.sshService, emitLog, serverId),
            createEnvFile: (serverId, workingDir, envVars) => (0, env_1.createEnvFile)(upload, serverId, workingDir, envVars),
            ensureEnvFileDirective: (serverId, workingDir, stackId) => (0, env_1.ensureEnvFileDirective)({
                sshService: this.sshService,
                uploadFile: upload,
                emitLog,
                serverId,
                workingDir,
                stackId,
            }),
        };
    }
    async deploy(input) {
        return (0, deploy_1.deployStack)(this.buildContext(), input);
    }
    async redeploy(serverId, stackId, options = {}) {
        return (0, redeploy_1.redeployStack)(this.buildContext(), serverId, stackId, options);
    }
    async redeployZeroDowntime(serverId, stackId, options = {}) {
        return (0, zeroDowntime_1.redeployZeroDowntime)(this.buildContext(), serverId, stackId, options);
    }
    async rollbackZeroDowntime(serverId, stackId, targetDeploymentId) {
        return (0, zeroDowntime_1.rollbackZeroDowntime)(this.buildContext(), serverId, stackId, targetDeploymentId);
    }
    async rollback(serverId, stackId, targetDeploymentId) {
        return (0, rollback_1.rollbackStack)(this.buildContext(), serverId, stackId, targetDeploymentId);
    }
    async updateDeploymentStrategy(serverId, stackId, strategy) {
        return (0, zeroDowntime_1.updateDeploymentStrategy)(this.buildContext(), serverId, stackId, strategy);
    }
    async updateBuildLocation(serverId, stackId, buildLocation) {
        return (0, buildLocation_1.updateBuildLocation)(this.buildContext(), serverId, stackId, buildLocation);
    }
    async start(serverId, stackId) {
        return (0, runtime_1.startStack)(this.buildContext(), serverId, stackId);
    }
    async stop(serverId, stackId, removeVolumes = false) {
        return (0, runtime_1.stopStack)(this.buildContext(), serverId, stackId, removeVolumes);
    }
    async restart(serverId, stackId, serviceName) {
        return (0, runtime_1.restartStack)(this.buildContext(), serverId, stackId, serviceName);
    }
    async delete(serverId, stackId, removeVolumes = false, force = false) {
        return (0, runtime_1.deleteStack)(this.buildContext(), serverId, stackId, removeVolumes, force);
    }
    async getStatus(serverId, stackId) {
        return (0, runtime_1.getStatus)(this.buildContext(), serverId, stackId);
    }
    async listStacks(serverId) {
        return (0, runtime_1.listStacks)(this.buildContext(), serverId);
    }
    getStack(stackId) {
        return (0, runtime_1.getStack)(this.buildContext(), stackId);
    }
    async updateComposeFile(serverId, stackId, content) {
        return (0, runtime_1.updateComposeFile)(this.buildContext(), serverId, stackId, content);
    }
    async updateEnvVars(serverId, stackId, envVars) {
        return (0, runtime_1.updateEnvVars)(this.buildContext(), serverId, stackId, envVars);
    }
    getDeploymentHistory(stackId, limit = 10) {
        return (0, runtime_1.getDeploymentHistory)(this.buildContext(), stackId, limit);
    }
    async *streamLogs(serverId, stackId, serviceName, tail = 100) {
        for await (const chunk of (0, runtime_1.streamLogs)(this.buildContext(), serverId, stackId, serviceName, tail)) {
            yield chunk;
        }
    }
    clearPendingFailure(stackId) {
        (0, deploymentDb_1.clearPendingFailure)(stackId);
    }
    async getAllContainers(serverId) {
        return (0, containers_1.getAllContainers)(this.buildContext(), serverId);
    }
    async getContainerStats(serverId) {
        return (0, containers_1.getContainerStats)(this.buildContext(), serverId);
    }
    async getContainerStatus(serverId, workingDir) {
        return (0, runtime_1.getContainerStatusForStack)(this.buildContext(), serverId, workingDir);
    }
}
exports.DockerStackService = DockerStackService;
function createDockerStackService(sshService, credentialVault) {
    return new DockerStackService(sshService, credentialVault);
}
//# sourceMappingURL=DockerStackService.js.map