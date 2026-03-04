"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerStackImporter = void 0;
const crypto_1 = require("crypto");
const db_1 = require("../../../db");
const ComposeService_1 = require("../../ComposeService");
const composeUtils_1 = require("../../docker-stack/composeUtils");
const docker_templates_1 = require("../../../docker-templates");
const system_1 = require("../../docker-stack/system");
const STACK_PATH = '/root/server-compass/apps';
function coerceString(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function parseEnvText(envText) {
    const envVars = {};
    for (const rawLine of envText.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const idx = line.indexOf('=');
        if (idx <= 0)
            continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (!key)
            continue;
        envVars[key] = value;
    }
    return envVars;
}
function extractComposeContent(payload) {
    const candidates = [
        payload.composeContent,
        payload.compose_content,
        payload.dockerCompose,
        payload.docker_compose,
        payload.generatedCompose,
        payload.composeFile,
        payload.compose,
        payload.rawConfig,
        payload.unitContent,
    ];
    for (const candidate of candidates) {
        const value = coerceString(candidate);
        if (value)
            return value;
    }
    return '';
}
function extractPortHint(payload, composeContent) {
    const portsExposes = coerceString(payload.portsExposes) || coerceString(payload.ports_exposes);
    if (portsExposes) {
        const first = portsExposes.split(',').map((p) => p.trim()).filter(Boolean)[0];
        if (first && /^\d+$/.test(first))
            return first;
    }
    const shortSyntax = composeContent.match(/^\s*-\s*["']?(\d+):\d+(?:\/\w+)?["']?\s*$/m);
    if (shortSyntax?.[1] && /^\d+$/.test(shortSyntax[1]))
        return shortSyntax[1];
    const published = composeContent.match(/^\s*published:\s*["']?(\d+)["']?\s*$/m);
    if (published?.[1] && /^\d+$/.test(published[1]))
        return published[1];
    return null;
}
function extractWordPressDbName(composeContent) {
    const match = composeContent.match(/WORDPRESS_DB_NAME:\s*["']?([A-Za-z0-9_.-]+)["']?/);
    if (match?.[1])
        return match[1];
    const mysqlMatch = composeContent.match(/MYSQL_DATABASE:\s*["']?([A-Za-z0-9_.-]+)["']?/);
    if (mysqlMatch?.[1])
        return mysqlMatch[1];
    return null;
}
function isWordPressStack(payload, composeContent, displayName) {
    const serviceType = coerceString(payload.serviceType) || coerceString(payload.service_type);
    if (serviceType && serviceType.toLowerCase().includes('wordpress'))
        return true;
    const buildPack = coerceString(payload.buildPack) || coerceString(payload.build_pack);
    if (buildPack && buildPack.toLowerCase() === 'dockercompose' && composeContent.toLowerCase().includes('wordpress')) {
        return true;
    }
    const lowerName = (displayName || '').toLowerCase();
    if (lowerName.includes('wordpress'))
        return true;
    const lowerCompose = composeContent.toLowerCase();
    return lowerCompose.includes('wordpress:') || lowerCompose.includes('image: wordpress');
}
/**
 * Parse Docker port string like "0.0.0.0:3000->80/tcp" into host:container mapping.
 */
function parsePortMapping(portStr) {
    // Matches patterns: "0.0.0.0:3000->80/tcp", "3000:80", "3000->80/tcp", ":::3000->80/tcp"
    const match = portStr.match(/(?:\d+\.\d+\.\d+\.\d+:|:::?)?(\d+)(?:->|:)(\d+)/);
    if (!match)
        return null;
    return { host: parseInt(match[1], 10), container: parseInt(match[2], 10) };
}
/**
 * Generate a minimal docker-compose.yml for a standalone container.
 */
function generateComposeForContainer(payload, serviceName) {
    const image = coerceString(payload.image) || coerceString(payload.Image) || 'unknown';
    const restart = coerceString(payload.restart) || coerceString(payload.RestartPolicy) || 'unless-stopped';
    const ports = [];
    const rawPorts = payload.ports || payload.Ports || [];
    if (Array.isArray(rawPorts)) {
        for (const p of rawPorts) {
            if (typeof p === 'string') {
                const mapping = parsePortMapping(p);
                if (mapping)
                    ports.push(`"${mapping.host}:${mapping.container}"`);
            }
            else if (p && typeof p === 'object' && p.PublicPort && p.PrivatePort) {
                ports.push(`"${p.PublicPort}:${p.PrivatePort}"`);
            }
        }
    }
    const volumes = [];
    const rawVolumes = payload.volumes || payload.Mounts || [];
    if (Array.isArray(rawVolumes)) {
        for (const v of rawVolumes) {
            if (typeof v === 'string') {
                volumes.push(v);
            }
            else if (v && typeof v === 'object' && v.Source && v.Destination) {
                volumes.push(`${v.Source}:${v.Destination}`);
            }
        }
    }
    let yaml = `services:\n  ${serviceName}:\n    image: ${image}\n    restart: ${restart}\n`;
    if (ports.length > 0) {
        yaml += '    ports:\n';
        for (const p of ports)
            yaml += `      - ${p}\n`;
    }
    if (volumes.length > 0) {
        yaml += '    volumes:\n';
        for (const v of volumes)
            yaml += `      - ${v}\n`;
    }
    return yaml;
}
/**
 * Convert env vars record to .env file content.
 */
function envVarsToFileContent(envVars) {
    return Object.entries(envVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';
}
class DockerStackImporter {
    sshService;
    constructor(sshService) {
        this.sshService = sshService;
    }
    async import(item, serverId, payload) {
        const rawProjectName = coerceString(payload.projectName) ||
            coerceString(payload.project_name) ||
            coerceString(payload.name) ||
            coerceString(payload.appName) ||
            item.display_name;
        const projectName = ComposeService_1.composeService.sanitizeProjectName(rawProjectName);
        if (!projectName) {
            throw new Error(`Unable to determine a valid project name for "${item.display_name}"`);
        }
        // Check for existing record (idempotency)
        const existing = db_1.db.prepare('SELECT id, compose_content FROM docker_stacks WHERE server_id = ? AND project_name = ?').get(serverId, projectName);
        if (existing) {
            // If existing record has compose content, it's a real stack — skip
            if (existing.compose_content && existing.compose_content.trim().length > 0) {
                return {
                    itemId: item.id,
                    success: true,
                    localRecordType: 'docker_stacks',
                    localRecordId: existing.id,
                    rollbackData: { type: 'noop', reason: 'Stack already existed' },
                };
            }
            // Hollow record from a previous import — upgrade it with compose content + VPS files
            const composeContent = extractComposeContent(payload);
            if (composeContent) {
                return this.upgradeHollowRecord(existing.id, serverId, projectName, composeContent, payload, item);
            }
            return {
                itemId: item.id,
                success: true,
                localRecordType: 'docker_stacks',
                localRecordId: existing.id,
                rollbackData: { type: 'noop', reason: 'Stack already existed (no compose available)' },
            };
        }
        const stackId = (0, crypto_1.randomUUID)();
        let composeContent = extractComposeContent(payload);
        let envVars = null;
        if (payload.envVars && typeof payload.envVars === 'object') {
            envVars = payload.envVars;
        }
        else if (typeof payload.env === 'string' && payload.env.trim().length > 0) {
            envVars = parseEnvText(payload.env);
        }
        // Quality migration: map known broken/incomplete provider templates to our built-in templates.
        // WordPress from Coolify fake setups often lacks DB credentials, causing the stack to never start.
        if (composeContent && isWordPressStack(payload, composeContent, item.display_name)) {
            const portHint = extractPortHint(payload, composeContent) || '80';
            const dbName = extractWordPressDbName(composeContent) || 'wordpress';
            const dbPassword = (0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 24);
            const rootPassword = (0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 24);
            envVars = {
                ...(envVars || {}),
                DB_NAME: dbName,
                DB_USER: 'wordpress',
                DB_PASSWORD: dbPassword,
                DB_ROOT_PASSWORD: rootPassword,
            };
            const rendered = (0, docker_templates_1.renderTemplate)('builtin-wordpress', {
                PORT: portHint,
                DB_NAME: envVars.DB_NAME,
                DB_USER: envVars.DB_USER,
                DB_PASSWORD: envVars.DB_PASSWORD,
                DB_ROOT_PASSWORD: envVars.DB_ROOT_PASSWORD,
            });
            composeContent = rendered.compose;
        }
        if (!composeContent) {
            // No compose content at all — store as snapshot-only DB record
            return this.insertStackRecord(stackId, serverId, projectName, '', envVars, 'pending', item);
        }
        // Write compose file + env to VPS
        const workingDir = `${STACK_PATH}/${projectName}`;
        try {
            await (0, system_1.uploadFile)(this.sshService, serverId, `${workingDir}/docker-compose.yml`, composeContent);
            if (envVars && Object.keys(envVars).length > 0) {
                await (0, system_1.uploadFile)(this.sshService, serverId, `${workingDir}/.env`, envVarsToFileContent(envVars));
            }
        }
        catch (err) {
            console.warn(`[DockerStackImporter] Failed to write files to VPS for ${projectName}:`, err);
            // Still create the DB record even if file write fails — user can retry deploy later
        }
        // Check if containers are already running (adopt path for same-server migration)
        const status = await this.checkContainerStatus(serverId, projectName, workingDir);
        return this.insertStackRecord(stackId, serverId, projectName, composeContent, envVars, status.status, item, status.servicesCount, status.lastDeployedAt);
    }
    /**
     * Import a standalone Docker container by generating a minimal compose file.
     */
    async importContainer(item, serverId, payload) {
        const rawName = coerceString(payload.name) ||
            coerceString(payload.Names) ||
            item.display_name;
        // Docker container names often start with "/" — strip it
        const cleanName = (rawName || 'container').replace(/^\/+/, '');
        const projectName = ComposeService_1.composeService.sanitizeProjectName(cleanName);
        if (!projectName) {
            throw new Error(`Unable to determine a valid project name for container "${item.display_name}"`);
        }
        // Check for existing record (idempotency)
        const existing = db_1.db.prepare('SELECT id, compose_content FROM docker_stacks WHERE server_id = ? AND project_name = ?').get(serverId, projectName);
        if (existing && existing.compose_content && existing.compose_content.trim().length > 0) {
            return {
                itemId: item.id,
                success: true,
                localRecordType: 'docker_stacks',
                localRecordId: existing.id,
                rollbackData: { type: 'noop', reason: 'Stack already existed' },
            };
        }
        // Generate minimal compose from container info
        const serviceName = projectName.replace(/-/g, '_');
        const composeContent = generateComposeForContainer(payload, serviceName);
        // If hollow record exists, upgrade it
        if (existing) {
            return this.upgradeHollowRecord(existing.id, serverId, projectName, composeContent, payload, item);
        }
        let envVars = null;
        const rawEnv = payload.env || payload.Env;
        if (Array.isArray(rawEnv)) {
            envVars = {};
            for (const entry of rawEnv) {
                if (typeof entry === 'string') {
                    const idx = entry.indexOf('=');
                    if (idx > 0) {
                        envVars[entry.slice(0, idx)] = entry.slice(idx + 1);
                    }
                }
            }
            if (Object.keys(envVars).length === 0)
                envVars = null;
        }
        // Write compose file + env to VPS
        const workingDir = `${STACK_PATH}/${projectName}`;
        try {
            await (0, system_1.uploadFile)(this.sshService, serverId, `${workingDir}/docker-compose.yml`, composeContent);
            if (envVars && Object.keys(envVars).length > 0) {
                await (0, system_1.uploadFile)(this.sshService, serverId, `${workingDir}/.env`, envVarsToFileContent(envVars));
            }
        }
        catch (err) {
            console.warn(`[DockerStackImporter] Failed to write files to VPS for container ${projectName}:`, err);
        }
        // Standalone containers are likely already running — check status
        const status = await this.checkContainerStatus(serverId, projectName, workingDir);
        const stackId = (0, crypto_1.randomUUID)();
        return this.insertStackRecord(stackId, serverId, projectName, composeContent, envVars, status.status, item, status.servicesCount, status.lastDeployedAt);
    }
    /**
     * Upgrade a hollow record (empty compose_content) from a previous import.
     * Writes compose + env to VPS and updates the DB record.
     */
    async upgradeHollowRecord(stackId, serverId, projectName, composeContent, payload, item) {
        let envVars = null;
        if (payload.envVars && typeof payload.envVars === 'object') {
            envVars = payload.envVars;
        }
        else if (typeof payload.env === 'string' && payload.env.trim().length > 0) {
            envVars = parseEnvText(payload.env);
        }
        const workingDir = `${STACK_PATH}/${projectName}`;
        try {
            await (0, system_1.uploadFile)(this.sshService, serverId, `${workingDir}/docker-compose.yml`, composeContent);
            if (envVars && Object.keys(envVars).length > 0) {
                await (0, system_1.uploadFile)(this.sshService, serverId, `${workingDir}/.env`, envVarsToFileContent(envVars));
            }
        }
        catch (err) {
            console.warn(`[DockerStackImporter] Failed to write files to VPS for ${projectName} (upgrade):`, err);
        }
        const status = await this.checkContainerStatus(serverId, projectName, workingDir);
        const envVarsJson = envVars && Object.keys(envVars).length > 0 ? JSON.stringify(envVars) : null;
        const svcCount = status.servicesCount ?? (0, composeUtils_1.countServicesInCompose)(composeContent);
        const now = Date.now();
        db_1.db.prepare(`
      UPDATE docker_stacks
      SET compose_content = ?, env_vars = ?, status = ?, stack_path = ?,
          build_location = 'vps', services_count = ?, last_deployed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(composeContent, envVarsJson, status.status, STACK_PATH, svcCount, status.lastDeployedAt ?? null, now, stackId);
        console.log(`[DockerStackImporter] Upgraded hollow record for ${projectName} (status=${status.status})`);
        return {
            itemId: item.id,
            success: true,
            localRecordType: 'docker_stacks',
            localRecordId: stackId,
            rollbackData: { type: 'delete_stack', stackId, projectName },
        };
    }
    /**
     * Check if containers with matching project name are already running on the VPS.
     * Used for the "adopt" path in same-server migrations.
     */
    async checkContainerStatus(serverId, projectName, workingDir) {
        try {
            const result = await this.sshService.executeCommand(serverId, `cd '${workingDir}' && docker compose ps --format json 2>/dev/null`);
            if (result.exitCode === 0 && result.stdout.trim()) {
                // Parse JSON lines output from docker compose ps
                const lines = result.stdout.trim().split('\n').filter(Boolean);
                let runningCount = 0;
                for (const line of lines) {
                    try {
                        const container = JSON.parse(line);
                        if (container.State === 'running')
                            runningCount++;
                    }
                    catch {
                        // Not valid JSON — skip
                    }
                }
                if (runningCount > 0) {
                    console.log(`[DockerStackImporter] Adopting ${runningCount} running container(s) for ${projectName}`);
                    return {
                        status: 'running',
                        servicesCount: runningCount,
                        lastDeployedAt: Date.now(),
                    };
                }
            }
        }
        catch {
            // SSH error or docker compose not available — default to pending
        }
        return { status: 'pending' };
    }
    insertStackRecord(stackId, serverId, projectName, composeContent, envVars, status, item, servicesCount, lastDeployedAt) {
        const envVarsJson = envVars && Object.keys(envVars).length > 0 ? JSON.stringify(envVars) : null;
        const svcCount = servicesCount ?? (composeContent ? (0, composeUtils_1.countServicesInCompose)(composeContent) : 0);
        const now = Date.now();
        db_1.db.prepare(`
      INSERT INTO docker_stacks
      (id, server_id, project_name, compose_content, status, source_type, env_vars, stack_path, build_location, services_count, last_deployed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'migration', ?, ?, 'vps', ?, ?, ?, ?)
    `).run(stackId, serverId, projectName, composeContent || '', status, envVarsJson, STACK_PATH, svcCount, lastDeployedAt ?? null, now, now);
        return {
            itemId: item.id,
            success: true,
            localRecordType: 'docker_stacks',
            localRecordId: stackId,
            rollbackData: { type: 'delete_stack', stackId, projectName },
        };
    }
}
exports.DockerStackImporter = DockerStackImporter;
//# sourceMappingURL=DockerStackImporter.js.map