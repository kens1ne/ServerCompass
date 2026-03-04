"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dockerfileGenerator = exports.DockerfileGeneratorService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
/**
 * Dockerfile templates for common project types
 */
const DOCKERFILE_TEMPLATES = {
    nextjs: `# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
{{INSTALL_COMMAND}}

# Copy source and build
COPY . .
ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64
RUN set -e; if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; fi; {{BUILD_COMMAND}}

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy built application
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE {{PORT}}
ENV PORT={{PORT}}
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
`,
    react: `# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
{{INSTALL_COMMAND}}

COPY . .
ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64
RUN set -e; if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; fi; {{BUILD_COMMAND}}

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=builder /app/build /usr/share/nginx/html 2>/dev/null || true

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
    vue: `# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
{{INSTALL_COMMAND}}

COPY . .
ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64
RUN set -e; if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; fi; {{BUILD_COMMAND}}

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
    nuxt: `# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
{{INSTALL_COMMAND}}

COPY . .
ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64
RUN set -e; if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; fi; {{BUILD_COMMAND}}

# Production stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/.output ./

EXPOSE {{PORT}}
CMD ["node", ".output/server/index.mjs"]
`,
    node: `FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
{{INSTALL_COMMAND}}

COPY . .

EXPOSE {{PORT}}
CMD ["{{START_COMMAND}}"]
`,
    express: `FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
{{INSTALL_COMMAND}}

COPY . .

EXPOSE {{PORT}}
ENV NODE_ENV=production
CMD ["{{START_COMMAND}}"]
`,
    nestjs: `# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
{{INSTALL_COMMAND}}

COPY . .
RUN {{BUILD_COMMAND}}

# Production stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE {{PORT}}
CMD ["node", "dist/main.js"]
`,
    python: `FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE {{PORT}}
CMD ["python", "{{START_COMMAND}}"]
`,
    fastapi: `FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE {{PORT}}
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "{{PORT}}"]
`,
    django: `FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE {{PORT}}
RUN python manage.py collectstatic --noinput || true
CMD ["gunicorn", "--bind", "0.0.0.0:{{PORT}}", "{{PROJECT_NAME}}.wsgi:application"]
`,
    flask: `FROM python:3.11-slim
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE {{PORT}}
CMD ["gunicorn", "--bind", "0.0.0.0:{{PORT}}", "app:app"]
`,
    go: `# Build stage
FROM golang:1.23-alpine AS builder
WORKDIR /app

COPY go.* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

# Production stage
FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app

COPY --from=builder /app/main .

EXPOSE {{PORT}}
CMD ["./main"]
`,
    rust: `# Build stage
FROM rust:1.83-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY . .
RUN cargo build --release

# Production stage
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/target/release/ /tmp/build/
RUN find /tmp/build -maxdepth 1 -type f -executable ! -name ".*" ! -name "*.d" | head -1 | xargs -I{} cp {} ./server && rm -rf /tmp/build

EXPOSE {{PORT}}
CMD ["./server"]
`,
    ruby: `FROM ruby:3.2-slim
WORKDIR /app

COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

COPY . .

EXPOSE {{PORT}}
CMD ["ruby", "{{START_COMMAND}}"]
`,
    rails: `FROM ruby:3.2-slim
WORKDIR /app

RUN apt-get update -qq && apt-get install -y nodejs postgresql-client

COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

COPY . .

RUN bundle exec rails assets:precompile || true

EXPOSE {{PORT}}
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "{{PORT}}"]
`,
    static: `FROM nginx:alpine
COPY . /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
    unknown: `# Generic Dockerfile - Please customize for your application
FROM node:20-alpine
WORKDIR /app

COPY . .

# Install dependencies if package.json exists
RUN if [ -f package.json ]; then npm install; fi

EXPOSE {{PORT}}
CMD ["npm", "start"]
`,
};
/**
 * Service for detecting project types and generating Dockerfiles locally
 */
class DockerfileGeneratorService {
    /**
     * Detect project type from local directory
     */
    async detectProjectType(projectPath) {
        const files = fs_1.default.readdirSync(projectPath);
        let detection = { type: 'unknown' };
        // Check for package.json (Node.js projects)
        if (files.includes('package.json')) {
            const pkgPath = path_1.default.join(projectPath, 'package.json');
            const pkg = JSON.parse(fs_1.default.readFileSync(pkgPath, 'utf-8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            // Detect package manager
            detection.packageManager = this.detectPackageManager(projectPath, files);
            // Detect framework
            if (deps.next) {
                detection.type = 'nextjs';
                detection.port = 3000;
                detection.buildCommand = pkg.scripts?.build || 'npm run build';
                detection.startCommand = 'node server.js';
            }
            else if (deps.nuxt) {
                detection.type = 'nuxt';
                detection.port = 3000;
                detection.buildCommand = pkg.scripts?.build || 'npm run build';
            }
            else if (deps['@nestjs/core']) {
                detection.type = 'nestjs';
                detection.port = 3000;
                detection.buildCommand = pkg.scripts?.build || 'npm run build';
                detection.startCommand = 'node dist/main.js';
            }
            else if (deps.vue || deps['@vue/cli-service']) {
                detection.type = 'vue';
                detection.port = 80;
                detection.buildCommand = pkg.scripts?.build || 'npm run build';
            }
            else if (deps.react || deps['react-dom']) {
                // Check if it's a Next.js project without the next dependency listed explicitly
                if (files.includes('next.config.js') || files.includes('next.config.mjs') || files.includes('next.config.ts')) {
                    detection.type = 'nextjs';
                    detection.port = 3000;
                    detection.buildCommand = pkg.scripts?.build || 'npm run build';
                }
                else {
                    detection.type = 'react';
                    detection.port = 80;
                    detection.buildCommand = pkg.scripts?.build || 'npm run build';
                }
            }
            else if (deps.express || deps.fastify || deps.koa || deps.hapi) {
                detection.type = 'express';
                detection.port = parseInt(process.env.PORT || '3000', 10);
                detection.startCommand = pkg.scripts?.start ? 'npm start' : (pkg.main || 'index.js');
            }
            else {
                detection.type = 'node';
                detection.port = 3000;
                detection.startCommand = pkg.scripts?.start ? 'npm start' : (pkg.main || 'index.js');
            }
            // Get version from package.json
            detection.version = pkg.version;
            return detection;
        }
        // Check for Python projects
        if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('Pipfile')) {
            const hasManagePy = files.includes('manage.py');
            const hasMainPy = files.includes('main.py');
            const hasAppPy = files.includes('app.py');
            if (hasManagePy) {
                detection.type = 'django';
                detection.port = 8000;
            }
            else if (hasMainPy) {
                // Check if it's FastAPI
                const mainContent = fs_1.default.readFileSync(path_1.default.join(projectPath, 'main.py'), 'utf-8');
                if (mainContent.includes('FastAPI') || mainContent.includes('fastapi')) {
                    detection.type = 'fastapi';
                    detection.port = 8000;
                }
                else {
                    detection.type = 'python';
                    detection.port = 8000;
                    detection.startCommand = 'main.py';
                }
            }
            else if (hasAppPy) {
                const appContent = fs_1.default.readFileSync(path_1.default.join(projectPath, 'app.py'), 'utf-8');
                if (appContent.includes('Flask') || appContent.includes('flask')) {
                    detection.type = 'flask';
                    detection.port = 5000;
                }
                else {
                    detection.type = 'python';
                    detection.port = 8000;
                    detection.startCommand = 'app.py';
                }
            }
            else {
                detection.type = 'python';
                detection.port = 8000;
            }
            return detection;
        }
        // Check for Go projects
        if (files.includes('go.mod')) {
            detection.type = 'go';
            detection.port = 8080;
            return detection;
        }
        // Check for Rust projects
        if (files.includes('Cargo.toml')) {
            detection.type = 'rust';
            detection.port = 8080;
            return detection;
        }
        // Check for Ruby projects
        if (files.includes('Gemfile')) {
            if (files.includes('config.ru') || files.includes('Rakefile')) {
                detection.type = 'rails';
                detection.port = 3000;
            }
            else {
                detection.type = 'ruby';
                detection.port = 3000;
            }
            return detection;
        }
        // Check for static sites
        if (files.includes('index.html')) {
            detection.type = 'static';
            detection.port = 80;
            return detection;
        }
        return detection;
    }
    /**
     * Detect package manager from lock files
     */
    detectPackageManager(_projectPath, files) {
        if (files.includes('pnpm-lock.yaml'))
            return 'pnpm';
        if (files.includes('yarn.lock'))
            return 'yarn';
        if (files.includes('bun.lockb'))
            return 'bun';
        return 'npm';
    }
    /**
     * Generate install command based on package manager
     */
    getInstallCommand(pm, isProduction = true) {
        switch (pm) {
            case 'pnpm':
                return isProduction ? 'RUN pnpm install --frozen-lockfile --prod' : 'RUN pnpm install --frozen-lockfile';
            case 'yarn':
                return isProduction ? 'RUN yarn install --frozen-lockfile --production' : 'RUN yarn install --frozen-lockfile';
            case 'bun':
                return isProduction ? 'RUN bun install --production' : 'RUN bun install';
            default:
                return isProduction ? 'RUN npm ci --omit=dev' : 'RUN npm ci';
        }
    }
    /**
     * Generate Dockerfile for a project
     */
    async generateDockerfile(projectPath, options = {}) {
        const detection = await this.detectProjectType(projectPath);
        const template = DOCKERFILE_TEMPLATES[detection.type] || DOCKERFILE_TEMPLATES.unknown;
        const port = options.port || detection.port || 3000;
        const pm = detection.packageManager || 'npm';
        const projectName = options.projectName || path_1.default.basename(projectPath);
        // Determine if we need dev dependencies for build
        const needsDevDeps = ['nextjs', 'react', 'vue', 'nuxt', 'nestjs'].includes(detection.type);
        const installCommand = this.getInstallCommand(pm, !needsDevDeps);
        const prodInstallCommand = this.getInstallCommand(pm, true);
        // Replace placeholders
        let content = template
            .replace(/\{\{PORT\}\}/g, String(port))
            .replace(/\{\{INSTALL_COMMAND\}\}/g, installCommand)
            .replace(/\{\{PROD_INSTALL_COMMAND\}\}/g, prodInstallCommand)
            .replace(/\{\{BUILD_COMMAND\}\}/g, detection.buildCommand || 'npm run build')
            .replace(/\{\{START_COMMAND\}\}/g, detection.startCommand || 'npm start')
            .replace(/\{\{PROJECT_NAME\}\}/g, projectName);
        // For pnpm, we need to install it first
        if (pm === 'pnpm') {
            content = content.replace('FROM node:20-alpine', 'FROM node:20-alpine\nRUN corepack enable && corepack prepare pnpm@latest --activate');
        }
        // For bun, use bun image
        if (pm === 'bun') {
            content = content.replace(/FROM node:20-alpine/g, 'FROM oven/bun:1');
        }
        // Write to temp directory
        const tempDir = path_1.default.join(os_1.default.tmpdir(), 'servercompass-builds', (0, crypto_1.randomUUID)());
        fs_1.default.mkdirSync(tempDir, { recursive: true });
        const dockerfilePath = path_1.default.join(tempDir, 'Dockerfile');
        fs_1.default.writeFileSync(dockerfilePath, content);
        return {
            dockerfilePath,
            projectType: detection.type,
            content,
            cleanup: async () => {
                try {
                    fs_1.default.rmSync(tempDir, { recursive: true, force: true });
                }
                catch {
                    // Ignore cleanup errors
                }
            },
        };
    }
    /**
     * Check if project has a Dockerfile
     */
    hasDockerfile(projectPath) {
        return fs_1.default.existsSync(path_1.default.join(projectPath, 'Dockerfile'));
    }
    /**
     * Get existing Dockerfile path
     */
    getDockerfilePath(projectPath) {
        const dockerfilePath = path_1.default.join(projectPath, 'Dockerfile');
        if (fs_1.default.existsSync(dockerfilePath)) {
            return dockerfilePath;
        }
        return null;
    }
}
exports.DockerfileGeneratorService = DockerfileGeneratorService;
exports.dockerfileGenerator = new DockerfileGeneratorService();
//# sourceMappingURL=DockerfileGenerator.js.map