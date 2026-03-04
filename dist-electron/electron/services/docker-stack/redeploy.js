"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redeployStack = redeployStack;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const GitAccountService_1 = require("../GitAccountService");
const buildUtils_1 = require("./buildUtils");
const deploymentDb_1 = require("./deploymentDb");
const nextjsConfig_1 = require("./nextjsConfig");
const supabase_1 = require("./supabase");
const containers_1 = require("./containers");
const composeUtils_1 = require("./composeUtils");
const pathUtils_1 = require("./pathUtils");
const docker_templates_1 = require("../../docker-templates");
function resolveTemplateEnvValue(template, key, envVars) {
    const envValue = envVars?.[key];
    if (envValue !== undefined && envValue !== null && String(envValue).trim().length > 0) {
        return String(envValue).trim();
    }
    const envHintDefault = template.envHints.find((hint) => hint.key === key)?.default;
    if (envHintDefault && envHintDefault.trim().length > 0) {
        return envHintDefault.trim();
    }
    const templateVariableDefault = template.variables.find((variable) => variable.name === key)?.default;
    if (templateVariableDefault && templateVariableDefault.trim().length > 0) {
        return templateVariableDefault.trim();
    }
    return '';
}
function getMissingRequiredTemplateEnvKeys(template, envVars) {
    return template.envHints
        .filter((hint) => hint.required)
        .map((hint) => hint.key)
        .filter((key) => resolveTemplateEnvValue(template, key, envVars) === '');
}
function extractHostPortForContainer(composeContent, containerPort) {
    const shortSyntaxMatch = composeContent.match(new RegExp(`^\\s*-\\s*["']?(\\d+):${containerPort}["']?\\s*$`, 'm'));
    if (shortSyntaxMatch?.[1]) {
        return shortSyntaxMatch[1];
    }
    const publishedMatch = composeContent.match(/^\s*published:\s*["']?(\d+)["']?\s*$/m);
    if (publishedMatch?.[1]) {
        return publishedMatch[1];
    }
    return null;
}
/**
 * Redeploy an existing stack (pull latest images and restart)
 */
async function redeployStack(ctx, serverId, stackId, options = {}) {
    const { pullImages: pullImagesOption, force = false, pullLatestCode = false, updateEnvOnly = false, buildLocation: newBuildLocation, } = options;
    const stack = db_1.queries.getDockerStack(stackId);
    if (!stack) {
        return { success: false, error: 'Stack not found' };
    }
    if (stack.server_id !== serverId) {
        return { success: false, error: 'Stack does not belong to this server' };
    }
    if (stack.status === 'deploying') {
        return { success: false, error: 'Stack is already being deployed. Please wait for the current deployment to complete.' };
    }
    // Use the new build location if provided, otherwise use the stack's existing build_location
    const effectiveBuildLocation = newBuildLocation || stack.build_location || 'vps';
    // Update stack's build_location if a new one was provided
    if (newBuildLocation && newBuildLocation !== stack.build_location) {
        db_1.queries.updateDockerStack(stackId, { build_location: newBuildLocation });
    }
    // Determine whether to pull images based on build_location:
    // - 'local-build': Skip pull (image only exists on VPS, not in any registry)
    // - 'vps' / 'github-actions': Can pull from registry (default behavior)
    const isLocalBuild = effectiveBuildLocation === 'local-build';
    const pullImages = pullImagesOption !== undefined
        ? pullImagesOption && !isLocalBuild // Respect explicit option, but always skip for local builds
        : !isLocalBuild; // Default: pull unless local build
    const deploymentId = `deploy-${(0, crypto_1.randomUUID)()}`;
    const { workingDir } = (0, pathUtils_1.resolveStackWorkingDir)(stack);
    const redeployMode = updateEnvOnly
        ? 'Restarting with updated environment'
        : pullLatestCode
            ? 'Pulling latest code and rebuilding'
            : 'Redeploying';
    const now = Date.now();
    (0, deploymentDb_1.createDeploymentRecord)(deploymentId, stackId, 'redeploy', now, undefined, effectiveBuildLocation);
    (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pending');
    ctx.initDeploymentLogs(deploymentId);
    const log = (message, type = 'info') => {
        ctx.emitLog(message, type, stackId, deploymentId);
    };
    log(`${redeployMode}: ${stack.project_name}`);
    // Ensure runtime `.env` is actually injected into containers during `docker compose up`.
    // Docker Compose loads `.env` for interpolation automatically, but containers only receive it via `env_file`.
    await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && (test -f .env || touch .env)`);
    await ctx.ensureEnvFileDirective(serverId, workingDir, stackId);
    const prevComposeStmt = db_1.db.prepare(`
      UPDATE docker_stack_deployments SET previous_compose_content = ? WHERE id = ?
    `);
    prevComposeStmt.run(stack.compose_content, deploymentId);
    try {
        db_1.queries.updateDockerStack(stackId, { status: 'deploying' });
        if (stack.env_vars) {
            try {
                const envVars = JSON.parse(stack.env_vars);
                if (stack.template_id) {
                    const template = (0, docker_templates_1.getTemplateById)(stack.template_id);
                    if (template) {
                        const missingRequiredEnvKeys = getMissingRequiredTemplateEnvKeys(template, envVars);
                        if (missingRequiredEnvKeys.length > 0) {
                            throw new Error(`Missing required environment variables for template "${template.name}": ${missingRequiredEnvKeys.join(', ')}`);
                        }
                    }
                }
                if (stack.template_id === 'builtin-neon-local') {
                    const template = (0, docker_templates_1.getTemplateById)(stack.template_id);
                    if (template) {
                        const variables = {};
                        for (const variable of template.variables || []) {
                            variables[variable.name] = variable.default ?? '';
                        }
                        const currentHostPort = extractHostPortForContainer(stack.compose_content || '', 5432);
                        if (currentHostPort) {
                            variables.PORT = currentHostPort;
                        }
                        for (const [key, value] of Object.entries(envVars)) {
                            variables[key] = String(value);
                        }
                        const rendered = (0, docker_templates_1.renderTemplate)(stack.template_id, variables);
                        if (rendered.compose && rendered.compose.trim().length > 0 && rendered.compose !== stack.compose_content) {
                            ctx.emitLog('Refreshing Neon Local compose with current template + env vars...', 'info', stackId);
                            await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, rendered.compose);
                            db_1.queries.updateDockerStack(stackId, { compose_content: rendered.compose });
                            stack.compose_content = rendered.compose;
                        }
                    }
                }
                if (Object.keys(envVars).length > 0) {
                    if (stack.template_id === 'builtin-supabase-full' && envVars.JWT_SECRET) {
                        let keysRegenerated = false;
                        if (!(0, supabase_1.isValidJWTFormat)(envVars.ANON_KEY)) {
                            ctx.emitLog('⚠️ ANON_KEY is not a valid JWT, regenerating...', 'warning', stackId);
                            envVars.ANON_KEY = (0, supabase_1.generateSupabaseJWT)(envVars.JWT_SECRET, 'anon');
                            keysRegenerated = true;
                        }
                        if (!(0, supabase_1.isValidJWTFormat)(envVars.SERVICE_ROLE_KEY)) {
                            ctx.emitLog('⚠️ SERVICE_ROLE_KEY is not a valid JWT, regenerating...', 'warning', stackId);
                            envVars.SERVICE_ROLE_KEY = (0, supabase_1.generateSupabaseJWT)(envVars.JWT_SECRET, 'service_role');
                            keysRegenerated = true;
                        }
                        if (keysRegenerated) {
                            db_1.queries.updateDockerStack(stackId, { env_vars: JSON.stringify(envVars) });
                            ctx.emitLog('✅ API keys regenerated and saved', 'success', stackId);
                        }
                    }
                    ctx.emitLog(`Syncing ${Object.keys(envVars).length} environment variable(s)...`, 'info', stackId);
                    await ctx.createEnvFile(serverId, workingDir, envVars);
                    await ctx.ensureEnvFileDirective(serverId, workingDir, stackId);
                    ctx.emitLog(`Template ID: ${stack.template_id || 'none'}`, 'info', stackId);
                    if (stack.template_id === 'builtin-supabase-full') {
                        await (0, supabase_1.regenerateSupabaseKongConfig)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: ctx.emitLog,
                            createEnvFile: ctx.createEnvFile,
                        }, serverId, workingDir, envVars, stackId);
                        await (0, supabase_1.fixSupabaseStudioPort)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: ctx.emitLog,
                            createEnvFile: ctx.createEnvFile,
                        }, serverId, workingDir, stackId);
                        await (0, supabase_1.ensureSupabaseGoTrueMigrations)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: ctx.emitLog,
                            createEnvFile: ctx.createEnvFile,
                        }, serverId, workingDir, stackId);
                        await (0, supabase_1.ensureSupabaseGoTrueDbNamespace)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: ctx.emitLog,
                            createEnvFile: ctx.createEnvFile,
                        }, serverId, workingDir, stackId);
                        await (0, supabase_1.ensureSupabaseFullSmtpMapping)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: ctx.emitLog,
                            createEnvFile: ctx.createEnvFile,
                        }, serverId, workingDir, envVars, stackId);
                        await (0, supabase_1.ensureSupabaseFullDbAccess)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: ctx.emitLog,
                            createEnvFile: ctx.createEnvFile,
                        }, serverId, workingDir, stackId);
                    }
                }
            }
            catch (error) {
                if (error instanceof SyntaxError) {
                    // Ignore JSON parse errors from legacy env storage
                }
                else {
                    throw error;
                }
            }
        }
        else if (stack.template_id) {
            const template = (0, docker_templates_1.getTemplateById)(stack.template_id);
            if (template) {
                const missingRequiredEnvKeys = getMissingRequiredTemplateEnvKeys(template, {});
                if (missingRequiredEnvKeys.length > 0) {
                    throw new Error(`Missing required environment variables for template "${template.name}": ${missingRequiredEnvKeys.join(', ')}`);
                }
            }
        }
        if (!stack.git_clone_path && stack.source_type === 'github') {
            const inferredClonePath = `${workingDir}/repo`;
            const inferredCloneCheck = await ctx.sshService.executeCommand(serverId, `test -d "${inferredClonePath}/.git" && echo "yes" || echo "no"`);
            if (inferredCloneCheck.exitCode === 0 && inferredCloneCheck.stdout.trim() === 'yes') {
                stack.git_clone_path = inferredClonePath;
                db_1.queries.updateDockerStack(stackId, { git_clone_path: inferredClonePath });
                log(`Recovered missing git clone path: ${inferredClonePath}`);
            }
        }
        const shouldPullCode = !updateEnvOnly && (pullLatestCode ||
            (stack.source_type === 'github' &&
                stack.git_account_id &&
                stack.github_repo &&
                stack.git_clone_path &&
                stack.git_pull_on_redeploy));
        const canPullFromGit = stack.source_type === 'github' &&
            stack.git_account_id &&
            stack.github_repo &&
            stack.git_clone_path;
        if (shouldPullCode && !canPullFromGit) {
            const missingFields = [];
            if (stack.source_type !== 'github')
                missingFields.push(`source_type='${stack.source_type}' (expected 'github')`);
            if (!stack.git_account_id)
                missingFields.push('git_account_id');
            if (!stack.github_repo)
                missingFields.push('github_repo');
            if (!stack.git_clone_path)
                missingFields.push('git_clone_path');
            ctx.emitLog(`⚠️ Git pull skipped - missing: ${missingFields.join(', ')}`, 'warning', stackId);
            ctx.emitLog(`To enable git pull, delete and re-deploy this app from GitHub`, 'info', stackId);
        }
        if (shouldPullCode && canPullFromGit) {
            const gitBranch = stack.git_branch || 'main';
            ctx.emitLog(`Pulling latest code from ${stack.github_repo} (${gitBranch})...`, 'info', stackId);
            await GitAccountService_1.gitAccountService.cloneWithAccount(serverId, stack.git_account_id, stack.github_repo, stack.git_clone_path, gitBranch);
            const commitResult = await ctx.sshService.executeCommand(serverId, `cd "${stack.git_clone_path}" && git rev-parse HEAD`);
            let newCommit = null;
            let commitTitle = null;
            if (commitResult.exitCode === 0) {
                newCommit = commitResult.stdout.trim();
                const titleResult = await ctx.sshService.executeCommand(serverId, `cd "${stack.git_clone_path}" && git log -1 --format=%s`);
                if (titleResult.exitCode === 0) {
                    commitTitle = titleResult.stdout.trim();
                    ctx.emitLog(`Updated to commit: ${commitTitle} (${newCommit.substring(0, 8)})`, 'info', stackId);
                }
                else {
                    ctx.emitLog(`Updated to commit: ${newCommit.substring(0, 8)}`, 'info', stackId);
                }
                db_1.db.prepare(`
            UPDATE docker_stack_deployments SET git_commit_hash = ?, git_commit_title = ? WHERE id = ?
          `).run(newCommit, commitTitle, deploymentId);
            }
            const composeResult = await ctx.sshService.executeCommand(serverId, `cat "${stack.git_clone_path}/docker-compose.yml" 2>/dev/null || cat "${stack.git_clone_path}/docker-compose.yaml" 2>/dev/null || cat "${stack.git_clone_path}/compose.yml" 2>/dev/null || cat "${stack.git_clone_path}/compose.yaml" 2>/dev/null`);
            if (composeResult.exitCode === 0 && composeResult.stdout.trim()) {
                let newComposeContent = composeResult.stdout;
                const rewriteResult = (0, composeUtils_1.rewriteComposeBuildContextsForGitHub)(newComposeContent);
                if (rewriteResult.rewrites > 0) {
                    newComposeContent = rewriteResult.content;
                    ctx.emitLog(`Adjusted ${rewriteResult.rewrites} Docker build context path(s) for GitHub repo layout (./repo)`, 'info', stackId);
                }
                // Preserve Dockerfile override across redeploys if the current stack compose uses it.
                const DOCKERFILE_OVERRIDE_PATH = 'Dockerfile.servercompass';
                if (stack.compose_content?.includes(DOCKERFILE_OVERRIDE_PATH)) {
                    const dockerfileRewrite = (0, composeUtils_1.rewriteComposeDockerfileForOverride)(newComposeContent, DOCKERFILE_OVERRIDE_PATH);
                    if (dockerfileRewrite.rewrites > 0) {
                        newComposeContent = dockerfileRewrite.content;
                        ctx.emitLog(`Updated ${dockerfileRewrite.rewrites} dockerfile reference(s) to "${DOCKERFILE_OVERRIDE_PATH}"`, 'info', stackId);
                    }
                    ctx.emitLog(`📦 Keeping Dockerfile override: ${DOCKERFILE_OVERRIDE_PATH}`, 'info', stackId);
                }
                await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, newComposeContent);
                db_1.queries.updateDockerStack(stackId, {
                    compose_content: newComposeContent,
                    ...(newCommit && { git_last_commit: newCommit }),
                });
            }
            const isNextjs = await ctx.sshService.executeCommand(serverId, `test -f "${stack.git_clone_path}/package.json" && grep -q '"next"' "${stack.git_clone_path}/package.json" && echo "yes" || echo "no"`);
            if (isNextjs.stdout.trim() === 'yes') {
                await (0, nextjsConfig_1.ensureNextjsStandaloneMode)({
                    sshService: ctx.sshService,
                    uploadFile: ctx.uploadFile,
                    emitLog: (message, type) => ctx.emitLog(message, type, stackId),
                    serverId,
                    repoPath: stack.git_clone_path,
                    stackId,
                });
            }
            const hasBuildContext = await ctx.sshService.executeCommand(serverId, `grep -E "^\\s*build:" "${workingDir}/docker-compose.yml"`);
            if (hasBuildContext.exitCode === 0) {
                ctx.emitLog('Rebuilding images with updated code...', 'info', stackId);
                (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'building');
                if (stack.git_clone_path && stack.env_vars) {
                    try {
                        const envVars = JSON.parse(stack.env_vars);
                        if (Object.keys(envVars).length > 0) {
                            ctx.emitLog('Copying environment variables to build context...', 'info', stackId);
                            await ctx.sshService.executeCommand(serverId, `cp "${workingDir}/.env" "${stack.git_clone_path}/.env" 2>/dev/null || true`);
                        }
                    }
                    catch {
                        // Ignore parse errors
                    }
                }
                const buildCmd = `cd ${workingDir} && docker compose build --no-cache 2>&1`;
                const legacyBuildCmd = `cd ${workingDir} && COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose build --no-cache 2>&1`;
                const runBuildAttempt = async (logTag) => {
                    const prefix = logTag ? `[${logTag}] ` : '';
                    let output = '';
                    let exitCode = 0;
                    try {
                        const buildResult = await (0, buildUtils_1.streamCommandWithTimeout)({
                            sshService: ctx.sshService,
                            serverId,
                            command: buildCmd,
                            timeoutMs: 20 * 60 * 1000,
                            timeoutErrorMessage: 'Build timed out after 20 minutes',
                            onTimeout: () => ctx.emitLog(`❌ ${prefix}Build timed out after 20 minutes`, 'error', stackId),
                            onLine: (line) => ctx.emitLog(`📦 ${prefix}${line}`, 'info', stackId),
                        });
                        output = buildResult.output;
                        exitCode = buildResult.exitCode;
                        const durationSec = Math.floor(buildResult.durationMs / 1000);
                        ctx.emitLog(`Build completed in ${durationSec}s (exit code: ${exitCode})`, exitCode === 0 ? 'info' : 'error', stackId);
                    }
                    catch (buildError) {
                        const errorWithOutput = buildError;
                        const errorMessage = buildError instanceof Error ? buildError.message : String(buildError);
                        if (!errorMessage.toLowerCase().includes('timed out')) {
                            ctx.emitLog(`Build command failed: ${errorMessage}`, 'error', stackId);
                        }
                        if (errorWithOutput.output) {
                            output = errorWithOutput.output;
                        }
                        (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'build_output', output);
                        throw buildError;
                    }
                    if (exitCode !== 0 && (0, buildUtils_1.isBuildkitTransportEofFailure)(output)) {
                        ctx.emitLog('⚠️ Docker BuildKit transport error detected (EOF). Retrying once with legacy builder...', 'warning', stackId);
                        try {
                            const legacyBuildResult = await (0, buildUtils_1.streamCommandWithTimeout)({
                                sshService: ctx.sshService,
                                serverId,
                                command: legacyBuildCmd,
                                timeoutMs: 20 * 60 * 1000,
                                timeoutErrorMessage: 'Legacy builder retry timed out after 20 minutes',
                                onTimeout: () => ctx.emitLog(`❌ ${prefix}Legacy builder retry timed out after 20 minutes`, 'error', stackId),
                                onLine: (line) => ctx.emitLog(`📦 ${prefix}[retry] ${line}`, 'info', stackId),
                            });
                            output = `${output}\n\n[ServerCompass Retry - Legacy Builder]\n${legacyBuildResult.output}`;
                            exitCode = legacyBuildResult.exitCode;
                            const retryDurationSec = Math.floor(legacyBuildResult.durationMs / 1000);
                            ctx.emitLog(`Legacy builder retry completed in ${retryDurationSec}s (exit code: ${exitCode})`, exitCode === 0 ? 'success' : 'error', stackId);
                        }
                        catch (retryError) {
                            const retryErrorWithOutput = retryError;
                            if (retryErrorWithOutput.output) {
                                output = `${output}\n\n[ServerCompass Retry - Legacy Builder]\n${retryErrorWithOutput.output}`;
                            }
                            throw retryError;
                        }
                    }
                    return { output, exitCode };
                };
                const firstAttempt = await runBuildAttempt();
                let buildOutput = firstAttempt.output;
                let buildExitCode = firstAttempt.exitCode;
                if (buildExitCode !== 0 && (0, buildUtils_1.isDockerDnsResolutionFailure)(buildOutput)) {
                    ctx.emitLog('⚠️ DNS resolution failed inside Docker build. Retrying once with `build.network: host` (build-time only)...', 'warning', stackId);
                    ctx.emitLog('If this keeps failing, Docker containers on your VPS likely cannot access DNS (often UFW/iptables). Try Local Build or fix VPS Docker networking.', 'warning', stackId);
                    const currentComposeResult = await ctx.sshService.executeCommand(serverId, `cat "${workingDir}/docker-compose.yml" 2>/dev/null || true`);
                    const currentCompose = currentComposeResult.stdout || '';
                    const injected = (0, composeUtils_1.injectBuildNetworkHost)(currentCompose);
                    if (injected.rewrites > 0) {
                        await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, injected.content);
                        db_1.queries.updateDockerStack(stackId, { compose_content: injected.content });
                        ctx.emitLog(`Updated ${injected.rewrites} service(s) to build with host network`, 'info', stackId);
                    }
                    else {
                        ctx.emitLog('No build.network changes applied (compose parsing failed or already configured)', 'warning', stackId);
                    }
                    const retryAttempt = await runBuildAttempt('dns-retry');
                    buildOutput = `${buildOutput}\n\n[ServerCompass Retry - Host Build Network]\n${retryAttempt.output}`;
                    buildExitCode = retryAttempt.exitCode;
                }
                (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'build_output', buildOutput);
                if (buildExitCode !== 0) {
                    const errorLines = buildOutput.split('\n');
                    const errorDetails = errorLines
                        .filter(line => line.includes('ERROR') ||
                        line.includes('Error:') ||
                        line.includes('error:') ||
                        line.includes('failed') ||
                        line.includes('FAILED') ||
                        line.includes('Dockerfile:') ||
                        line.includes('npm error') ||
                        line.includes('permission denied'))
                        .slice(-30)
                        .join('\n');
                    const detailedError = errorDetails.trim()
                        ? errorDetails
                        : errorLines.slice(-40).join('\n');
                    ctx.emitLog('❌ Build failed. Error details:', 'error', stackId);
                    ctx.emitLog(detailedError, 'error', stackId);
                    if (buildOutput.includes('.next/standalone') && buildOutput.includes('not found')) {
                        ctx.emitLog('', 'error', stackId);
                        ctx.emitLog('💡 Next.js Standalone Mode Issue:', 'warning', stackId);
                        ctx.emitLog('ServerCompass attempted to auto-configure standalone mode but the build still failed.', 'warning', stackId);
                        ctx.emitLog('Please verify your next.config file has: output: "standalone"', 'warning', stackId);
                        ctx.emitLog('If you have a complex config with conditional logic, you may need to manually ensure standalone mode is enabled.', 'warning', stackId);
                    }
                    const dnsHint = (0, buildUtils_1.isDockerDnsResolutionFailure)(buildOutput)
                        ? '\n\nHint: DNS resolution failed inside the Docker build container. This usually means Docker networking on the VPS is blocked (often UFW/iptables). Try switching Build Location to Local Build or fixing Docker DNS/firewall on the server.'
                        : '';
                    throw new Error(`Docker build failed:\n\n${detailedError}${dnsHint}`);
                }
                ctx.emitLog('✅ Build completed successfully', 'success', stackId);
            }
        }
        else if (updateEnvOnly) {
            ctx.emitLog('Skipping code pull and rebuild (update env only mode)', 'info', stackId);
        }
        if (stack.registry_credential_id) {
            ctx.emitLog('Authenticating with container registry...', 'info', stackId);
            await ctx.registryService.loginToRegistry(serverId, stack.registry_credential_id);
        }
        if (pullImages && !updateEnvOnly) {
            ctx.emitLog('Pulling latest images...', 'info', stackId);
            (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pulling');
            const pullCmd = `cd ${workingDir} && docker compose pull`;
            const pullResult = await ctx.sshService.executeCommand(serverId, pullCmd);
            const fullPullOutput = pullResult.stdout + pullResult.stderr;
            (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'pull_output', fullPullOutput);
            if (pullResult.exitCode !== 0) {
                const errorLines = fullPullOutput.split('\n').slice(-20).join('\n');
                throw new Error(`Failed to pull Docker images:\n\n${errorLines}`);
            }
        }
        else if (isLocalBuild && !updateEnvOnly) {
            ctx.emitLog('Skipping image pull (Local Build: image already on server)', 'info', stackId);
        }
        if (updateEnvOnly) {
            log('Applying environment changes (preserving volumes)...', 'info');
        }
        else {
            log('Stopping existing containers (preserving volumes)...', 'info');
            const cleanupResult = await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && docker compose down --remove-orphans 2>&1 || true`);
            if (cleanupResult.stdout || cleanupResult.stderr) {
                const output = (cleanupResult.stdout + cleanupResult.stderr).trim();
                if (output && !output.includes('no configuration file') && !output.includes('no such file')) {
                    log(`Cleanup output: ${output}`, 'info');
                }
            }
            // Wait for ports to be fully released after container removal.
            // Docker proxy / kernel may hold the port briefly after `docker compose down`.
            // Verify no docker-proxy is still holding ports for this project.
            const proxyCheck = await ctx.sshService.executeCommand(serverId, `docker ps -a --filter "label=com.docker.compose.project=${stack.project_name}" -q 2>/dev/null || true`);
            const lingering = (proxyCheck.stdout || '').trim();
            if (lingering) {
                log('Removing lingering containers...', 'info');
                await ctx.sshService.executeCommand(serverId, `docker rm -f ${lingering.split('\n').join(' ')} 2>/dev/null || true`);
            }
            // Grace period for port release
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        const containerAction = updateEnvOnly ? 'Recreating containers with new environment...' : 'Starting containers...';
        ctx.emitLog(containerAction, 'info', stackId);
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'starting');
        const upCmd = updateEnvOnly
            ? `cd ${workingDir} && docker compose up -d --force-recreate`
            : force
                ? `cd ${workingDir} && docker compose up -d --force-recreate`
                : `cd ${workingDir} && docker compose up -d`;
        const upResult = await ctx.sshService.executeCommand(serverId, upCmd);
        const fullUpOutput = upResult.stdout + upResult.stderr;
        (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'up_output', fullUpOutput);
        if (upResult.exitCode !== 0) {
            const errorLines = fullUpOutput.split('\n').slice(-20).join('\n');
            throw new Error(`Failed to restart containers:\n\n${errorLines}`);
        }
        const containers = await (0, containers_1.getContainerStatus)(ctx, serverId, workingDir);
        db_1.db.prepare(`
        UPDATE docker_stacks SET
          status = 'running',
          last_deployed_at = ?,
          services_count = ?,
          last_successful_deployment_id = ?,
          has_pending_failure = 0,
          failed_compose_content = NULL,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(now, containers.length, deploymentId, now, stackId);
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'success');
        (0, deploymentDb_1.updateDeploymentFinished)(deploymentId, now);
        log(`Stack redeployed successfully!`, 'success');
        return {
            success: true,
            stackId,
            deploymentId,
            projectName: stack.project_name,
            containers,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Redeployment failed: ${errorMessage}`, 'error');
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'failed');
        (0, deploymentDb_1.updateDeploymentError)(deploymentId, errorMessage);
        (0, deploymentDb_1.updateDeploymentFinished)(deploymentId, Date.now());
        const lastSuccess = (0, deploymentDb_1.getLastSuccessfulDeployment)(stackId);
        if (lastSuccess) {
            log('Fallback: Previous successful version is still running', 'warning');
            (0, deploymentDb_1.updateStackWithFallback)(stackId, errorMessage, stack.compose_content, lastSuccess.id);
        }
        else {
            db_1.queries.updateDockerStack(stackId, {
                status: 'error',
                last_error: errorMessage,
            });
        }
        return {
            success: false,
            error: errorMessage,
        };
    }
    finally {
        ctx.saveDeploymentLogs(deploymentId);
    }
}
//# sourceMappingURL=redeploy.js.map