"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NixpacksService = void 0;
exports.createNixpacksService = createNixpacksService;
exports.getNixpacksService = getNixpacksService;
/**
 * Service for managing Nixpacks tool on VPS servers.
 * Handles installation, configuration, and Dockerfile generation.
 */
class NixpacksService {
    sshService;
    installCache = new Map();
    constructor(sshService) {
        this.sshService = sshService;
    }
    injectNextjsNextPublicEnvBuildArg(dockerfile) {
        if (!dockerfile)
            return dockerfile;
        if (dockerfile.includes('SERVER_COMPASS_NEXT_PUBLIC_ENV_B64'))
            return dockerfile;
        // Heuristic: `.next` is Next.js-specific and appears in nixpacks Dockerfiles (cache mounts, rm -rf, etc.)
        const looksLikeNextjs = /\.next\b/i.test(dockerfile);
        if (!looksLikeNextjs)
            return dockerfile;
        const lines = dockerfile.split('\n');
        const buildIndex = lines.findIndex((line) => /^\s*RUN\b.*\b(npm\s+run\s+build|yarn\s+build|pnpm\s+build|npx\s+next\s+build|next\s+build)\b/i.test(line));
        if (buildIndex === -1)
            return dockerfile;
        const injection = [
            'ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64',
            'RUN set -e; if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; fi',
        ];
        lines.splice(buildIndex, 0, ...injection);
        return lines.join('\n');
    }
    /**
     * Check Nixpacks installation status on VPS.
     * Caches results in-memory (keyed by serverId).
     */
    async checkInstallation(serverId) {
        // Check cache first
        if (this.installCache.has(serverId)) {
            return this.installCache.get(serverId);
        }
        try {
            // Execute: nixpacks --version
            const result = await this.sshService.executeCommand(serverId, 'nixpacks --version 2>&1');
            if (result.exitCode === 0 && result.stdout.trim()) {
                const version = result.stdout.trim().replace('nixpacks ', '');
                const status = { installed: true, version };
                this.installCache.set(serverId, status);
                return status;
            }
            const status = { installed: false };
            this.installCache.set(serverId, status);
            return status;
        }
        catch (error) {
            console.error('[NixpacksService] Failed to check installation:', error);
            const status = { installed: false };
            this.installCache.set(serverId, status);
            return status;
        }
    }
    /**
     * Clear the installation cache for a server.
     * Call this after installation to force a fresh check.
     */
    clearCache(serverId) {
        if (serverId) {
            this.installCache.delete(serverId);
        }
        else {
            this.installCache.clear();
        }
    }
    /**
     * Detect framework using Nixpacks on VPS.
     * Runs `nixpacks detect` in the repo directory.
     * Returns the detected provider/framework name.
     */
    async detectFramework(serverId, repoPath) {
        try {
            console.log(`[NixpacksService] Detecting framework for ${repoPath} on server ${serverId}`);
            // Check if Nixpacks is installed
            const status = await this.checkInstallation(serverId);
            if (!status.installed) {
                return {
                    success: false,
                    framework: null,
                    error: 'Nixpacks not installed',
                };
            }
            // Run nixpacks detect - outputs JSON with provider info
            const result = await this.sshService.executeCommand(serverId, `cd "${repoPath}" && nixpacks detect . 2>&1`);
            if (result.exitCode !== 0) {
                console.warn('[NixpacksService] Detection failed:', result.stderr || result.stdout);
                return {
                    success: false,
                    framework: null,
                    error: result.stderr || result.stdout,
                };
            }
            // Parse the output - Nixpacks outputs provider name
            // Example outputs: "node", "python", "go", "rust", "ruby", etc.
            const output = result.stdout.trim().toLowerCase();
            // Map Nixpacks provider names to our framework names
            const frameworkMap = {
                'node': 'nodejs',
                'nodejs': 'nodejs',
                'python': 'python',
                'go': 'go',
                'golang': 'go',
                'rust': 'rust',
                'ruby': 'ruby',
                'php': 'php',
                'java': 'java',
                'staticfile': 'static',
                'static': 'static',
                'deno': 'deno',
                'elixir': 'elixir',
                'haskell': 'haskell',
                'crystal': 'crystal',
                'zig': 'zig',
                'clojure': 'clojure',
                'dart': 'dart',
                'fsharp': 'fsharp',
                'csharp': 'csharp',
                'dotnet': 'dotnet',
                'scala': 'scala',
                'swift': 'swift',
                'cobol': 'cobol',
                'lunatic': 'lunatic',
            };
            const framework = frameworkMap[output] || output || null;
            console.log(`[NixpacksService] Detected framework: ${framework}`);
            return {
                success: true,
                framework,
            };
        }
        catch (error) {
            console.error('[NixpacksService] Detection error:', error);
            return {
                success: false,
                framework: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Install Nixpacks on VPS via SSH.
     * Timeout: 5 minutes.
     */
    async install(serverId) {
        console.log(`[NixpacksService] Installing Nixpacks on server ${serverId}...`);
        // Clear cache before installation
        this.installCache.delete(serverId);
        // Execute: curl -sSL https://nixpacks.com/install.sh | bash
        const result = await this.sshService.executeCommand(serverId, 'curl -sSL https://nixpacks.com/install.sh | bash');
        if (result.exitCode !== 0) {
            // Check for common error patterns
            if (result.stderr.includes('Permission denied')) {
                throw new Error('Permission denied. Please ensure your VPS user has sudo privileges or install Nixpacks manually with: curl -sSL https://nixpacks.com/install.sh | bash');
            }
            if (result.stderr.includes('No space left')) {
                throw new Error('Insufficient disk space on VPS. Please free up space and try again.');
            }
            throw new Error(`Failed to install Nixpacks: ${result.stderr || result.stdout}`);
        }
        // Verify installation
        const versionResult = await this.sshService.executeCommand(serverId, 'nixpacks --version');
        if (versionResult.exitCode !== 0) {
            throw new Error('Nixpacks installation verification failed - command not found after install');
        }
        // Update cache
        const version = versionResult.stdout.trim().replace('nixpacks ', '');
        this.installCache.set(serverId, {
            installed: true,
            version,
        });
        console.log(`[NixpacksService] Nixpacks ${version} installed successfully on server ${serverId}`);
    }
    /**
     * Generate Dockerfile using Nixpacks.
     * Runs on VPS server in the repo directory.
     */
    async generateDockerfile(serverId, repoPath, config) {
        try {
            console.log(`[NixpacksService] Generating Dockerfile for ${repoPath} on server ${serverId}`);
            // 1. If config provided, create nixpacks.toml in repoPath
            if (config && Object.keys(config).length > 0) {
                await this.createConfig(serverId, repoPath, config);
            }
            // 2. Execute: cd {repoPath} && nixpacks build . --dockerfile
            // This outputs the Dockerfile to stdout
            const result = await this.sshService.executeCommand(serverId, `cd "${repoPath}" && nixpacks build . --dockerfile 2>&1`);
            if (result.exitCode !== 0) {
                return {
                    success: false,
                    error: `Nixpacks generation failed: ${result.stderr || result.stdout}`,
                    dockerfile: '',
                };
            }
            // 3. Dockerfile content is in stdout
            const dockerfile = this.sanitizeDockerfileOutput(result.stdout);
            if (!dockerfile) {
                return {
                    success: false,
                    error: 'Nixpacks returned empty Dockerfile',
                    dockerfile: '',
                };
            }
            // Validate that the output looks like a Dockerfile
            if (!dockerfile.includes('FROM') && !dockerfile.includes('RUN')) {
                return {
                    success: false,
                    error: `Nixpacks output does not appear to be a valid Dockerfile: ${dockerfile.substring(0, 200)}`,
                    dockerfile: '',
                };
            }
            // 4. Get version
            const status = await this.checkInstallation(serverId);
            console.log(`[NixpacksService] Successfully generated Dockerfile (${dockerfile.length} bytes)`);
            return {
                success: true,
                dockerfile,
                version: status.version,
            };
        }
        catch (error) {
            console.error('[NixpacksService] Generation failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                dockerfile: '',
            };
        }
    }
    /**
     * Nixpacks CLI prints a summary banner before the Dockerfile. This strips
     * any leading banner/log lines so Docker builds don't fail with
     * "unknown instruction: ╔══════".
     */
    sanitizeDockerfileOutput(rawOutput) {
        if (!rawOutput)
            return '';
        const lines = rawOutput.split('\n');
        let removedNixpacksArtifacts = false;
        const startIndex = lines.findIndex((line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return false;
            if (trimmed.toUpperCase().startsWith('FROM '))
                return true;
            if (trimmed.startsWith('# syntax='))
                return true;
            if (/^ARG\s+\w+/i.test(trimmed))
                return true;
            return false;
        });
        if (startIndex === -1) {
            return rawOutput.trim();
        }
        const dockerfileLines = lines.slice(startIndex).filter((line) => {
            const trimmed = line.trim();
            // Drop nixpacks pinned nixpkgs/assets artifacts that are not present in our saved context
            if (trimmed.includes('.nixpacks/') ||
                trimmed.includes('/assets/') ||
                trimmed.includes('nix-env -if .nixpacks')) {
                removedNixpacksArtifacts = true;
                return false;
            }
            return true;
        });
        let dockerfile = dockerfileLines.join('\n').trim();
        // If we removed nixpacks nixpkgs artifacts for Go builds, ensure Go is installed
        const needsGo = /go\s+(mod|build)/i.test(dockerfile);
        const hasGoInstall = /apt-get install -y[^\\n]*golang|apk add[^\\n]*go(lang)?/i.test(dockerfile);
        const usingNixpacksBase = dockerfile.toLowerCase().includes('from ghcr.io/railwayapp/nixpacks');
        if (removedNixpacksArtifacts && needsGo && !hasGoInstall && usingNixpacksBase) {
            const workdirIndex = dockerfileLines.findIndex((line) => line.trim().toLowerCase().startsWith('workdir'));
            const injectLine = 'RUN apt-get update && apt-get install -y golang-go';
            if (workdirIndex !== -1) {
                dockerfileLines.splice(workdirIndex + 1, 0, injectLine);
                dockerfile = dockerfileLines.join('\n').trim();
            }
            else {
                dockerfile = `${injectLine}\n${dockerfile}`;
            }
        }
        // If nixpacks artifacts were stripped for PHP/Laravel builds, ensure PHP + Composer are installed
        const needsPhp = /composer|php\s+artisan|artisan\s+serve/i.test(dockerfile);
        const hasPhpInstall = /apt-get install -y[^\\n]*php|apk add[^\\n]*php/i.test(dockerfile);
        const hasCmd = dockerfileLines.some((line) => line.trim().toUpperCase().startsWith('CMD'));
        const hasPlaceholderCmd = dockerfileLines.some((line) => {
            const trimmed = line.trim().toUpperCase();
            return trimmed.startsWith('CMD') && (trimmed.includes('PLEASE CONFIGURE') ||
                trimmed.includes('PLACEHOLDER') ||
                trimmed.includes('NOT CONFIGURED'));
        });
        const hasValidCmd = hasCmd && !hasPlaceholderCmd;
        const needsNode = /(npm\s+(ci|install|run)|yarn\s+|pnpm\s+|node\s)/i.test(dockerfile);
        const hasNodeInstall = /apt-get install -y[^\\n]*nodejs|apk add[^\\n]*nodejs/i.test(dockerfile);
        const needsPython = /(python\s|pip\s|gunicorn|manage\.py)/i.test(dockerfile);
        // Remove placeholder CMD lines
        if (hasPlaceholderCmd) {
            const cmdIndex = dockerfileLines.findIndex((line) => {
                const trimmed = line.trim().toUpperCase();
                return trimmed.startsWith('CMD') && (trimmed.includes('PLEASE CONFIGURE') ||
                    trimmed.includes('PLACEHOLDER') ||
                    trimmed.includes('NOT CONFIGURED'));
            });
            if (cmdIndex !== -1) {
                dockerfileLines.splice(cmdIndex, 1);
                dockerfile = dockerfileLines.join('\n').trim();
            }
        }
        if (removedNixpacksArtifacts && needsPhp && !hasPhpInstall && usingNixpacksBase) {
            const workdirIndex = dockerfileLines.findIndex((line) => line.trim().toLowerCase().startsWith('workdir'));
            const phpInstallLines = [
                'ENV PATH="/usr/local/bin:${PATH}"',
                'RUN apt-get update \\',
                '    && apt-get install -y php php-cli php-fpm php-mysql php-zip php-gd php-mbstring php-curl php-xml unzip curl \\',
                '    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \\',
                '    && ln -sf /usr/local/bin/composer /usr/bin/composer',
            ];
            if (workdirIndex !== -1) {
                dockerfileLines.splice(workdirIndex + 1, 0, ...phpInstallLines);
            }
            else {
                dockerfileLines.unshift(...phpInstallLines);
            }
            // Add a sane default start command if the original relied on /assets start script
            if (!hasValidCmd) {
                dockerfileLines.push('CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=${PORT:-3000}"]');
            }
            dockerfile = dockerfileLines.join('\n').trim();
        }
        // If nixpacks artifacts were stripped for Node apps, ensure node/npm are installed
        if (removedNixpacksArtifacts && needsNode && !hasNodeInstall && usingNixpacksBase) {
            const workdirIndex = dockerfileLines.findIndex((line) => line.trim().toLowerCase().startsWith('workdir'));
            const nodeInstallLines = [
                'ENV DEBIAN_FRONTEND=noninteractive',
                'RUN apt-get update && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs',
                'ENV PATH="/usr/local/bin:/usr/bin:/bin:$PATH"',
            ];
            if (workdirIndex !== -1) {
                dockerfileLines.splice(workdirIndex + 1, 0, ...nodeInstallLines);
            }
            else {
                dockerfileLines.unshift(...nodeInstallLines);
            }
            // Add default CMD if missing
            if (!hasValidCmd) {
                // Try to detect package.json start script, otherwise use a generic node command
                const hasPackageJson = dockerfileLines.some(line => line.includes('package.json'));
                if (hasPackageJson) {
                    dockerfileLines.push('CMD ["sh", "-c", "npm install && npm start"]');
                }
                else {
                    // Fallback to basic node command
                    dockerfileLines.push('CMD ["node", "index.js"]');
                }
            }
            dockerfile = dockerfileLines.join('\n').trim();
        }
        // If nixpacks artifacts were stripped for Python apps, ensure python/venv/pip are installed and inject a sane Dockerfile
        if (removedNixpacksArtifacts && needsPython && usingNixpacksBase) {
            const baseFrom = dockerfileLines.find((line) => line.trim().toUpperCase().startsWith('FROM')) ||
                'FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067';
            return [
                baseFrom,
                'ENV DEBIAN_FRONTEND=noninteractive',
                'WORKDIR /app',
                'RUN apt-get update && apt-get install -y python3 python3-pip python3-venv python-is-python3',
                'ENV PATH="/usr/local/bin:/usr/bin:/bin:$PATH"',
                'COPY . /app',
                'RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --upgrade pip && /opt/venv/bin/pip install gunicorn && /opt/venv/bin/pip install -r requirements.txt',
                'ENV PATH="/opt/venv/bin:$PATH"',
                'EXPOSE 3000',
                'CMD ["sh", "-c", "/opt/venv/bin/python manage.py migrate && /opt/venv/bin/gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-3000}"]',
            ].join('\n').trim();
        }
        // If artifacts were stripped and there's no start command, fall back to a basic nginx static server
        if (removedNixpacksArtifacts && !hasValidCmd && usingNixpacksBase && !needsPhp) {
            const baseFrom = dockerfileLines.find((line) => line.trim().toUpperCase().startsWith('FROM')) ||
                'FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067';
            const staticDockerfile = [
                baseFrom,
                'WORKDIR /app',
                'RUN apt-get update && apt-get install -y nginx',
                'COPY . /app',
                'RUN mkdir -p /etc/nginx /var/log/nginx /var/cache/nginx',
                'RUN rm -f /etc/nginx/sites-enabled/default',
                'RUN printf \'server {\\n  listen 3000;\\n  root /app/public;\\n  index index.html;\\n  location / {\\n    try_files $uri $uri/ /index.html;\\n  }\\n}\\n\' > /etc/nginx/conf.d/default.conf',
                'EXPOSE 3000',
                'CMD ["nginx", "-g", "daemon off;"]',
            ];
            return staticDockerfile.join('\n').trim();
        }
        const normalizedDockerfile = dockerfile
            .split('\n')
            .map((line) => this.normalizeNixpacksPathEnvLine(line))
            .join('\n')
            .trim();
        return this.injectNextjsNextPublicEnvBuildArg(normalizedDockerfile);
    }
    /**
     * Nixpacks can emit invalid unquoted ENV values containing spaces (seen with Ruby version constraints).
     * Docker requires ENV in the form name=value without unescaped spaces.
     */
    normalizeNixpacksPathEnvLine(line) {
        const match = line.match(/^(\s*ENV\s+NIXPACKS_PATH=)(.*)$/);
        if (!match)
            return line;
        const prefix = match[1];
        let value = match[2].trim();
        if (!value)
            return line;
        const isQuoted = (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"));
        if (isQuoted) {
            return `${prefix}${value}`;
        }
        // Repair common malformed tokens like "ruby->= 2.6.0/bin"
        value = value
            .replace(/->=\s+/g, '->=')
            .replace(/->\s+/g, '->')
            .replace(/\s+:/g, ':')
            .replace(/:\s+/g, ':')
            .replace(/\s+\/bin/g, '/bin');
        if (/\s/.test(value)) {
            const escaped = value.replace(/"/g, '\\"');
            return `${prefix}"${escaped}"`;
        }
        return `${prefix}${value}`;
    }
    /**
     * Create nixpacks.toml with user overrides.
     * Uses Nixpacks environment variables for version control.
     */
    async createConfig(serverId, repoPath, config) {
        // Generate nixpacks.toml content
        const configContent = this.buildNixpacksConfig(config);
        if (!configContent) {
            // No config to create
            return;
        }
        console.log(`[NixpacksService] Creating nixpacks.toml with config:`, config);
        // Upload to {repoPath}/nixpacks.toml via SSH using heredoc
        const uploadCommand = `cat > "${repoPath}/nixpacks.toml" << 'NIXPACKS_CONFIG_EOF'
${configContent}
NIXPACKS_CONFIG_EOF`;
        const result = await this.sshService.executeCommand(serverId, uploadCommand);
        if (result.exitCode !== 0) {
            console.warn('[NixpacksService] Failed to create nixpacks.toml:', result.stderr);
            // Don't throw - continue with generation, Nixpacks will use defaults
        }
    }
    /**
     * Build nixpacks.toml configuration.
     * Uses environment variables for versions (NODE_VERSION, etc.) rather than Nix packages.
     * See: https://nixpacks.com/docs/configuration/environment
     */
    buildNixpacksConfig(config) {
        const parts = [];
        // Use environment variables for version control
        const variables = [];
        if (config.nodeVersion) {
            variables.push(`NODE_VERSION = "${config.nodeVersion}"`);
        }
        if (config.pythonVersion) {
            variables.push(`PYTHON_VERSION = "${config.pythonVersion}"`);
        }
        if (config.rubyVersion) {
            variables.push(`RUBY_VERSION = "${config.rubyVersion}"`);
        }
        if (variables.length > 0) {
            parts.push('[variables]');
            parts.push(...variables);
            parts.push('');
        }
        // Custom install command
        if (config.installCommand) {
            parts.push('[phases.install]');
            parts.push(`cmds = ["${config.installCommand}"]`);
            parts.push('');
        }
        // Custom build commands
        if (config.buildCommand) {
            parts.push('[phases.build]');
            parts.push(`cmds = ["${config.buildCommand}"]`);
            parts.push('');
        }
        // Custom start command
        if (config.startCommand) {
            parts.push('[start]');
            parts.push(`cmd = "${config.startCommand}"`);
        }
        return parts.join('\n').trim();
    }
    /**
     * Clean up generated nixpacks.toml file after generation.
     */
    async cleanupConfig(serverId, repoPath) {
        try {
            await this.sshService.executeCommand(serverId, `rm -f "${repoPath}/nixpacks.toml"`);
        }
        catch (error) {
            // Ignore cleanup errors
            console.warn('[NixpacksService] Failed to cleanup nixpacks.toml:', error);
        }
    }
}
exports.NixpacksService = NixpacksService;
// Singleton instance
let nixpacksServiceInstance = null;
function createNixpacksService(sshService) {
    if (!nixpacksServiceInstance) {
        nixpacksServiceInstance = new NixpacksService(sshService);
    }
    return nixpacksServiceInstance;
}
function getNixpacksService() {
    return nixpacksServiceInstance;
}
//# sourceMappingURL=NixpacksService.js.map