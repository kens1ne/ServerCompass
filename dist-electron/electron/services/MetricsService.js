"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsService = exports.MetricsService = void 0;
const SSHService_1 = require("./SSHService");
const SECTOR_SIZE = 512;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toFiniteOrZero = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
};
const toFiniteOrNull = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};
class MetricsService {
    /**
     * Fetches only the essential metrics needed for dashboard cards.
     * Uses a single batched SSH command for minimal latency.
     * This is Stage 1 of progressive loading.
     */
    async getQuickMetrics(serverId) {
        // Batch multiple metrics into a single SSH command for speed
        const batchedCommand = `
echo "===CPU==="
nproc
cat /proc/loadavg
echo "===MEMORY==="
free -b | grep -E '^Mem:'
echo "===DISK==="
df -B1 / | tail -1
cat /proc/diskstats | grep -v -E 'loop|ram' | awk '{r+=$6; w+=$10} END {print r*512, w*512}'
echo "===NETWORK==="
cat /proc/net/dev | tail -n +3 | awk '{rx+=$2; tx+=$10} END {print rx, tx}'
`.trim();
        const result = await SSHService_1.sshService.executeCommand(serverId, batchedCommand);
        const output = result.stdout;
        // Parse sections
        const sections = output.split(/===([A-Z]+)===/);
        const cpuSection = sections[sections.indexOf('CPU') + 1] || '';
        const memSection = sections[sections.indexOf('MEMORY') + 1] || '';
        const diskSection = sections[sections.indexOf('DISK') + 1] || '';
        const netSection = sections[sections.indexOf('NETWORK') + 1] || '';
        // Parse CPU
        const cpuLines = cpuSection.trim().split('\n');
        const cores = parseInt(cpuLines[0]?.trim() || '1', 10) || 1;
        const loadAvg = parseFloat(cpuLines[1]?.trim().split(' ')[0] || '0');
        const cpuUsage = clamp((loadAvg / cores) * 100, 0, 100);
        // Parse Memory
        const memParts = memSection.trim().split(/\s+/);
        const memTotal = toFiniteOrZero(memParts[1]);
        const memUsed = toFiniteOrZero(memParts[2]);
        const memUsagePercent = memTotal > 0 ? clamp((memUsed / memTotal) * 100, 0, 100) : 0;
        // Parse Disk
        const diskLines = diskSection.trim().split('\n');
        const dfParts = diskLines[0]?.trim().split(/\s+/) || [];
        const diskTotal = toFiniteOrZero(dfParts[1]);
        const diskUsed = toFiniteOrZero(dfParts[2]);
        const diskFree = toFiniteOrZero(dfParts[3]);
        const diskUsagePercent = diskTotal > 0 ? clamp((diskUsed / diskTotal) * 100, 0, 100) : 0;
        // Parse disk I/O from second line
        const diskIoParts = diskLines[1]?.trim().split(/\s+/) || [];
        const readBytes = toFiniteOrZero(diskIoParts[0]);
        const writeBytes = toFiniteOrZero(diskIoParts[1]);
        // Parse Network
        const netParts = netSection.trim().split(/\s+/);
        const rxBytes = toFiniteOrZero(netParts[0]);
        const txBytes = toFiniteOrZero(netParts[1]);
        return {
            timestamp: Date.now(),
            cpu: {
                usage: cpuUsage,
                cores,
            },
            memory: {
                total: memTotal,
                used: memUsed,
                usagePercent: memUsagePercent,
            },
            disk: {
                total: diskTotal,
                used: diskUsed,
                free: diskFree,
                usagePercent: diskUsagePercent,
                readBytes,
                writeBytes,
            },
            network: {
                rxBytes,
                txBytes,
            },
        };
    }
    /**
     * Collects server metrics by executing lightweight SSH commands and deriving
     * health insights that drive the renderer overview experience.
     */
    async getMetrics(serverId) {
        const cpu = await this.getCPUMetrics(serverId);
        const memory = await this.getMemoryMetrics(serverId);
        const disk = await this.getDiskMetrics(serverId);
        const network = await this.getNetworkMetrics(serverId);
        const system = await this.getSystemMetrics(serverId);
        const health = this.evaluateHealth({ cpu, memory, disk });
        const alerts = this.buildAlerts({ health, memory, disk });
        return {
            timestamp: Date.now(),
            cpu,
            memory,
            disk,
            network,
            system,
            health,
            alerts,
        };
    }
    async getCPUMetrics(serverId) {
        const coresResult = await SSHService_1.sshService.executeCommand(serverId, 'nproc');
        const loadResult = await SSHService_1.sshService.executeCommand(serverId, 'cat /proc/loadavg');
        const modelResult = await SSHService_1.sshService.executeCommand(serverId, "cat /proc/cpuinfo | awk -F ':' '/model name/ {print $2; exit}'");
        const freqResult = await SSHService_1.sshService.executeCommand(serverId, "cat /proc/cpuinfo | awk -F ':' '/cpu MHz/ {print $2; exit}'");
        const cores = parseInt(coresResult.stdout.trim(), 10) || 1;
        const load = parseFloat(loadResult.stdout.trim().split(' ')[0] || '0');
        const usage = clamp((load / cores) * 100, 0, 100);
        const model = modelResult.stdout.trim() || null;
        const frequencyMHz = parseFloat(freqResult.stdout.trim());
        const frequencyGHz = Number.isFinite(frequencyMHz) ? frequencyMHz / 1000 : null;
        return {
            cores,
            usage,
            model,
            frequencyGHz,
        };
    }
    async getMemoryMetrics(serverId) {
        const result = await SSHService_1.sshService.executeCommand(serverId, 'free -b');
        const lines = result.stdout.trim().split('\n');
        const memLine = lines.find((line) => line.toLowerCase().startsWith('mem'));
        const swapLine = lines.find((line) => line.toLowerCase().startsWith('swap'));
        const parseLine = (line) => {
            if (!line)
                return [];
            return line
                .trim()
                .split(/\s+/)
                .map((value) => Number(value.replace(/[^0-9.-]/g, '')));
        };
        const memValues = parseLine(memLine);
        const swapValues = parseLine(swapLine);
        const total = toFiniteOrZero(memValues[1]);
        const used = toFiniteOrZero(memValues[2]);
        const free = toFiniteOrZero(memValues[3]);
        const available = toFiniteOrZero(memValues[6]) || Math.max(total - used, 0);
        const usagePercent = total > 0 ? clamp((used / total) * 100, 0, 100) : 0;
        const swapTotal = toFiniteOrNull(swapValues[1]);
        const swapUsed = toFiniteOrNull(swapValues[2]);
        const swapUsagePercent = swapTotal && swapTotal > 0
            ? clamp(((swapUsed ?? 0) / swapTotal) * 100, 0, 100)
            : null;
        return {
            total,
            used,
            free,
            available,
            usagePercent,
            swapTotal,
            swapUsed,
            swapUsagePercent,
        };
    }
    async getDiskMetrics(serverId) {
        const rootResult = await SSHService_1.sshService.executeCommand(serverId, "df -B1 / | tail -1");
        const mountsResult = await SSHService_1.sshService.executeCommand(serverId, "df -B1 --output=source,fstype,target,size,used,avail,pcent | tail -n +2");
        const diskStatsResult = await SSHService_1.sshService.executeCommand(serverId, 'cat /proc/diskstats');
        const parseDfLine = (line) => line
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        const rootParts = parseDfLine(rootResult.stdout);
        const total = toFiniteOrZero(rootParts[1]);
        const used = toFiniteOrZero(rootParts[2]);
        const free = toFiniteOrZero(rootParts[3]);
        const percentString = rootParts[4] ? rootParts[4].replace('%', '') : '0';
        const parsedPercent = toFiniteOrZero(percentString);
        const usagePercent = total > 0 ? clamp((used / total) * 100, 0, 100) : parsedPercent;
        const rootDevice = rootParts[0] ?? null;
        const mounts = mountsResult.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
            const [device, filesystem, mountpoint, size, usedValue, available, percent] = parseDfLine(line);
            const usage = Number((percent ?? '0').replace('%', '')) || 0;
            return {
                device,
                filesystem,
                mountpoint,
                total: toFiniteOrZero(size),
                used: toFiniteOrZero(usedValue),
                available: toFiniteOrZero(available),
                usagePercent: clamp(usage, 0, 100),
            };
        });
        const diskStatsLines = diskStatsResult.stdout.trim().split('\n');
        let readBytes = 0;
        let writeBytes = 0;
        diskStatsLines.forEach((line) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 11)
                return;
            const name = parts[2];
            // Skip loopback and ram devices
            if (!name || name.startsWith('loop') || name.startsWith('ram')) {
                return;
            }
            const sectorsRead = Number(parts[5] ?? 0);
            const sectorsWritten = Number(parts[9] ?? 0);
            readBytes += sectorsRead * SECTOR_SIZE;
            writeBytes += sectorsWritten * SECTOR_SIZE;
        });
        return {
            total,
            used,
            free,
            usagePercent,
            readBytes,
            writeBytes,
            rootDevice,
            mounts,
        };
    }
    async getNetworkMetrics(serverId) {
        const result = await SSHService_1.sshService.executeCommand(serverId, 'cat /proc/net/dev');
        const lines = result.stdout.trim().split('\n').slice(2); // Skip headers
        let rxBytes = 0;
        let txBytes = 0;
        let rxPackets = 0;
        let txPackets = 0;
        const interfaces = [];
        lines.forEach((rawLine) => {
            const line = rawLine.trim();
            if (!line)
                return;
            const [ifacePart, statsPart] = line.split(':');
            if (!ifacePart || !statsPart)
                return;
            const iface = ifacePart.trim();
            const stats = statsPart.trim().split(/\s+/);
            if (stats.length < 10)
                return;
            const ifaceRxBytes = Number(stats[0] ?? 0);
            const ifaceRxPackets = Number(stats[1] ?? 0);
            const ifaceTxBytes = Number(stats[8] ?? 0);
            const ifaceTxPackets = Number(stats[9] ?? 0);
            rxBytes += ifaceRxBytes;
            txBytes += ifaceTxBytes;
            rxPackets += ifaceRxPackets;
            txPackets += ifaceTxPackets;
            interfaces.push({
                name: iface,
                rxBytes: ifaceRxBytes,
                txBytes: ifaceTxBytes,
                rxPackets: ifaceRxPackets,
                txPackets: ifaceTxPackets,
                speedMbps: null,
            });
        });
        return {
            rxBytes,
            txBytes,
            rxPackets,
            txPackets,
            interfaces,
        };
    }
    async getSystemMetrics(serverId) {
        const hostnameResult = await SSHService_1.sshService.executeCommand(serverId, 'hostname');
        const osResult = await SSHService_1.sshService.executeCommand(serverId, `sh -c "if [ -f /etc/os-release ]; then . /etc/os-release && echo \\$PRETTY_NAME; else uname -s; fi"`);
        const kernelResult = await SSHService_1.sshService.executeCommand(serverId, 'uname -sr');
        const uptimeResult = await SSHService_1.sshService.executeCommand(serverId, "cat /proc/uptime | awk '{print $1}'");
        const loadResult = await SSHService_1.sshService.executeCommand(serverId, 'cat /proc/loadavg');
        const processResult = await SSHService_1.sshService.executeCommand(serverId, 'ps -e --no-headers | wc -l');
        const loadParts = loadResult.stdout.trim().split(' ');
        return {
            hostname: hostnameResult.stdout.trim() || null,
            os: osResult.stdout.trim() || null,
            kernel: kernelResult.stdout.trim() || null,
            uptime: parseFloat(uptimeResult.stdout.trim()) || 0,
            loadAverage: {
                one: parseFloat(loadParts[0] ?? '0'),
                five: parseFloat(loadParts[1] ?? '0'),
                fifteen: parseFloat(loadParts[2] ?? '0'),
            },
            processCount: parseInt(processResult.stdout.trim(), 10) || null,
        };
    }
    evaluateHealth({ cpu, memory, disk, }) {
        const indicators = [];
        const cpuLevel = cpu.usage >= 90 ? 'critical' : cpu.usage >= 75 ? 'warning' : 'ok';
        indicators.push({
            key: 'cpu',
            label: 'CPU Usage',
            level: cpuLevel,
            value: `${cpu.usage.toFixed(1)}%`,
            hint: cpuLevel === 'critical'
                ? 'CPU usage is saturated'
                : cpuLevel === 'warning'
                    ? 'CPU usage is elevated'
                    : 'CPU operating within normal range',
        });
        const memoryLevel = memory.usagePercent >= 90 ? 'critical' : memory.usagePercent >= 80 ? 'warning' : 'ok';
        indicators.push({
            key: 'memory',
            label: 'Memory Usage',
            level: memoryLevel,
            value: `${memory.usagePercent.toFixed(1)}%`,
            hint: memoryLevel === 'critical'
                ? 'Memory pressure is severe'
                : memoryLevel === 'warning'
                    ? 'Memory usage is approaching limits'
                    : 'Memory capacity is stable',
        });
        const diskLevel = disk.usagePercent >= 95 ? 'critical' : disk.usagePercent >= 85 ? 'warning' : 'ok';
        indicators.push({
            key: 'disk',
            label: 'Disk Usage',
            level: diskLevel,
            value: `${disk.usagePercent.toFixed(1)}%`,
            hint: diskLevel === 'critical'
                ? 'Root filesystem is nearly full'
                : diskLevel === 'warning'
                    ? 'Disk usage is trending high'
                    : 'Plenty of disk capacity available',
        });
        let status = 'healthy';
        if (indicators.some((indicator) => indicator.level === 'critical')) {
            status = 'critical';
        }
        else if (indicators.some((indicator) => indicator.level === 'warning')) {
            status = 'warning';
        }
        const penalty = indicators.reduce((score, indicator) => {
            if (indicator.level === 'critical')
                return score + 35;
            if (indicator.level === 'warning')
                return score + 15;
            return score;
        }, 0);
        const score = Math.max(0, Math.min(100, 100 - penalty));
        const summary = status === 'critical'
            ? 'Immediate attention required'
            : status === 'warning'
                ? 'Performance requires attention'
                : 'Server performing normally';
        return {
            status,
            score,
            summary,
            indicators,
        };
    }
    buildAlerts({ health, memory, disk, }) {
        const alerts = [];
        health.indicators.forEach((indicator) => {
            if (indicator.level === 'ok')
                return;
            const level = indicator.level === 'critical' ? 'critical' : 'warning';
            alerts.push({
                id: `indicator-${indicator.key}`,
                level,
                title: indicator.label,
                description: indicator.hint,
            });
        });
        if (memory.swapTotal && memory.swapTotal > 0) {
            const swapUsage = memory.swapUsagePercent ?? 0;
            if (swapUsage >= 60) {
                const level = swapUsage >= 80 ? 'critical' : 'warning';
                alerts.push({
                    id: 'swap-usage',
                    level,
                    title: 'Swap usage is elevated',
                    description: `Swap is ${swapUsage.toFixed(1)}% utilized. Consider optimizing memory usage.`,
                    actionLabel: 'View processes',
                });
            }
        }
        const mountAlerts = disk.mounts
            .filter((mount) => mount.usagePercent >= 85)
            .map((mount) => {
            const level = mount.usagePercent >= 95 ? 'critical' : 'warning';
            return {
                id: `mount-${mount.mountpoint}`,
                level,
                title: `Disk usage high on ${mount.mountpoint}`,
                description: `${mount.usagePercent.toFixed(1)}% used on ${mount.device}`,
                actionLabel: 'View storage',
            };
        });
        alerts.push(...mountAlerts);
        return alerts;
    }
}
exports.MetricsService = MetricsService;
exports.metricsService = new MetricsService();
//# sourceMappingURL=MetricsService.js.map