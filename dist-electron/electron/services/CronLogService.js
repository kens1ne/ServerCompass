"use strict";
/**
 * CronLogService
 *
 * Manages cron job logging on remote servers.
 * Logs are stored at ~/server-compass/cron/{job_signature}/
 * with automatic rotation based on file size or line count.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cronLogService = void 0;
const SSHService_1 = require("./SSHService");
/** Default log configuration */
const DEFAULT_LOG_CONFIG = {
    /** Maximum log file size in bytes (default: 1MB) */
    maxSizeBytes: 1024 * 1024,
    /** Maximum number of lines to keep (default: 10000) */
    maxLines: 10000,
    /** Number of backup files to keep (default: 3) */
    backupCount: 3,
};
/** Log directory base path on the server */
const LOG_BASE_PATH = '~/server-compass/crons/logs';
class CronLogService {
    /**
     * Get the log directory path for a cron job by its ID
     */
    getLogDirPath(cronId) {
        return `${LOG_BASE_PATH}/${cronId}`;
    }
    /**
     * Get the log file path for a cron job by its ID
     */
    getLogFilePath(cronId) {
        return `${this.getLogDirPath(cronId)}/output.log`;
    }
    /**
     * Initialize the log directory on the server
     */
    async initLogDir(serverId, cronId) {
        const logDir = this.getLogDirPath(cronId);
        const command = `mkdir -p ${logDir}`;
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to create log directory: ${result.stderr || result.stdout}`);
        }
    }
    /**
     * Get information about a cron job's log file
     */
    async getLogInfo(serverId, cronId) {
        const logPath = this.getLogFilePath(cronId);
        // Check if log file exists and get its stats
        const command = `
      if [ -f ${logPath} ]; then
        stat -c '%s %Y' ${logPath} 2>/dev/null || stat -f '%z %m' ${logPath} 2>/dev/null
        wc -l < ${logPath}
        echo "EXISTS"
      else
        echo "0 0"
        echo "0"
        echo "NOT_EXISTS"
      fi
    `;
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0) {
            return {
                exists: false,
                path: logPath,
                sizeBytes: 0,
                lineCount: 0,
                lastModified: null,
            };
        }
        const lines = (result.stdout || '').trim().split('\n');
        const exists = lines[2]?.trim() === 'EXISTS';
        if (!exists) {
            return {
                exists: false,
                path: logPath,
                sizeBytes: 0,
                lineCount: 0,
                lastModified: null,
            };
        }
        const [sizeStr, timestampStr] = (lines[0] || '0 0').split(' ');
        const lineCount = parseInt(lines[1] || '0', 10);
        const timestamp = parseInt(timestampStr || '0', 10);
        return {
            exists: true,
            path: logPath,
            sizeBytes: parseInt(sizeStr || '0', 10),
            lineCount: isNaN(lineCount) ? 0 : lineCount,
            lastModified: timestamp ? new Date(timestamp * 1000).toISOString() : null,
        };
    }
    /**
     * Get the content of a cron job's log file
     */
    async getLogs(serverId, cronId, options) {
        const logPath = this.getLogFilePath(cronId);
        const tailLines = options?.tailLines ?? 500;
        // Get total line count and last N lines
        const command = `
      if [ -f ${logPath} ]; then
        total=$(wc -l < ${logPath})
        echo "TOTAL:$total"
        tail -n ${tailLines} ${logPath}
      else
        echo "TOTAL:0"
        echo ""
      fi
    `;
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0) {
            return {
                content: '',
                truncated: false,
                totalLines: 0,
            };
        }
        const output = result.stdout || '';
        const firstLine = output.split('\n')[0] || '';
        const totalMatch = firstLine.match(/^TOTAL:(\d+)$/);
        const totalLines = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        // Remove the TOTAL line from content
        const content = output.replace(/^TOTAL:\d+\n?/, '');
        return {
            content,
            truncated: totalLines > tailLines,
            totalLines,
        };
    }
    /**
     * Clear a cron job's log file
     */
    async clearLogs(serverId, cronId) {
        const logPath = this.getLogFilePath(cronId);
        const command = `> ${logPath} 2>/dev/null || true`;
        await SSHService_1.sshService.executeCommand(serverId, command);
    }
    /**
     * Delete all log files for a cron job
     */
    async deleteLogs(serverId, cronId) {
        const logDir = this.getLogDirPath(cronId);
        const command = `rm -rf ${logDir}`;
        await SSHService_1.sshService.executeCommand(serverId, command);
    }
    /**
     * Wrap a command with logging redirection.
     * The wrapped command will:
     * 1. Create log directory if needed
     * 2. Rotate logs if they exceed size limit
     * 3. Redirect stdout and stderr to the log file
     */
    wrapCommandWithLogging(command, cronId, config = {}) {
        const logDir = this.getLogDirPath(cronId);
        const logFile = this.getLogFilePath(cronId);
        const maxBytes = config.maxSizeBytes ?? DEFAULT_LOG_CONFIG.maxSizeBytes;
        const backupCount = config.backupCount ?? DEFAULT_LOG_CONFIG.backupCount;
        // Create a wrapper script that:
        // 1. Creates log directory
        // 2. Rotates log if too large
        // 3. Adds timestamp header
        // 4. Runs the command with output redirected
        const wrapper = `
mkdir -p ${logDir} 2>/dev/null;
if [ -f ${logFile} ] && [ $(stat -c%s ${logFile} 2>/dev/null || stat -f%z ${logFile} 2>/dev/null || echo 0) -gt ${maxBytes} ]; then
  for i in $(seq ${backupCount - 1} -1 1); do
    [ -f ${logFile}.$i ] && mv ${logFile}.$i ${logFile}.$((i+1));
  done;
  mv ${logFile} ${logFile}.1 2>/dev/null;
fi;
echo "=== $(date '+\\%Y-\\%m-\\%d \\%H:\\%M:\\%S') ===" >> ${logFile};
(${command}) >> ${logFile} 2>&1
`.trim().replace(/\n/g, ' ');
        return wrapper;
    }
    /**
     * Check if a command already has logging enabled
     */
    hasLoggingEnabled(command) {
        return command.includes(LOG_BASE_PATH) && command.includes('output.log');
    }
    /**
     * Extract the original command from a logging-wrapped command
     */
    extractOriginalCommand(wrappedCommand) {
        // Try to extract the command between ( and ) >> logfile
        const match = wrappedCommand.match(/\(([^)]+)\)\s*>>\s*[^\s]+output\.log/);
        return match ? match[1].trim() : null;
    }
    /**
     * List all log directories for a server
     */
    async listLogDirs(serverId) {
        const command = `ls -1 ${LOG_BASE_PATH} 2>/dev/null || true`;
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0 || !result.stdout?.trim()) {
            return [];
        }
        return result.stdout.trim().split('\n').filter(Boolean);
    }
    /**
     * Get disk usage of all cron logs for a server
     */
    async getLogsDiskUsage(serverId) {
        const command = `du -sb ${LOG_BASE_PATH} 2>/dev/null | cut -f1 && find ${LOG_BASE_PATH} -name "*.log" 2>/dev/null | wc -l`;
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0 || !result.stdout?.trim()) {
            return { totalBytes: 0, count: 0 };
        }
        const lines = result.stdout.trim().split('\n');
        return {
            totalBytes: parseInt(lines[0] || '0', 10) || 0,
            count: parseInt(lines[1] || '0', 10) || 0,
        };
    }
}
exports.cronLogService = new CronLogService();
//# sourceMappingURL=CronLogService.js.map