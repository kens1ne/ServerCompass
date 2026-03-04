"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamCommandWithTimeout = streamCommandWithTimeout;
exports.isBuildkitTransportEofFailure = isBuildkitTransportEofFailure;
exports.isDockerDnsResolutionFailure = isDockerDnsResolutionFailure;
/**
 * Stream a long-running command (e.g., docker compose build) with a timeout.
 * Shared between deploy and redeploy paths to avoid duplicating the buffering
 * and ANSI-stripping logic.
 */
async function streamCommandWithTimeout(options) {
    const { sshService, serverId, command, timeoutMs, onLine, timeoutErrorMessage, onTimeout } = options;
    let output = '';
    let exitCode = 0;
    let lineBuffer = '';
    const start = Date.now();
    await new Promise((resolve, reject) => {
        let streamCompleted = false;
        const timeout = setTimeout(() => {
            if (!streamCompleted) {
                streamCompleted = true;
                onTimeout?.();
                const error = new Error(timeoutErrorMessage || `Command timed out after ${Math.round(timeoutMs / 1000)} seconds`);
                error.output = output;
                reject(error);
            }
        }, timeoutMs);
        sshService.executeCommandStreaming(serverId, command, (data) => {
            output += data;
            lineBuffer += data;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';
            for (const line of lines) {
                const cleanLine = line
                    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
                    .replace(/\r/g, '')
                    .trim();
                if (cleanLine && !cleanLine.match(/^[#\s]*$/)) {
                    onLine?.(cleanLine);
                }
            }
        }).then((code) => {
            if (timeout)
                clearTimeout(timeout);
            if (!streamCompleted) {
                streamCompleted = true;
                exitCode = code;
                if (lineBuffer.trim()) {
                    const cleanLine = lineBuffer
                        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
                        .replace(/\r/g, '')
                        .trim();
                    if (cleanLine) {
                        onLine?.(cleanLine);
                    }
                }
                resolve();
            }
        }).catch((err) => {
            if (timeout)
                clearTimeout(timeout);
            if (!streamCompleted) {
                streamCompleted = true;
                if (err && typeof err === 'object') {
                    err.output = output;
                }
                reject(err);
            }
        });
    });
    return {
        output,
        exitCode,
        durationMs: Date.now() - start,
    };
}
/**
 * Detect transient BuildKit transport failures where docker compose build loses
 * connection to the daemon/buildkit process while exporting layers.
 *
 * Typical message:
 *   failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF
 */
function isBuildkitTransportEofFailure(output) {
    if (!output)
        return false;
    const text = output.toLowerCase();
    return (text.includes('failed to receive status') &&
        text.includes('rpc error: code = unavailable') &&
        text.includes('error reading from server: eof'));
}
/**
 * Detect common DNS resolution failures inside Docker build steps.
 *
 * These failures often indicate that the Docker bridge/forwarding rules on the VPS
 * are blocked (e.g., UFW) while the host itself still has connectivity.
 */
function isDockerDnsResolutionFailure(output) {
    if (!output)
        return false;
    const text = output.toLowerCase();
    return (text.includes('temporary failure resolving') ||
        text.includes('could not resolve host') ||
        text.includes('name or service not known') ||
        text.includes('no such host') ||
        text.includes('eai_again') ||
        text.includes('dial tcp: lookup') ||
        text.includes('getaddrinfo') && text.includes('temporary failure'));
}
//# sourceMappingURL=buildUtils.js.map