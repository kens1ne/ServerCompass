"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.githubActionsService = exports.GitHubActionsService = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const db_1 = require("../db");
const GitHubApiService_1 = require("./GitHubApiService");
const GitAccountService_1 = require("./GitAccountService");
class GitHubActionsService {
    githubApi = new GitHubApiService_1.GitHubApiService();
    /**
     * Generate app-specific workflow file path
     * This ensures each app has its own workflow file even when deploying to the same repo
     */
    getWorkflowPath(appName) {
        return `.github/workflows/server-compass-deploy-${appName}.yml`;
    }
    /**
     * Enable GitHub Actions deployment for an app
     */
    async enableGitHubActions(options) {
        const { serverId, appName, repoOwner, repoName, branch, workingDirectory, installCommand, buildCommand, } = options;
        console.log(`[GitHubActionsService] Enabling GitHub Actions for ${appName}...`);
        try {
            // Step 1: Generate deployment SSH key
            console.log('[GitHubActionsService] Generating deployment SSH key...');
            const { privateKey, publicKey, keyPath } = await GitAccountService_1.gitAccountService.generateDeploymentSSHKey(serverId, appName);
            // Step 2: Upload public key to GitHub via API
            console.log('[GitHubActionsService] Uploading SSH public key to GitHub...');
            const keyTitle = `ServerCompass-Deploy-${appName}-${Date.now()}`;
            await this.githubApi.uploadSSHKey(keyTitle, publicKey);
            // Step 3: Get VPS connection details
            const server = this.getServerDetails(serverId);
            // Step 4: Upload secrets to GitHub
            console.log('[GitHubActionsService] Uploading secrets to GitHub...');
            console.log('[GitHubActionsService] Debug - Secret values:');
            console.log(`  - vpsHost: ${server.host}`);
            console.log(`  - vpsUser: ${server.username}`);
            console.log(`  - vpsPort: ${server.port}`);
            console.log(`  - privateKey length: ${privateKey?.length || 0} chars`);
            console.log(`  - privateKey starts with: ${privateKey?.substring(0, 50) || 'NULL'}...`);
            await this.uploadSecrets({
                repoOwner,
                repoName,
                appName,
                vpsHost: server.host,
                vpsUser: server.username,
                vpsPort: server.port.toString(),
                vpsSSHKey: privateKey,
            });
            // Step 5: Create workflow file
            console.log('[GitHubActionsService] Creating workflow file...');
            const workflowContent = this.generateWorkflowContent({
                appName,
                branch,
                workingDirectory,
                installCommand,
                buildCommand,
            });
            await this.githubApi.createWorkflowFile(repoOwner, repoName, this.getWorkflowPath(appName), workflowContent);
            // Step 6: Get workflow file SHA for future sync detection
            const workflowFileSha = await this.getWorkflowFileSha(repoOwner, repoName, appName);
            // Step 7: Save configuration to database
            console.log('[GitHubActionsService] Saving configuration to database...');
            this.saveConfig({
                serverId,
                appName,
                repoOwner,
                repoName,
                branch,
                workingDirectory,
                installCommand,
                buildCommand,
                sshKeyPath: keyPath,
                workflowFileSha,
            });
            console.log(`[GitHubActionsService] Successfully enabled GitHub Actions for ${appName}`);
        }
        catch (error) {
            console.error('[GitHubActionsService] Failed to enable GitHub Actions:', error);
            // Check if it's a permissions error
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('repository secrets') || errorMessage.includes('fine-grained permission')) {
                throw new Error('GitHub account needs the "workflow" scope to manage Actions. Please go to Git Accounts, remove this account, and reconnect it to grant the required permissions.');
            }
            throw new Error(`Failed to enable GitHub Actions: ${errorMessage}`);
        }
    }
    /**
     * Upload secrets to GitHub repository
     */
    async uploadSecrets(options) {
        const { repoOwner, repoName, appName, vpsHost, vpsUser, vpsPort, vpsSSHKey } = options;
        // Convert app name to uppercase with underscores for secret names
        const appNameUpper = appName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const secrets = [
            { name: `VPS_HOST_${appNameUpper}`, value: vpsHost },
            { name: `VPS_USER_${appNameUpper}`, value: vpsUser },
            { name: `VPS_PORT_${appNameUpper}`, value: vpsPort },
            { name: `VPS_SSH_KEY_${appNameUpper}`, value: vpsSSHKey },
        ];
        // Upload each secret
        for (const secret of secrets) {
            console.log(`[GitHubActionsService] Uploading secret: ${secret.name} (value length: ${secret.value?.length || 0})`);
            if (!secret.value) {
                console.error(`[GitHubActionsService] WARNING: Secret ${secret.name} has empty value!`);
            }
            try {
                await this.githubApi.createOrUpdateSecret(repoOwner, repoName, secret.name, secret.value);
                console.log(`[GitHubActionsService] ✅ Successfully uploaded: ${secret.name}`);
            }
            catch (error) {
                console.error(`[GitHubActionsService] ❌ Failed to upload ${secret.name}:`, error);
                throw error;
            }
        }
    }
    /**
     * Generate workflow file content from template
     */
    generateWorkflowContent(options) {
        const { appName, branch, workingDirectory, installCommand, buildCommand } = options;
        // Read template file
        const templatePath = (0, path_1.join)(__dirname, '../templates/github-actions-deploy.yml');
        let template = (0, fs_1.readFileSync)(templatePath, 'utf-8');
        // Replace placeholders
        const appNameUpper = appName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        template = template.replace(/\{\{APP_NAME\}\}/g, appName);
        template = template.replace(/\{\{APP_NAME_UPPER\}\}/g, appNameUpper);
        template = template.replace(/\{\{BRANCH\}\}/g, branch);
        template = template.replace(/\{\{WORKING_DIRECTORY\}\}/g, workingDirectory);
        template = template.replace(/\{\{INSTALL_COMMAND\}\}/g, installCommand);
        template = template.replace(/\{\{BUILD_COMMAND\}\}/g, buildCommand);
        return template;
    }
    /**
     * Get workflow file SHA from GitHub
     */
    async getWorkflowFileSha(repoOwner, repoName, appName) {
        try {
            const content = await this.githubApi.getFileContent(repoOwner, repoName, this.getWorkflowPath(appName));
            // The GitHub API returns the file data with SHA, but we're getting content here
            // For now, we'll return null and can enhance this later if needed
            return content ? 'sha-placeholder' : null;
        }
        catch (error) {
            console.warn('[GitHubActionsService] Could not get workflow file SHA:', error);
            return null;
        }
    }
    /**
     * Get server connection details from database
     */
    getServerDetails(serverId) {
        const server = db_1.db
            .prepare('SELECT host, username, port FROM servers WHERE id = ? LIMIT 1')
            .get(serverId);
        if (!server) {
            throw new Error('Server not found');
        }
        return server;
    }
    /**
     * Save GitHub Actions configuration to database
     */
    saveConfig(options) {
        const { serverId, appName, repoOwner, repoName, branch, workingDirectory, installCommand, buildCommand, sshKeyPath, workflowFileSha, } = options;
        const now = Date.now();
        db_1.db.prepare(`
      INSERT INTO github_actions_config (
        id, server_id, app_name, repo_owner, repo_name, branch,
        working_directory, install_command, build_command,
        ssh_key_path, workflow_file_sha, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(server_id, app_name) DO UPDATE SET
        repo_owner = excluded.repo_owner,
        repo_name = excluded.repo_name,
        branch = excluded.branch,
        working_directory = excluded.working_directory,
        install_command = excluded.install_command,
        build_command = excluded.build_command,
        ssh_key_path = excluded.ssh_key_path,
        workflow_file_sha = excluded.workflow_file_sha,
        is_active = 1,
        updated_at = excluded.updated_at
    `).run(`gha-${serverId}-${appName}`, serverId, appName, repoOwner, repoName, branch, workingDirectory, installCommand, buildCommand, sshKeyPath, workflowFileSha, now, now);
    }
    /**
     * Get GitHub Actions configuration for an app
     */
    getConfig(serverId, appName) {
        const config = db_1.db
            .prepare('SELECT * FROM github_actions_config WHERE server_id = ? AND app_name = ? LIMIT 1')
            .get(serverId, appName);
        return config || null;
    }
    /**
     * Check if GitHub Actions is enabled for an app
     */
    isEnabled(serverId, appName) {
        const config = this.getConfig(serverId, appName);
        return config !== null && config.is_active === 1;
    }
    /**
     * Disable GitHub Actions for an app (soft delete + workflow file removal)
     */
    async disable(serverId, appName) {
        console.log(`[GitHubActionsService] 🔴 DISABLE called for app: ${appName}, server: ${serverId}`);
        const config = this.getConfig(serverId, appName);
        if (!config) {
            console.error(`[GitHubActionsService] ❌ No config found for ${appName}`);
            throw new Error('GitHub Actions is not enabled for this app');
        }
        console.log(`[GitHubActionsService] Found config:`, {
            repo_owner: config.repo_owner,
            repo_name: config.repo_name,
            branch: config.branch,
        });
        try {
            // Get the GitHub account username associated with this app
            console.log(`[GitHubActionsService] Looking up app binding in database...`);
            const appBinding = db_1.db.prepare(`
        SELECT git_account_id FROM app_git_bindings
        WHERE server_id = ? AND app_name = ?
      `).get(serverId, appName);
            let githubUsername;
            if (appBinding) {
                console.log(`[GitHubActionsService] Found app binding, git_account_id: ${appBinding.git_account_id}`);
                const gitAccount = db_1.db.prepare(`
          SELECT username FROM git_accounts
          WHERE id = ?
        `).get(appBinding.git_account_id);
                githubUsername = gitAccount?.username;
                console.log(`[GitHubActionsService] ✅ Using GitHub account: ${githubUsername || 'NOT FOUND'}`);
            }
            else {
                console.log(`[GitHubActionsService] ⚠️ No app binding found, using default GitHub account`);
            }
            // Delete the workflow file from GitHub repository
            const workflowPath = this.getWorkflowPath(appName);
            console.log(`[GitHubActionsService] 🗑️ Attempting to delete workflow file...`);
            console.log(`[GitHubActionsService]   - Owner: ${config.repo_owner}`);
            console.log(`[GitHubActionsService]   - Repo: ${config.repo_name}`);
            console.log(`[GitHubActionsService]   - Path: ${workflowPath}`);
            console.log(`[GitHubActionsService]   - Username: ${githubUsername || 'default'}`);
            await this.githubApi.deleteFile(config.repo_owner, config.repo_name, workflowPath, `Disable ServerCompass auto-deploy for ${appName}`, githubUsername);
            console.log(`[GitHubActionsService] ✅ Successfully deleted workflow file for ${appName}`);
        }
        catch (error) {
            console.error(`[GitHubActionsService] ❌ Failed to delete workflow file for ${appName}:`);
            console.error(`[GitHubActionsService]   Error name: ${error?.name}`);
            console.error(`[GitHubActionsService]   Error message: ${error?.message}`);
            console.error(`[GitHubActionsService]   Error status: ${error?.status}`);
            console.error(`[GitHubActionsService]   Full error:`, error);
            // Continue with database update even if file deletion fails
            // (file might already be deleted manually)
        }
        // Mark as inactive in database
        console.log(`[GitHubActionsService] Marking as inactive in database...`);
        db_1.db.prepare('UPDATE github_actions_config SET is_active = 0, updated_at = ? WHERE server_id = ? AND app_name = ?').run(Date.now(), serverId, appName);
        console.log(`[GitHubActionsService] ✅ Disabled GitHub Actions for ${appName}`);
    }
    /**
     * Get workflow runs for an app
     */
    async getWorkflowRuns(serverId, appName, options) {
        const config = this.getConfig(serverId, appName);
        if (!config) {
            return [];
        }
        try {
            return await this.githubApi.getWorkflowRuns(config.repo_owner, config.repo_name, options);
        }
        catch (error) {
            console.error('[GitHubActionsService] Failed to get workflow runs:', error);
            return [];
        }
    }
    /**
     * Trigger a manual deployment via workflow dispatch
     */
    async triggerManualDeploy(serverId, appName) {
        const config = this.getConfig(serverId, appName);
        if (!config) {
            throw new Error('GitHub Actions is not enabled for this app');
        }
        try {
            // Extract just the filename from the workflow path for the API call
            const workflowFileName = `server-compass-deploy-${appName}.yml`;
            await this.githubApi.triggerWorkflowDispatch(config.repo_owner, config.repo_name, workflowFileName, config.branch);
            console.log(`[GitHubActionsService] Triggered manual deployment for ${appName}`);
        }
        catch (error) {
            console.error('[GitHubActionsService] Failed to trigger manual deployment:', error);
            throw new Error(`Failed to trigger manual deployment: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Sync workflow file if it has been modified
     */
    async syncWorkflow(serverId, appName) {
        const config = this.getConfig(serverId, appName);
        if (!config) {
            return { synced: false, message: 'GitHub Actions is not enabled' };
        }
        try {
            // Generate expected workflow content
            const expectedContent = this.generateWorkflowContent({
                appName,
                branch: config.branch,
                workingDirectory: config.working_directory,
                installCommand: config.install_command,
                buildCommand: config.build_command,
            });
            // Get current workflow file
            const currentContent = await this.githubApi.getFileContent(config.repo_owner, config.repo_name, this.getWorkflowPath(appName));
            // Compare content
            if (currentContent === expectedContent) {
                return { synced: true, message: 'Workflow file is up to date' };
            }
            // Update workflow file
            await this.githubApi.createWorkflowFile(config.repo_owner, config.repo_name, this.getWorkflowPath(appName), expectedContent);
            return { synced: true, message: 'Workflow file has been updated' };
        }
        catch (error) {
            console.error('[GitHubActionsService] Failed to sync workflow:', error);
            return {
                synced: false,
                message: `Failed to sync: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    /**
     * Update GitHub Actions configuration
     */
    async updateConfig(serverId, appName, updates) {
        const config = this.getConfig(serverId, appName);
        if (!config) {
            throw new Error('GitHub Actions is not enabled for this app');
        }
        // Build update query dynamically
        const fields = [];
        const values = [];
        if (updates.branch !== undefined) {
            fields.push('branch = ?');
            values.push(updates.branch);
        }
        if (updates.workingDirectory !== undefined) {
            fields.push('working_directory = ?');
            values.push(updates.workingDirectory);
        }
        if (updates.installCommand !== undefined) {
            fields.push('install_command = ?');
            values.push(updates.installCommand);
        }
        if (updates.buildCommand !== undefined) {
            fields.push('build_command = ?');
            values.push(updates.buildCommand);
        }
        if (fields.length === 0) {
            return; // No updates
        }
        fields.push('updated_at = ?');
        values.push(Date.now());
        values.push(serverId, appName);
        db_1.db.prepare(`UPDATE github_actions_config SET ${fields.join(', ')} WHERE server_id = ? AND app_name = ?`).run(...values);
        // Sync workflow file with new configuration
        await this.syncWorkflow(serverId, appName);
        console.log(`[GitHubActionsService] Updated configuration for ${appName}`);
    }
}
exports.GitHubActionsService = GitHubActionsService;
exports.githubActionsService = new GitHubActionsService();
//# sourceMappingURL=GitHubActionsService.js.map