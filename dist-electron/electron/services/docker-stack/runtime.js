"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStacks = listStacks;
exports.getStack = getStack;
exports.updateComposeFile = updateComposeFile;
exports.updateEnvVars = updateEnvVars;
exports.getDeploymentHistory = getDeploymentHistory;
exports.streamLogs = streamLogs;
exports.startStack = startStack;
exports.stopStack = stopStack;
exports.restartStack = restartStack;
exports.deleteStack = deleteStack;
exports.getStatus = getStatus;
exports.getContainerStatusForStack = getContainerStatusForStack;
exports.getDeploymentHistoryForStack = getDeploymentHistoryForStack;
const ComposeService_1 = require("../ComposeService");
const db_1 = require("../../db");
const yaml = __importStar(require("yaml"));
const containers_1 = require("./containers");
const env_1 = require("./env");
const supabase_1 = require("./supabase");
const pathUtils_1 = require("./pathUtils");
function shellQuote(value) {
    // Safe for POSIX shells: wrap in single quotes and escape existing single quotes.
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
async function listStacks(_ctx, serverId) {
    return db_1.queries.getDockerStacks(serverId);
}
function getStack(_ctx, stackId) {
    return db_1.queries.getDockerStack(stackId) || null;
}
function syncNocodbTelemetryEnvVarInCompose(composeContent, telemetryValue) {
    try {
        const parsed = yaml.parse(composeContent);
        const nocodbService = parsed.services?.nocodb;
        if (!nocodbService)
            return null;
        const key = 'NC_DISABLE_TELE';
        const pair = `${key}=${telemetryValue}`;
        const currentEnv = nocodbService.environment;
        if (Array.isArray(currentEnv)) {
            let replaced = false;
            const nextEnv = currentEnv.map((entry) => {
                const envLine = String(entry);
                if (envLine.startsWith(`${key}=`)) {
                    replaced = true;
                    return pair;
                }
                return envLine;
            });
            if (!replaced) {
                nextEnv.push(pair);
            }
            nocodbService.environment = nextEnv;
        }
        else if (currentEnv && typeof currentEnv === 'object') {
            currentEnv[key] = telemetryValue;
        }
        else {
            nocodbService.environment = [pair];
        }
        return yaml.stringify(parsed);
    }
    catch {
        return null;
    }
}
async function updateComposeFile(ctx, serverId, stackId, content) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    const validation = ComposeService_1.composeService.validateCompose(content);
    if (!validation.isValid) {
        throw new Error(`Invalid compose file: ${validation.errors.join(', ')}`);
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, content);
    db_1.queries.updateDockerStack(stackId, { compose_content: content });
    ctx.emitLog(`Compose file updated for stack: ${stack.project_name}`, 'info', stackId);
}
async function updateEnvVars(ctx, serverId, stackId, envVars) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    await (0, env_1.syncEnvVarsForStack)({
        serverId,
        workingDir,
        stackId,
        templateId: stack.template_id,
        envVars,
        uploadFile: ctx.uploadFile,
        emitLog: ctx.emitLog,
        sshService: ctx.sshService,
        applySupabaseFullSmtpEnvVars: (vars, id) => (0, supabase_1.applySupabaseFullSmtpEnvVars)(vars, id, ctx.emitLog),
    });
    let updatedComposeContent = null;
    if (stack.template_id === 'builtin-nocodb' && Object.prototype.hasOwnProperty.call(envVars, 'NC_DISABLE_TELE')) {
        const composeResult = await ctx.sshService.executeCommand(serverId, `cat "${workingDir}/docker-compose.yml" 2>/dev/null || cat "${workingDir}/docker-compose.yaml" 2>/dev/null || echo ""`);
        if (composeResult.exitCode === 0 && composeResult.stdout.trim()) {
            const syncedCompose = syncNocodbTelemetryEnvVarInCompose(composeResult.stdout, String(envVars.NC_DISABLE_TELE));
            if (syncedCompose && syncedCompose !== composeResult.stdout) {
                await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, syncedCompose);
                updatedComposeContent = syncedCompose;
                ctx.emitLog('Synced NC_DISABLE_TELE into docker-compose.yml for NocoDB', 'info', stackId);
            }
        }
    }
    db_1.queries.updateDockerStack(stackId, {
        env_vars: JSON.stringify(envVars),
        ...(updatedComposeContent ? { compose_content: updatedComposeContent } : {}),
    });
    if (stack.template_id === 'builtin-supabase-full') {
        await (0, supabase_1.ensureSupabaseFullSmtpMapping)({
            sshService: ctx.sshService,
            uploadFile: ctx.uploadFile,
            emitLog: ctx.emitLog,
            createEnvFile: ctx.createEnvFile,
        }, serverId, workingDir, envVars, stackId);
    }
    ctx.emitLog(`Environment variables updated for stack: ${stack.project_name}`, 'info', stackId);
}
function getDeploymentHistory(_ctx, stackId, limit = 10) {
    return db_1.queries.getDockerStackDeployments(stackId, limit);
}
async function* streamLogs(ctx, serverId, stackId, serviceName, tail = 100) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    const serviceArg = serviceName || '';
    const command = `cd ${workingDir} && docker compose logs -f --tail=${tail} ${serviceArg}`;
    const chunks = [];
    let resolveNext = null;
    let isComplete = false;
    ctx.sshService.executeCommandStreaming(serverId, command, (data) => {
        chunks.push(data);
        if (resolveNext) {
            const resolve = resolveNext;
            resolveNext = null;
            resolve({ value: chunks.shift(), done: false });
        }
    }).then(() => {
        isComplete = true;
        if (resolveNext) {
            resolveNext({ value: '', done: true });
        }
    }).catch(() => {
        isComplete = true;
        if (resolveNext) {
            resolveNext({ value: '', done: true });
        }
    });
    while (!isComplete || chunks.length > 0) {
        if (chunks.length > 0) {
            yield chunks.shift();
        }
        else if (!isComplete) {
            const result = await new Promise((resolve) => {
                resolveNext = resolve;
            });
            if (!result.done && result.value) {
                yield result.value;
            }
        }
    }
}
async function startStack(ctx, serverId, stackId) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    if (stack.status === 'deploying') {
        throw new Error('Stack is currently being deployed. Please wait for the deployment to complete.');
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    ctx.emitLog(`Starting stack: ${stack.project_name}`, 'info', stackId);
    // 'pending' stacks have never been deployed — containers don't exist yet.
    // Use `docker compose up -d` to create+start them. For stopped stacks
    // (previously running), `docker compose start` resumes existing containers.
    const cmd = stack.status === 'pending'
        ? `cd ${workingDir} && docker compose up -d`
        : `cd ${workingDir} && docker compose start`;
    const result = await ctx.sshService.executeCommand(serverId, cmd);
    if (result.exitCode !== 0) {
        const output = result.stdout + result.stderr;
        const errorLines = output.split('\n').slice(-15).join('\n');
        throw new Error(`Failed to start stack:\n\n${errorLines}`);
    }
    db_1.queries.updateDockerStack(stackId, { status: 'running' });
    ctx.emitLog(`Stack started successfully`, 'success', stackId);
}
async function stopStack(ctx, serverId, stackId, removeVolumes = false) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    if (stack.status === 'deploying') {
        throw new Error('Stack is currently being deployed. Please wait for the deployment to complete.');
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    ctx.emitLog(`Stopping stack: ${stack.project_name}`, 'info', stackId);
    const cmd = removeVolumes
        ? `cd ${workingDir} && docker compose down -v`
        : `cd ${workingDir} && docker compose stop`;
    const result = await ctx.sshService.executeCommand(serverId, cmd);
    if (result.exitCode !== 0) {
        const output = result.stdout + result.stderr;
        const errorLines = output.split('\n').slice(-15).join('\n');
        throw new Error(`Failed to stop stack:\n\n${errorLines}`);
    }
    db_1.queries.updateDockerStack(stackId, { status: 'stopped' });
    ctx.emitLog(`Stack stopped successfully`, 'success', stackId);
}
async function restartStack(ctx, serverId, stackId, serviceName) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    if (stack.status === 'deploying') {
        throw new Error('Stack is currently being deployed. Please wait for the deployment to complete.');
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    const serviceArg = serviceName || '';
    ctx.emitLog(serviceName
        ? `Restarting service: ${serviceName}`
        : `Restarting stack: ${stack.project_name}`, 'info', stackId);
    const result = await ctx.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose restart ${serviceArg}`);
    if (result.exitCode !== 0) {
        const output = result.stdout + result.stderr;
        const errorLines = output.split('\n').slice(-15).join('\n');
        throw new Error(`Failed to restart:\n\n${errorLines}`);
    }
    ctx.emitLog(`Restart completed successfully`, 'success', stackId);
}
async function deleteStack(ctx, serverId, stackId, removeVolumes = false, force = false) {
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        throw new Error('Stack not found');
    }
    if (!force && stack.status === 'deploying') {
        throw new Error('Stack is currently being deployed. Please wait for the deployment to complete before deleting.');
    }
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    const projectName = (stack.project_name || '').trim();
    if (!projectName) {
        throw new Error('Stack has an invalid project name (cannot safely clean up Docker resources).');
    }
    const labelFilter = `label=com.docker.compose.project=${projectName}`;
    const quotedWorkingDir = shellQuote(workingDir);
    ctx.emitLog(`Deleting stack: ${stack.project_name}`, 'info', stackId);
    const downCmd = removeVolumes
        ? `cd ${quotedWorkingDir} && docker compose -p ${shellQuote(projectName)} down -v --remove-orphans --rmi local`
        : `cd ${quotedWorkingDir} && docker compose -p ${shellQuote(projectName)} down --remove-orphans --rmi local`;
    const downResult = await ctx.sshService.executeCommand(serverId, downCmd);
    if (downResult.exitCode !== 0) {
        const output = (downResult.stdout + downResult.stderr).trim();
        const errorLines = output.split('\n').slice(-15).join('\n');
        ctx.emitLog(`docker compose down failed (continuing with fallback cleanup):\n\n${errorLines}`, 'warning', stackId);
    }
    // Fallback cleanup: even if docker-compose.yml or env interpolation is broken/missing, we still
    // want "Force Delete" to actually remove containers/volumes created by the Compose project.
    const fallbackCleanupCmd = [
        `docker ps -aq --filter ${shellQuote(labelFilter)} | xargs -r docker rm -f 2>&1 || true`,
        `docker network ls -q --filter ${shellQuote(labelFilter)} | xargs -r docker network rm 2>&1 || true`,
        removeVolumes
            ? `docker volume ls -q --filter ${shellQuote(labelFilter)} | xargs -r docker volume rm 2>&1 || true`
            : '',
        removeVolumes
            ? `docker volume ls --format "{{.Name}}" | grep "^${projectName}_" | xargs -r docker volume rm 2>&1 || true`
            : '',
    ]
        .filter(Boolean)
        .join('\n');
    const fallbackResult = await ctx.sshService.executeCommand(serverId, fallbackCleanupCmd);
    if (fallbackResult.exitCode !== 0) {
        const output = (fallbackResult.stdout + fallbackResult.stderr).trim();
        const errorLines = output.split('\n').slice(-15).join('\n');
        ctx.emitLog(`Fallback cleanup encountered errors (some resources may remain):\n\n${errorLines}`, 'warning', stackId);
    }
    if (removeVolumes && projectName) {
        const remainingVolumeCheck = await ctx.sshService.executeCommand(serverId, `docker volume ls --format "{{.Name}}" | grep "^${projectName}_" | head -1`);
        const hasRemainingVolumes = remainingVolumeCheck.exitCode === 0 && remainingVolumeCheck.stdout.trim() !== '';
        if (hasRemainingVolumes && !force) {
            throw new Error(`Failed to remove all Docker volumes for project "${projectName}". ` +
                `Try Force Delete, or remove them manually:\n` +
                `docker volume ls --format "{{.Name}}" | grep "^${projectName}_" && docker volume rm $(docker volume ls -q | grep "^${projectName}_")`);
        }
        if (hasRemainingVolumes && force) {
            ctx.emitLog(`Warning: some Docker volumes may remain (prefix: "${projectName}_").`, 'warning', stackId);
        }
    }
    const rmResult = await ctx.sshService.executeCommand(serverId, `rm -rf ${quotedWorkingDir}`);
    if (rmResult.exitCode !== 0 && !force) {
        const details = (rmResult.stderr || rmResult.stdout || '').trim();
        throw new Error(`Failed to remove stack directory ${workingDir}. ${details ? `Details: ${details}` : ''}`);
    }
    db_1.queries.deleteDockerStack(stackId);
    ctx.emitLog(`Stack deleted successfully`, 'success', stackId);
}
async function getStatus(ctx, serverId, stackId) {
    let stack = db_1.queries.getDockerStack(stackId);
    if (!stack || stack.server_id !== serverId) {
        return null;
    }
    const { workingDir, normalizedStackPath, needsNormalization } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    if (needsNormalization && normalizedStackPath !== stack.stack_path) {
        db_1.queries.updateDockerStack(stackId, { stack_path: normalizedStackPath });
        stack = { ...stack, stack_path: normalizedStackPath };
    }
    const containers = await (0, containers_1.getContainerStatus)(ctx, serverId, workingDir);
    const containersForHealth = containers.filter((c) => {
        const service = (c.service || '').toLowerCase();
        const isInitService = service.endsWith('-init') || service.endsWith('_init');
        const exitedSuccessfully = c.state === 'exited' && /exited\\s*\\(0\\)/i.test(c.status || '');
        return !(isInitService && exitedSuccessfully);
    });
    const runningCount = containersForHealth.filter(c => c.state === 'running').length;
    const totalCount = containersForHealth.length;
    const isHealthy = totalCount > 0 && runningCount === totalCount;
    let newStatus = stack.status;
    if (stack.status === 'error') {
        newStatus = 'error';
    }
    else if (stack.status === 'deploying') {
        // Allow automatic reconciliation for external builders (e.g. GitHub Actions):
        // once all non-init containers are running, mark stack as running instead of
        // leaving it stuck in deploying.
        newStatus = isHealthy ? 'running' : 'deploying';
    }
    else if (totalCount === 0) {
        newStatus = 'stopped';
    }
    else if (runningCount === 0) {
        newStatus = 'stopped';
    }
    else if (runningCount < totalCount) {
        newStatus = 'partial';
    }
    else {
        newStatus = 'running';
    }
    if (newStatus !== stack.status) {
        db_1.queries.updateDockerStack(stackId, { status: newStatus, services_count: totalCount });
    }
    return {
        stack: { ...stack, status: newStatus },
        containers,
        isHealthy,
    };
}
async function getContainerStatusForStack(ctx, serverId, workingDir) {
    return (0, containers_1.getContainerStatus)(ctx, serverId, workingDir);
}
function getDeploymentHistoryForStack(_ctx, stackId, limit = 10) {
    return db_1.queries.getDockerStackDeployments(stackId, limit);
}
//# sourceMappingURL=runtime.js.map