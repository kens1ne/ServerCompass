"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.composeService = exports.ComposeService = void 0;
const yaml_1 = __importDefault(require("yaml"));
const crypto_1 = require("crypto");
const db_1 = require("../db");
// Dangerous compose file features that should be blocked by default
const DANGEROUS_FEATURES = {
    privileged: 'Container runs with full host privileges',
    host_pid: 'Container shares host PID namespace',
    host_network: 'Container shares host network stack',
    host_ipc: 'Container shares host IPC namespace',
    cap_add_sys_admin: 'Container has SYS_ADMIN capability',
    cap_add_all: 'Container has ALL capabilities',
    security_opt_apparmor_unconfined: 'AppArmor disabled',
    security_opt_seccomp_unconfined: 'Seccomp disabled',
};
class ComposeService {
    /**
     * Parse a Docker Compose file content
     */
    parseCompose(content) {
        try {
            const parsed = yaml_1.default.parse(content);
            if (!parsed) {
                throw new Error('Empty compose file');
            }
            // Normalize services (could be at root level or under 'services' key)
            const services = parsed.services || {};
            return {
                version: parsed.version,
                services,
                volumes: parsed.volumes,
                networks: parsed.networks,
                configs: parsed.configs,
                secrets: parsed.secrets,
            };
        }
        catch (error) {
            if (error instanceof yaml_1.default.YAMLParseError) {
                throw new Error(`YAML parsing error at line ${error.linePos?.[0]?.line || 'unknown'}: ${error.message}`);
            }
            throw error;
        }
    }
    /**
     * Validate a Docker Compose file
     */
    validateCompose(content) {
        const errors = [];
        const warnings = [];
        const securityIssues = [];
        const services = [];
        const images = [];
        let hasDockerfile = false;
        let hasBuildContext = false;
        try {
            const parsed = this.parseCompose(content);
            // Check if there are any services
            if (!parsed.services || Object.keys(parsed.services).length === 0) {
                errors.push('No services defined in compose file');
                return {
                    isValid: false,
                    errors,
                    warnings,
                    services,
                    securityIssues,
                    images,
                    hasDockerfile,
                    hasBuildContext
                };
            }
            // Validate each service
            for (const [serviceName, service] of Object.entries(parsed.services)) {
                services.push(serviceName);
                // Extract image information
                if (service.image) {
                    // Service uses a pre-built image
                    images.push(service.image);
                }
                else if (service.build) {
                    // Service builds from source
                    images.push(`build:${serviceName}`);
                    hasBuildContext = true;
                    // Check if a Dockerfile is specified
                    if (typeof service.build === 'object' && service.build.dockerfile) {
                        hasDockerfile = true;
                    }
                    else {
                        // Default Dockerfile name is used
                        hasDockerfile = true;
                    }
                }
                // Service must have either image or build
                if (!service.image && !service.build) {
                    errors.push(`Service '${serviceName}' must have either 'image' or 'build' defined`);
                }
                // Check for security issues
                if (service.privileged) {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.privileged}`);
                }
                if (service.pid === 'host') {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.host_pid}`);
                }
                if (service.network_mode === 'host') {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.host_network}`);
                }
                if (service.cap_add?.includes('SYS_ADMIN')) {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.cap_add_sys_admin}`);
                }
                if (service.cap_add?.includes('ALL')) {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.cap_add_all}`);
                }
                if (service.security_opt?.some(opt => opt.includes('apparmor:unconfined'))) {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.security_opt_apparmor_unconfined}`);
                }
                if (service.security_opt?.some(opt => opt.includes('seccomp:unconfined'))) {
                    securityIssues.push(`Service '${serviceName}': ${DANGEROUS_FEATURES.security_opt_seccomp_unconfined}`);
                }
                // Check for common issues
                if (service.ports) {
                    for (const port of service.ports) {
                        const portStr = typeof port === 'string' ? port : `${port.published}:${port.target}`;
                        // Check for privileged ports (< 1024) exposed
                        const hostPort = parseInt(portStr.split(':')[0]);
                        if (hostPort < 1024 && hostPort > 0) {
                            warnings.push(`Service '${serviceName}': Exposing privileged port ${hostPort}`);
                        }
                    }
                }
                // Check for missing restart policy in production
                if (!service.restart || service.restart === 'no') {
                    warnings.push(`Service '${serviceName}': No restart policy set (recommended: 'unless-stopped')`);
                }
                // Check for missing health check
                if (!service.healthcheck && service.image) {
                    warnings.push(`Service '${serviceName}': No health check defined`);
                }
            }
            // Check for deprecated version field
            if (parsed.version) {
                warnings.push(`'version' field is deprecated in Docker Compose V2`);
            }
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
        return {
            isValid: errors.length === 0,
            errors,
            warnings,
            services,
            securityIssues,
            images,
            hasDockerfile,
            hasBuildContext,
        };
    }
    /**
     * Sanitize a compose file by removing dangerous features
     */
    sanitizeCompose(content) {
        const removedFeatures = [];
        try {
            const parsed = yaml_1.default.parse(content);
            if (parsed.services) {
                for (const [serviceName, service] of Object.entries(parsed.services)) {
                    // Remove privileged mode
                    if (service.privileged) {
                        delete service.privileged;
                        removedFeatures.push(`${serviceName}: privileged mode`);
                    }
                    // Remove host PID
                    if (service.pid === 'host') {
                        delete service.pid;
                        removedFeatures.push(`${serviceName}: host PID namespace`);
                    }
                    // Remove host network mode
                    if (service.network_mode === 'host') {
                        delete service.network_mode;
                        removedFeatures.push(`${serviceName}: host network mode`);
                    }
                    // Remove dangerous capabilities
                    if (service.cap_add) {
                        const dangerous = ['SYS_ADMIN', 'ALL', 'NET_ADMIN', 'SYS_PTRACE'];
                        const removed = service.cap_add.filter(cap => dangerous.includes(cap));
                        service.cap_add = service.cap_add.filter(cap => !dangerous.includes(cap));
                        if (removed.length > 0) {
                            removedFeatures.push(`${serviceName}: capabilities ${removed.join(', ')}`);
                        }
                        if (service.cap_add.length === 0) {
                            delete service.cap_add;
                        }
                    }
                    // Remove security_opt with unconfined
                    if (service.security_opt) {
                        const removed = service.security_opt.filter(opt => opt.includes('unconfined') || opt.includes('no-new-privileges:false'));
                        service.security_opt = service.security_opt.filter(opt => !opt.includes('unconfined') && !opt.includes('no-new-privileges:false'));
                        if (removed.length > 0) {
                            removedFeatures.push(`${serviceName}: security options ${removed.join(', ')}`);
                        }
                        if (service.security_opt.length === 0) {
                            delete service.security_opt;
                        }
                    }
                }
            }
            const sanitized = yaml_1.default.stringify(parsed, { lineWidth: 0 });
            return { sanitized, removedFeatures };
        }
        catch (error) {
            // If parsing fails, return original
            return { sanitized: content, removedFeatures: [] };
        }
    }
    /**
     * Get all available templates
     */
    getTemplates() {
        return db_1.queries.getDockerComposeTemplates();
    }
    /**
     * Get a template by ID
     */
    getTemplateById(id) {
        return db_1.queries.getDockerComposeTemplate(id) || null;
    }
    /**
     * Render a template with variables
     */
    renderTemplate(templateId, variables) {
        const template = this.getTemplateById(templateId);
        if (!template) {
            throw new Error(`Template not found: ${templateId}`);
        }
        // Substitute variables using {{variable}} pattern
        let compose = template.compose_content;
        let dockerfile = template.dockerfile_content || undefined;
        for (const [key, value] of Object.entries(variables)) {
            const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
            compose = compose.replace(pattern, value);
            if (dockerfile) {
                dockerfile = dockerfile.replace(pattern, value);
            }
        }
        // Parse env hints to get default env vars
        const envVars = {};
        if (template.env_hints) {
            try {
                const hints = JSON.parse(template.env_hints);
                for (const hint of hints) {
                    if (hint.default) {
                        envVars[hint.key] = hint.default;
                    }
                }
            }
            catch {
                // Ignore parse errors
            }
        }
        // Override with provided variables that look like env vars
        for (const [key, value] of Object.entries(variables)) {
            if (key === key.toUpperCase()) {
                envVars[key] = value;
            }
        }
        return { compose, dockerfile, envVars };
    }
    /**
     * Generate Docker Compose from PM2 config
     *
     * IMPORTANT: Healthchecks are intentionally omitted from the generated compose file.
     * Traefik v3 filters out unhealthy containers by default, and many minimal container
     * images (Go, Rust, alpine-based) don't include wget/curl for HTTP health checks.
     *
     * @see docs/common-errors/traefik_skip_unhealthy_check.md for full explanation
     */
    generateComposeFromPM2(config) {
        const projectName = this.sanitizeProjectName(config.name);
        const port = config.port || 3000;
        // Determine the interpreter and base image
        const interpreter = config.interpreter || 'node';
        let baseImage = 'node:20-alpine';
        if (interpreter.includes('python')) {
            baseImage = 'python:3.11-slim';
        }
        else if (interpreter.includes('bun')) {
            baseImage = 'oven/bun:1';
        }
        // Build environment variables
        const envVars = {
            NODE_ENV: 'production',
            PORT: String(port),
            ...config.env,
            ...config.env_production,
        };
        // Calculate replicas
        let replicas = 1;
        if (config.instances === 'max') {
            replicas = 4; // Reasonable default for 'max'
        }
        else if (typeof config.instances === 'number') {
            replicas = config.instances;
        }
        // Generate Dockerfile
        const dockerfile = this.generatePM2Dockerfile(config, baseImage, port);
        // Generate docker-compose.yml
        const composeConfig = {
            services: {
                [projectName]: {
                    container_name: `${projectName}-app`,
                    build: {
                        context: '.',
                        dockerfile: 'Dockerfile',
                    },
                    ports: [`${port}:${port}`],
                    environment: envVars,
                    restart: 'unless-stopped',
                    deploy: {
                        replicas,
                        resources: {
                            limits: {
                                memory: config.max_memory_restart || '512M',
                            },
                        },
                    },
                    // NOTE: Healthcheck disabled - Traefik v3 filters unhealthy containers,
                    // and wget is not available in all container images (Go, Rust, etc.)
                    // This caused domains to not work when containers were marked unhealthy.
                },
            },
        };
        const compose = yaml_1.default.stringify(composeConfig, { lineWidth: 0 });
        return { compose, dockerfile, envVars };
    }
    /**
     * Generate Dockerfile for PM2 migration
     */
    generatePM2Dockerfile(config, baseImage, port) {
        const script = config.script || 'index.js';
        const nodeArgs = config.node_args || config.interpreter_args || '';
        // Determine the command
        let cmd;
        if (config.interpreter?.includes('python')) {
            cmd = `python ${script}`;
        }
        else if (config.interpreter?.includes('bun')) {
            cmd = `bun run ${script}`;
        }
        else {
            cmd = nodeArgs ? `node ${nodeArgs} ${script}` : `node ${script}`;
        }
        // Add args if present
        if (config.args) {
            const args = Array.isArray(config.args) ? config.args.join(' ') : config.args;
            cmd = `${cmd} ${args}`;
        }
        return `# Generated from PM2 config: ${config.name}
FROM ${baseImage}

WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./

# Install dependencies (auto-detect lock file)
RUN \\
  if [ -f yarn.lock ]; then yarn install --production --frozen-lockfile; \\
  elif [ -f package-lock.json ]; then npm ci --only=production; \\
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --prod --frozen-lockfile; \\
  else echo "Lockfile not found." && npm install --only=production; \\
  fi

# Copy application code
COPY . .

# Expose the application port
EXPOSE ${port}

# Set environment
ENV NODE_ENV=production
ENV PORT=${port}

# Run the application
CMD ["sh", "-c", "${cmd}"]
`;
    }
    /**
     * Sanitize a string to be used as a project name
     */
    sanitizeProjectName(name) {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9-_]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 64);
    }
    /**
     * Extract exposed ports from compose file
     */
    extractPorts(content) {
        const ports = [];
        try {
            const parsed = this.parseCompose(content);
            for (const [serviceName, service] of Object.entries(parsed.services)) {
                if (service.ports) {
                    for (const port of service.ports) {
                        let hostPort;
                        let containerPort;
                        if (typeof port === 'string') {
                            const parts = port.split(':');
                            if (parts.length === 2) {
                                hostPort = parseInt(parts[0]);
                                containerPort = parseInt(parts[1].split('/')[0]);
                            }
                            else {
                                hostPort = containerPort = parseInt(parts[0].split('/')[0]);
                            }
                        }
                        else {
                            hostPort = port.published;
                            containerPort = port.target;
                        }
                        if (!isNaN(hostPort) && !isNaN(containerPort)) {
                            ports.push({ service: serviceName, host: hostPort, container: containerPort });
                        }
                    }
                }
            }
        }
        catch {
            // Return empty array on parse error
        }
        return ports;
    }
    /**
     * Get service names from compose file
     */
    getServiceNames(content) {
        try {
            const parsed = this.parseCompose(content);
            return Object.keys(parsed.services);
        }
        catch {
            return [];
        }
    }
    /**
     * Add default restart policy to services that don't have one
     */
    addRestartPolicy(content, policy = 'unless-stopped') {
        try {
            const parsed = yaml_1.default.parse(content);
            if (parsed.services) {
                for (const service of Object.values(parsed.services)) {
                    if (!service.restart) {
                        service.restart = policy;
                    }
                }
            }
            return yaml_1.default.stringify(parsed, { lineWidth: 0 });
        }
        catch {
            return content;
        }
    }
    /**
     * Create a new custom template
     */
    createTemplate(template) {
        const id = `template-${(0, crypto_1.randomUUID)()}`;
        db_1.queries.createDockerComposeTemplate({
            id,
            ...template,
            is_builtin: 0,
        });
        return id;
    }
    /**
     * Update an existing template
     */
    updateTemplate(id, updates) {
        const template = this.getTemplateById(id);
        if (!template) {
            throw new Error(`Template not found: ${id}`);
        }
        if (template.is_builtin) {
            throw new Error('Cannot modify built-in templates');
        }
        db_1.queries.updateDockerComposeTemplate(id, updates);
    }
    /**
     * Delete a custom template
     */
    deleteTemplate(id) {
        const template = this.getTemplateById(id);
        if (!template) {
            throw new Error(`Template not found: ${id}`);
        }
        if (template.is_builtin) {
            throw new Error('Cannot delete built-in templates');
        }
        db_1.queries.deleteDockerComposeTemplate(id);
    }
    /**
     * Generate Docker configuration based on detected framework
     */
    generateFromFramework(options) {
        const { framework, projectName, port = 3000, packageManager = 'npm' } = options;
        const installCmd = packageManager === 'yarn' ? 'yarn install --frozen-lockfile' :
            packageManager === 'pnpm' ? 'pnpm install --frozen-lockfile' :
                'npm ci --only=production';
        const buildCmd = packageManager === 'yarn' ? 'yarn build' :
            packageManager === 'pnpm' ? 'pnpm build' :
                'npm run build';
        const startCmd = packageManager === 'yarn' ? 'yarn start' :
            packageManager === 'pnpm' ? 'pnpm start' :
                'npm start';
        let dockerfile;
        let compose;
        const envVars = {
            NODE_ENV: 'production',
            PORT: String(port),
        };
        switch (framework) {
            case 'nextjs':
                dockerfile = this.generateNextJsDockerfile(port, packageManager);
                compose = this.generateComposeYml(projectName, port, true);
                break;
            case 'react':
            case 'vue':
                // Static build served by nginx
                dockerfile = this.generateStaticSiteDockerfile(buildCmd, packageManager);
                compose = this.generateComposeYml(projectName, 80, true);
                break;
            case 'express':
            case 'fastify':
            case 'nestjs':
            case 'node':
                dockerfile = this.generateNodeDockerfile(port, packageManager, installCmd, startCmd);
                compose = this.generateComposeYml(projectName, port, true);
                break;
            case 'static':
                dockerfile = this.generateStaticNginxDockerfile();
                compose = this.generateComposeYml(projectName, 80, false);
                break;
            case 'rust':
                dockerfile = `# Rust Production Dockerfile
FROM rust:1.83-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/target/release/ /tmp/build/
RUN find /tmp/build -maxdepth 1 -type f -executable ! -name ".*" ! -name "*.d" | head -1 | xargs -I{} cp {} ./server && rm -rf /tmp/build

EXPOSE ${port}
CMD ["./server"]`;
                compose = this.generateComposeYml(projectName, port, true);
                envVars['RUST_LOG'] = 'info';
                delete envVars['NODE_ENV'];
                break;
            case 'go':
                dockerfile = `# Go Application Dockerfile
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/main .
EXPOSE ${port}
CMD ["./main"]`;
                compose = this.generateComposeYml(projectName, port, true);
                envVars['GO_ENV'] = 'production';
                delete envVars['NODE_ENV'];
                break;
            case 'python':
            case 'django':
            case 'flask':
            case 'fastapi': {
                const pythonCmd = framework === 'django'
                    ? `CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "${projectName}.wsgi:application"]`
                    : framework === 'flask'
                        ? `CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:${port}"]`
                        : framework === 'fastapi'
                            ? `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${port}"]`
                            : `CMD ["python", "app.py"]`;
                dockerfile = `# Python Production Dockerfile
FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE ${port}
${pythonCmd}`;
                compose = this.generateComposeYml(projectName, port, true);
                envVars['ENVIRONMENT'] = 'production';
                delete envVars['NODE_ENV'];
                break;
            }
            case 'rails':
                dockerfile = `# Ruby on Rails Production Dockerfile
FROM ruby:3.2-slim
WORKDIR /app

RUN apt-get update -qq && apt-get install -y nodejs postgresql-client && rm -rf /var/lib/apt/lists/*

COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

COPY . .
RUN bundle exec rails assets:precompile || true

EXPOSE ${port}
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "${port}"]`;
                compose = this.generateComposeYml(projectName, port, true);
                envVars['RAILS_ENV'] = 'production';
                delete envVars['NODE_ENV'];
                break;
            case 'laravel':
                dockerfile = `# Laravel Production Dockerfile
FROM php:8.2-fpm
WORKDIR /app

RUN apt-get update && apt-get install -y git curl libpng-dev libonig-dev libxml2-dev zip unzip \\
  && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd

COPY --from=composer:latest /usr/bin/composer /usr/bin/composer
COPY . .
RUN composer install --no-dev --optimize-autoloader

EXPOSE ${port}
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=${port}"]`;
                compose = this.generateComposeYml(projectName, port, true);
                envVars['APP_ENV'] = 'production';
                delete envVars['NODE_ENV'];
                break;
            default:
                // Generic Node.js app
                dockerfile = this.generateNodeDockerfile(port, packageManager, installCmd, startCmd);
                compose = this.generateComposeYml(projectName, port, true);
        }
        return { compose, dockerfile, envVars };
    }
    generateNextJsDockerfile(port, _packageManager) {
        const buildCmd = _packageManager === 'yarn' ? 'yarn build' :
            _packageManager === 'pnpm' ? 'pnpm build' :
                'npm run build';
        const startCmd = _packageManager === 'yarn' ? '["yarn", "start"]' :
            _packageManager === 'pnpm' ? '["pnpm", "start"]' :
                '["npm", "start"]';
        return `# Next.js Production Dockerfile
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN \\
  if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\
  elif [ -f package-lock.json ]; then npm ci; \\
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \\
  else echo "Lockfile not found." && npm install; \\
  fi

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

	# Remove any existing .next folder that might be committed to the repo
	RUN rm -rf .next
	
	ENV NEXT_TELEMETRY_DISABLED=1
	ENV NODE_ENV=production
	
	# Build the application
	ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64
	RUN if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then \\
	      echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; \\
	    fi; \\
	    ${buildCmd}
	
	# Verify the build succeeded - fail fast if .next/BUILD_ID doesn't exist
	RUN test -f .next/BUILD_ID && echo "Build successful: $(cat .next/BUILD_ID)" || (echo "ERROR: Build failed - .next/BUILD_ID not found" && ls -la .next/ 2>/dev/null && exit 1)

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=${port}

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

# Copy next.config.js/mjs/ts if it exists (needed for runtime config)
COPY --from=builder --chown=nextjs:nodejs /app/next.config* ./

USER nextjs

EXPOSE ${port}

CMD ${startCmd}
`;
    }
    generateNodeDockerfile(port, packageManager, _installCmd, _startCmd) {
        return `# Node.js Production Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./

# Install dependencies (auto-detect lock file)
RUN \\
  if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\
  elif [ -f package-lock.json ]; then npm ci; \\
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \\
  else echo "Lockfile not found." && npm install; \\
  fi

# Copy application code
COPY . .

# Build if build script exists
RUN if grep -q '"build"' package.json; then ${packageManager === 'yarn' ? 'yarn build' : packageManager === 'pnpm' ? 'pnpm build' : 'npm run build'}; fi

# Remove dev dependencies
RUN \\
  if [ -f yarn.lock ]; then yarn install --production --frozen-lockfile; \\
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm prune --prod; \\
  else npm prune --production; \\
  fi

# Set environment
ENV NODE_ENV=production
ENV PORT=${port}

EXPOSE ${port}

CMD ["${packageManager === 'yarn' ? 'yarn' : packageManager === 'pnpm' ? 'pnpm' : 'npm'}", "start"]
`;
    }
    generateStaticSiteDockerfile(buildCmd, _packageManager) {
        return `# Static Site Build Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json yarn.lock* pnpm-lock.yaml* ./

# Install dependencies
RUN \\
  if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \\
  elif [ -f package-lock.json ]; then npm ci; \\
  elif [ -f pnpm-lock.yaml ]; then corepack enable pnpm && pnpm i --frozen-lockfile; \\
  else npm install; \\
  fi

# Copy source code
COPY . .

# Build the app
RUN ${buildCmd}

# Production stage with nginx
FROM nginx:alpine

# Copy built assets to nginx
COPY --from=builder /app/dist /usr/share/nginx/html
# For Create React App
COPY --from=builder /app/build /usr/share/nginx/html 2>/dev/null || true

# Add nginx config for SPA routing
RUN echo 'server { \\
  listen 80; \\
  location / { \\
    root /usr/share/nginx/html; \\
    try_files $uri $uri/ /index.html; \\
  } \\
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
    }
    generateStaticNginxDockerfile() {
        return `# Static Files Dockerfile
FROM nginx:alpine

# Copy static files
COPY . /usr/share/nginx/html

# Add nginx config for SPA routing
RUN echo 'server { \\
  listen 80; \\
  location / { \\
    root /usr/share/nginx/html; \\
    try_files $uri $uri/ /index.html; \\
  } \\
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
    }
    /**
     * Generate a docker-compose.yml for the given project.
     *
     * IMPORTANT: Healthchecks are intentionally omitted from the generated compose file.
     * Traefik v3 filters out unhealthy containers by default, and many minimal container
     * images (Go, Rust, alpine-based) don't include wget/curl for HTTP health checks.
     * This causes containers to be marked (unhealthy) and ignored by Traefik routing.
     *
     * @see docs/common-errors/traefik_skip_unhealthy_check.md for full explanation
     */
    generateComposeYml(projectName, port, hasBuild) {
        const service = {
            container_name: `${projectName}-app`,
            restart: 'unless-stopped',
            ports: [`${port}:${port}`],
            environment: {
                NODE_ENV: 'production',
                PORT: String(port),
            },
            // Load runtime env vars from server-managed `.env` file.
            // Without this, `.env` is only used for interpolation, not injected into containers.
            env_file: ['.env'],
            // NOTE: Healthcheck disabled - Traefik v3 filters unhealthy containers,
            // and wget is not available in all container images (Go, Rust, etc.)
        };
        if (hasBuild) {
            service.build = {
                context: '.',
                dockerfile: 'Dockerfile',
            };
        }
        const composeConfig = {
            services: {
                [projectName]: service,
            },
        };
        return yaml_1.default.stringify(composeConfig, { lineWidth: 0 });
    }
}
exports.ComposeService = ComposeService;
// Export singleton instance
exports.composeService = new ComposeService();
//# sourceMappingURL=ComposeService.js.map