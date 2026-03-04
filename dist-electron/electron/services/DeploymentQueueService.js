"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deploymentQueueService = void 0;
/**
 * DeploymentQueueService
 *
 * Ensures only one deployment per app runs at a time to prevent conflicts.
 * Queues deployment requests and processes them sequentially per app.
 */
class DeploymentQueueService {
    queues = new Map();
    running = new Set();
    /**
     * Ensures only one deployment per app runs at a time
     */
    async enqueueDeployment(serverId, appName, fn) {
        const key = `${serverId}:${appName}`;
        // Initialize queue if doesn't exist
        if (!this.queues.has(key)) {
            this.queues.set(key, []);
        }
        return new Promise((resolve, reject) => {
            const task = async () => {
                let taskCompleted = false;
                try {
                    console.log(`[DeploymentQueue] Starting deployment for ${key}`);
                    await fn();
                    taskCompleted = true;
                    console.log(`[DeploymentQueue] Deployment completed for ${key}`);
                    resolve();
                }
                catch (error) {
                    taskCompleted = true;
                    console.error(`[DeploymentQueue] Deployment failed for ${key}:`, error);
                    reject(error);
                }
                finally {
                    // CRITICAL: Always cleanup, even if task didn't complete properly
                    if (!taskCompleted) {
                        console.warn(`[DeploymentQueue] Task for ${key} ended without completion flag`);
                    }
                    // Remove from running set
                    this.running.delete(key);
                    // Process next task in queue
                    setImmediate(() => this.processNext(key));
                }
            };
            this.queues.get(key).push(task);
            // If not already running, start processing
            if (!this.running.has(key)) {
                this.processNext(key);
            }
        });
    }
    processNext(key) {
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) {
            console.log(`[DeploymentQueue] Queue empty for ${key}`);
            return;
        }
        const nextTask = queue.shift();
        if (nextTask) {
            this.running.add(key);
            console.log(`[DeploymentQueue] Processing next task for ${key}. Queue length: ${queue.length}`);
            // Execute task with a safety timeout wrapper
            const safetyTimeout = setTimeout(() => {
                console.error(`[DeploymentQueue] CRITICAL: Task for ${key} exceeded safety timeout (15 minutes). Forcing cleanup.`);
                this.running.delete(key);
                this.processNext(key);
            }, 900000); // 15 minutes safety timeout
            // Execute the task
            nextTask().finally(() => {
                clearTimeout(safetyTimeout);
            });
        }
    }
    /**
     * Get queue position for an app (0 = currently running)
     */
    getQueuePosition(serverId, appName) {
        const key = `${serverId}:${appName}`;
        const queue = this.queues.get(key);
        if (!queue)
            return -1;
        return queue.length;
    }
    /**
     * Check if a deployment is currently running for an app
     */
    isRunning(serverId, appName) {
        const key = `${serverId}:${appName}`;
        return this.running.has(key);
    }
}
exports.deploymentQueueService = new DeploymentQueueService();
//# sourceMappingURL=DeploymentQueueService.js.map