"use strict";
/**
 * SSH Error Logger - Provides better error messages for SSH issues
 *
 * CRITICAL: SSH errors can be cryptic. This utility:
 * - Detects common SSH error patterns
 * - Provides helpful context about what likely caused the error
 * - Suggests fixes
 * - Deduplicates similar errors to reduce noise
 *
 * WHY THIS EXISTS:
 * =================
 * Before this utility, SSH errors looked like this:
 *   "Error: (SSH) Channel open failure: open failed
 *    at onChannelOpenFailure (/path/to/ssh2/lib/utils.js:16:11)
 *    ...50 more lines of stack trace...
 *    { reason: 2 }"
 *
 * Problems with raw SSH errors:
 * 1. Stack traces are long and unhelpful (library internals, not our code)
 * 2. Error messages are technical ("Channel open failure reason: 2" - what does that mean?)
 * 3. No context about WHAT operation failed or WHERE in our app
 * 4. No suggestion for HOW to fix it
 * 5. Same error repeated many times (SSH retries, parallel operations)
 *
 * DESIGN DECISIONS:
 * =================
 * 1. Pattern Detection: Analyze error message and stack to identify error type
 *    - Why: Different SSH errors have different causes and fixes
 *    - Example: "reason: 2" means MaxSessions limit, not auth failure
 *
 * 2. Deduplication: Track recent errors in a 5-second window
 *    - Why: Parallel SSH calls can trigger same error 10+ times
 *    - Example: Loading 5 containers simultaneously → 5 identical errors
 *    - Trade-off: We might miss rapid different errors, but that's rare
 *
 * 3. Two Logging Modes (full vs compact):
 *    - Full: For user-facing operations (test connection, manual commands)
 *      → User needs detailed explanation to fix their config
 *    - Compact: For internal operations (docker ps, port scanning)
 *      → Developer needs quick info to debug, not full details
 *
 * 4. Context Object: Pass operation, serverId, serverHost, command
 *    - Why: Same error can happen in different contexts
 *    - Example: "Channel limit" during deployment vs during metrics polling
 *    - Helps developer understand which code path triggered the error
 *
 * WHEN TO USE:
 * ============
 * - Use `logSSHError()` for user-facing operations (they need help fixing it)
 * - Use `logSSHErrorCompact()` for internal operations (we need to debug it)
 * - Always provide context object with at least operation and serverId
 *
 * COMMON ERROR TYPES:
 * ===================
 * - SSH_CHANNEL_LIMIT (reason: 2): Too many simultaneous SSH channels
 *   → Fix: Reduce parallel operations, add delays, use connection pooling
 *
 * - SSH_HANDSHAKE_TIMEOUT: SSH handshake took too long
 *   → Fix: Check server load, network latency, increase timeout
 *
 * - SSH_AUTH_FAILED: Invalid credentials
 *   → Fix: Check SSH key or password is correct
 *
 * - SSH_CONN_REFUSED: Cannot connect to server
 *   → Fix: Check SSH daemon is running, port is correct, firewall allows it
 *
 * @example
 * // In IPC handler for user-facing operation:
 * catch (error) {
 *   if (error instanceof Error) {
 *     logSSHError(error, {
 *       operation: 'testConnection',
 *       serverHost: input.host,
 *     });
 *   }
 *   return { success: false, error: String(error) };
 * }
 *
 * @example
 * // In internal service for frequent operations:
 * catch (error) {
 *   if (error instanceof Error) {
 *     logSSHErrorCompact(error, {
 *       operation: 'executeCommand',
 *       serverId: serverId,
 *       command: command,
 *     });
 *   }
 *   throw error;
 * }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.logSSHError = logSSHError;
exports.logSSHErrorCompact = logSSHErrorCompact;
exports.getSSHErrorStats = getSSHErrorStats;
// Track recent errors to deduplicate (keep last 100)
const recentErrors = new Map();
const MAX_RECENT_ERRORS = 100;
const ERROR_DEDUPE_WINDOW_MS = 5000; // 5 seconds
/**
 * Analyze SSH error and extract useful information
 */
function analyzeSSHError(error) {
    const errorMessage = error.message;
    const errorStack = error.stack || '';
    // CRITICAL: Channel open failure (reason: 2) = SSH connection limit exceeded
    // This happens when too many SSH channels are opened simultaneously
    if (errorMessage.includes('Channel open failure') || errorStack.includes('CHANNEL_OPEN_FAILURE')) {
        const reasonMatch = errorStack.match(/reason:\s*(\d+)/);
        const reason = reasonMatch ? parseInt(reasonMatch[1], 10) : null;
        if (reason === 2) {
            return {
                type: 'SSH_CHANNEL_LIMIT',
                message: 'SSH connection limit exceeded',
                suggestion: 'Too many simultaneous SSH operations. The server has a MaxSessions limit. Wait for ongoing operations to complete or reduce concurrent SSH calls.',
                originalError: errorMessage,
            };
        }
        return {
            type: 'SSH_CHANNEL_FAILURE',
            message: 'SSH channel open failure',
            suggestion: `Channel open failed with reason: ${reason || 'unknown'}. This may indicate server-side SSH restrictions or resource limits.`,
            originalError: errorMessage,
        };
    }
    // CRITICAL: Handshake timeout = Network issues or server overload
    if (errorMessage.includes('Timed out while waiting for handshake') || errorMessage.includes('handshake')) {
        return {
            type: 'SSH_HANDSHAKE_TIMEOUT',
            message: 'SSH handshake timeout',
            suggestion: 'The SSH connection timed out during handshake. This usually means the server is slow to respond (high load) or there are network issues.',
            originalError: errorMessage,
        };
    }
    // CRITICAL: Authentication failure
    if (errorMessage.includes('All configured authentication methods failed') ||
        errorMessage.includes('Authentication failed')) {
        return {
            type: 'SSH_AUTH_FAILED',
            message: 'SSH authentication failed',
            suggestion: 'Invalid credentials. Check that the SSH key or password is correct.',
            originalError: errorMessage,
        };
    }
    // CRITICAL: Connection refused = Server not reachable or SSH not running
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('Connection refused')) {
        return {
            type: 'SSH_CONN_REFUSED',
            message: 'SSH connection refused',
            suggestion: 'Cannot connect to SSH server. Ensure the server is running and the SSH daemon is active on the correct port.',
            originalError: errorMessage,
        };
    }
    // CRITICAL: Timeout = Network issues or firewall
    if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('Timed out')) {
        return {
            type: 'SSH_TIMEOUT',
            message: 'SSH connection timeout',
            suggestion: 'Connection timed out. Check network connectivity, firewall rules, and server availability.',
            originalError: errorMessage,
        };
    }
    // CRITICAL: Connection reset = Abrupt disconnection
    if (errorMessage.includes('ECONNRESET') || errorMessage.includes('Connection reset')) {
        return {
            type: 'SSH_CONN_RESET',
            message: 'SSH connection reset',
            suggestion: 'The connection was abruptly closed. This may be due to network issues, server restart, or firewall interference.',
            originalError: errorMessage,
        };
    }
    // Host key verification failed
    if (errorMessage.includes('Host key verification failed')) {
        return {
            type: 'SSH_HOST_KEY_FAILED',
            message: 'SSH host key verification failed',
            suggestion: 'The server host key has changed. This could indicate a security issue (MITM attack) or the server was reinstalled.',
            originalError: errorMessage,
        };
    }
    // Generic SSH error
    return {
        type: 'SSH_ERROR',
        message: 'SSH operation failed',
        suggestion: 'An unexpected SSH error occurred. Check server connectivity and SSH configuration.',
        originalError: errorMessage,
    };
}
/**
 * Create a deduplication key for the error
 */
function createErrorKey(errorInfo, context) {
    return `${errorInfo.type}:${context.serverId || 'unknown'}:${context.operation || 'unknown'}`;
}
/**
 * Check if this error should be logged (not a recent duplicate)
 */
function shouldLogError(errorKey) {
    const now = Date.now();
    const recent = recentErrors.get(errorKey);
    if (recent && (now - recent.lastSeen) < ERROR_DEDUPE_WINDOW_MS) {
        // This is a duplicate within the dedupe window
        recent.count++;
        recent.lastSeen = now;
        return false;
    }
    // New error or outside dedupe window - log it
    recentErrors.set(errorKey, { count: 1, lastSeen: now });
    // Cleanup old entries if map gets too large
    if (recentErrors.size > MAX_RECENT_ERRORS) {
        const oldestKey = Array.from(recentErrors.entries())
            .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0][0];
        recentErrors.delete(oldestKey);
    }
    return true;
}
/**
 * Log SSH error with better context and formatting
 *
 * @param error - The error object
 * @param context - Additional context about the operation
 */
function logSSHError(error, context = {}) {
    const errorInfo = analyzeSSHError(error);
    const errorKey = createErrorKey(errorInfo, context);
    // Check for deduplication
    if (!shouldLogError(errorKey)) {
        const recent = recentErrors.get(errorKey);
        if (recent && recent.count === 2) {
            // Log once more to indicate we're suppressing duplicates
            console.warn(`[SSH] ⚠️  Suppressing duplicate ${errorInfo.type} errors (will resume logging after 5s quiet period)`);
        }
        return;
    }
    // Format a clean, helpful error message
    const parts = [
        `\n${'='.repeat(80)}`,
        `[SSH ERROR] ${errorInfo.type}`,
        `${'='.repeat(80)}`,
    ];
    // Add context
    if (context.operation) {
        parts.push(`Operation: ${context.operation}`);
    }
    if (context.serverId) {
        parts.push(`Server ID: ${context.serverId}`);
    }
    if (context.serverHost) {
        parts.push(`Server Host: ${context.serverHost}`);
    }
    if (context.command) {
        // Truncate long commands
        const displayCommand = context.command.length > 100
            ? context.command.substring(0, 100) + '...'
            : context.command;
        parts.push(`Command: ${displayCommand}`);
    }
    parts.push('');
    parts.push(`❌ ${errorInfo.message}`);
    parts.push(`💡 ${errorInfo.suggestion}`);
    parts.push('');
    parts.push(`Original Error: ${errorInfo.originalError}`);
    parts.push(`${'='.repeat(80)}\n`);
    console.error(parts.join('\n'));
}
/**
 * Log SSH error with minimal output (one-line)
 * Use this for non-critical errors or when you want less noise
 */
function logSSHErrorCompact(error, context = {}) {
    const errorInfo = analyzeSSHError(error);
    const errorKey = createErrorKey(errorInfo, context);
    // Check for deduplication
    if (!shouldLogError(errorKey)) {
        return;
    }
    const contextStr = [
        context.serverId && `server=${context.serverId.substring(0, 8)}`,
        context.operation && `op=${context.operation}`,
    ].filter(Boolean).join(' ');
    console.error(`[SSH] ${errorInfo.type}: ${errorInfo.message} ${contextStr ? `(${contextStr})` : ''}`);
}
/**
 * Get error statistics (useful for debugging)
 */
function getSSHErrorStats() {
    return Array.from(recentErrors.entries()).map(([key, data]) => ({
        key,
        count: data.count,
        lastSeen: new Date(data.lastSeen),
    }));
}
//# sourceMappingURL=sshErrorLogger.js.map