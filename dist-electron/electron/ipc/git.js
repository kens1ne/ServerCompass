"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGitHandlers = registerGitHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const SSHService_1 = require("../services/SSHService");
const GitAccountService_1 = require("../services/GitAccountService");
const GitHubActionsService_1 = require("../services/GitHubActionsService");
const db_1 = require("../db");
function registerGitHandlers() {
    // Check GitHub SSH connection status
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_CHECK_CONNECTION, async (_event, input) => {
        try {
            const { serverId } = types_1.GitCheckConnectionSchema.parse(input);
            // Execute ssh with options to bypass host key verification prompts
            // -o StrictHostKeyChecking=no: Skip the "Are you sure?" prompt
            // -T: Disable pseudo-terminal allocation
            // -v: Verbose output for debugging
            const result = await SSHService_1.sshService.executeCommand(serverId, 'ssh -o StrictHostKeyChecking=no -vT git@github.com 2>&1 || true');
            const output = result.stdout + result.stderr;
            // Parse the output to determine configuration status
            const isConfigured = output.includes('successfully authenticated');
            // Extract username if authenticated
            let username;
            const usernameMatch = output.match(/Hi ([^!]+)!/);
            if (usernameMatch) {
                username = usernameMatch[1];
            }
            // Extract key path if present
            let keyPath;
            const keyPathMatch = output.match(/identity file ([^\s]+)/);
            if (keyPathMatch) {
                keyPath = keyPathMatch[1];
            }
            const connectionStatus = {
                isConfigured,
                username,
                keyPath,
                rawOutput: output,
            };
            // Save status to database for caching
            db_1.queries.saveGitConnectionStatus({
                serverId,
                isConfigured,
                username,
                keyPath,
                rawOutput: output,
            });
            return {
                success: true,
                data: connectionStatus,
            };
        }
        catch (error) {
            console.error('Error checking GitHub connection:', error);
            return { success: false, error: String(error) };
        }
    });
    // Generate SSH key on VPS
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_GENERATE_KEY, async (_event, input) => {
        try {
            const { serverId, keyName } = types_1.GitGenerateKeySchema.parse(input);
            // Count existing github-vps keys to generate unique name
            const countResult = await SSHService_1.sshService.executeCommand(serverId, 'ls ~/.ssh/github-vps* 2>/dev/null | wc -l || echo 0');
            const count = parseInt(countResult.stdout.trim()) || 0;
            // Determine key name
            const finalKeyName = keyName || (count === 0 ? 'github-vps' : `github-vps-${Math.floor(count / 2) + 1}`);
            const keyPath = `~/.ssh/${finalKeyName}`;
            // Remove any existing key with the same name to avoid interactive prompts
            await SSHService_1.sshService.executeCommand(serverId, `rm -f ${keyPath} ${keyPath}.pub && ssh-keygen -q -o -t ed25519 -C "vps@github" -f ${keyPath} -N ""`);
            // Set proper permissions
            const chmodCmd = `chmod 600 ${keyPath} && chmod 644 ${keyPath}.pub`;
            await SSHService_1.sshService.executeCommand(serverId, chmodCmd);
            // Read the public key
            const readKeyResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${keyPath}.pub`);
            const publicKey = readKeyResult.stdout.trim();
            return {
                success: true,
                data: {
                    publicKey,
                    keyPath,
                },
            };
        }
        catch (error) {
            console.error('Error generating SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
    // Read public key content
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_READ_PUBLIC_KEY, async (_event, input) => {
        try {
            const { serverId, keyPath } = types_1.GitReadPublicKeySchema.parse(input);
            const result = await SSHService_1.sshService.executeCommand(serverId, `cat ${keyPath}.pub`);
            return {
                success: true,
                data: {
                    content: result.stdout.trim(),
                },
            };
        }
        catch (error) {
            console.error('Error reading public key:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_READ_PRIVATE_KEY, async (_event, input) => {
        try {
            const { serverId, keyPath } = types_1.GitReadPrivateKeySchema.parse(input);
            // Security: Read private key (this is sensitive!)
            const result = await SSHService_1.sshService.executeCommand(serverId, `cat ${keyPath}`);
            return {
                success: true,
                data: {
                    content: result.stdout.trim(),
                },
            };
        }
        catch (error) {
            console.error('Error reading private key:', error);
            return { success: false, error: String(error) };
        }
    });
    // Configure SSH config file for GitHub
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_CONFIGURE_SSH, async (_event, input) => {
        try {
            const { serverId, keyPath } = types_1.GitConfigureSSHSchema.parse(input);
            // Create ~/.ssh directory if it doesn't exist
            await SSHService_1.sshService.executeCommand(serverId, 'mkdir -p ~/.ssh');
            // Add GitHub's host key to known_hosts to avoid host key verification failure
            // Remove any existing GitHub entries to avoid duplicates, then add fresh ones
            await SSHService_1.sshService.executeCommand(serverId, 'ssh-keygen -R github.com 2>/dev/null || true');
            await SSHService_1.sshService.executeCommand(serverId, 'ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null');
            // Set proper permissions for known_hosts
            await SSHService_1.sshService.executeCommand(serverId, 'chmod 600 ~/.ssh/known_hosts 2>/dev/null || true');
            // Check if config file exists
            const checkConfigResult = await SSHService_1.sshService.executeCommand(serverId, 'test -f ~/.ssh/config && echo "exists" || echo "not exists"');
            const configExists = checkConfigResult.stdout.trim() === 'exists';
            // Check if GitHub config already exists
            let githubConfigExists = false;
            if (configExists) {
                const checkGithubResult = await SSHService_1.sshService.executeCommand(serverId, 'grep -q "Host github.com" ~/.ssh/config && echo "exists" || echo "not exists"');
                githubConfigExists = checkGithubResult.stdout.trim() === 'exists';
            }
            if (githubConfigExists) {
                // Update existing GitHub config
                const updateCmd = `sed -i '/Host github.com/,/^$/c\\
Host github.com\\
  HostName github.com\\
  User git\\
  IdentityFile ${keyPath}\\
  IdentitiesOnly yes\\
' ~/.ssh/config`;
                await SSHService_1.sshService.executeCommand(serverId, updateCmd);
            }
            else {
                // Append new GitHub config
                const appendCmd = `cat >> ~/.ssh/config << 'EOF'

Host github.com
  HostName github.com
  User git
  IdentityFile ${keyPath}
  IdentitiesOnly yes
EOF`;
                await SSHService_1.sshService.executeCommand(serverId, appendCmd);
            }
            // Set proper permissions
            await SSHService_1.sshService.executeCommand(serverId, 'chmod 600 ~/.ssh/config');
            // Test the connection (with StrictHostKeyChecking=no to avoid prompts)
            await SSHService_1.sshService.executeCommand(serverId, 'ssh -o StrictHostKeyChecking=no -T git@github.com 2>&1 || true');
            return { success: true };
        }
        catch (error) {
            console.error('Error configuring SSH:', error);
            return { success: false, error: String(error) };
        }
    });
    // Detect framework from repository
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_DETECT_FRAMEWORK, async (_event, input) => {
        try {
            const { serverId, repoUrl, branch } = types_1.GitDetectFrameworkSchema.parse(input);
            const detection = await GitAccountService_1.gitAccountService.detectFramework(serverId, repoUrl, branch || 'main');
            return {
                success: true,
                data: detection,
            };
        }
        catch (error) {
            console.error('Error detecting framework:', error);
            return { success: false, error: String(error) };
        }
    });
    // List SSH public keys
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_LIST_SSH_KEYS, async (_event, input) => {
        try {
            const { serverId } = types_1.GitListSSHKeysSchema.parse(input);
            const keys = await GitAccountService_1.gitAccountService.listSSHKeys(serverId);
            return {
                success: true,
                data: keys,
            };
        }
        catch (error) {
            console.error('Error listing SSH keys:', error);
            return { success: false, error: String(error) };
        }
    });
    // Fetch available branches from a deployed app's repository
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_FETCH_BRANCHES, async (_event, input) => {
        try {
            const { serverId, appName, workingDirectory: providedWorkingDirectory } = types_1.GitFetchBranchesSchema.parse(input);
            // Get working directory from either the provided parameter or GitHub Actions config
            let workingDirectory = providedWorkingDirectory;
            if (!workingDirectory) {
                // Fall back to GitHub Actions config if working directory not provided
                const githubActionsConfig = GitHubActionsService_1.githubActionsService.getConfig(serverId, appName);
                workingDirectory = githubActionsConfig?.working_directory || undefined;
            }
            if (!workingDirectory) {
                return {
                    success: false,
                    error: 'Working directory not provided and deployment not configured',
                };
            }
            // Fetch all branches and parse the output
            const fetchResult = await SSHService_1.sshService.executeCommand(serverId, `cd ${workingDirectory} && git fetch --all 2>&1`);
            if (fetchResult.exitCode !== 0 && !fetchResult.stdout.toLowerCase().includes('fetching')) {
                // Fetch might fail but we can still proceed with listing branches
                console.warn('Git fetch had issues:', fetchResult.stderr);
            }
            // Get all branches (both local and remote)
            const branchResult = await SSHService_1.sshService.executeCommand(serverId, `cd ${workingDirectory} && git branch -a 2>&1`);
            if (branchResult.exitCode !== 0) {
                return {
                    success: false,
                    error: `Failed to list branches: ${branchResult.stderr}`,
                };
            }
            // Parse branch names from the output
            const branches = branchResult.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                // Remove git markers (* for current branch, + for checked out in worktree)
                .map((line) => {
                // Handle lines like "* main", "+ feat/new-feature", "  remotes/origin/main"
                let branchName = line.replace(/^[\*\+\s]+/, '').trim();
                // Remove remotes/ prefix to show cleaner branch names
                if (branchName.startsWith('remotes/origin/')) {
                    branchName = branchName.replace('remotes/origin/', '');
                }
                return branchName;
            })
                // Remove duplicates (same branch might appear as both local and remote)
                .filter((branch, index, arr) => index === arr.indexOf(branch))
                // Filter out HEAD reference
                .filter((branch) => branch !== 'HEAD' && !branch.endsWith('-> origin/main'));
            return {
                success: true,
                data: branches.sort(),
            };
        }
        catch (error) {
            console.error('Error fetching branches:', error);
            return { success: false, error: String(error) };
        }
    });
    // List SSH keys on the remote server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_LIST_SERVER_KEYS, async (_event, input) => {
        try {
            const { serverId } = types_1.GitListServerKeysSchema.parse(input);
            // List all private keys in ~/.ssh directory
            const listKeysCmd = `find ~/.ssh -maxdepth 1 -type f ! -name "*.pub" ! -name "config" ! -name "known_hosts*" ! -name "authorized_keys*" 2>/dev/null || true`;
            const result = await SSHService_1.sshService.executeCommand(serverId, listKeysCmd);
            const keyPaths = result.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            const keys = [];
            // Get fingerprint and type for each key
            for (const keyPath of keyPaths) {
                const basename = keyPath.split('/').pop() || keyPath;
                // Try to get fingerprint
                const fingerprintResult = await SSHService_1.sshService.executeCommand(serverId, `ssh-keygen -lf ${keyPath} 2>/dev/null || echo ""`);
                let fingerprint;
                let type;
                if (fingerprintResult.stdout.trim()) {
                    // Parse output like: "2048 SHA256:xxx... user@host (RSA)"
                    const match = fingerprintResult.stdout.match(/^\d+\s+([^\s]+)\s+.*?\(([^)]+)\)/);
                    if (match) {
                        fingerprint = match[1];
                        type = match[2];
                    }
                }
                keys.push({
                    name: basename,
                    path: keyPath,
                    fingerprint,
                    type,
                });
            }
            return {
                success: true,
                data: keys,
            };
        }
        catch (error) {
            console.error('Error listing server SSH keys:', error);
            return { success: false, error: String(error) };
        }
    });
    // Test GitHub connection with a specific SSH key
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_TEST_KEY_CONNECTION, async (_event, input) => {
        try {
            const { serverId, keyPath } = types_1.GitTestKeyConnectionSchema.parse(input);
            // Test connection with specific key using ssh -i flag
            // -i: Specify identity file (private key)
            // -o StrictHostKeyChecking=no: Skip host key verification prompt
            // -o IdentitiesOnly=yes: Only use the specified key
            // -T: Disable pseudo-terminal allocation
            // -v: Verbose output for debugging
            const testCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -vT git@github.com 2>&1 || true`;
            const result = await SSHService_1.sshService.executeCommand(serverId, testCmd);
            const output = result.stdout + result.stderr;
            // Parse the output to determine configuration status
            const isConfigured = output.includes('successfully authenticated');
            // Extract username if authenticated
            let username;
            const usernameMatch = output.match(/Hi ([^!]+)!/);
            if (usernameMatch) {
                username = usernameMatch[1];
            }
            const connectionStatus = {
                isConfigured,
                username,
                keyPath,
                rawOutput: output,
            };
            // Save status to database if configured successfully
            if (isConfigured) {
                db_1.queries.saveGitConnectionStatus({
                    serverId,
                    isConfigured,
                    username,
                    keyPath,
                    rawOutput: output,
                });
            }
            return {
                success: true,
                data: connectionStatus,
            };
        }
        catch (error) {
            console.error('Error testing key connection:', error);
            return { success: false, error: String(error) };
        }
    });
    // Delete SSH key from the remote server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_DELETE_SERVER_KEY, async (_event, input) => {
        try {
            const { serverId, keyPath } = types_1.GitDeleteServerKeySchema.parse(input);
            // Delete both private and public keys
            const deleteCmd = `rm -f ${keyPath} ${keyPath}.pub`;
            await SSHService_1.sshService.executeCommand(serverId, deleteCmd);
            return {
                success: true,
            };
        }
        catch (error) {
            console.error('Error deleting SSH key:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_RENAME_SERVER_KEY, async (_event, input) => {
        try {
            const { serverId, oldPath, newName } = types_1.GitRenameServerKeySchema.parse(input);
            // Validate new name (no path separators, no special characters)
            if (newName.includes('/') || newName.includes('..') || newName.startsWith('.')) {
                throw new Error('Invalid key name');
            }
            // Get directory from old path
            const directory = oldPath.substring(0, oldPath.lastIndexOf('/'));
            const newPath = `${directory}/${newName}`;
            // Check if target already exists
            const checkCmd = `test -f ${newPath} && echo "exists" || echo "ok"`;
            const checkResult = await SSHService_1.sshService.executeCommand(serverId, checkCmd);
            if (checkResult.stdout.trim() === 'exists') {
                throw new Error('A key with this name already exists');
            }
            // Rename both private and public keys
            const renameCmd = `mv ${oldPath} ${newPath} && mv ${oldPath}.pub ${newPath}.pub`;
            await SSHService_1.sshService.executeCommand(serverId, renameCmd);
            return {
                success: true,
                data: { newPath },
            };
        }
        catch (error) {
            console.error('Error renaming SSH key:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // --- Multi-account Git handlers ---
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_CREATE_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.CreateGitAccountSchema.parse(input);
            const account = await GitAccountService_1.gitAccountService.createAccount(payload);
            return { success: true, data: account };
        }
        catch (error) {
            console.error('Error creating Git account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_UPDATE_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.UpdateGitAccountSchema.parse(input);
            const account = await GitAccountService_1.gitAccountService.updateAccount(payload);
            return { success: true, data: account };
        }
        catch (error) {
            console.error('Error updating Git account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_LIST_ACCOUNTS, async (_event, input) => {
        try {
            const payload = types_1.ListGitAccountsSchema.parse(input);
            const accounts = await GitAccountService_1.gitAccountService.listAccounts(payload.serverId, payload.provider);
            return { success: true, data: accounts };
        }
        catch (error) {
            console.error('Error listing Git accounts:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_DELETE_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.GitAccountIdSchema.parse(input);
            await GitAccountService_1.gitAccountService.deleteAccount(payload.accountId);
            return { success: true };
        }
        catch (error) {
            console.error('Error deleting Git account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_REVOKE_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.GitAccountIdSchema.parse(input);
            await GitAccountService_1.gitAccountService.revokeAccess(payload.accountId);
            return { success: true };
        }
        catch (error) {
            console.error('Error revoking Git account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_CHECK_ACCOUNT_STATUS, async (_event, input) => {
        try {
            const payload = types_1.GitAccountStatusSchema.parse(input);
            const result = await GitAccountService_1.gitAccountService.checkAccountStatus(payload.accountId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error checking Git account status:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_TEST_SSH_KEY, async (_event, input) => {
        try {
            const payload = types_1.GitTestSSHKeySchema.parse(input);
            const result = await GitAccountService_1.gitAccountService.testSSHKey(payload.serverId, payload.accountId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error testing SSH key:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_DETECT_MISMATCHED_REPOS, async (_event, input) => {
        try {
            const payload = types_1.GitDetectMismatchedReposSchema.parse(input);
            const result = await GitAccountService_1.gitAccountService.detectMismatchedRepositories(payload.serverId, payload.accountId);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error detecting mismatched repositories:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_FIX_REPOSITORY_REMOTES, async (_event, input) => {
        try {
            const payload = types_1.GitFixRepositoryRemotesSchema.parse(input);
            const result = await GitAccountService_1.gitAccountService.fixRepositoryRemotes(payload.serverId, payload.accountId, payload.repoPaths);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error fixing repository remotes:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_SET_DEFAULT_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.GitSetDefaultAccountSchema.parse(input);
            await GitAccountService_1.gitAccountService.setDefaultAccount(payload.serverId, payload.gitAccountId);
            return { success: true };
        }
        catch (error) {
            console.error('Error setting default Git account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_GET_REPOS, async (_event, input) => {
        try {
            const payload = types_1.GitGetReposSchema.parse(input);
            const repos = await GitAccountService_1.gitAccountService.getRepositories(payload.gitAccountId, payload.page ?? 1, payload.perPage ?? 30);
            return { success: true, data: repos };
        }
        catch (error) {
            console.error('Error fetching repositories for account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_BIND_APP, async (_event, input) => {
        try {
            const payload = types_1.GitBindAppSchema.parse(input);
            await GitAccountService_1.gitAccountService.bindApp(payload);
            return { success: true };
        }
        catch (error) {
            console.error('Error binding Git account to app:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_GET_ACCOUNT_MAPPINGS, async (_event, input) => {
        try {
            const payload = types_1.GitAccountMappingsSchema.parse(input);
            const mappings = await GitAccountService_1.gitAccountService.getAccountMappings(payload.serverId);
            return { success: true, data: mappings };
        }
        catch (error) {
            console.error('Error loading Git account mappings:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_CLONE_WITH_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.GitCloneWithAccountSchema.parse(input);
            await GitAccountService_1.gitAccountService.cloneWithAccount(payload.serverId, payload.gitAccountId, payload.repository, payload.targetPath, payload.branch);
            return { success: true };
        }
        catch (error) {
            console.error('Error cloning repository with Git account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GIT_SWITCH_REPO_ACCOUNT, async (_event, input) => {
        try {
            const payload = types_1.GitSwitchRepoAccountSchema.parse(input);
            await GitAccountService_1.gitAccountService.switchRepoAccount(payload.serverId, payload.repoPath, payload.gitAccountId, payload.repository);
            return { success: true };
        }
        catch (error) {
            console.error('Error switching repository account:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
}
//# sourceMappingURL=git.js.map