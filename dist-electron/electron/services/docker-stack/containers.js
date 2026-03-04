"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllContainers = getAllContainers;
exports.getContainerStats = getContainerStats;
exports.getContainerStatus = getContainerStatus;
exports.getContainerInfo = getContainerInfo;
const composeUtils_1 = require("./composeUtils");
async function getAllContainers(ctx, serverId) {
    const psResult = await ctx.sshService.executeCommand(serverId, `docker ps -a --format '{{json .}}'`);
    if (psResult.exitCode !== 0) {
        console.warn('Failed to get all containers:', psResult.stderr);
        return new Map();
    }
    const containersByProject = new Map();
    const lines = psResult.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const data = JSON.parse(line);
            const labels = data.Labels || '';
            const projectMatch = labels.match(/com\\.docker\\.compose\\.project=([^,]+)/);
            const projectName = projectMatch ? projectMatch[1] : null;
            if (!projectName)
                continue;
            const serviceMatch = labels.match(/com\\.docker\\.compose\\.service=([^,]+)/);
            const serviceName = serviceMatch ? serviceMatch[1] : data.Names || '';
            const ports = (0, composeUtils_1.parsePortsString)(data.Ports || '');
            const container = {
                id: data.ID || '',
                name: data.Names || '',
                service: serviceName,
                state: data.State || '',
                status: data.Status || '',
                image: data.Image || '',
                ports,
                health: undefined,
            };
            if (!containersByProject.has(projectName)) {
                containersByProject.set(projectName, []);
            }
            containersByProject.get(projectName).push(container);
        }
        catch {
            // Skip non-JSON lines
        }
    }
    return containersByProject;
}
async function getContainerStats(ctx, serverId) {
    const statsMap = new Map();
    try {
        const statsResult = await Promise.race([
            ctx.sshService.executeCommand(serverId, `docker stats --no-stream --format '{{json .}}'`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Stats timeout')), 5000)),
        ]);
        if (statsResult.exitCode !== 0)
            return statsMap;
        const statsLines = statsResult.stdout.split('\n').filter(Boolean);
        for (const line of statsLines) {
            try {
                const stats = JSON.parse(line);
                const name = stats.Name || stats.Container || '';
                if (name) {
                    statsMap.set(name, {
                        cpu: stats.CPUPerc || '0%',
                        mem: stats.MemUsage || '0B',
                        memPerc: stats.MemPerc || '0%',
                    });
                }
            }
            catch {
                // Skip parse errors
            }
        }
    }
    catch (error) {
        console.warn('Failed to get container stats:', error instanceof Error ? error.message : String(error));
    }
    return statsMap;
}
async function getContainerStatus(ctx, serverId, workingDir) {
    const psResult = await ctx.sshService.executeCommand(serverId, `cd ${workingDir} && (docker compose ps --format json 2>/dev/null || docker compose ps)`);
    if (psResult.exitCode !== 0) {
        console.warn('Failed to get container status:', psResult.stderr);
        return [];
    }
    const containers = [];
    const lines = psResult.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const container = JSON.parse(line);
            containers.push({
                id: container.ID || container.Container || '',
                name: container.Name || '',
                service: container.Service || '',
                state: container.State || '',
                status: container.Status || '',
                image: container.Image || '',
                ports: (0, composeUtils_1.parsePorts)(container.Publishers || container.Ports || []),
                health: container.Health || undefined,
            });
        }
        catch {
            // Skip non-JSON lines
        }
    }
    if (containers.length > 0) {
        await enrichWithStats(ctx, serverId, containers);
        await enrichWithInspectData(ctx, serverId, containers);
    }
    return containers;
}
async function getContainerInfo(ctx, serverId, projectName) {
    const result = await ctx.sshService.executeCommand(serverId, `docker compose ps --format json -a 2>/dev/null || docker ps --filter "label=com.docker.compose.project=${projectName}" --format json 2>/dev/null || echo "[]"`);
    if (!result.stdout.trim() || result.stdout.trim() === '[]') {
        return [];
    }
    const containers = [];
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
        try {
            const data = JSON.parse(line);
            containers.push({
                id: data.ID || data.Id || '',
                name: data.Name || data.Names || '',
                service: data.Service || data.Labels?.['com.docker.compose.service'] || '',
                state: data.State || '',
                status: data.Status || '',
                image: data.Image || '',
                ports: [],
            });
        }
        catch {
            // Skip invalid JSON lines
        }
    }
    return containers;
}
async function enrichWithStats(ctx, serverId, containers) {
    const containerIds = containers.map(c => c.id).filter(Boolean).join(' ');
    if (!containerIds)
        return;
    try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Stats timeout')), 5000));
        const statsPromise = ctx.sshService.executeCommand(serverId, `docker stats ${containerIds} --no-stream --format "{{json .}}"`);
        const statsResult = await Promise.race([statsPromise, timeoutPromise]);
        if (statsResult.exitCode !== 0)
            return;
        const statsLines = statsResult.stdout.split('\n').filter(Boolean);
        for (const line of statsLines) {
            try {
                const stats = JSON.parse(line);
                const container = containers.find(c => c.id === stats.Container || c.name === stats.Name);
                if (container) {
                    container.cpuPercent = stats.CPUPerc || '0%';
                    container.memUsage = stats.MemUsage || '0B';
                    container.memPercent = stats.MemPerc || '0%';
                }
            }
            catch {
                // Skip parse errors
            }
        }
    }
    catch (error) {
        console.warn('Failed to enrich container stats:', error instanceof Error ? error.message : String(error));
    }
}
async function enrichWithInspectData(ctx, serverId, containers) {
    const containerIds = containers.map(c => c.id).filter(Boolean).join(' ');
    if (!containerIds)
        return;
    try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Inspect timeout')), 5000));
        const inspectPromise = ctx.sshService.executeCommand(serverId, `docker inspect ${containerIds}`);
        const inspectResult = await Promise.race([inspectPromise, timeoutPromise]);
        if (inspectResult.exitCode !== 0)
            return;
        try {
            const inspectData = JSON.parse(inspectResult.stdout);
            if (Array.isArray(inspectData)) {
                for (const containerData of inspectData) {
                    const containerId = containerData.Id?.substring(0, 12);
                    const container = containers.find(c => c.id === containerId || containerData.Id?.startsWith(c.id));
                    if (container && containerData.Config) {
                        container.workingDir = containerData.Config.WorkingDir || undefined;
                        const labels = containerData.Config.Labels || {};
                        container.composeProjectWorkingDir = labels['com.docker.compose.project.working_dir'] || undefined;
                        if (Array.isArray(containerData.Mounts)) {
                            container.mounts = containerData.Mounts.map((mount) => ({
                                source: mount.Source || '',
                                destination: mount.Destination || '',
                                type: mount.Type || 'unknown',
                                mode: mount.Mode || mount.RW === false ? 'ro' : 'rw',
                            }));
                        }
                    }
                }
            }
        }
        catch (parseError) {
            console.warn('Failed to parse docker inspect output:', parseError);
        }
    }
    catch (error) {
        console.warn('Failed to enrich container inspect data:', error instanceof Error ? error.message : String(error));
    }
}
//# sourceMappingURL=containers.js.map