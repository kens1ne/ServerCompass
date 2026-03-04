"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGitHubActionsDockerHandlers = registerGitHubActionsDockerHandlers;
const electron_1 = require("electron");
const zod_1 = require("zod");
const GitHubActionsDockerService_1 = require("../services/GitHubActionsDockerService");
const SSHService_1 = require("../services/SSHService");
const db_1 = require("../db");
const GitHubApiService_1 = require("../services/GitHubApiService");
const ExternalBuildDeploymentService_1 = require("../services/build/ExternalBuildDeploymentService");
function encodeNextPublicEnvBase64(envFileContent) {
    const lines = envFileContent.split(/\r?\n/);
    const nextPublicLines = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0)
            continue;
        const key = line.slice(0, separatorIndex).trim();
        if (!key.startsWith('NEXT_PUBLIC_'))
            continue;
        nextPublicLines.push(`${key}=${line.slice(separatorIndex + 1)}`);
    }
    const fileContent = nextPublicLines.length === 0
        ? '# ServerCompass: no NEXT_PUBLIC_* vars provided\n'
        : `${nextPublicLines.join('\n')}\n`;
    return Buffer.from(fileContent, 'utf8').toString('base64');
}
// Zod schemas for validation
const setupDockerDeploymentSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string(),
    repoOwner: zod_1.z.string(),
    repoName: zod_1.z.string(),
    branch: zod_1.z.string(),
    appPath: zod_1.z.string(),
    port: zod_1.z.number().int().min(1).max(65535),
    imageTag: zod_1.z.string().optional(),
    includeTraefikPublicNetwork: zod_1.z.boolean().optional(),
    framework: zod_1.z.string(),
    packageManager: zod_1.z.string().optional(),
    gitAccountId: zod_1.z.string(),
    workflowContent: zod_1.z.string().optional(),
    envFileContent: zod_1.z.string().optional(),
    dockerfileContent: zod_1.z.string().optional(),
    useDockerfileOverride: zod_1.z.boolean().optional(),
    retryDeployOnly: zod_1.z.boolean().optional(),
    deployOnly: zod_1.z.boolean().optional(),
});
const previewWorkflowSchema = zod_1.z.object({
    projectName: zod_1.z.string(),
    branch: zod_1.z.string(),
    appPath: zod_1.z.string(),
    port: zod_1.z.number().int().min(1).max(65535),
    imageTag: zod_1.z.string().optional(),
    framework: zod_1.z.string().optional(),
    dockerfilePath: zod_1.z.string().optional(),
    dockerfileContent: zod_1.z.string().optional(),
});
const waitForDeploymentSchema = zod_1.z.object({
    repoOwner: zod_1.z.string(),
    repoName: zod_1.z.string(),
    timeoutMs: zod_1.z.number().int().positive().optional(),
});
const getJobStatusSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string(),
    gitRepository: zod_1.z.string().optional(),
    runId: zod_1.z.number().int().positive().optional(),
    workflowPath: zod_1.z.string().optional(),
    branch: zod_1.z.string().optional(),
    expectedHeadSha: zod_1.z.string().optional(),
    expectedEvent: zod_1.z.enum(['push', 'workflow_dispatch']).optional(),
    triggeredAfter: zod_1.z.string().optional(),
});
const getJobLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string(),
    jobName: zod_1.z.string().optional(),
    gitRepository: zod_1.z.string().optional(),
    runId: zod_1.z.number().int().positive().optional(),
    workflowPath: zod_1.z.string().optional(),
    branch: zod_1.z.string().optional(),
    expectedHeadSha: zod_1.z.string().optional(),
    expectedEvent: zod_1.z.enum(['push', 'workflow_dispatch']).optional(),
    triggeredAfter: zod_1.z.string().optional(),
});
const pushEnvSecretSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    repoOwner: zod_1.z.string(),
    repoName: zod_1.z.string(),
    projectName: zod_1.z.string(),
    envFileContent: zod_1.z.string(),
});
const pushNextPublicSecretSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    repoOwner: zod_1.z.string(),
    repoName: zod_1.z.string(),
    projectName: zod_1.z.string(),
    envFileContent: zod_1.z.string(),
});
const saveDeploymentLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string(),
    logs: zod_1.z.string(),
    phase: zod_1.z.enum(['deployed', 'failed']),
    failureMessage: zod_1.z.string().optional(),
});
// Service instances (singletons – reused across handler calls to avoid re-fetching tokens)
let sshService;
let githubActionsDockerService;
let gitHubApiService;
const externalBuildDeploymentService = new ExternalBuildDeploymentService_1.ExternalBuildDeploymentService();
function registerGitHubActionsDockerHandlers() {
    // Initialize services (singletons reused across all handler invocations)
    sshService = new SSHService_1.SSHService();
    githubActionsDockerService = (0, GitHubActionsDockerService_1.createGitHubActionsDockerService)(sshService);
    gitHubApiService = new GitHubApiService_1.GitHubApiService();
    // Preview GitHub Actions workflow content (without committing)
    electron_1.ipcMain.handle('github-actions-docker:preview-workflow', async (_event, params) => {
        try {
            const validated = previewWorkflowSchema.parse(params);
            const preview = githubActionsDockerService.previewWorkflowFile(validated);
            return { success: true, data: preview };
        }
        catch (error) {
            console.error('Error generating GitHub Actions workflow preview:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    // Setup Docker deployment with GitHub Actions
    electron_1.ipcMain.handle('github-actions-docker:setup', async (_event, params) => {
        try {
            const validated = setupDockerDeploymentSchema.parse(params);
            const result = await githubActionsDockerService.setupDockerDeployment(validated);
            if (!result.success || !result.data) {
                return { success: false, error: result.error };
            }
            return { success: true, data: result.data };
        }
        catch (error) {
            console.error('Error setting up GitHub Actions Docker deployment:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    // Wait for deployment to complete
    electron_1.ipcMain.handle('github-actions-docker:wait', async (_event, params) => {
        try {
            const validated = waitForDeploymentSchema.parse(params);
            const result = await githubActionsDockerService.waitForDeployment(validated.repoOwner, validated.repoName, validated.timeoutMs);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error waiting for deployment:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    // Get job status for a deployment
    electron_1.ipcMain.handle('github-actions-docker:get-job-status', async (_event, params) => {
        const validated = getJobStatusSchema.parse(params);
        const { serverId, projectName, gitRepository } = validated;
        try {
            let repoOwner;
            let repoName;
            // Get deployment record from docker_stacks table (may not exist yet for GitHub Actions flow)
            const stack = db_1.db.prepare(`
          SELECT github_repo, git_account_id FROM docker_stacks
          WHERE server_id = ? AND project_name = ?
        `).get(serverId, projectName);
            const gitUsername = stack?.git_account_id
                ? db_1.db.prepare('SELECT username FROM git_accounts WHERE id = ? LIMIT 1').get(stack.git_account_id)?.username
                : undefined;
            if (stack?.github_repo) {
                [repoOwner, repoName] = stack.github_repo.split('/');
            }
            // Fallback to repo provided by renderer when DB entry is not ready
            if ((!repoOwner || !repoName) && gitRepository) {
                const [owner, name] = gitRepository.split('/');
                if (owner && name) {
                    repoOwner = owner;
                    repoName = name;
                }
            }
            if (!repoOwner || !repoName) {
                return { success: false, error: 'No GitHub repository linked' };
            }
            const apiService = gitHubApiService;
            const workflowPath = validated.workflowPath || `.github/workflows/server-compass-docker-${projectName}.yml`;
            const workflowFileName = workflowPath.split('/').pop() || workflowPath;
            // Query workflow-scoped runs first to avoid mixing with unrelated workflows in the repo.
            let runs = await apiService.getWorkflowRunsForWorkflow(repoOwner, repoName, workflowFileName, {
                per_page: 20,
                branch: validated.branch,
            }, gitUsername);
            // Fallback to repo-wide list if the workflow is brand-new and not indexed yet.
            if (runs.length === 0) {
                runs = await apiService.getWorkflowRuns(repoOwner, repoName, {
                    per_page: 20,
                    branch: validated.branch,
                }, gitUsername);
            }
            const run = selectWorkflowRun(runs, {
                runId: validated.runId,
                expectedHeadSha: validated.expectedHeadSha,
                expectedEvent: validated.expectedEvent,
                triggeredAfter: validated.triggeredAfter,
            });
            if (!run) {
                return { success: false, error: 'Waiting for the workflow run triggered by your latest setup...' };
            }
            // Get jobs for this run
            const jobs = await apiService.getWorkflowJobs(repoOwner, repoName, run.id, gitUsername);
            // Calculate progress with flexible job matching
            const buildJob = jobs.find(j => /build|compile|package|docker/i.test(j.name));
            const deployJob = jobs.find(j => /deploy|ship|release|publish/i.test(j.name));
            const isSingleJobWorkflow = jobs.length === 1;
            const buildCompleted = buildJob?.status === 'completed';
            const buildSucceededOrSkipped = Boolean(buildCompleted && (buildJob?.conclusion === 'success' || buildJob?.conclusion === 'skipped'));
            const buildFailed = Boolean(buildCompleted && buildJob?.conclusion && !['success', 'skipped'].includes(buildJob.conclusion));
            let currentPhase = 'queued';
            let progress = 0;
            // Multi-tier completion detection
            if (buildSucceededOrSkipped) {
                // Build completed or intentionally skipped (deploy-only retry) - check deploy job
                if (deployJob?.status === 'in_progress') {
                    currentPhase = 'deploying';
                    progress = 75;
                }
                else if (deployJob?.status === 'completed') {
                    if (deployJob.conclusion === 'success') {
                        // Deploy succeeded - verify container health
                        currentPhase = 'verifying';
                        progress = 90;
                    }
                    else {
                        // Deploy failed
                        currentPhase = 'failed';
                        progress = 100;
                    }
                }
                else if (!deployJob && isSingleJobWorkflow && jobs[0]?.conclusion === 'success') {
                    // Single job workflow - verify container
                    currentPhase = 'verifying';
                    progress = 90;
                }
                else if (!deployJob && jobs.length <= 2) {
                    // Build succeeded but deploy job missing - possible workflow variation
                    currentPhase = 'verifying';
                    progress = 85;
                }
                else {
                    // Deploy job not found or not started
                    currentPhase = 'deploying';
                    progress = 50;
                }
            }
            else if (buildJob?.status === 'in_progress') {
                currentPhase = 'building';
                progress = 25;
            }
            else if (buildFailed) {
                currentPhase = 'failed';
                progress = 100;
            }
            else if (!buildJob && run.status === 'completed' && run.conclusion === 'success') {
                // Ultimate fallback: workflow-level status
                currentPhase = 'verifying';
                progress = 80;
            }
            // When currentPhase is 'verifying', check container health
            let containerHealth = null;
            const shouldCheckContainer = currentPhase === 'verifying' ||
                run.status === 'in_progress'; // allow success fallback if GitHub data lags but container is already running
            if (shouldCheckContainer) {
                containerHealth = await verifyContainerHealth(serverId, projectName);
                // Final phase determination based on container health
                if (containerHealth.isHealthy) {
                    currentPhase = 'deployed';
                    progress = 100;
                }
                else if (run.status === 'completed') {
                    // Only mark as failed when the workflow finished and container is unhealthy
                    currentPhase = 'failed';
                    progress = 100;
                }
                else {
                    // Keep verifying while the workflow is still running (prevents premature failure during container restart loops)
                    currentPhase = 'verifying';
                    progress = Math.max(progress, 90);
                }
            }
            const failureMessage = currentPhase === 'failed'
                ? containerHealth?.details || `GitHub Actions workflow failed (${run.conclusion || run.status})`
                : null;
            // Extract first line of commit message as title
            const commitTitle = run.head_commit_message
                ? run.head_commit_message.split('\n')[0].trim()
                : null;
            syncGitHubDeploymentRecord({
                serverId,
                projectName,
                currentPhase,
                runUrl: run.html_url,
                failureMessage,
                gitCommitHash: run.head_sha,
                gitCommitTitle: commitTitle,
            });
            // Backfill logs from GitHub Actions if deployment is complete and logs are missing
            // This handles the case where Server Compass was closed during deployment
            if (currentPhase === 'deployed' || currentPhase === 'failed') {
                void backfillDeploymentLogsIfMissing({
                    serverId,
                    projectName,
                    runId: run.id,
                    repoOwner: repoOwner,
                    repoName: repoName,
                    gitUsername,
                    currentPhase,
                    failureMessage,
                });
            }
            return {
                success: true,
                data: {
                    runId: run.id,
                    runNumber: run.run_number,
                    status: run.status,
                    conclusion: run.conclusion,
                    htmlUrl: run.html_url,
                    currentPhase,
                    progress,
                    jobs: jobs.map(j => ({
                        name: j.name,
                        status: j.status,
                        conclusion: j.conclusion,
                        startedAt: j.started_at,
                        completedAt: j.completed_at,
                    })),
                    containerHealth: containerHealth ? {
                        status: containerHealth.containerStatus,
                        details: containerHealth.details,
                        isHealthy: containerHealth.isHealthy
                    } : null,
                },
            };
        }
        catch (error) {
            // Fallback: if GitHub API failed, check container health directly to avoid missing a successful deploy
            try {
                const containerHealth = await verifyContainerHealth(serverId, projectName);
                if (containerHealth.isHealthy) {
                    syncGitHubDeploymentRecord({
                        serverId,
                        projectName,
                        currentPhase: 'deployed',
                        runUrl: null,
                        failureMessage: null,
                    });
                    return {
                        success: true,
                        data: {
                            runId: 0,
                            runNumber: 0,
                            status: 'completed',
                            conclusion: 'success',
                            htmlUrl: '',
                            currentPhase: 'deployed',
                            progress: 100,
                            jobs: [],
                            containerHealth: {
                                status: containerHealth.containerStatus,
                                details: containerHealth.details,
                                isHealthy: containerHealth.isHealthy,
                            },
                        },
                    };
                }
            }
            catch (healthError) {
                console.error('[github-actions-docker:get-job-status] Container health fallback failed:', healthError);
            }
            console.error('[github-actions-docker:get-job-status] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Get job logs for a deployment
    electron_1.ipcMain.handle('github-actions-docker:get-job-logs', async (_event, params) => {
        try {
            const validated = getJobLogsSchema.parse(params);
            const { serverId, projectName, jobName = 'build', gitRepository } = validated;
            let repoOwner;
            let repoName;
            // Get deployment record from docker_stacks table
            const stack = db_1.db.prepare(`
          SELECT github_repo, git_account_id FROM docker_stacks
          WHERE server_id = ? AND project_name = ?
        `).get(serverId, projectName);
            const gitUsername = stack?.git_account_id
                ? db_1.db.prepare('SELECT username FROM git_accounts WHERE id = ? LIMIT 1').get(stack.git_account_id)?.username
                : undefined;
            if (stack?.github_repo) {
                [repoOwner, repoName] = stack.github_repo.split('/');
            }
            if ((!repoOwner || !repoName) && gitRepository) {
                const [owner, name] = gitRepository.split('/');
                if (owner && name) {
                    repoOwner = owner;
                    repoName = name;
                }
            }
            if (!repoOwner || !repoName) {
                return { success: false, error: 'No GitHub repository linked' };
            }
            const apiService = gitHubApiService;
            let runId = validated.runId;
            if (!runId) {
                const workflowPath = validated.workflowPath || `.github/workflows/server-compass-docker-${projectName}.yml`;
                const workflowFileName = workflowPath.split('/').pop() || workflowPath;
                let runs = await apiService.getWorkflowRunsForWorkflow(repoOwner, repoName, workflowFileName, {
                    per_page: 20,
                    branch: validated.branch,
                }, gitUsername);
                if (runs.length === 0) {
                    runs = await apiService.getWorkflowRuns(repoOwner, repoName, {
                        per_page: 20,
                        branch: validated.branch,
                    }, gitUsername);
                }
                const selectedRun = selectWorkflowRun(runs, {
                    expectedHeadSha: validated.expectedHeadSha,
                    expectedEvent: validated.expectedEvent,
                    triggeredAfter: validated.triggeredAfter,
                });
                if (!selectedRun) {
                    return { success: false, error: 'Workflow run not available yet' };
                }
                runId = selectedRun.id;
            }
            if (!runId) {
                return { success: false, error: 'Workflow run not available yet' };
            }
            const run = { id: runId };
            const jobs = await apiService.getWorkflowJobs(repoOwner, repoName, run.id, gitUsername);
            // Find requested job
            const job = jobs.find(j => j.name.toLowerCase().includes(jobName.toLowerCase()));
            if (!job) {
                return { success: false, error: `Job "${jobName}" not found` };
            }
            // Get logs for this job
            const logs = await apiService.getJobLogs(repoOwner, repoName, job.id, gitUsername);
            return {
                success: true,
                data: {
                    jobId: job.id,
                    jobName: job.name,
                    logs,
                    status: job.status,
                    conclusion: job.conclusion,
                },
            };
        }
        catch (error) {
            if (error?.status === 404) {
                console.warn('[github-actions-docker:get-job-logs] Job logs not available yet (404). The run may not have produced logs or they may have expired.');
                return {
                    success: false,
                    error: 'Job logs are not available yet (GitHub returned 404).',
                };
            }
            console.error('[github-actions-docker:get-job-logs] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Save deployment logs (called when GitHub Actions deployment completes)
    electron_1.ipcMain.handle('github-actions-docker:save-deployment-logs', async (_event, params) => {
        try {
            const validated = saveDeploymentLogsSchema.parse(params);
            const { serverId, projectName, logs, phase, failureMessage } = validated;
            syncGitHubDeploymentRecord({
                serverId,
                projectName,
                currentPhase: phase,
                runUrl: null,
                failureMessage: failureMessage || null,
                logs,
            });
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('[github-actions-docker:save-deployment-logs] Error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    });
    // Push .env file content as a GitHub Actions secret
    electron_1.ipcMain.handle('github-actions-docker:push-env-secret', async (_event, params) => {
        try {
            const validated = pushEnvSecretSchema.parse(params);
            const { serverId, repoOwner, repoName, projectName, envFileContent } = validated;
            const appNameUpper = projectName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
            const secretName = `ENV_FILE_${appNameUpper}`;
            const nextPublicSecretName = `ENV_NEXT_PUBLIC_B64_${appNameUpper}`;
            const stack = db_1.db.prepare(`
          SELECT git_account_id FROM docker_stacks
          WHERE server_id = ? AND project_name = ?
        `).get(serverId, projectName);
            const gitUsername = stack?.git_account_id
                ? db_1.db.prepare('SELECT username FROM git_accounts WHERE id = ? LIMIT 1').get(stack.git_account_id)?.username
                : undefined;
            const apiService = gitHubApiService;
            await apiService.createOrUpdateSecret(repoOwner, repoName, secretName, envFileContent, gitUsername);
            await apiService.createOrUpdateSecret(repoOwner, repoName, nextPublicSecretName, encodeNextPublicEnvBase64(envFileContent), gitUsername);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error pushing .env secret to GitHub:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    // Push only NEXT_PUBLIC_* env vars as a base64-encoded GitHub Actions secret.
    // This avoids storing server-only secrets (DATABASE_URL, API keys) in GitHub when users prefer keeping them on the VPS.
    electron_1.ipcMain.handle('github-actions-docker:push-next-public-secret', async (_event, params) => {
        try {
            const validated = pushNextPublicSecretSchema.parse(params);
            const { serverId, repoOwner, repoName, projectName, envFileContent } = validated;
            const appNameUpper = projectName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
            const nextPublicSecretName = `ENV_NEXT_PUBLIC_B64_${appNameUpper}`;
            const stack = db_1.db.prepare(`
          SELECT git_account_id FROM docker_stacks
          WHERE server_id = ? AND project_name = ?
        `).get(serverId, projectName);
            const gitUsername = stack?.git_account_id
                ? db_1.db.prepare('SELECT username FROM git_accounts WHERE id = ? LIMIT 1').get(stack.git_account_id)?.username
                : undefined;
            const apiService = gitHubApiService;
            await apiService.createOrUpdateSecret(repoOwner, repoName, nextPublicSecretName, encodeNextPublicEnvBase64(envFileContent), gitUsername);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('Error pushing NEXT_PUBLIC_* secret to GitHub:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
}
function syncGitHubDeploymentRecord(input) {
    try {
        externalBuildDeploymentService.syncDeploymentStatus({
            serverId: input.serverId,
            projectName: input.projectName,
            phase: input.currentPhase,
            runUrl: input.runUrl,
            failureMessage: input.failureMessage,
            logs: input.logs,
            gitCommitHash: input.gitCommitHash,
            gitCommitTitle: input.gitCommitTitle,
        });
    }
    catch (error) {
        console.warn('[github-actions-docker:get-job-status] Failed to sync deployment record:', error);
    }
}
/**
 * Backfill deployment logs from GitHub Actions API when:
 * - Deployment is complete (deployed/failed)
 * - No logs exist in the database (e.g., Server Compass was closed during deployment)
 */
async function backfillDeploymentLogsIfMissing(input) {
    try {
        // Check if deployment already has logs
        const stack = db_1.db.prepare(`
      SELECT id FROM docker_stacks
      WHERE server_id = ? AND project_name = ?
      LIMIT 1
    `).get(input.serverId, input.projectName);
        if (!stack)
            return;
        const deployment = db_1.db.prepare(`
      SELECT id, logs FROM docker_stack_deployments
      WHERE stack_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(stack.id);
        if (!deployment)
            return;
        // Already has logs - no need to backfill
        if (deployment.logs && deployment.logs.trim().length > 0) {
            return;
        }
        console.log('[github-actions-docker] Backfilling missing deployment logs from GitHub Actions...');
        // Fetch logs from GitHub Actions API
        const apiService = gitHubApiService;
        const jobs = await apiService.getWorkflowJobs(input.repoOwner, input.repoName, input.runId, input.gitUsername);
        // Collect logs from all jobs (build and deploy)
        const allLogs = [];
        for (const job of jobs) {
            try {
                const jobLogs = await apiService.getJobLogs(input.repoOwner, input.repoName, job.id, input.gitUsername);
                if (jobLogs) {
                    allLogs.push(`=== ${job.name} (${job.conclusion || job.status}) ===\n${jobLogs}`);
                }
            }
            catch (err) {
                console.warn(`[github-actions-docker] Could not fetch logs for job ${job.name}:`, err);
            }
        }
        if (allLogs.length === 0) {
            console.warn('[github-actions-docker] No logs available from GitHub Actions');
            return;
        }
        const combinedLogs = allLogs.join('\n\n');
        // Save logs to database
        syncGitHubDeploymentRecord({
            serverId: input.serverId,
            projectName: input.projectName,
            currentPhase: input.currentPhase,
            runUrl: null,
            failureMessage: input.failureMessage || null,
            logs: combinedLogs,
        });
        console.log('[github-actions-docker] Successfully backfilled deployment logs');
    }
    catch (error) {
        console.warn('[github-actions-docker] Failed to backfill deployment logs:', error);
    }
}
function selectWorkflowRun(runs, filters) {
    const { runId, expectedHeadSha, expectedEvent, triggeredAfter } = filters;
    const sortedRuns = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (runId) {
        return sortedRuns.find((run) => run.id === runId) || null;
    }
    let candidates = sortedRuns.filter((run) => run.conclusion !== 'skipped' && run.conclusion !== 'cancelled');
    const triggeredAfterMs = triggeredAfter ? new Date(triggeredAfter).getTime() : Number.NaN;
    if (triggeredAfter) {
        // Prefer strict correlation to avoid locking onto the previous run while GitHub indexes the new one.
        // We intentionally do not backtrack immediately; a short wait is safer than selecting stale run data.
        if (Number.isFinite(triggeredAfterMs)) {
            const strictCandidates = candidates.filter((run) => new Date(run.created_at).getTime() >= triggeredAfterMs);
            if (strictCandidates.length > 0) {
                candidates = strictCandidates;
            }
            else {
                const withinWarmupWindow = Date.now() - triggeredAfterMs < 60_000;
                if (withinWarmupWindow) {
                    return null;
                }
            }
        }
    }
    if (expectedEvent) {
        candidates = candidates.filter((run) => run.event === expectedEvent);
    }
    if (expectedHeadSha) {
        candidates = candidates.filter((run) => run.head_sha === expectedHeadSha);
    }
    return candidates[0] || null;
}
/**
 * Verify container health on VPS by checking docker ps status
 */
async function verifyContainerHealth(serverId, projectName) {
    try {
        // Get server connection details
        const server = db_1.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
        if (!server) {
            throw new Error('Server not found');
        }
        const command = `docker ps -a --filter "label=com.docker.compose.project=${projectName}" --format "{{.Names}}|{{.State}}|{{.Status}}"`;
        const result = await sshService.executeCommand(serverId, command);
        if (result.exitCode !== 0 || !result.stdout.trim()) {
            return {
                isHealthy: false,
                containerStatus: 'not_found',
                details: 'Container not found on VPS'
            };
        }
        const containers = result.stdout
            .trim()
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
            const [name = '', state = '', status = ''] = line.split('|');
            return { name, state, status };
        });
        if (containers.length === 0) {
            return {
                isHealthy: false,
                containerStatus: 'not_found',
                details: 'Container not found on VPS'
            };
        }
        const restarting = containers.find((container) => container.state === 'restarting' ||
            container.status.toLowerCase().includes('restarting'));
        if (restarting) {
            return {
                isHealthy: false,
                containerStatus: 'restarting',
                details: `Container is in restart loop: ${restarting.name} (${restarting.status})`
            };
        }
        const exited = containers.find((container) => container.state === 'exited' || container.state === 'dead');
        if (exited) {
            return {
                isHealthy: false,
                containerStatus: 'exited',
                details: `Container exited: ${exited.name} (${exited.status})`
            };
        }
        if (containers.every((container) => container.state === 'running')) {
            return {
                isHealthy: true,
                containerStatus: 'running',
                details: `${containers.length} container(s) running`
            };
        }
        const firstContainer = containers[0];
        return {
            isHealthy: false,
            containerStatus: 'exited',
            details: `Container state is not healthy: ${firstContainer.name} (${firstContainer.status})`
        };
    }
    catch (error) {
        console.error('[verifyContainerHealth] Error:', error);
        return {
            isHealthy: false,
            containerStatus: 'not_found',
            details: error instanceof Error ? error.message : 'Verification failed'
        };
    }
}
//# sourceMappingURL=github-actions-docker.js.map