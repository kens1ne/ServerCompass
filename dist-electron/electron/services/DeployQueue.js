"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeployQueue = void 0;
exports.getDeployQueue = getDeployQueue;
exports.createDeployQueue = createDeployQueue;
/**
 * DeployQueue - Server-level deployment queue to prevent resource saturation
 *
 * Problem: Two zero-downtime deploys on same server simultaneously = 4x resource usage.
 * Solution: Server-level deploy queue that serializes deployments per server.
 *
 * Queue behavior:
 * - Deploys on SAME server: serialized (queued)
 * - Deploys on DIFFERENT servers: parallel (no queue)
 * - Standard deploys: also queued (same mechanism)
 */
class DeployQueue {
    // In-memory queue per server (main process)
    deployQueues = new Map();
    // Track queue positions for UI feedback
    queuePositions = new Map(); // serverId -> [stackIds in queue]
    /**
     * Queue a deployment operation for a server
     * Deployments on the same server are serialized; different servers run in parallel
     *
     * @param serverId - Server ID to queue deployment for
     * @param stackId - Stack ID being deployed (for tracking)
     * @param deployFn - The actual deployment function to execute
     * @returns Promise resolving to deployment result
     */
    async queueDeploy(serverId, stackId, deployFn) {
        // Add to queue positions for UI feedback
        if (!this.queuePositions.has(serverId)) {
            this.queuePositions.set(serverId, []);
        }
        const positions = this.queuePositions.get(serverId);
        positions.push(stackId);
        try {
            // Wait for any existing deploy on this server to complete
            const existingQueue = this.deployQueues.get(serverId) || Promise.resolve();
            const newQueue = existingQueue
                .catch(() => { }) // Don't let previous failure block queue
                .then(() => deployFn());
            this.deployQueues.set(serverId, newQueue);
            return await newQueue;
        }
        finally {
            // Remove from queue positions
            const idx = positions.indexOf(stackId);
            if (idx !== -1) {
                positions.splice(idx, 1);
            }
            if (positions.length === 0) {
                this.queuePositions.delete(serverId);
            }
        }
    }
    /**
     * Get the current queue position for a stack
     *
     * @param serverId - Server ID
     * @param stackId - Stack ID to check
     * @returns Queue position (0 = running, 1+ = waiting) or -1 if not in queue
     */
    getQueuePosition(serverId, stackId) {
        const positions = this.queuePositions.get(serverId);
        if (!positions) {
            return -1;
        }
        return positions.indexOf(stackId);
    }
    /**
     * Check if a server has any deployments in queue
     *
     * @param serverId - Server ID to check
     */
    hasQueuedDeployments(serverId) {
        const positions = this.queuePositions.get(serverId);
        return positions !== undefined && positions.length > 0;
    }
    /**
     * Get the number of deployments waiting in queue for a server
     *
     * @param serverId - Server ID to check
     */
    getQueueLength(serverId) {
        const positions = this.queuePositions.get(serverId);
        return positions?.length || 0;
    }
    /**
     * Check if a specific stack is currently being deployed
     *
     * @param serverId - Server ID
     * @param stackId - Stack ID to check
     */
    isDeploying(serverId, stackId) {
        const positions = this.queuePositions.get(serverId);
        if (!positions || positions.length === 0) {
            return false;
        }
        // First in queue is the one currently deploying
        return positions[0] === stackId;
    }
}
exports.DeployQueue = DeployQueue;
// Singleton instance
let deployQueueInstance = null;
function getDeployQueue() {
    if (!deployQueueInstance) {
        deployQueueInstance = new DeployQueue();
    }
    return deployQueueInstance;
}
function createDeployQueue() {
    return getDeployQueue();
}
//# sourceMappingURL=DeployQueue.js.map