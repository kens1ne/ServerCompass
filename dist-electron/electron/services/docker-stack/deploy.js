"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployStack = deployStack;
exports.executeDeployment = executeDeployment;
const crypto_1 = require("crypto");
const BuildpackGenerationService_1 = require("../BuildpackGenerationService");
const ComposeService_1 = require("../ComposeService");
const GitAccountService_1 = require("../GitAccountService");
const db_1 = require("../../db");
const composeUtils_1 = require("./composeUtils");
const deploymentDb_1 = require("./deploymentDb");
const buildUtils_1 = require("./buildUtils");
const nextjsConfig_1 = require("./nextjsConfig");
const containers_1 = require("./containers");
const supabase_1 = require("./supabase");
const docker_templates_1 = require("../../docker-templates");
const MonitoringAgentService_1 = require("../MonitoringAgentService");
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
/**
 * Deploy a new Docker stack
 */
async function deployStack(ctx, input) {
    const { serverId, projectName, sourceType, dockerfileContent, dockerfileOverridePath, envVars, stackPath = '/root/server-compass/apps', registryCredentialId, buildOnDeploy = false, notifyOnCompletion = false, pullPolicy = 'missing', gitAccountId, gitRepository, gitBranch = 'main', gitPullOnRedeploy = true, appPort, buildLocation = 'vps', uploadFolderPath, } = input;
    if (sourceType === 'template' && input.templateId) {
        const tpl = (0, docker_templates_1.getTemplateById)(input.templateId);
        if (!tpl) {
            throw new Error(`Template not found: ${input.templateId}`);
        }
        const missingRequiredEnvKeys = getMissingRequiredTemplateEnvKeys(tpl, envVars);
        if (missingRequiredEnvKeys.length > 0) {
            throw new Error(`Missing required environment variables for template "${tpl.name}": ${missingRequiredEnvKeys.join(', ')}`);
        }
    }
    const escapedProjectName = projectName.replace(/"/g, '\\"');
    const existingContainers = await ctx.sshService.executeCommand(serverId, `docker ps -a --filter "label=com.docker.compose.project=${escapedProjectName}" --format "{{.Names}}" | head -1`);
    const exactNamedContainer = await ctx.sshService.executeCommand(serverId, `docker ps -a --filter "name=^/${escapedProjectName}$" --format "{{.Names}}" | head -1`);
    const conflictingContainerName = existingContainers.stdout.trim() || exactNamedContainer.stdout.trim();
    if (conflictingContainerName) {
        throw new Error(`Cannot deploy: Existing containers for project "${projectName}" were found on this server (found: ${conflictingContainerName}). ` +
            `This would cause volume conflicts and database password issues. ` +
            `Please either:\n` +
            `1. Choose a different project name (e.g., "${projectName}-v2", "${projectName}-new"), OR\n` +
            `2. Completely remove the old deployment first:\n` +
            `   ssh YOUR_SERVER "cd ~/server-compass/apps/${projectName} && docker compose down -v && cd .. && rm -rf ${projectName}"`);
    }
    let composeContent = input.composeContent;
    const stackId = `stack-${(0, crypto_1.randomUUID)()}`;
    const deploymentId = `deploy-${(0, crypto_1.randomUUID)()}`;
    const workingDir = `${stackPath}/${projectName}`;
    ctx.emitLog(`Starting deployment for stack: ${projectName}`, 'info', stackId);
    const now = Date.now();
    const createStackStmt = db_1.db.prepare(`
      INSERT INTO docker_stacks (
        id, server_id, project_name, source_type, template_id,
        compose_content, dockerfile_content, env_vars, stack_path,
        registry_credential_id, build_on_deploy, pull_policy,
        status, services_count,
        github_repo, git_account_id, git_branch, git_clone_path, git_pull_on_redeploy, git_last_commit,
        build_location,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
        createStackStmt.run(stackId, serverId, projectName, sourceType, input.templateId || null, composeContent || '', dockerfileContent || null, envVars ? JSON.stringify(envVars) : null, stackPath, registryCredentialId || null, buildOnDeploy ? 1 : 0, pullPolicy, 'deploying', 0, gitRepository || null, gitAccountId || null, gitBranch, null, gitPullOnRedeploy ? 1 : 0, null, buildLocation, now, now);
    }
    catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: docker_stacks\.server_id, docker_stacks\.project_name/i.test(error.message)) {
            throw new Error('A stack with this name already exists on this server. Choose a different project name or redeploy the existing stack.');
        }
        throw error;
    }
    (0, deploymentDb_1.createDeploymentRecord)(deploymentId, stackId, 'manual', now, undefined, buildLocation);
    (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pending');
    let notificationScheduled = false;
    if (notifyOnCompletion) {
        ctx.emitLog('Preparing deployment notifications on your server (first time may take a minute)...', 'info', stackId, deploymentId);
        try {
            const notificationResult = await MonitoringAgentService_1.monitoringAgentService.scheduleDeploymentNotification(serverId, {
                projectName,
                deploymentId,
                workingDir,
                action: 'deploy',
            });
            notificationScheduled = notificationResult.success;
            if (notificationResult.success) {
                ctx.emitLog('Deployment notifications scheduled on your server. You will be alerted even if Server Compass is closed.', 'success', stackId, deploymentId);
            }
            else {
                ctx.emitLog('Could not enable server-side notifications. The app will notify you while it remains open.', 'warning', stackId, deploymentId);
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            ctx.emitLog(`Server-side notifications setup failed: ${errorMessage}`, 'warning', stackId, deploymentId);
        }
    }
    setImmediate(async () => {
        try {
            await executeDeployment(ctx, {
                stackId,
                deploymentId,
                serverId,
                projectName,
                sourceType,
                templateId: input.templateId,
                workingDir,
                stackPath,
                composeContent,
                dockerfileContent,
                dockerfileOverridePath,
                envVars,
                buildOnDeploy,
                registryCredentialId,
                pullPolicy,
                gitAccountId,
                gitRepository,
                gitBranch,
                gitPullOnRedeploy,
                appPort,
                uploadFolderPath,
                now,
            });
        }
        catch (error) {
            console.error('Background deployment error:', error);
        }
    });
    return {
        success: true,
        stackId,
        deploymentId,
        projectName,
        services: [],
        containers: [],
        notificationScheduled,
    };
}
async function executeDeployment(ctx, params) {
    const { stackId, deploymentId, serverId, projectName, sourceType, templateId, workingDir, gitAccountId, gitRepository, gitBranch, gitPullOnRedeploy: _gitPullOnRedeploy, buildOnDeploy, registryCredentialId, pullPolicy, envVars, appPort, uploadFolderPath, now, } = params;
    let composeContent = params.composeContent;
    let dockerfileContent = params.dockerfileContent;
    const dockerfileOverridePath = params.dockerfileOverridePath?.trim() || null;
    let gitClonePath = null;
    let gitLastCommit = null;
    ctx.initDeploymentLogs(deploymentId);
    const log = (message, type = 'info') => {
        ctx.emitLog(message, type, stackId, deploymentId);
    };
    // Template deployments should be resilient even if the renderer didn't pre-render composeContent.
    // This avoids deploying a compose file with unresolved {{VAR}} placeholders or an empty compose.
    //
    // Neon Local is always re-rendered from current envVars so runtime credentials
    // never get stuck in stale inline compose values from an earlier wizard step.
    const shouldRenderBuiltinTemplate = sourceType === 'template' &&
        !!templateId &&
        (!composeContent ||
            !composeContent.trim() ||
            templateId === 'builtin-neon-local');
    if (shouldRenderBuiltinTemplate && templateId) {
        const tpl = (0, docker_templates_1.getTemplateById)(templateId);
        if (!tpl) {
            throw new Error(`Template not found: ${templateId}`);
        }
        const variables = {};
        for (const v of tpl.variables || []) {
            variables[v.name] = v.default ?? '';
        }
        // Prefer explicit appPort when the template defines PORT.
        if ('PORT' in variables && appPort) {
            variables.PORT = String(appPort);
        }
        // envVars from the wizard (if present) override defaults.
        if (envVars) {
            for (const [k, v] of Object.entries(envVars)) {
                variables[k] = String(v);
            }
        }
        // Supabase Full: ANON_KEY and SERVICE_ROLE_KEY must be HS256 JWTs derived from JWT_SECRET.
        if (templateId === 'builtin-supabase-full' && variables.JWT_SECRET) {
            if (!variables.ANON_KEY)
                variables.ANON_KEY = (0, supabase_1.generateSupabaseJWT)(variables.JWT_SECRET, 'anon');
            if (!variables.SERVICE_ROLE_KEY)
                variables.SERVICE_ROLE_KEY = (0, supabase_1.generateSupabaseJWT)(variables.JWT_SECRET, 'service_role');
        }
        log('Rendering built-in template in main process...', 'info');
        const rendered = (0, docker_templates_1.renderTemplate)(templateId, variables);
        composeContent = rendered.compose;
        dockerfileContent = dockerfileContent || rendered.dockerfile;
    }
    if (sourceType === 'template' && templateId) {
        const tpl = (0, docker_templates_1.getTemplateById)(templateId);
        if (!tpl) {
            throw new Error(`Template not found: ${templateId}`);
        }
        const missingRequiredEnvKeys = getMissingRequiredTemplateEnvKeys(tpl, envVars);
        if (missingRequiredEnvKeys.length > 0) {
            throw new Error(`Missing required environment variables for template "${tpl.name}": ${missingRequiredEnvKeys.join(', ')}`);
        }
    }
    try {
        log('Checking Docker installation...');
        await ctx.ensureDockerInstalled(serverId);
        // Create the stack working directory as early as possible so:
        // - file uploads don't fail with "No such file or directory"
        // - concurrent status polling doesn't spam "cd: ... No such file or directory"
        const mkdirResult = await ctx.sshService.executeCommand(serverId, `mkdir -p "${workingDir}"`);
        if (mkdirResult.exitCode !== 0) {
            const details = (mkdirResult.stderr || mkdirResult.stdout || '').trim();
            throw new Error(`Failed to create stack directory ${workingDir}. ` +
                `If you're not connecting as root, choose a stack path under your user's home directory. ` +
                (details ? `Details: ${details}` : ''));
        }
        // Execute template preDeployCommands (e.g. create bind-mount dirs with correct ownership)
        if (sourceType === 'template' && templateId) {
            const tpl = (0, docker_templates_1.getTemplateById)(templateId);
            const preDeployCommands = tpl?.preDeployCommands;
            if (preDeployCommands && preDeployCommands.length > 0) {
                log('Running pre-deploy commands...', 'info');
                for (const rawCmd of preDeployCommands) {
                    const cmd = rawCmd.replace(/\{\{STACK_DIR\}\}/g, workingDir);
                    log(`  > ${cmd}`, 'info');
                    const result = await ctx.sshService.executeCommand(serverId, cmd);
                    if (result.exitCode !== 0) {
                        const errDetails = (result.stderr || result.stdout || '').trim();
                        log(`Pre-deploy command failed: ${errDetails}`, 'warning');
                    }
                }
            }
        }
        const dirExistsCheck = await ctx.sshService.executeCommand(serverId, `test -f "${workingDir}/docker-compose.yml" && echo "exists" || echo "new"`);
        const volumeExistsCheck = await ctx.sshService.executeCommand(serverId, `docker volume ls --format "{{.Name}}" | grep "^${projectName}_" | head -1`);
        const hasExistingDir = dirExistsCheck.stdout.trim() === 'exists';
        const hasExistingVolumes = volumeExistsCheck.stdout.trim() !== '';
        if (hasExistingDir || hasExistingVolumes) {
            log('Found existing deployment or orphaned volumes, cleaning up...', 'info');
            log('This ensures database passwords are set correctly (MySQL/PostgreSQL only initialize passwords on first startup)', 'info');
            if (hasExistingDir) {
                log('Removing existing containers and volumes from directory...', 'info');
                const cleanupResult = await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && docker compose down -v 2>&1 || true`);
                if (cleanupResult.stdout || cleanupResult.stderr) {
                    const output = (cleanupResult.stdout + cleanupResult.stderr).trim();
                    if (output && !output.includes('no configuration file') && !output.includes('no such file')) {
                        log(`Cleanup output: ${output}`, 'info');
                    }
                }
            }
            if (hasExistingVolumes) {
                log('Removing orphaned volumes with same project name...', 'info');
                await ctx.sshService.executeCommand(serverId, `docker volume ls --format "{{.Name}}" | grep "^${projectName}_" | xargs -r docker volume rm 2>&1 || true`);
            }
        }
        if (sourceType === 'github') {
            if (!gitAccountId || !gitRepository) {
                throw new Error('GitHub deployment requires gitAccountId and gitRepository');
            }
            log(`Cloning repository ${gitRepository} (${gitBranch})...`);
            gitClonePath = `${workingDir}/repo`;
            await ctx.sshService.executeCommand(serverId, `mkdir -p "${gitClonePath}"`);
            // cloneWithAccount throws on error, no return value to check
            await GitAccountService_1.gitAccountService.cloneWithAccount(serverId, gitAccountId, gitRepository, gitClonePath, gitBranch);
            const commitResult = await ctx.sshService.executeCommand(serverId, `cd "${gitClonePath}" && git rev-parse HEAD`);
            if (commitResult.exitCode === 0) {
                gitLastCommit = commitResult.stdout.trim();
            }
            const hasWizardCompose = !!composeContent && !!composeContent.trim();
            if (hasWizardCompose) {
                log('📄 Using docker-compose.yml provided by the wizard', 'info');
            }
            else {
                const composeResult = await ctx.sshService.executeCommand(serverId, `cat "${gitClonePath}/docker-compose.yml" 2>/dev/null || cat "${gitClonePath}/docker-compose.yaml" 2>/dev/null || cat "${gitClonePath}/compose.yml" 2>/dev/null || cat "${gitClonePath}/compose.yaml" 2>/dev/null`);
                if (composeResult.exitCode === 0 && composeResult.stdout.trim()) {
                    composeContent = composeResult.stdout;
                    log('📄 Using docker-compose.yml from repository', 'info');
                }
                else {
                    log('No docker-compose.yml found in repository - generating one automatically...', 'warning');
                    const buildpackServiceWithLogs = new BuildpackGenerationService_1.BuildpackGenerationService(ctx.nixpacksService, ctx.sshService, (message, type) => ctx.emitLog(message, type, stackId));
                    const generationResult = await buildpackServiceWithLogs.generateDockerfile({
                        serverId,
                        repoPath: gitClonePath,
                        overrides: {
                            port: appPort || 3000,
                        },
                        projectName,
                    });
                    if (!generationResult.success || !generationResult.compose?.trim()) {
                        throw new Error(`No docker-compose.yml found in repository, and auto-generation failed: ${generationResult.error || 'unknown error'}`);
                    }
                    composeContent = generationResult.compose;
                    // Only set dockerfileContent if the wizard didn't already provide one.
                    if (!dockerfileContent?.trim() && generationResult.dockerfile?.trim()) {
                        dockerfileContent = generationResult.dockerfile;
                    }
                    db_1.queries.updateStackGenerationMetadata(stackId, {
                        generation_method: generationResult.method,
                        generation_config: JSON.stringify(generationResult.config || {}),
                        nixpacks_version: generationResult.method === 'nixpacks' ? generationResult.toolVersion : undefined,
                    });
                    log(`✅ Generated docker-compose.yml using ${generationResult.method}${generationResult.toolVersion ? ` v${generationResult.toolVersion}` : ''}`, 'success');
                }
            }
            if (!composeContent || !composeContent.trim()) {
                throw new Error('Compose content is missing for GitHub deployment');
            }
            const validation = ComposeService_1.composeService.validateCompose(composeContent);
            if (!validation.isValid) {
                throw new Error(`Invalid compose file: ${validation.errors.join(', ')}`);
            }
            if (validation.securityIssues.length > 0) {
                for (const issue of validation.securityIssues) {
                    log(`Security warning: ${issue}`, 'warning');
                }
            }
            const serviceCount = (0, composeUtils_1.countServicesInCompose)(composeContent);
            if (appPort && serviceCount <= 1) {
                log(`Injecting custom port mapping: ${appPort}`, 'info');
                const originalCompose = composeContent;
                composeContent = (0, composeUtils_1.injectPortMapping)(composeContent, appPort);
                if (composeContent === originalCompose) {
                    log(`⚠️  Warning: Port injection had no effect (port may already be ${appPort}). Compose ports section:\n${composeContent.match(/ports:[\\s\\S]*?(?=\\n\\s*\\w|$)/)?.[0] || 'not found'}`, 'warning');
                }
                else {
                    log(`✅ Port mapping updated to ${appPort}`, 'success');
                }
            }
            else if (serviceCount > 1) {
                log(`ℹ️ Skipping port injection for multi-service template (${serviceCount} services) - using pre-configured ports`, 'info');
            }
            else {
                log(`ℹ️ Using default port mapping from compose file`, 'info');
            }
            log(`📄 Final compose ports section:\n${composeContent.match(/ports:[\\s\\S]*?(?=\\n\\s*[a-z]|$)/)?.[0] || 'ports section not found'}`, 'info');
            const rewriteResult = (0, composeUtils_1.rewriteComposeBuildContextsForGitHub)(composeContent);
            if (rewriteResult.rewrites > 0) {
                composeContent = rewriteResult.content;
                log(`Adjusted ${rewriteResult.rewrites} Docker build context path(s) for GitHub repo layout (./repo)`, 'info');
            }
            if (dockerfileOverridePath) {
                if (dockerfileOverridePath.startsWith('/') || dockerfileOverridePath.startsWith('~') || dockerfileOverridePath.includes('..')) {
                    throw new Error(`Invalid dockerfileOverridePath: ${dockerfileOverridePath}`);
                }
                const overrideCheck = await ctx.sshService.executeCommand(serverId, `test -f "${gitClonePath}/${dockerfileOverridePath}" && echo "exists" || echo "missing"`);
                if (overrideCheck.stdout.trim() !== 'exists') {
                    const lsResult = await ctx.sshService.executeCommand(serverId, `ls -la "${gitClonePath}" | head -50`);
                    throw new Error(`Dockerfile override "${dockerfileOverridePath}" was not found in the repository clone. ` +
                        `Make sure it was committed to ${gitRepository} (${gitBranch}).\n\n` +
                        `Repo root files:\n${(lsResult.stdout || lsResult.stderr || '').trim()}`);
                }
                const dockerfileRewrite = (0, composeUtils_1.rewriteComposeDockerfileForOverride)(composeContent, dockerfileOverridePath);
                if (dockerfileRewrite.rewrites > 0) {
                    composeContent = dockerfileRewrite.content;
                    log(`Updated ${dockerfileRewrite.rewrites} dockerfile reference(s) to "${dockerfileOverridePath}"`, 'info');
                }
                log(`📦 Using Dockerfile override: ${dockerfileOverridePath}`, 'info');
            }
            // Always reference `.env` at runtime so the container receives variables from the server-side env file.
            // Without `env_file`, Docker Compose only uses `.env` for interpolation, not container environment injection.
            if (!composeContent.includes('env_file:')) {
                let injected = false;
                if (composeContent.includes('restart:')) {
                    composeContent = composeContent.replace(/^(\\s*restart:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (!injected && composeContent.includes('image:')) {
                    composeContent = composeContent.replace(/^(\\s*image:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (!injected && composeContent.includes('build:')) {
                    composeContent = composeContent.replace(/^(\\s*build:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (injected) {
                    log('Injected env_file reference for environment variables', 'info');
                }
            }
            composeContent = (0, composeUtils_1.escapeDollarInEnvVars)(composeContent);
            await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, composeContent);
            if (!dockerfileOverridePath) {
                const existingDockerfileCheck = await ctx.sshService.executeCommand(serverId, `test -f "${gitClonePath}/Dockerfile" && echo "exists" || echo "not_found"`);
                const repoHasDockerfile = existingDockerfileCheck.stdout.trim() === 'exists';
                if (repoHasDockerfile) {
                    log('📦 Found existing Dockerfile in repository - using it as-is', 'info');
                    const existingDockerfile = await ctx.sshService.executeCommand(serverId, `head -20 "${gitClonePath}/Dockerfile"`);
                    if (existingDockerfile.exitCode === 0) {
                        log(`Dockerfile preview:\n${existingDockerfile.stdout.substring(0, 300)}...`, 'info');
                    }
                    log('✅ Using repository Dockerfile (not overwriting)', 'success');
                }
                else if (dockerfileContent) {
                    log(`Using Dockerfile from template (${dockerfileContent.length} bytes)`, 'info');
                    log(`Dockerfile preview: ${dockerfileContent.substring(0, 200)}...`, 'info');
                    await ctx.uploadFile(serverId, `${gitClonePath}/Dockerfile`, dockerfileContent);
                    log('✅ Dockerfile uploaded successfully to ' + gitClonePath, 'success');
                }
                else {
                    log('🤖 No Dockerfile found - generating automatically...', 'info');
                    const pkgJsonCheck = await ctx.sshService.executeCommand(serverId, `test -f "${gitClonePath}/package.json" && cat "${gitClonePath}/package.json"`);
                    let framework = 'node';
                    let packageManager = 'npm';
                    if (pkgJsonCheck.exitCode === 0 && pkgJsonCheck.stdout.trim()) {
                        try {
                            const pkgJson = JSON.parse(pkgJsonCheck.stdout);
                            const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
                            if (deps.next)
                                framework = 'nextjs';
                            else if (deps.react && (deps['react-scripts'] || deps.vite))
                                framework = 'react';
                            else if (deps.vue)
                                framework = 'vue';
                            else if (deps.express)
                                framework = 'express';
                            else if (deps.fastify)
                                framework = 'fastify';
                            else if (deps['@nestjs/core'])
                                framework = 'nestjs';
                            if (pkgJson.packageManager) {
                                if (pkgJson.packageManager.startsWith('yarn'))
                                    packageManager = 'yarn';
                                else if (pkgJson.packageManager.startsWith('pnpm'))
                                    packageManager = 'pnpm';
                            }
                        }
                        catch {
                            // Keep defaults
                        }
                    }
                    const lockFileCheck = await ctx.sshService.executeCommand(serverId, `cd "${gitClonePath}" && ls -la yarn.lock pnpm-lock.yaml package-lock.json 2>/dev/null || true`);
                    if (lockFileCheck.stdout.includes('yarn.lock'))
                        packageManager = 'yarn';
                    else if (lockFileCheck.stdout.includes('pnpm-lock.yaml'))
                        packageManager = 'pnpm';
                    log(`🔍 Detected: ${framework} (${packageManager})`, 'info');
                    if (framework === 'nextjs') {
                        await (0, nextjsConfig_1.ensureNextjsStandaloneMode)({
                            sshService: ctx.sshService,
                            uploadFile: ctx.uploadFile,
                            emitLog: (message, type) => ctx.emitLog(message, type, stackId),
                            serverId,
                            repoPath: gitClonePath,
                            stackId,
                        });
                    }
                    const buildpackServiceWithLogs = new BuildpackGenerationService_1.BuildpackGenerationService(ctx.nixpacksService, ctx.sshService, (message, type) => ctx.emitLog(message, type, stackId));
                    const generationResult = await buildpackServiceWithLogs.generateDockerfile({
                        serverId,
                        repoPath: gitClonePath,
                        framework,
                        overrides: {
                            port: appPort || 3000,
                        },
                        projectName,
                    });
                    if (generationResult.success && generationResult.dockerfile) {
                        db_1.queries.updateStackGenerationMetadata(stackId, {
                            generation_method: generationResult.method,
                            generation_config: JSON.stringify(generationResult.config || {}),
                            nixpacks_version: generationResult.method === 'nixpacks' ? generationResult.toolVersion : undefined,
                        });
                        log(`✅ Generated Dockerfile using ${generationResult.method}${generationResult.toolVersion ? ` v${generationResult.toolVersion}` : ''}`, 'success');
                        await ctx.uploadFile(serverId, `${gitClonePath}/Dockerfile`, generationResult.dockerfile);
                        log('✅ Dockerfile uploaded to repository', 'success');
                    }
                    else {
                        throw new Error(`Failed to generate Dockerfile: ${generationResult.error}`);
                    }
                }
            }
        }
        else if (sourceType === 'upload') {
            if (!uploadFolderPath) {
                throw new Error('Upload deployment requires uploadFolderPath');
            }
            log(`📦 Upload deployment: moving uploaded code to working directory...`);
            gitClonePath = `${workingDir}/repo`;
            await ctx.sshService.executeCommand(serverId, `mkdir -p "${gitClonePath}"`);
            // Move uploaded code from /tmp to the working directory
            const moveResult = await ctx.sshService.executeCommand(serverId, `cp -a "${uploadFolderPath}/." "${gitClonePath}/" && rm -rf "${uploadFolderPath}"`);
            if (moveResult.exitCode !== 0) {
                const details = (moveResult.stderr || moveResult.stdout || '').trim();
                throw new Error(`Failed to move uploaded code from ${uploadFolderPath} to ${gitClonePath}. ` +
                    (details ? `Details: ${details}` : ''));
            }
            log('✅ Uploaded code moved to working directory', 'success');
            // Check for existing docker-compose.yml in uploaded code
            const hasWizardCompose = !!composeContent && !!composeContent.trim();
            if (hasWizardCompose) {
                log('📄 Using docker-compose.yml provided by the wizard', 'info');
            }
            else {
                const composeResult = await ctx.sshService.executeCommand(serverId, `cat "${gitClonePath}/docker-compose.yml" 2>/dev/null || cat "${gitClonePath}/docker-compose.yaml" 2>/dev/null || cat "${gitClonePath}/compose.yml" 2>/dev/null || cat "${gitClonePath}/compose.yaml" 2>/dev/null`);
                if (composeResult.exitCode === 0 && composeResult.stdout.trim()) {
                    composeContent = composeResult.stdout;
                    log('📄 Using docker-compose.yml from uploaded code', 'info');
                }
                else {
                    log('No docker-compose.yml found in uploaded code - generating one automatically...', 'warning');
                    const buildpackServiceWithLogs = new BuildpackGenerationService_1.BuildpackGenerationService(ctx.nixpacksService, ctx.sshService, (message, type) => ctx.emitLog(message, type, stackId));
                    const generationResult = await buildpackServiceWithLogs.generateDockerfile({
                        serverId,
                        repoPath: gitClonePath,
                        overrides: {
                            port: appPort || 3000,
                        },
                        projectName,
                    });
                    if (!generationResult.success || !generationResult.compose?.trim()) {
                        throw new Error(`No docker-compose.yml found in uploaded code, and auto-generation failed: ${generationResult.error || 'unknown error'}`);
                    }
                    composeContent = generationResult.compose;
                    if (!dockerfileContent?.trim() && generationResult.dockerfile?.trim()) {
                        dockerfileContent = generationResult.dockerfile;
                    }
                    db_1.queries.updateStackGenerationMetadata(stackId, {
                        generation_method: generationResult.method,
                        generation_config: JSON.stringify(generationResult.config || {}),
                        nixpacks_version: generationResult.method === 'nixpacks' ? generationResult.toolVersion : undefined,
                    });
                    log(`✅ Generated docker-compose.yml using ${generationResult.method}${generationResult.toolVersion ? ` v${generationResult.toolVersion}` : ''}`, 'success');
                }
            }
            if (!composeContent || !composeContent.trim()) {
                throw new Error('Compose content is missing for upload deployment');
            }
            const validation = ComposeService_1.composeService.validateCompose(composeContent);
            if (!validation.isValid) {
                throw new Error(`Invalid compose file: ${validation.errors.join(', ')}`);
            }
            if (validation.securityIssues.length > 0) {
                for (const issue of validation.securityIssues) {
                    log(`Security warning: ${issue}`, 'warning');
                }
            }
            const serviceCount = (0, composeUtils_1.countServicesInCompose)(composeContent);
            if (appPort && serviceCount <= 1) {
                log(`Injecting custom port mapping: ${appPort}`, 'info');
                const originalCompose = composeContent;
                composeContent = (0, composeUtils_1.injectPortMapping)(composeContent, appPort);
                if (composeContent === originalCompose) {
                    log(`⚠️  Warning: Port injection had no effect`, 'warning');
                }
                else {
                    log(`✅ Port mapping updated to ${appPort}`, 'success');
                }
            }
            else if (serviceCount > 1) {
                log(`ℹ️ Skipping port injection for multi-service app (${serviceCount} services)`, 'info');
            }
            const rewriteResult = (0, composeUtils_1.rewriteComposeBuildContextsForGitHub)(composeContent);
            if (rewriteResult.rewrites > 0) {
                composeContent = rewriteResult.content;
                log(`Adjusted ${rewriteResult.rewrites} Docker build context path(s) for uploaded code layout (./repo)`, 'info');
            }
            // Inject env_file reference
            if (!composeContent.includes('env_file:')) {
                let injected = false;
                if (composeContent.includes('restart:')) {
                    composeContent = composeContent.replace(/^(\\s*restart:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (!injected && composeContent.includes('image:')) {
                    composeContent = composeContent.replace(/^(\\s*image:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (!injected && composeContent.includes('build:')) {
                    composeContent = composeContent.replace(/^(\\s*build:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (injected) {
                    log('Injected env_file reference for environment variables', 'info');
                }
            }
            composeContent = (0, composeUtils_1.escapeDollarInEnvVars)(composeContent);
            await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, composeContent);
            // Handle Dockerfile: wizard-provided content takes priority over repo's existing file
            if (dockerfileContent) {
                log(`Using wizard-configured Dockerfile (${dockerfileContent.length} bytes)`, 'info');
                await ctx.uploadFile(serverId, `${gitClonePath}/Dockerfile`, dockerfileContent);
                log('✅ Dockerfile uploaded successfully', 'success');
            }
            else {
                const existingDockerfileCheck = await ctx.sshService.executeCommand(serverId, `test -f "${gitClonePath}/Dockerfile" && echo "exists" || echo "not_found"`);
                const repoHasDockerfile = existingDockerfileCheck.stdout.trim() === 'exists';
                if (repoHasDockerfile) {
                    log('📦 Found existing Dockerfile in uploaded code - using it as-is', 'info');
                }
                else {
                    log('🤖 No Dockerfile found - generating automatically...', 'info');
                    const buildpackServiceWithLogs = new BuildpackGenerationService_1.BuildpackGenerationService(ctx.nixpacksService, ctx.sshService, (message, type) => ctx.emitLog(message, type, stackId));
                    const generationResult = await buildpackServiceWithLogs.generateDockerfile({
                        serverId,
                        repoPath: gitClonePath,
                        overrides: {
                            port: appPort || 3000,
                        },
                        projectName,
                    });
                    if (generationResult.success && generationResult.dockerfile) {
                        db_1.queries.updateStackGenerationMetadata(stackId, {
                            generation_method: generationResult.method,
                            generation_config: JSON.stringify(generationResult.config || {}),
                            nixpacks_version: generationResult.method === 'nixpacks' ? generationResult.toolVersion : undefined,
                        });
                        log(`✅ Generated Dockerfile using ${generationResult.method}${generationResult.toolVersion ? ` v${generationResult.toolVersion}` : ''}`, 'success');
                        await ctx.uploadFile(serverId, `${gitClonePath}/Dockerfile`, generationResult.dockerfile);
                        log('✅ Dockerfile uploaded', 'success');
                    }
                    else {
                        throw new Error(`Failed to generate Dockerfile: ${generationResult.error}`);
                    }
                }
            }
        }
        else {
            log(`📝 Non-GitHub deployment (sourceType: ${sourceType})`, 'info');
            log(`📝 Template ID: ${templateId || 'none'}`, 'info');
            if (!composeContent) {
                throw new Error('Compose content is required for non-GitHub deployments');
            }
            log(`📄 Received compose content: ${composeContent.length} chars`, 'info');
            log(`📄 Compose preview (first 300 chars): ${composeContent.substring(0, 300)}`, 'info');
            if (dockerfileContent) {
                log(`📄 Received dockerfile content: ${dockerfileContent.length} chars`, 'info');
                log(`📄 Dockerfile preview (first 300 chars): ${dockerfileContent.substring(0, 300)}`, 'info');
            }
            const validation = ComposeService_1.composeService.validateCompose(composeContent);
            if (!validation.isValid) {
                throw new Error(`Invalid compose file: ${validation.errors.join(', ')}`);
            }
            if (validation.securityIssues.length > 0) {
                for (const issue of validation.securityIssues) {
                    log(`Security warning: ${issue}`, 'warning');
                }
            }
            const serviceCountForPaste = (0, composeUtils_1.countServicesInCompose)(composeContent);
            if (appPort && serviceCountForPaste <= 1) {
                log(`Injecting custom port mapping: ${appPort}`, 'info');
                const originalCompose = composeContent;
                composeContent = (0, composeUtils_1.injectPortMapping)(composeContent, appPort);
                if (composeContent === originalCompose) {
                    log(`⚠️  Warning: Port injection had no effect (port may already be ${appPort}). Compose ports section:\n${composeContent.match(/ports:[\\s\\S]*?(?=\\n\\s*\\w|$)/)?.[0] || 'not found'}`, 'warning');
                }
                else {
                    log(`✅ Port mapping updated to ${appPort}`, 'success');
                }
            }
            else if (serviceCountForPaste > 1) {
                log(`ℹ️ Skipping port injection for multi-service template (${serviceCountForPaste} services) - using pre-configured ports`, 'info');
            }
            else {
                log(`ℹ️ Using default port mapping from compose file`, 'info');
            }
            log(`📄 Final compose ports section:\n${composeContent.match(/ports:[\\s\\S]*?(?=\\n\\s*[a-z]|$)/)?.[0] || 'ports section not found'}`, 'info');
            let injected = false;
            if (!composeContent.includes('env_file:')) {
                if (composeContent.includes('restart:')) {
                    composeContent = composeContent.replace(/^(\\s*restart:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (!injected && composeContent.includes('image:')) {
                    composeContent = composeContent.replace(/^(\\s*image:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (!injected && composeContent.includes('build:')) {
                    composeContent = composeContent.replace(/^(\\s*build:\\s*.+)$/gm, (_match, p1) => {
                        const indent = p1.match(/^(\\s*)/)?.[1] || '    ';
                        return `${p1}\\n${indent}env_file:\\n${indent}  - .env`;
                    });
                    injected = true;
                }
                if (injected) {
                    log('Injected env_file reference for environment variables', 'info');
                }
            }
            composeContent = (0, composeUtils_1.escapeDollarInEnvVars)(composeContent);
            log('Uploading docker-compose.yml...', 'info');
            log(`🚀 Final compose to upload (first 300 chars): ${composeContent.substring(0, 300)}`, 'info');
            await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, composeContent);
            if (dockerfileContent) {
                log('Uploading Dockerfile...', 'info');
                log(`🚀 Final dockerfile to upload (first 300 chars): ${dockerfileContent.substring(0, 300)}`, 'info');
                await ctx.uploadFile(serverId, `${workingDir}/Dockerfile`, dockerfileContent);
            }
        }
        if (!composeContent) {
            throw new Error('Compose content is missing');
        }
        const validation = ComposeService_1.composeService.validateCompose(composeContent);
        if (!validation.isValid) {
            throw new Error(`Invalid compose file: ${validation.errors.join(', ')}`);
        }
        const serviceNames = validation.services;
        const imageNames = validation.images;
        const externalImages = imageNames.filter(img => !img.startsWith('build:'));
        const buildServices = serviceNames.filter((_, i) => imageNames[i]?.startsWith('build:'));
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pulling');
        if (envVars && Object.keys(envVars).length > 0) {
            const envKeys = Object.keys(envVars);
            log(`Creating .env file with ${envKeys.length} variable(s): ${envKeys.join(', ')}`, 'info');
            await ctx.createEnvFile(serverId, workingDir, envVars);
            log('✅ Environment variables configured', 'success');
        }
        else {
            log('ℹ️ No custom environment variables provided - using existing .env on server (if present)', 'info');
            const ensureEnvResult = await ctx.sshService.executeCommand(serverId, `cd "${workingDir}" && (test -f .env || touch .env)`);
            if (ensureEnvResult.exitCode !== 0) {
                // Fallback: create an empty env file so `env_file: .env` never breaks compose.
                await ctx.uploadFile(serverId, `${workingDir}/.env`, '');
            }
        }
        if (templateId === 'builtin-supabase' && envVars?.POSTGRES_PASSWORD) {
            log('Creating Supabase database roles initialization script...', 'info');
            const initScript = `-- Supabase Database Roles Initialization Script
-- This script creates the required roles for PostgREST to function correctly
-- Auto-generated by ServerCompass

-- Create PostgREST roles
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Create authenticator user (used by PostgREST to connect)
-- Note: Password is set from environment variable
CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${envVars.POSTGRES_PASSWORD}';

-- Grant roles to authenticator
GRANT anon, authenticated, service_role TO authenticator;
GRANT postgres TO authenticator;

-- Grant permissions on postgres database
GRANT ALL ON DATABASE postgres TO authenticator;
GRANT ALL ON SCHEMA public TO authenticator;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticator;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticator;

-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticator;

-- Log successful initialization
DO $$
BEGIN
  RAISE NOTICE 'Supabase roles initialized successfully';
END $$;
`;
            await ctx.uploadFile(serverId, `${workingDir}/init-supabase-roles.sql`, initScript);
            log('✅ Supabase initialization script created', 'success');
        }
        if (templateId === 'builtin-supabase-full' && envVars?.POSTGRES_PASSWORD && envVars?.JWT_SECRET) {
            log('Creating Supabase Full stack initialization files...', 'info');
            if (!envVars.ANON_KEY || envVars.ANON_KEY === '') {
                envVars.ANON_KEY = (0, supabase_1.generateSupabaseJWT)(envVars.JWT_SECRET, 'anon');
                log('Generated ANON_KEY', 'info');
            }
            if (!envVars.SERVICE_ROLE_KEY || envVars.SERVICE_ROLE_KEY === '') {
                envVars.SERVICE_ROLE_KEY = (0, supabase_1.generateSupabaseJWT)(envVars.JWT_SECRET, 'service_role');
                log('Generated SERVICE_ROLE_KEY', 'info');
            }
            const initScriptFull = `-- Supabase Full Stack Database Initialization Script
-- This script creates all required roles, schemas, and extensions for full Supabase
-- Auto-generated by ServerCompass

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create schemas
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS graphql_public;
CREATE SCHEMA IF NOT EXISTS _realtime;

-- Create auth types required by GoTrue
DO $$ BEGIN
  CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE auth.code_challenge_method AS ENUM ('s256', 'plain');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create PostgREST roles
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Create authenticator user (used by PostgREST)
CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${envVars.POSTGRES_PASSWORD}';
GRANT anon, authenticated, service_role TO authenticator;
GRANT postgres TO authenticator;

-- Create supabase_admin for Meta and Realtime services
CREATE ROLE supabase_admin NOINHERIT LOGIN PASSWORD '${envVars.POSTGRES_PASSWORD}';
-- Supabase services often rely on unqualified table names; ensure auth schema is in search_path where needed.
ALTER ROLE supabase_admin SET search_path TO public, auth;
GRANT ALL PRIVILEGES ON DATABASE postgres TO supabase_admin;
GRANT ALL PRIVILEGES ON SCHEMA public TO supabase_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO supabase_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO supabase_admin;

-- Create supabase_auth_admin for GoTrue
CREATE ROLE supabase_auth_admin NOINHERIT LOGIN PASSWORD '${envVars.POSTGRES_PASSWORD}';
ALTER ROLE supabase_auth_admin SET search_path TO auth, public;

-- GoTrue migrations must be able to ALTER auth types (e.g., auth.factor_type).
-- The init script runs as the postgres superuser, so types created above are owned by postgres unless we transfer ownership.
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
ALTER TYPE auth.aal_level OWNER TO supabase_auth_admin;
ALTER TYPE auth.code_challenge_method OWNER TO supabase_auth_admin;
ALTER TYPE auth.factor_status OWNER TO supabase_auth_admin;
ALTER TYPE auth.factor_type OWNER TO supabase_auth_admin;
ALTER TYPE auth.one_time_token_type OWNER TO supabase_auth_admin;

GRANT ALL PRIVILEGES ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON TABLES TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT ALL ON SEQUENCES TO supabase_auth_admin;

-- Allow Postgres Meta / Studio to read auth schema via supabase_admin
GRANT USAGE ON SCHEMA auth TO supabase_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_admin;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA auth TO supabase_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO supabase_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO supabase_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO supabase_admin;

-- Grant supabase_auth_admin permissions on public schema (needed for GoTrue migrations)
GRANT ALL PRIVILEGES ON SCHEMA public TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO supabase_auth_admin;

-- Grant permissions on postgres database
GRANT ALL ON DATABASE postgres TO authenticator;
GRANT ALL ON SCHEMA public TO authenticator;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticator;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticator;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticator;

-- Grant realtime schema permissions
GRANT ALL ON SCHEMA _realtime TO supabase_admin;

-- Set default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticator;

-- Log successful initialization
DO $$
BEGIN
  RAISE NOTICE 'Supabase Full Stack roles and schemas initialized successfully';
END $$;
`;
            await ctx.uploadFile(serverId, `${workingDir}/init-supabase-full.sql`, initScriptFull);
            log('✅ Supabase Full database initialization script created', 'success');
            if (!envVars.DASHBOARD_USERNAME || envVars.DASHBOARD_USERNAME === '') {
                envVars.DASHBOARD_USERNAME = 'admin';
            }
            const dashboardUsername = envVars.DASHBOARD_USERNAME;
            if (!envVars.DASHBOARD_PASSWORD || envVars.DASHBOARD_PASSWORD === '') {
                const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let password = '';
                for (let i = 0; i < 16; i++) {
                    password += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                envVars.DASHBOARD_PASSWORD = password;
                log('Generated DASHBOARD_PASSWORD for Studio login', 'info');
            }
            const dashboardPassword = envVars.DASHBOARD_PASSWORD;
            const kongConfig = (0, supabase_1.generateKongConfig)({
                ...envVars,
                DASHBOARD_USERNAME: dashboardUsername,
                DASHBOARD_PASSWORD: dashboardPassword,
            });
            await ctx.uploadFile(serverId, `${workingDir}/kong.yml`, kongConfig);
            log('✅ Kong API Gateway configuration created', 'success');
            (0, supabase_1.applySupabaseFullSmtpEnvVars)(envVars, stackId, (message, type) => ctx.emitLog(message, type, stackId));
            await ctx.createEnvFile(serverId, workingDir, envVars);
            log('✅ Environment variables updated with generated API keys', 'success');
            db_1.queries.updateDockerStack(stackId, { env_vars: JSON.stringify(envVars) });
            log('✅ Generated credentials saved to database', 'info');
        }
        if (registryCredentialId) {
            log('Authenticating with container registry...', 'info');
            await ctx.registryService.loginToRegistry(serverId, registryCredentialId);
        }
        if (pullPolicy !== 'never') {
            if (externalImages.length === 0) {
                log('No external images to pull - all services will be built from source', 'info');
            }
            else if (externalImages.length === 1) {
                log(`Pulling 1 container image: ${externalImages[0]}`, 'info');
            }
            else {
                log(`Pulling ${externalImages.length} container image(s): ${externalImages.join(', ')}`, 'info');
            }
            (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'pulling');
            const pullCmd = pullPolicy === 'always'
                ? `cd ${workingDir} && docker compose pull --policy always`
                : `cd ${workingDir} && docker compose pull`;
            const pullResult = await ctx.sshService.executeCommand(serverId, pullCmd);
            const fullPullOutput = pullResult.stdout + pullResult.stderr;
            (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'pull_output', fullPullOutput);
            if (pullResult.exitCode !== 0 && pullPolicy === 'always') {
                const errorLines = fullPullOutput.split('\\n').slice(-20).join('\\n');
                throw new Error(`Failed to pull Docker images:\\n\\n${errorLines}`);
            }
        }
        if ((sourceType === 'github' || sourceType === 'upload') && gitClonePath) {
            const dockerfileExists = await ctx.sshService.executeCommand(serverId, `test -f "${gitClonePath}/Dockerfile" && echo "exists" || echo "missing"`);
            if (dockerfileExists.stdout.trim() !== 'exists') {
                log('⚠️  Warning: No Dockerfile found after generation attempt', 'warning');
            }
        }
        const shouldBuild = buildOnDeploy || ((sourceType === 'github' || sourceType === 'upload') && gitClonePath);
        if (shouldBuild) {
            const hasBuildContext = await ctx.sshService.executeCommand(serverId, `grep -E "^\\s*build:" "${workingDir}/docker-compose.yml"`);
            if (hasBuildContext.exitCode === 0) {
                if (buildServices.length === 0) {
                    log('No build step required - using pre-built images', 'info');
                }
                else if (buildServices.length === 1) {
                    log(`Building 1 service from source: ${buildServices[0]}`, 'info');
                }
                else {
                    log(`Building ${buildServices.length} service(s) from source: ${buildServices.join(', ')}`, 'info');
                }
                (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'building');
                if (gitClonePath && envVars && Object.keys(envVars).length > 0) {
                    log('Copying environment variables to build context...', 'info');
                    await ctx.sshService.executeCommand(serverId, `cp "${workingDir}/.env" "${gitClonePath}/.env" 2>/dev/null || true`);
                }
                const buildCmd = gitClonePath
                    ? `cd ${workingDir} && COMPOSE_PROJECT_NAME=${projectName} docker compose build --no-cache 2>&1`
                    : `cd ${workingDir} && docker compose build --no-cache 2>&1`;
                const legacyBuildCmd = gitClonePath
                    ? `cd ${workingDir} && COMPOSE_PROJECT_NAME=${projectName} COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose build --no-cache 2>&1`
                    : `cd ${workingDir} && COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose build --no-cache 2>&1`;
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
                            timeoutErrorMessage: 'Build timed out after 20 minutes. Check if your build requires more resources or has an infinite loop.',
                            onTimeout: () => ctx.emitLog(`❌ ${prefix}Build timed out after 20 minutes`, 'error', stackId),
                            onLine: (line) => ctx.emitLog(`📦 ${prefix}${line}`, 'info', stackId),
                        });
                        output = buildResult.output;
                        exitCode = buildResult.exitCode;
                        const durationSec = Math.floor(buildResult.durationMs / 1000);
                        log(`Build completed in ${durationSec}s (exit code: ${exitCode})`, exitCode === 0 ? 'info' : 'error');
                    }
                    catch (buildError) {
                        const errorWithOutput = buildError;
                        const errorMessage = buildError instanceof Error ? buildError.message : String(buildError);
                        if (!errorMessage.toLowerCase().includes('timed out')) {
                            log(`Build command failed: ${errorMessage}`, 'error');
                        }
                        if (errorWithOutput.output) {
                            output = errorWithOutput.output;
                        }
                        (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'build_output', output);
                        throw buildError;
                    }
                    if (exitCode !== 0 && (0, buildUtils_1.isBuildkitTransportEofFailure)(output)) {
                        log('⚠️ Docker BuildKit transport error detected (EOF). Retrying once with legacy builder...', 'warning');
                        try {
                            const legacyBuildResult = await (0, buildUtils_1.streamCommandWithTimeout)({
                                sshService: ctx.sshService,
                                serverId,
                                command: legacyBuildCmd,
                                timeoutMs: 20 * 60 * 1000,
                                timeoutErrorMessage: 'Legacy builder retry timed out after 20 minutes.',
                                onTimeout: () => ctx.emitLog(`❌ ${prefix}Legacy builder retry timed out after 20 minutes`, 'error', stackId),
                                onLine: (line) => ctx.emitLog(`📦 ${prefix}[retry] ${line}`, 'info', stackId),
                            });
                            output = `${output}\n\n[ServerCompass Retry - Legacy Builder]\n${legacyBuildResult.output}`;
                            exitCode = legacyBuildResult.exitCode;
                            const retryDurationSec = Math.floor(legacyBuildResult.durationMs / 1000);
                            log(`Legacy builder retry completed in ${retryDurationSec}s (exit code: ${exitCode})`, exitCode === 0 ? 'success' : 'error');
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
                // DNS failures are common on VPSes with firewall/forwarding issues (host can pull images, containers can't resolve).
                // Retry once with host networking for build steps by injecting `build.network: host` into docker-compose.yml.
                if (buildExitCode !== 0 && (0, buildUtils_1.isDockerDnsResolutionFailure)(buildOutput)) {
                    log('⚠️ DNS resolution failed inside Docker build. Retrying once with `build.network: host` (build-time only)...', 'warning');
                    log('If this keeps failing, Docker containers on your VPS likely cannot access DNS (often UFW/iptables). Try Local Build or fix VPS Docker networking.', 'warning');
                    const injected = (0, composeUtils_1.injectBuildNetworkHost)(composeContent);
                    if (injected.rewrites > 0) {
                        composeContent = injected.content;
                        await ctx.uploadFile(serverId, `${workingDir}/docker-compose.yml`, composeContent);
                        log(`Updated ${injected.rewrites} service(s) to build with host network`, 'info');
                    }
                    else {
                        log('No build.network changes applied (compose parsing failed or already configured)', 'warning');
                    }
                    const retryAttempt = await runBuildAttempt('dns-retry');
                    buildOutput = `${buildOutput}\n\n[ServerCompass Retry - Host Build Network]\n${retryAttempt.output}`;
                    buildExitCode = retryAttempt.exitCode;
                }
                (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'build_output', buildOutput);
                if (buildExitCode !== 0) {
                    const errorLines = buildOutput.split('\\n');
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
                        .join('\\n');
                    const detailedError = errorDetails.trim()
                        ? errorDetails
                        : errorLines.slice(-40).join('\\n');
                    log('❌ Build failed. Error details:', 'error');
                    log(detailedError, 'error');
                    if (buildOutput.includes('.next/standalone') && buildOutput.includes('not found')) {
                        log('', 'error');
                        log('💡 Next.js Standalone Mode Issue:', 'warning');
                        log('ServerCompass attempted to auto-configure standalone mode but the build still failed.', 'warning');
                        log('Please verify your next.config file has: output: "standalone"', 'warning');
                        log('If you have a complex config with conditional logic, you may need to manually ensure standalone mode is enabled.', 'warning');
                    }
                    const dnsHint = (0, buildUtils_1.isDockerDnsResolutionFailure)(buildOutput)
                        ? '\\n\\nHint: DNS resolution failed inside the Docker build container. This usually means Docker networking on the VPS is blocked (often UFW/iptables). Try switching Build Location to Local Build or fixing Docker DNS/firewall on the server.'
                        : '';
                    throw new Error(`Docker build failed:\\n\\n${detailedError}${dnsHint}`);
                }
                log('✅ Build completed successfully', 'success');
            }
        }
        if (serviceNames.length === 1) {
            log(`Starting 1 container: ${serviceNames[0]}`, 'info');
        }
        else {
            log(`Starting ${serviceNames.length} container(s): ${serviceNames.join(', ')}`, 'info');
        }
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'starting');
        const upResult = await ctx.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose up -d`);
        const fullUpOutput = upResult.stdout + upResult.stderr;
        (0, deploymentDb_1.updateDeploymentOutput)(deploymentId, 'up_output', fullUpOutput);
        if (upResult.exitCode !== 0) {
            const errorLines = fullUpOutput.split('\\n').slice(-20).join('\\n');
            throw new Error(`Failed to start containers:\\n\\n${errorLines}`);
        }
        log('Verifying container status...', 'info');
        const containers = await (0, containers_1.getContainerStatus)(ctx, serverId, workingDir);
        const servicesCount = containers.length;
        const crashingContainers = containers.filter(c => c.state !== 'running' ||
            c.status.toLowerCase().includes('restart') ||
            c.status.toLowerCase().includes('exited'));
        if (crashingContainers.length > 0) {
            log(`⚠️ Warning: ${crashingContainers.length} container(s) may be unhealthy`, 'warning');
            for (const container of crashingContainers) {
                log(`📋 Fetching logs for ${container.name}...`, 'info');
                try {
                    const logsResult = await ctx.sshService.executeCommand(serverId, `docker logs ${container.name} --tail 50 2>&1`);
                    if (logsResult.stdout.trim() || logsResult.stderr.trim()) {
                        const logs = (logsResult.stdout + logsResult.stderr).trim();
                        log(`📋 Container logs (${container.name}):\\n${logs}`, 'warning');
                    }
                }
                catch {
                    log(`Failed to fetch logs for ${container.name}`, 'error');
                }
            }
            const psResult = await ctx.sshService.executeCommand(serverId, `cd ${workingDir} && docker compose ps -a`);
            if (psResult.stdout.trim()) {
                log(`📊 Container status:\\n${psResult.stdout}`, 'info');
            }
        }
        const updateStackStmt = db_1.db.prepare(`
        UPDATE docker_stacks SET
          compose_content = ?,
          status = 'running',
          last_deployed_at = ?,
          services_count = ?,
          git_clone_path = ?,
          git_last_commit = ?,
          last_successful_deployment_id = ?,
          has_pending_failure = 0,
          failed_compose_content = NULL,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
      `);
        updateStackStmt.run(composeContent, now, servicesCount, gitClonePath, gitLastCommit, deploymentId, now, stackId);
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'success');
        (0, deploymentDb_1.updateDeploymentFinished)(deploymentId, now);
        log(`Deployment complete! Services running: ${serviceNames.join(', ')} (${servicesCount} container(s))`, 'success');
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Deployment failed: ${errorMessage}`, 'error');
        (0, deploymentDb_1.updateDeploymentStatus)(deploymentId, 'failed');
        (0, deploymentDb_1.updateDeploymentError)(deploymentId, errorMessage);
        (0, deploymentDb_1.updateDeploymentFinished)(deploymentId, Date.now());
        const lastSuccess = (0, deploymentDb_1.getLastSuccessfulDeployment)(stackId);
        try {
            (0, deploymentDb_1.updateStackWithFallback)(stackId, errorMessage, undefined, lastSuccess?.id);
        }
        catch {
            // Stack might not exist yet
        }
    }
    finally {
        ctx.saveDeploymentLogs(deploymentId);
    }
}
//# sourceMappingURL=deploy.js.map