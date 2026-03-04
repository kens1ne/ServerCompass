"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseProvider = void 0;
class BaseProvider {
    /** Execute a single decommission step. */
    async executeDecommissionStep(serverId, sshService, step) {
        try {
            const result = await sshService.executeCommand(serverId, step.command);
            return { success: result.exitCode === 0, output: result.stdout || result.stderr };
        }
        catch (err) {
            return { success: false, output: err instanceof Error ? err.message : String(err) };
        }
    }
    /** Helper: check if a systemctl service is active using exact match (not .includes). */
    async isServiceActive(serverId, sshService, serviceName) {
        try {
            const result = await sshService.executeCommand(serverId, `systemctl is-active ${serviceName} 2>/dev/null`);
            return result.stdout.trim().split('\n').some(line => line.trim() === 'active');
        }
        catch {
            return false;
        }
    }
    /** Helper: check if a Docker container exists by name filter. */
    async dockerContainerExists(serverId, sshService, nameFilter) {
        try {
            const result = await sshService.executeCommand(serverId, `docker ps --filter "name=${nameFilter}" --format "{{.Names}}" 2>/dev/null`);
            return result.exitCode === 0 && result.stdout.trim().length > 0;
        }
        catch {
            return false;
        }
    }
    /** Helper: check if a path exists on the remote server. */
    async pathExists(serverId, sshService, remotePath) {
        try {
            const result = await sshService.executeCommand(serverId, `test -e ${remotePath} && echo "exists"`);
            return result.stdout.trim() === 'exists';
        }
        catch {
            return false;
        }
    }
    /** Helper: safely execute a command, returning empty string on failure. */
    async safeExec(serverId, sshService, command) {
        try {
            const result = await sshService.executeCommand(serverId, command);
            return result.exitCode === 0 ? result.stdout.trim() : '';
        }
        catch {
            return '';
        }
    }
}
exports.BaseProvider = BaseProvider;
//# sourceMappingURL=BaseProvider.js.map