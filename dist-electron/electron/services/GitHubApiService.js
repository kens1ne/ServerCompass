"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubApiService = void 0;
const rest_1 = require("@octokit/rest");
const SecureStorageService_1 = require("./SecureStorageService");
const libsodium_wrappers_1 = __importDefault(require("libsodium-wrappers"));
/**
 * GitHub API service using Octokit
 * Handles repository operations, framework detection, etc.
 */
class GitHubApiService {
    octokitInstances = new Map();
    storage;
    constructor() {
        this.storage = new SecureStorageService_1.SecureStorageService();
    }
    /**
     * Initialize Octokit with stored token for a specific account
     */
    async getOctokit(username) {
        // Get username (use provided or active account)
        const accountUsername = username || await this.storage.getActiveAccount();
        if (!accountUsername) {
            throw new Error('Not authenticated. Please sign in to GitHub first.');
        }
        // Return cached instance if exists
        if (this.octokitInstances.has(accountUsername)) {
            return this.octokitInstances.get(accountUsername);
        }
        // Get token for this account
        const token = await this.storage.getGitHubToken(accountUsername);
        if (!token) {
            throw new Error('Not authenticated. Please sign in to GitHub first.');
        }
        // Create new instance
        const octokit = new rest_1.Octokit({
            auth: token,
            userAgent: 'ServerCompass/1.0.0',
        });
        this.octokitInstances.set(accountUsername, octokit);
        return octokit;
    }
    /**
     * Reset Octokit instance for a specific account
     */
    resetOctokit(username) {
        if (username) {
            this.octokitInstances.delete(username);
        }
        else {
            this.octokitInstances.clear();
        }
    }
    /**
     * Get user's repositories
     */
    async getRepositories(options) {
        const octokit = await this.getOctokit(options?.username);
        try {
            const { data } = await octokit.repos.listForAuthenticatedUser({
                sort: options?.sort || 'updated',
                direction: options?.direction || 'desc',
                per_page: options?.per_page || 100,
                type: 'all', // Include all repos (owner, collaborator, organization)
            });
            console.log(`[GitHubAPI] Retrieved ${data.length} repositories`);
            return data;
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get repositories:', error);
            if (error.status === 401) {
                // Token expired or invalid
                const username = options?.username || await this.storage.getActiveAccount();
                if (username) {
                    await this.storage.deleteGitHubToken(username);
                    this.resetOctokit(username);
                }
                throw new Error('Authentication expired. Please sign in again.');
            }
            throw error;
        }
    }
    /**
     * Create a new repository
     */
    async createRepo(options) {
        const octokit = await this.getOctokit(options.username);
        try {
            console.log(`[GitHubAPI] Creating repository: ${options.name}`);
            const { data } = await octokit.repos.createForAuthenticatedUser({
                name: options.name,
                description: options.description,
                private: options.private ?? true,
                auto_init: true, // Initialize with README to create default branch
            });
            console.log(`[GitHubAPI] Repository created: ${data.full_name}`);
            return data;
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to create repository:', error);
            if (error.status === 422) {
                throw new Error(`Repository name "${options.name}" already exists or is invalid`);
            }
            if (error.status === 401) {
                const username = options.username || await this.storage.getActiveAccount();
                if (username) {
                    await this.storage.deleteGitHubToken(username);
                    this.resetOctokit(username);
                }
                throw new Error('Authentication expired. Please sign in again.');
            }
            throw error;
        }
    }
    /**
     * Get file content from a repository
     */
    async getFileContent(owner, repo, path) {
        const octokit = await this.getOctokit();
        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path,
            });
            if ('content' in data && data.content) {
                // Decode base64 content
                return Buffer.from(data.content, 'base64').toString('utf-8');
            }
            return null;
        }
        catch (error) {
            if (error.status === 404) {
                return null; // File not found
            }
            throw error;
        }
    }
    /**
     * Detect framework from repository
     *
     * CRITICAL: The order of checks matters!
     *
     * Matches Nixpacks detection logic via GitHub API (before clone).
     * See: https://nixpacks.com/docs/providers
     *
     * Backend frameworks must be checked FIRST before package.json to prevent
     * false positives. Many backend apps include package.json for frontend assets.
     *
     * Detection Order (matches Nixpacks providers):
     * 1. Ruby/Rails (Gemfile)
     * 2. Python (requirements.txt, pyproject.toml, setup.py, Pipfile, manage.py)
     * 3. PHP/Laravel (composer.json)
     * 4. Go (go.mod)
     * 5. Rust (Cargo.toml)
     * 6. Java (pom.xml, build.gradle)
     * 7. Elixir (mix.exs)
     * 8. Crystal (shard.yml)
     * 9. Swift (Package.swift)
     * 10. Zig (build.zig)
     * 11. Haskell (stack.yaml)
     * 12. Scala (build.sbt)
     * 13. Clojure (deps.edn, project.clj)
     * 14. Dart (pubspec.yaml)
     * 15. F#/C#/.NET (*.fsproj, *.csproj)
     * 16. Deno (deno.json, deno.jsonc)
     * 17. Node.js (package.json) - LAST to avoid false positives
     * 18. Static (index.html without package.json)
     * 19. Docker (Dockerfile) - final fallback
     */
    async detectFramework(owner, repo) {
        console.log(`[GitHubAPI] Detecting framework for ${owner}/${repo}`);
        // Helper to check if file exists (returns content or null)
        const fileExists = async (path) => {
            const content = await this.getFileContent(owner, repo, path);
            return content !== null;
        };
        // 1. Ruby/Rails (Gemfile)
        const gemfile = await this.getFileContent(owner, repo, 'Gemfile');
        if (gemfile) {
            if (gemfile.includes('rails')) {
                console.log('[GitHubAPI] Detected: Rails');
                return 'rails';
            }
            console.log('[GitHubAPI] Detected: Ruby');
            return 'ruby';
        }
        // 2. Python (requirements.txt, pyproject.toml, setup.py, Pipfile, manage.py)
        const requirements = await this.getFileContent(owner, repo, 'requirements.txt');
        const pyproject = await fileExists('pyproject.toml');
        const setupPy = await fileExists('setup.py');
        const pipfile = await fileExists('Pipfile');
        const managePy = await fileExists('manage.py');
        if (requirements || pyproject || setupPy || pipfile || managePy) {
            // Check for specific frameworks
            if (requirements?.toLowerCase().includes('django') || managePy) {
                console.log('[GitHubAPI] Detected: Django');
                return 'django';
            }
            if (requirements?.toLowerCase().includes('flask')) {
                console.log('[GitHubAPI] Detected: Flask');
                return 'flask';
            }
            if (requirements?.toLowerCase().includes('fastapi')) {
                console.log('[GitHubAPI] Detected: FastAPI');
                return 'fastapi';
            }
            console.log('[GitHubAPI] Detected: Python');
            return 'python';
        }
        // 3. PHP/Laravel (composer.json)
        const composerJson = await this.getFileContent(owner, repo, 'composer.json');
        if (composerJson) {
            if (composerJson.includes('laravel/framework')) {
                console.log('[GitHubAPI] Detected: Laravel');
                return 'laravel';
            }
            console.log('[GitHubAPI] Detected: PHP');
            return 'php';
        }
        // 4. Go (go.mod)
        if (await fileExists('go.mod')) {
            console.log('[GitHubAPI] Detected: Go');
            return 'go';
        }
        // 5. Rust (Cargo.toml)
        if (await fileExists('Cargo.toml')) {
            console.log('[GitHubAPI] Detected: Rust');
            return 'rust';
        }
        // 6. Java (pom.xml, build.gradle)
        if (await fileExists('pom.xml') || await fileExists('build.gradle')) {
            console.log('[GitHubAPI] Detected: Java');
            return 'java';
        }
        // 7. Elixir (mix.exs)
        if (await fileExists('mix.exs')) {
            console.log('[GitHubAPI] Detected: Elixir');
            return 'elixir';
        }
        // 8. Crystal (shard.yml)
        if (await fileExists('shard.yml')) {
            console.log('[GitHubAPI] Detected: Crystal');
            return 'crystal';
        }
        // 9. Swift (Package.swift)
        if (await fileExists('Package.swift')) {
            console.log('[GitHubAPI] Detected: Swift');
            return 'swift';
        }
        // 10. Zig (build.zig)
        if (await fileExists('build.zig')) {
            console.log('[GitHubAPI] Detected: Zig');
            return 'zig';
        }
        // 11. Haskell (stack.yaml)
        if (await fileExists('stack.yaml')) {
            console.log('[GitHubAPI] Detected: Haskell');
            return 'haskell';
        }
        // 12. Scala (build.sbt)
        if (await fileExists('build.sbt')) {
            console.log('[GitHubAPI] Detected: Scala');
            return 'scala';
        }
        // 13. Clojure (deps.edn, project.clj)
        if (await fileExists('deps.edn') || await fileExists('project.clj')) {
            console.log('[GitHubAPI] Detected: Clojure');
            return 'clojure';
        }
        // 14. Dart (pubspec.yaml)
        if (await fileExists('pubspec.yaml')) {
            console.log('[GitHubAPI] Detected: Dart');
            return 'dart';
        }
        // 15. Deno (deno.json, deno.jsonc)
        if (await fileExists('deno.json') || await fileExists('deno.jsonc')) {
            console.log('[GitHubAPI] Detected: Deno');
            return 'deno';
        }
        // 16. Node.js (package.json) - checked LAST to avoid false positives
        const packageJson = await this.getFileContent(owner, repo, 'package.json');
        if (packageJson) {
            try {
                const pkg = JSON.parse(packageJson);
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                if (deps.next) {
                    console.log('[GitHubAPI] Detected: Next.js');
                    return 'nextjs';
                }
                if (deps.nuxt) {
                    console.log('[GitHubAPI] Detected: Nuxt');
                    return 'nuxt';
                }
                if (deps['@remix-run/node'] || deps['@remix-run/react']) {
                    console.log('[GitHubAPI] Detected: Remix');
                    return 'remix';
                }
                if (deps.astro) {
                    console.log('[GitHubAPI] Detected: Astro');
                    return 'astro';
                }
                if (deps.svelte || deps['@sveltejs/kit']) {
                    console.log('[GitHubAPI] Detected: Svelte');
                    return 'svelte';
                }
                if (deps.vue) {
                    console.log('[GitHubAPI] Detected: Vue');
                    return 'vue';
                }
                if (deps.react) {
                    console.log('[GitHubAPI] Detected: React');
                    return 'react';
                }
                if (deps['@nestjs/core']) {
                    console.log('[GitHubAPI] Detected: NestJS');
                    return 'nestjs';
                }
                if (deps.fastify) {
                    console.log('[GitHubAPI] Detected: Fastify');
                    return 'fastify';
                }
                if (deps.express) {
                    console.log('[GitHubAPI] Detected: Express');
                    return 'express';
                }
                // Generic Node.js
                console.log('[GitHubAPI] Detected: Node.js');
                return 'nodejs';
            }
            catch {
                console.log('[GitHubAPI] Detected: Node.js (invalid package.json)');
                return 'nodejs';
            }
        }
        // 17. Static (index.html without package.json)
        if (await fileExists('index.html')) {
            console.log('[GitHubAPI] Detected: Static');
            return 'static';
        }
        // 18. Dockerfile as final fallback
        if (await fileExists('Dockerfile')) {
            console.log('[GitHubAPI] Detected: Docker (has Dockerfile)');
            return 'docker';
        }
        console.log('[GitHubAPI] Could not detect framework');
        return null;
    }
    /**
     * Upload SSH public key to GitHub
     */
    async uploadSSHKey(title, publicKey, username) {
        const octokit = await this.getOctokit(username);
        try {
            await octokit.users.createPublicSshKeyForAuthenticatedUser({
                title,
                key: publicKey,
            });
            console.log('[GitHubAPI] SSH key uploaded:', title);
        }
        catch (error) {
            // Check if the key already exists (422 status with "already in use" message)
            if (error.status === 422 && error.message?.toLowerCase().includes('already in use')) {
                console.log('[GitHubAPI] SSH key already exists in GitHub, skipping upload');
                return; // Key already exists, this is fine
            }
            // Handle rate limit errors - throw the original error to preserve metadata
            if (error.status === 403 || error.status === 429) {
                console.error('[GitHubAPI] Rate limit exceeded when uploading SSH key');
                throw error; // Throw original error so formatGitHubError can properly format it
            }
            console.error('[GitHubAPI] Failed to upload SSH key:', error);
            throw error; // Throw original error to preserve status codes and metadata
        }
    }
    /**
     * Create or update a file in repository (for GitHub Actions workflows)
     */
    async createOrUpdateFile(owner, repo, path, content, _message) {
        const octokit = await this.getOctokit();
        try {
            // Check if file exists to get its SHA
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path,
                });
                if ('sha' in data) {
                    sha = data.sha;
                }
            }
            catch (error) {
                if (error.status !== 404)
                    throw error;
                // File doesn't exist, that's fine
            }
            // Create or update file
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path,
                message: sha ? `Update ${path}` : `Add ${path}`,
                content: Buffer.from(content).toString('base64'),
                sha,
            });
            console.log('[GitHubAPI] File created/updated:', path);
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to create/update file:', error);
            throw error;
        }
    }
    /**
     * Create or update multiple files in a single commit
     * More efficient than calling createOrUpdateFile multiple times
     */
    async createOrUpdateMultipleFiles(owner, repo, branch, files, message, username) {
        const octokit = await this.getOctokit(username);
        try {
            // Get the current commit SHA for the branch
            const { data: refData } = await octokit.git.getRef({
                owner,
                repo,
                ref: `heads/${branch}`,
            });
            const currentCommitSha = refData.object.sha;
            // Get the tree SHA from the current commit
            const { data: commitData } = await octokit.git.getCommit({
                owner,
                repo,
                commit_sha: currentCommitSha,
            });
            const baseTreeSha = commitData.tree.sha;
            // Create blobs for each file
            const blobs = await Promise.all(files.map(async (file) => {
                const { data: blob } = await octokit.git.createBlob({
                    owner,
                    repo,
                    content: Buffer.from(file.content).toString('base64'),
                    encoding: 'base64',
                });
                return {
                    path: file.path,
                    mode: '100644',
                    type: 'blob',
                    sha: blob.sha,
                };
            }));
            // Create a new tree with the files
            const { data: newTree } = await octokit.git.createTree({
                owner,
                repo,
                base_tree: baseTreeSha,
                tree: blobs,
            });
            // If nothing changed, skip creating a no-op commit and return current HEAD.
            if (newTree.sha === baseTreeSha) {
                console.log(`[GitHubAPI] No file changes detected for ${owner}/${repo}@${branch}; skipping commit.`);
                return {
                    commitSha: currentCommitSha,
                    changed: false,
                };
            }
            // Create a new commit
            const { data: newCommit } = await octokit.git.createCommit({
                owner,
                repo,
                message,
                tree: newTree.sha,
                parents: [currentCommitSha],
            });
            // Update the branch reference to point to the new commit
            await octokit.git.updateRef({
                owner,
                repo,
                ref: `heads/${branch}`,
                sha: newCommit.sha,
            });
            console.log(`[GitHubAPI] Created commit with ${files.length} file(s):`, files.map(f => f.path).join(', '));
            return {
                commitSha: newCommit.sha,
                changed: true,
            };
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to create multi-file commit:', error);
            throw error;
        }
    }
    /**
     * Delete a file from repository
     */
    async deleteFile(owner, repo, path, message, username) {
        console.log('[GitHubAPI] 🗑️ deleteFile called:');
        console.log(`[GitHubAPI]   - owner: ${owner}`);
        console.log(`[GitHubAPI]   - repo: ${repo}`);
        console.log(`[GitHubAPI]   - path: ${path}`);
        console.log(`[GitHubAPI]   - message: ${message}`);
        console.log(`[GitHubAPI]   - username: ${username || 'default'}`);
        const octokit = await this.getOctokit(username);
        console.log('[GitHubAPI] ✅ Got Octokit instance');
        try {
            // Get file SHA (required for deletion)
            console.log('[GitHubAPI] Fetching file to get SHA...');
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path,
            });
            console.log('[GitHubAPI] File content retrieved:', {
                type: Array.isArray(data) ? 'directory' : 'sha' in data ? 'file' : 'unknown',
                sha: 'sha' in data ? data.sha : 'N/A'
            });
            if (!('sha' in data)) {
                console.error('[GitHubAPI] ❌ Data does not have SHA - not a file');
                throw new Error(`Cannot delete ${path}: not a file`);
            }
            // Delete file
            console.log(`[GitHubAPI] Deleting file with SHA: ${data.sha}`);
            await octokit.repos.deleteFile({
                owner,
                repo,
                path,
                message,
                sha: data.sha,
            });
            console.log('[GitHubAPI] ✅ File deleted successfully:', path);
        }
        catch (error) {
            if (error.status === 404) {
                console.log('[GitHubAPI] ⚠️ File does not exist (404), skipping deletion:', path);
                return;
            }
            console.error('[GitHubAPI] ❌ Failed to delete file:');
            console.error('[GitHubAPI]   Error status:', error.status);
            console.error('[GitHubAPI]   Error message:', error.message);
            console.error('[GitHubAPI]   Full error:', error);
            throw error;
        }
    }
    /**
     * Create GitHub Actions workflow file
     */
    async createWorkflowFile(owner, repo, workflowPath, workflowContent) {
        await this.createOrUpdateFile(owner, repo, workflowPath, workflowContent, 'Add Server Compass deployment workflow');
    }
    /**
     * List SSH keys for authenticated user
     */
    async listSSHKeys() {
        const octokit = await this.getOctokit();
        try {
            const { data } = await octokit.users.listPublicSshKeysForAuthenticatedUser();
            console.log(`[GitHubAPI] Retrieved ${data.length} SSH keys`);
            return data.map(key => ({
                id: key.id,
                title: key.title || '',
                key: key.key,
            }));
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to list SSH keys:', error);
            throw error;
        }
    }
    /**
     * Delete SSH key
     */
    async deleteSSHKey(keyId) {
        const octokit = await this.getOctokit();
        try {
            await octokit.users.deletePublicSshKeyForAuthenticatedUser({
                key_id: keyId,
            });
            console.log('[GitHubAPI] SSH key deleted:', keyId);
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to delete SSH key:', error);
            throw error;
        }
    }
    /**
     * Get repository public key for encrypting secrets
     * Required before uploading secrets to GitHub Actions
     */
    async getRepoPublicKey(owner, repo, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.actions.getRepoPublicKey({
                owner,
                repo,
            });
            console.log('[GitHubAPI] Retrieved repository public key');
            return {
                key_id: data.key_id,
                key: data.key,
            };
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get repository public key:', error);
            throw error;
        }
    }
    /**
     * Encrypt secret value using libsodium (sealed box encryption)
     * This is required by GitHub's secret encryption API
     */
    async encryptSecret(value, publicKey) {
        // Ensure sodium is ready
        await libsodium_wrappers_1.default.ready;
        // Convert the public key from base64 to Uint8Array
        const publicKeyBytes = libsodium_wrappers_1.default.from_base64(publicKey, libsodium_wrappers_1.default.base64_variants.ORIGINAL);
        // Convert the secret value to Uint8Array
        const valueBytes = libsodium_wrappers_1.default.from_string(value);
        // Encrypt using sealed box (anonymous encryption)
        const encryptedBytes = libsodium_wrappers_1.default.crypto_box_seal(valueBytes, publicKeyBytes);
        // Convert encrypted bytes to base64
        const encryptedValue = libsodium_wrappers_1.default.to_base64(encryptedBytes, libsodium_wrappers_1.default.base64_variants.ORIGINAL);
        return encryptedValue;
    }
    /**
     * Create or update a repository secret for GitHub Actions
     */
    async createOrUpdateSecret(owner, repo, secretName, secretValue, username) {
        const octokit = await this.getOctokit(username);
        try {
            console.log(`[GitHubAPI] Creating/updating secret: ${secretName}`);
            console.log(`[GitHubAPI]   - Value length: ${secretValue?.length || 0} chars`);
            console.log('[GitHubAPI]   - Value preview: [REDACTED]');
            // Get repository public key
            const { key_id, key } = await this.getRepoPublicKey(owner, repo, username);
            // Encrypt the secret value
            const encryptedValue = await this.encryptSecret(secretValue, key);
            console.log(`[GitHubAPI]   - Encrypted value length: ${encryptedValue?.length || 0} chars`);
            // Upload the encrypted secret
            await octokit.actions.createOrUpdateRepoSecret({
                owner,
                repo,
                secret_name: secretName,
                encrypted_value: encryptedValue,
                key_id,
            });
            console.log('[GitHubAPI] ✅ Secret created/updated:', secretName);
        }
        catch (error) {
            console.error('[GitHubAPI] ❌ Failed to create/update secret:', secretName, error);
            throw error;
        }
    }
    /**
     * Read repository secret metadata (name + timestamps). Secret values are never readable via GitHub API.
     */
    async getRepoSecretMetadata(owner, repo, secretName, username) {
        const octokit = await this.getOctokit(username);
        const { data } = await octokit.actions.getRepoSecret({
            owner,
            repo,
            secret_name: secretName,
        });
        return {
            name: data.name,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
        };
    }
    /**
     * Get branches for a repository
     */
    async getBranches(owner, repo, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.repos.listBranches({
                owner,
                repo,
                per_page: 100,
            });
            console.log(`[GitHubAPI] Retrieved ${data.length} branches`);
            return data.map(branch => ({
                name: branch.name,
                protected: branch.protected || false,
            }));
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get branches:', error);
            throw error;
        }
    }
    /**
     * Get workflow runs for a repository
     */
    async getWorkflowRuns(owner, repo, options, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.actions.listWorkflowRunsForRepo({
                owner,
                repo,
                per_page: options?.per_page || 30,
                page: options?.page || 1,
                branch: options?.branch,
            });
            // Only log when there are runs (reduces spam during polling)
            // console.log(`[GitHubAPI] Retrieved ${data.workflow_runs.length} workflow runs`);
            return data.workflow_runs.map(run => ({
                id: run.id,
                name: run.name || 'Unnamed Workflow',
                status: run.status || 'unknown',
                conclusion: run.conclusion,
                event: run.event || 'unknown',
                created_at: run.created_at,
                updated_at: run.updated_at,
                html_url: run.html_url,
                head_sha: run.head_sha,
                head_branch: run.head_branch || 'unknown',
                run_number: run.run_number,
                head_commit_message: run.head_commit?.message || null,
            }));
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get workflow runs:', error);
            throw error;
        }
    }
    /**
     * Get workflow runs for a specific workflow file.
     */
    async getWorkflowRunsForWorkflow(owner, repo, workflowId, options, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.actions.listWorkflowRuns({
                owner,
                repo,
                workflow_id: workflowId,
                per_page: options?.per_page || 30,
                page: options?.page || 1,
                branch: options?.branch,
            });
            return data.workflow_runs.map(run => ({
                id: run.id,
                name: run.name || 'Unnamed Workflow',
                status: run.status || 'unknown',
                conclusion: run.conclusion,
                event: run.event || 'unknown',
                created_at: run.created_at,
                updated_at: run.updated_at,
                html_url: run.html_url,
                head_sha: run.head_sha,
                head_branch: run.head_branch || 'unknown',
                run_number: run.run_number,
                head_commit_message: run.head_commit?.message || null,
            }));
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get workflow runs for workflow:', workflowId, error);
            throw error;
        }
    }
    /**
     * Trigger a workflow dispatch event
     * Allows manually triggering workflows that have workflow_dispatch enabled
     */
    async triggerWorkflowDispatch(owner, repo, workflowId, ref, username, inputs) {
        const octokit = await this.getOctokit(username);
        try {
            await octokit.actions.createWorkflowDispatch({
                owner,
                repo,
                workflow_id: workflowId,
                ref,
                inputs,
            });
            console.log('[GitHubAPI] Workflow dispatch triggered:', workflowId);
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to trigger workflow dispatch:', error);
            throw error;
        }
    }
    /**
     * Get the default branch name for a repository.
     */
    async getRepoDefaultBranch(owner, repo, username) {
        const octokit = await this.getOctokit(username);
        const { data } = await octokit.repos.get({ owner, repo });
        return data.default_branch || null;
    }
    /**
     * Get the latest commit SHA for a branch.
     */
    async getBranchHeadSha(owner, repo, branch, username) {
        const octokit = await this.getOctokit(username);
        const { data } = await octokit.git.getRef({
            owner,
            repo,
            ref: `heads/${branch}`,
        });
        return data.object.sha;
    }
    /**
     * Get workflow jobs for a run
     */
    async getWorkflowJobs(owner, repo, runId, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
                owner,
                repo,
                run_id: runId,
            });
            return data.jobs;
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get workflow jobs:', error);
            throw error;
        }
    }
    /**
     * Get job logs
     */
    async getJobLogs(owner, repo, jobId, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
                owner,
                repo,
                job_id: jobId,
                headers: {
                    accept: 'application/vnd.github.v3+json',
                },
            });
            return data;
        }
        catch (error) {
            if (error?.status === 404) {
                console.warn('[GitHubAPI] Job logs not available yet (404). The job may still be running or logs have expired.');
                throw error;
            }
            console.error('[GitHubAPI] Failed to get job logs:', error);
            throw error;
        }
    }
    /**
     * Get workflow run timing
     */
    async getWorkflowTiming(owner, repo, runId, username) {
        const octokit = await this.getOctokit(username);
        try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing', {
                owner,
                repo,
                run_id: runId,
            });
            return data;
        }
        catch (error) {
            console.error('[GitHubAPI] Failed to get workflow timing:', error);
            throw error;
        }
    }
    /**
     * Analyze a repository for Docker deployment
     * Checks for existing docker-compose.yml, Dockerfile, and detects framework
     */
    async analyzeRepoForDocker(owner, repo) {
        console.log(`[GitHubAPI] Analyzing repo for Docker: ${owner}/${repo}`);
        // Check for docker-compose files
        const dockerComposePaths = [
            'docker-compose.yml',
            'docker-compose.yaml',
            'compose.yml',
            'compose.yaml',
        ];
        let hasDockerCompose = false;
        let dockerComposePath = null;
        let dockerComposeContent = null;
        for (const path of dockerComposePaths) {
            const content = await this.getFileContent(owner, repo, path);
            if (content) {
                hasDockerCompose = true;
                dockerComposePath = path;
                dockerComposeContent = content;
                console.log(`[GitHubAPI] Found docker-compose at: ${path}`);
                break;
            }
        }
        // Check for Dockerfile
        let hasDockerfile = false;
        let dockerfileContent = null;
        const dockerfilePath = await this.getFileContent(owner, repo, 'Dockerfile');
        if (dockerfilePath) {
            hasDockerfile = true;
            dockerfileContent = dockerfilePath;
            console.log('[GitHubAPI] Found Dockerfile');
        }
        // Detect framework
        const framework = await this.detectFramework(owner, repo);
        // Detect package manager
        let packageManager = null;
        if (await this.getFileContent(owner, repo, 'pnpm-lock.yaml')) {
            packageManager = 'pnpm';
        }
        else if (await this.getFileContent(owner, repo, 'yarn.lock')) {
            packageManager = 'yarn';
        }
        else if (await this.getFileContent(owner, repo, 'package-lock.json')) {
            packageManager = 'npm';
        }
        // Suggest port based on framework
        let suggestedPort = 3000;
        if (framework === 'react' || framework === 'vue') {
            suggestedPort = 80; // Static sites with nginx
        }
        else if (framework === 'rails') {
            suggestedPort = 3000;
        }
        else if (framework === 'django' || framework === 'flask') {
            suggestedPort = 8000;
        }
        else if (framework === 'rust') {
            suggestedPort = 8080; // Common for Actix, Rocket, Axum
        }
        else if (framework === 'go') {
            suggestedPort = 8080; // Common for Go web frameworks
        }
        return {
            hasDockerCompose,
            hasDockerfile,
            dockerComposePath,
            dockerComposeContent,
            dockerfileContent,
            framework,
            packageManager,
            suggestedPort,
        };
    }
}
exports.GitHubApiService = GitHubApiService;
//# sourceMappingURL=GitHubApiService.js.map