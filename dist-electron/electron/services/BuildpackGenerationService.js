"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuildpackGenerationService = void 0;
exports.createBuildpackGenerationService = createBuildpackGenerationService;
const ComposeService_1 = require("./ComposeService");
/**
 * Service that orchestrates Dockerfile generation with a simple fallback chain:
 * Nixpacks (Primary) → Templates (Fallback)
 */
class BuildpackGenerationService {
    nixpacksService;
    logEmitter;
    constructor(nixpacksService, _sshService, // Reserved for future use
    logEmitter) {
        this.nixpacksService = nixpacksService;
        this.logEmitter = logEmitter;
    }
    /**
     * Main generation method with simple two-step fallback.
     * Uses Nixpacks for both framework detection and Dockerfile generation.
     */
    async generateDockerfile(params) {
        const { overrides, projectName, mode } = params;
        const port = overrides?.port || 3000;
        // Explicit template-only generation (used when user overrides runtime/framework)
        if (mode === 'template') {
            this.log('🧰 Generating using templates (Nixpacks skipped by request)...', 'info');
            const templateResult = await this.fallbackToTemplate(params);
            if (templateResult.success && templateResult.dockerfile && templateResult.compose) {
                this.log('✅ Generated using template mode', 'success');
                return {
                    success: true,
                    dockerfile: templateResult.dockerfile,
                    compose: templateResult.compose,
                    envVars: templateResult.envVars || {},
                    method: 'template',
                    framework: params.framework,
                    config: overrides,
                };
            }
            return {
                success: false,
                dockerfile: '',
                compose: '',
                envVars: {},
                method: 'template',
                framework: params.framework,
                error: templateResult.error || 'Template generation failed',
            };
        }
        // Frameworks where our templates produce more reliable Dockerfiles than Nixpacks.
        // Nixpacks Meteor output uses `curl | sh` without pipefail, which silently
        // swallows DNS/network failures and then fails at the next step.
        const PREFER_TEMPLATE_FRAMEWORKS = new Set(['meteor']);
        // Step 1: Try Nixpacks (includes framework detection)
        this.log('🚀 Attempting Dockerfile generation with Nixpacks...', 'info');
        const nixpacksResult = await this.tryNixpacks(params);
        if (nixpacksResult.success && nixpacksResult.dockerfile) {
            const detectedFramework = nixpacksResult.framework || params.framework;
            const normalizedDetected = detectedFramework?.toLowerCase() || '';
            // For certain frameworks, prefer our template over Nixpacks output
            if (PREFER_TEMPLATE_FRAMEWORKS.has(normalizedDetected)) {
                this.log(`🔍 Detected framework: ${detectedFramework}`, 'info');
                this.log(`🔄 Using template instead of Nixpacks for ${detectedFramework} (more reliable)...`, 'info');
                const templateResult = await this.fallbackToTemplate({ ...params, framework: normalizedDetected });
                if (templateResult.success && templateResult.dockerfile && templateResult.compose) {
                    this.log(`✅ Generated using ${detectedFramework} template`, 'success');
                    return {
                        success: true,
                        dockerfile: templateResult.dockerfile,
                        compose: templateResult.compose,
                        envVars: templateResult.envVars || {},
                        method: 'template',
                        framework: detectedFramework,
                        config: overrides,
                    };
                }
                // If template fails, fall through to use Nixpacks result
            }
            this.log(`✅ Successfully generated using Nixpacks${nixpacksResult.toolVersion ? ` v${nixpacksResult.toolVersion}` : ''}`, 'success');
            if (detectedFramework) {
                this.log(`🔍 Detected framework: ${detectedFramework}`, 'info');
            }
            return {
                success: true,
                dockerfile: nixpacksResult.dockerfile,
                compose: nixpacksResult.compose || this.generateComposeYml(projectName, port, detectedFramework),
                envVars: {},
                method: 'nixpacks',
                toolVersion: nixpacksResult.toolVersion,
                framework: detectedFramework,
                config: overrides,
            };
        }
        this.log(`⚠️ Nixpacks generation failed: ${nixpacksResult.error}`, 'warning');
        this.log('🔄 Falling back to template system...', 'info');
        // Step 2: Fallback to templates (use Nixpacks-detected framework if available, or params.framework)
        const fallbackFramework = nixpacksResult.framework || params.framework;
        const templateResult = await this.fallbackToTemplate({ ...params, framework: fallbackFramework });
        if (templateResult.success && templateResult.dockerfile && templateResult.compose) {
            this.log('✅ Generated using template fallback', 'success');
            return {
                success: true,
                dockerfile: templateResult.dockerfile,
                compose: templateResult.compose,
                envVars: templateResult.envVars || {},
                method: 'template',
                framework: fallbackFramework,
                config: overrides,
            };
        }
        // Both methods failed
        return {
            success: false,
            dockerfile: '',
            compose: '',
            envVars: {},
            method: 'template',
            framework: nixpacksResult.framework || params.framework,
            error: `All generation methods failed. Nixpacks: ${nixpacksResult.error}. Template: ${templateResult.error}`,
        };
    }
    /**
     * Try Nixpacks generation with installation if needed.
     * Flow: 1) Install Nixpacks if missing → 2) Detect framework → 3) Generate Dockerfile
     * Returns detected framework even if generation fails (used for template fallback).
     */
    async tryNixpacks(params) {
        const { serverId, repoPath, overrides, projectName } = params;
        const port = overrides?.port || 3000;
        let detectedFramework;
        try {
            // Check if Nixpacks is installed
            const status = await this.nixpacksService.checkInstallation(serverId);
            if (!status.installed) {
                this.log('📦 Nixpacks not found, installing...', 'info');
                try {
                    await this.nixpacksService.install(serverId);
                    this.log('✅ Nixpacks installed successfully', 'success');
                }
                catch (installError) {
                    return {
                        success: false,
                        error: `Failed to install Nixpacks: ${installError instanceof Error ? installError.message : String(installError)}`,
                    };
                }
            }
            else {
                this.log(`📦 Using Nixpacks${status.version ? ` v${status.version}` : ''}`, 'info');
            }
            // Step 1: Detect framework using Nixpacks
            this.log('🔍 Detecting framework...', 'info');
            const detectionResult = await this.nixpacksService.detectFramework(serverId, repoPath);
            if (detectionResult.success && detectionResult.framework) {
                detectedFramework = detectionResult.framework;
                this.log(`🎯 Nixpacks detected: ${detectedFramework}`, 'info');
            }
            else {
                this.log('⚠️ Framework detection returned no result, continuing with generation...', 'warning');
            }
            // Build Nixpacks config from overrides
            const nixpacksConfig = {};
            if (overrides?.nodeVersion)
                nixpacksConfig.nodeVersion = overrides.nodeVersion;
            if (overrides?.pythonVersion)
                nixpacksConfig.pythonVersion = overrides.pythonVersion;
            if (overrides?.rubyVersion)
                nixpacksConfig.rubyVersion = overrides.rubyVersion;
            if (overrides?.buildCommand)
                nixpacksConfig.buildCommand = overrides.buildCommand;
            if (overrides?.startCommand)
                nixpacksConfig.startCommand = overrides.startCommand;
            if (overrides?.installCommand)
                nixpacksConfig.installCommand = overrides.installCommand;
            // Step 2: Generate Dockerfile
            this.log('🏗️ Generating Dockerfile...', 'info');
            const result = await this.nixpacksService.generateDockerfile(serverId, repoPath, Object.keys(nixpacksConfig).length > 0 ? nixpacksConfig : undefined);
            if (!result.success) {
                // Return with detected framework even if generation fails (for fallback)
                return { success: false, error: result.error, framework: detectedFramework };
            }
            // Generate compose file with framework-appropriate env vars
            const compose = this.generateComposeYml(projectName, port, detectedFramework || params.framework);
            return {
                success: true,
                dockerfile: result.dockerfile,
                compose,
                toolVersion: result.version,
                framework: detectedFramework,
                envVars: {},
            };
        }
        catch (error) {
            console.error('[BuildpackGen] Nixpacks generation failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                framework: detectedFramework, // Return detected framework even on error
            };
        }
    }
    /**
     * Fallback to template system.
     * For non-Node.js frameworks, generates a generic Dockerfile.
     */
    async fallbackToTemplate(params) {
        const { framework, projectName, overrides } = params;
        const port = overrides?.port || 3000;
        const normalizedFramework = framework?.toLowerCase() || '';
        try {
            // Check if this is a Node.js framework that ComposeService can handle
            const nodeFrameworkMap = {
                'nextjs': 'nextjs',
                'next': 'nextjs',
                'react': 'react',
                'vue': 'vue',
                'express': 'express',
                'fastify': 'fastify',
                'nestjs': 'nestjs',
                'nest': 'nestjs',
                'node': 'node',
                'nodejs': 'node',
                'static': 'static',
                'nuxt': 'vue',
                'remix': 'node',
                'astro': 'static',
                'svelte': 'static',
            };
            const mappedNodeFramework = nodeFrameworkMap[normalizedFramework];
            if (mappedNodeFramework) {
                // Use existing ComposeService for Node.js frameworks
                const generated = ComposeService_1.composeService.generateFromFramework({
                    framework: mappedNodeFramework,
                    projectName,
                    port,
                    packageManager: 'npm',
                    buildCommand: overrides?.buildCommand,
                    startCommand: overrides?.startCommand,
                });
                return {
                    success: true,
                    dockerfile: generated.dockerfile,
                    compose: generated.compose,
                    envVars: generated.envVars,
                };
            }
            // For non-Node.js frameworks, generate a generic fallback
            // This should rarely be used since Nixpacks handles most cases
            const dockerfile = this.generateGenericDockerfile(normalizedFramework, port);
            const compose = this.generateComposeYml(projectName, port, framework);
            return {
                success: true,
                dockerfile,
                compose,
                envVars: {},
            };
        }
        catch (error) {
            console.error('[BuildpackGen] Template generation failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Generate a generic Dockerfile for non-Node.js frameworks.
     * This is a last resort fallback when Nixpacks fails.
     */
    generateGenericDockerfile(framework, port) {
        switch (framework) {
            case 'rust':
                return `# Rust Production Dockerfile
FROM rust:1.75-alpine AS builder
WORKDIR /app
RUN apk add --no-cache musl-dev
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/target/release/* ./
ENV PORT=${port}
EXPOSE ${port}
CMD ["./app"]
`;
            case 'go':
            case 'golang':
                return `# Go Production Dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/main .
ENV PORT=${port}
EXPOSE ${port}
CMD ["./main"]
`;
            case 'python':
            case 'django':
            case 'flask':
            case 'fastapi':
                return `# Python Production Dockerfile
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
ENV PORT=${port}
EXPOSE ${port}
CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "--workers", "4", "app:app"]
`;
            case 'ruby':
            case 'rails':
                return `# Ruby/Rails Production Dockerfile
FROM ruby:3.2-alpine
WORKDIR /app
RUN apk add --no-cache build-base postgresql-dev nodejs yarn
COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test
COPY . .
ENV RAILS_ENV=production PORT=${port}
EXPOSE ${port}
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "${port}"]
`;
            case 'java':
            case 'spring':
            case 'springboot':
                return `# Java/Spring Production Dockerfile
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app
COPY . .
RUN ./mvnw package -DskipTests || ./gradlew build -x test

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
ENV PORT=${port}
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]
`;
            case 'meteor':
                return `# syntax=docker/dockerfile:1
# Meteor Production Dockerfile (multi-stage)

# ── Stage 1: Build ──────────────────────────────────────
FROM node:22-bookworm AS builder

# Use pipefail so curl failures abort the build instead of silently continuing
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -fsSL https://install.meteor.com/ | sh

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json .
RUN meteor npm install --production=false

# Copy the full source (excluding items in .dockerignore)
COPY . .

# Build a standard Node.js bundle
RUN meteor build --directory /build --server-only

# ── Stage 2: Production runtime ─────────────────────────
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /build/bundle .
RUN cd programs/server && npm install --production

ENV PORT=${port}
ENV ROOT_URL=http://localhost:${port}
EXPOSE ${port}
CMD ["node", "main.js"]
`;
            case 'elixir':
            case 'phoenix':
                return `# Elixir/Phoenix Production Dockerfile
FROM elixir:1.16-alpine AS builder
WORKDIR /app
RUN mix local.hex --force && mix local.rebar --force
ENV MIX_ENV=prod
COPY mix.exs mix.lock ./
RUN mix deps.get --only prod && mix deps.compile
COPY . .
RUN mix compile && mix release

FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache openssl ncurses-libs
COPY --from=builder /app/_build/prod/rel/app ./
ENV PORT=${port}
EXPOSE ${port}
CMD ["bin/app", "start"]
`;
            default:
                // Very generic fallback
                return `# Generic Dockerfile - Please customize for your framework
FROM ubuntu:22.04
WORKDIR /app
RUN apt-get update && apt-get install -y curl wget && rm -rf /var/lib/apt/lists/*
COPY . .
ENV PORT=${port}
EXPOSE ${port}
# TODO: Add your start command
CMD ["echo", "Please configure your start command"]
`;
        }
    }
    /**
     * Generate a docker-compose.yml appropriate for the detected framework.
     *
     * IMPORTANT: Healthchecks are intentionally omitted from the generated compose file.
     * Traefik v3 filters out unhealthy containers by default, and many minimal container
     * images (Go, Rust, alpine-based) don't include wget/curl for HTTP health checks.
     * This causes containers to be marked (unhealthy) and ignored by Traefik routing.
     *
     * @see docs/common-errors/traefik_skip_unhealthy_check.md for full explanation
     */
    generateComposeYml(projectName, port, framework) {
        const normalizedFramework = framework?.toLowerCase() || '';
        // Determine environment variables based on framework
        let envVars;
        if (normalizedFramework === 'rust') {
            // Rust apps commonly use RUST_LOG
            envVars = `      PORT: "${port}"
      RUST_LOG: info`;
        }
        else if (['go', 'golang'].includes(normalizedFramework)) {
            // Go apps don't need NODE_ENV; GO_ENV is a common convention
            envVars = `      PORT: "${port}"
      GO_ENV: production`;
        }
        else if (['python', 'django', 'flask', 'fastapi'].includes(normalizedFramework)) {
            // Python apps
            envVars = `      PYTHONUNBUFFERED: "1"
      PORT: "${port}"`;
        }
        else if (['ruby', 'rails'].includes(normalizedFramework)) {
            // Ruby/Rails
            envVars = `      RAILS_ENV: production
      PORT: "${port}"`;
        }
        else if (['java', 'spring', 'springboot'].includes(normalizedFramework)) {
            // Java
            envVars = `      JAVA_OPTS: "-Xmx512m"
      PORT: "${port}"`;
        }
        else if (['elixir', 'phoenix'].includes(normalizedFramework)) {
            // Elixir
            envVars = `      MIX_ENV: prod
      PORT: "${port}"`;
        }
        else if (normalizedFramework === 'meteor') {
            // Meteor (Node.js-based)
            envVars = `      PORT: "${port}"
      ROOT_URL: "http://localhost:${port}"`;
        }
        else {
            // Default: Node.js style
            envVars = `      NODE_ENV: production
      PORT: "${port}"`;
        }
        return `services:
  ${projectName}:
    container_name: ${projectName}
    restart: unless-stopped
    ports:
      - "${port}:${port}"
    environment:
${envVars}
    env_file:
      - .env
    build:
      context: .
      dockerfile: Dockerfile
`;
    }
    /**
     * Emit log messages to frontend.
     */
    log(message, type = 'info') {
        console.log(`[BuildpackGen] ${type.toUpperCase()}: ${message}`);
        if (this.logEmitter) {
            this.logEmitter(message, type);
        }
    }
}
exports.BuildpackGenerationService = BuildpackGenerationService;
// Factory function for creating instances
function createBuildpackGenerationService(nixpacksService, sshService, logEmitter) {
    return new BuildpackGenerationService(nixpacksService, sshService, logEmitter);
}
//# sourceMappingURL=BuildpackGenerationService.js.map