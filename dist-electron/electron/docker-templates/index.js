"use strict";
/**
 * Docker Templates Registry
 *
 * ⚠️ IMPORTANT: BEFORE EDITING OR ADDING TEMPLATES
 * ================================================
 * ALWAYS READ THESE DOCUMENTS FIRST:
 * 1. docs/common-errors/traefik_skip_unhealthy_check.md
 * 2. electron/docker-templates/README.md
 *
 * HEALTHCHECK POLICY:
 * ------------------
 * ❌ NEVER add wget/curl healthchecks to web application containers
 *    - Minimal images (Go, Rust, Node alpine) don't include these tools
 *    - Failed healthchecks → containers marked (unhealthy) → Traefik filters them out → 404 errors
 *
 * ✅ ONLY add healthchecks to database containers using native tools:
 *    - PostgreSQL: pg_isready
 *    - MySQL: mysqladmin ping
 *    - Redis: redis-cli ping
 *
 * ✅ For multi-service stacks (app + database):
 *    - Add healthcheck to database using native tool
 *    - Use depends_on with condition: service_healthy on web app
 *    - This ensures database is ready before web app starts
 *
 * Web application templates (Next.js, Express, NestJS, FastAPI, Go, etc.) intentionally
 * omit healthchecks from their docker-compose definitions to avoid Traefik filtering.
 *
 * Database templates (PostgreSQL, MySQL, Redis) retain healthchecks because they use
 * native tools that are included in their images.
 *
 * @see docs/common-errors/traefik_skip_unhealthy_check.md for full explanation
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_TEMPLATES = void 0;
exports.syncBuiltinTemplatesFromConfig = syncBuiltinTemplatesFromConfig;
exports.resolveTemplateByFramework = resolveTemplateByFramework;
exports.initializeBuiltinTemplates = initializeBuiltinTemplates;
exports.getAllTemplates = getAllTemplates;
exports.getTemplateById = getTemplateById;
exports.renderTemplate = renderTemplate;
const db_1 = require("../db");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
function deriveAppType(category) {
    if (category === 'database')
        return 'database';
    if (category === 'cms')
        return 'service';
    if (category === 'nocode')
        return 'service';
    if (category === 'analytics')
        return 'service';
    if (category === 'application')
        return 'service';
    if (category === 'development')
        return 'service';
    if (category === 'infrastructure')
        return 'service';
    return 'app';
}
function parseJson(value, fallback) {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function normalizeTemplate(template) {
    // Use category if present, otherwise fall back to parentCategory for new template format
    const category = (template.category || template.parentCategory);
    const appType = template.appType || template.app_type || deriveAppType(category);
    const requiresBuild = typeof template.requiresBuild === 'boolean'
        ? template.requiresBuild
        : template.requires_build !== undefined
            ? Boolean(template.requires_build)
            : appType === 'app';
    const envHints = Array.isArray(template.envHints)
        ? template.envHints
        : template.env_hints
            ? template.env_hints
            : [];
    const variables = Array.isArray(template.variables) && template.variables.length > 0
        ? template.variables
        : extractVariables(template.compose || template.compose_content || '');
    return {
        id: template.id,
        name: template.name,
        description: template.description || '',
        category,
        extraCategories: template.extraCategories || template.extra_categories || undefined,
        dbClassification: template.dbClassification || template.db_classification || undefined,
        icon: template.icon || '📦',
        minMemoryMB: template.minMemoryMB ?? template.min_memory_mb ?? 512,
        recommendedPort: template.recommendedPort ?? template.recommended_port ?? undefined,
        compose: template.compose || template.compose_content || '',
        dockerfile: template.dockerfile || template.dockerfile_content || undefined,
        envHints,
        variables,
        documentation: template.documentation,
        externalAccessInstructions: template.externalAccessInstructions,
        securityNotes: template.securityNotes,
        postDeploymentSteps: template.postDeploymentSteps,
        appType,
        // Template JSON uses subCategory while DB uses subcategory; support both.
        subcategory: template.subcategory || template.subCategory || undefined,
        requiresBuild,
        volumeHints: template.volumeHints || template.volume_hints || undefined,
        portsHints: template.portsHints || template.ports_hints || undefined,
        frameworks: template.frameworks,
        preDeployCommands: template.preDeployCommands || undefined,
    };
}
// ============ Load Templates from Config ============
/**
 * Load templates from multiple category-based config files
 *
 * Structure:
 * - templates-config.json: Main config with metadata and templateFiles array
 * - templates/*.json: Category-based template files (database.json, nocode.json, web.json)
 */
function loadTemplatesFromConfigWithSignature() {
    try {
        const configPath = path.join(__dirname, 'templates-config.json');
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        // Signature lets us detect template changes while the app is running (handy in dev).
        const hasher = crypto.createHash('sha256');
        hasher.update('templates-config.json\0');
        hasher.update(configContent);
        const allTemplates = [];
        // Load templates from each file specified in templateFiles
        if (config.templateFiles && Array.isArray(config.templateFiles)) {
            for (const templateFile of config.templateFiles) {
                const filePath = path.join(__dirname, templateFile);
                const fileContent = fs.readFileSync(filePath, 'utf-8');
                const fileData = JSON.parse(fileContent);
                hasher.update('\0');
                hasher.update(String(templateFile));
                hasher.update('\0');
                hasher.update(fileContent);
                if (fileData.templates && Array.isArray(fileData.templates)) {
                    allTemplates.push(...fileData.templates);
                }
            }
        }
        // Backward compatibility: also check for inline templates array
        if (config.templates && Array.isArray(config.templates)) {
            allTemplates.push(...config.templates);
        }
        console.log(`[DockerTemplates] Loaded ${allTemplates.length} templates from ${config.templateFiles?.length || 0} files (version ${config.version})`);
        return {
            templates: allTemplates.map(normalizeTemplate),
            signature: hasher.digest('hex'),
        };
    }
    catch (error) {
        console.error('[DockerTemplates] Failed to load templates from config, falling back to hardcoded templates:', error);
        return {
            templates: getFallbackTemplates(),
            signature: 'fallback',
        };
    }
}
/**
 * Fallback templates in case config file loading fails
 */
function getFallbackTemplates() {
    return [
        nextjsTemplate,
        expressTemplate,
        nestjsTemplate,
        staticTemplate,
        fastapiTemplate,
        djangoTemplate,
        railsTemplate,
        goTemplate,
        postgresTemplate,
        mysqlTemplate,
        redisTemplate,
    ];
}
// ============ Fallback Templates (used if config loading fails) ============
const nextjsTemplate = normalizeTemplate({
    id: 'builtin-nextjs',
    name: 'Next.js',
    description: 'Production-ready Next.js application with standalone output',
    category: 'nextjs',
    icon: '⚛️',
    minMemoryMB: 512,
    frameworks: ['nextjs'],
    recommendedPort: 3000,
    compose: `services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
    restart: unless-stopped
`,
    dockerfile: `# Build stage
	FROM node:20-alpine AS builder
	WORKDIR /app
	COPY package*.json ./
	RUN npm ci
	COPY . .
	ARG SERVER_COMPASS_NEXT_PUBLIC_ENV_B64
	RUN set -e; if [ -n "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" ]; then echo "$SERVER_COMPASS_NEXT_PUBLIC_ENV_B64" | base64 -d > .env.production.local; fi; npm run build
	
	# Production stage
	FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
`,
    envHints: [
        { key: 'NODE_ENV', description: 'Node environment', required: true, default: 'production', type: 'string' },
        { key: 'NEXT_PUBLIC_API_URL', description: 'Public API URL for frontend', required: false, type: 'string' },
        { key: 'DATABASE_URL', description: 'Database connection string', required: false, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '3000' },
    ],
    documentation: `## Next.js Deployment

### Requirements
- Your Next.js app must be configured for standalone output in \`next.config.js\`:
\`\`\`js
module.exports = {
  output: 'standalone'
}
\`\`\`

### Health Check
Add an API route at \`/api/health\` that returns 200 OK.
`,
});
const expressTemplate = normalizeTemplate({
    id: 'builtin-express',
    name: 'Express.js',
    description: 'Node.js Express API server with PM2 process manager',
    category: 'express',
    icon: '🚀',
    minMemoryMB: 256,
    frameworks: ['express', 'node'],
    recommendedPort: 3000,
    compose: `services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:{{PORT}}"
    environment:
      - NODE_ENV=production
      - PORT={{PORT}}
    restart: unless-stopped
`,
    dockerfile: `FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production
EXPOSE {{PORT}}

CMD ["node", "index.js"]
`,
    envHints: [
        { key: 'NODE_ENV', description: 'Node environment', required: true, default: 'production', type: 'string' },
        { key: 'PORT', description: 'Application port', required: true, default: '3000', type: 'number' },
        { key: 'DATABASE_URL', description: 'Database connection string', required: false, type: 'secret' },
        { key: 'JWT_SECRET', description: 'JWT signing secret', required: false, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Application port', default: '3000' },
    ],
});
const nestjsTemplate = normalizeTemplate({
    id: 'builtin-nestjs',
    name: 'NestJS',
    description: 'TypeScript NestJS framework with production build',
    category: 'nestjs',
    icon: '🐈',
    minMemoryMB: 512,
    frameworks: ['nestjs', 'node'],
    recommendedPort: 3000,
    compose: `services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
    restart: unless-stopped
`,
    dockerfile: `# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

EXPOSE 3000
CMD ["node", "dist/main.js"]
`,
    envHints: [
        { key: 'NODE_ENV', description: 'Node environment', required: true, default: 'production', type: 'string' },
        { key: 'DATABASE_URL', description: 'Database connection string', required: false, type: 'secret' },
        { key: 'JWT_SECRET', description: 'JWT signing secret', required: false, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '3000' },
    ],
});
const railsTemplate = normalizeTemplate({
    id: 'builtin-rails',
    name: 'Ruby on Rails',
    description: 'Rails app with Puma and asset precompilation',
    category: 'fullstack',
    icon: '💎',
    minMemoryMB: 512,
    frameworks: ['rails'],
    recommendedPort: 3000,
    compose: `services:
  rails:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:3000"
    environment:
      - RAILS_ENV=production
      - SECRET_KEY_BASE={{SECRET_KEY_BASE}}
    restart: unless-stopped
`,
    dockerfile: `# Ruby on Rails Production Dockerfile
FROM ruby:2.6.10-slim

ENV RAILS_ENV=production \\
    RACK_ENV=production \\
    BUNDLE_PATH=/bundle \\
    BUNDLE_APP_CONFIG=/bundle/config \\
    BUNDLE_BIN=/bundle/bin \\
    BUNDLE_FORCE_RUBY_PLATFORM=1 \\
    RAILS_LOG_TO_STDOUT=true \\
    RAILS_SERVE_STATIC_FILES=true \\
    SECRET_KEY_BASE=dummytoken

ENV PATH="\${BUNDLE_BIN}:\${PATH}"

WORKDIR /app

# Install dependencies (include git for private/git-sourced gems and sqlite headers)
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential libpq-dev nodejs git libsqlite3-dev pkg-config \\
  && rm -rf /var/lib/apt/lists/*

# Install gems (pin Bundler to match older Rails apps)
COPY Gemfile Gemfile.lock ./
ARG BUNDLER_VERSION=1.17.2
RUN gem install bundler -v "\${BUNDLER_VERSION}" \\
  && mkdir -p "\${BUNDLE_APP_CONFIG}" "\${BUNDLE_PATH}" \\
  && bundle _\${BUNDLER_VERSION}_ config --local path "\${BUNDLE_PATH}" \\
  && bundle _\${BUNDLER_VERSION}_ config --local force_ruby_platform true \\
  && bundle _\${BUNDLER_VERSION}_ config build.sqlite3 --with-sqlite3-dir=/usr \\
  && bundle _\${BUNDLER_VERSION}_ install --jobs 4 --retry 3

# Copy application
COPY . .

# Optional: precompile assets (non-fatal if pipeline not configured)
RUN SECRET_KEY_BASE=\${SECRET_KEY_BASE} bundle _\${BUNDLER_VERSION}_ exec rails assets:precompile || echo "Skipping assets precompile (non-fatal)"

EXPOSE 3000

# Run with Rails server
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"]
`,
    envHints: [
        { key: 'SECRET_KEY_BASE', description: 'Rails secret key base', required: true, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '3000' },
        { name: 'SECRET_KEY_BASE', description: 'Rails secret key base', default: '' },
    ],
});
const staticTemplate = normalizeTemplate({
    id: 'builtin-static',
    name: 'Static Site (Nginx)',
    description: 'Static files served by Nginx with gzip compression',
    category: 'static',
    icon: '📄',
    minMemoryMB: 64,
    frameworks: ['static'],
    recommendedPort: 80,
    compose: `services:
  \${projectName}:
    image: nginx:alpine
    container_name: \${projectName}-app
    ports:
      - "{{PORT}}:80"
    volumes:
      - ./public:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    restart: unless-stopped
`,
    envHints: [],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '80' },
    ],
    documentation: `## Static Site Deployment

### Directory Structure
\`\`\`
project/
├── public/          # Your static files (index.html, etc.)
├── nginx.conf       # Optional custom nginx config
└── docker-compose.yml
\`\`\`

### Custom Nginx Config (Optional)
Create \`nginx.conf\` for SPA routing:
\`\`\`nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
\`\`\`
`,
});
const fastapiTemplate = normalizeTemplate({
    id: 'builtin-fastapi',
    name: 'FastAPI',
    description: 'Python FastAPI with uvicorn ASGI server',
    category: 'python',
    icon: '🐍',
    minMemoryMB: 256,
    frameworks: ['fastapi', 'python'],
    recommendedPort: 8000,
    compose: `services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:8000"
    environment:
      - ENVIRONMENT=production
    restart: unless-stopped
`,
    dockerfile: `FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`,
    envHints: [
        { key: 'ENVIRONMENT', description: 'Application environment', required: true, default: 'production', type: 'string' },
        { key: 'DATABASE_URL', description: 'Database connection string', required: false, type: 'secret' },
        { key: 'SECRET_KEY', description: 'Application secret key', required: false, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '8000' },
    ],
});
const djangoTemplate = normalizeTemplate({
    id: 'builtin-django',
    name: 'Django',
    description: 'Python Django with gunicorn and static files',
    category: 'python',
    icon: '🎸',
    minMemoryMB: 512,
    frameworks: ['django', 'python'],
    recommendedPort: 8000,
    compose: `services:
  \${projectName}:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: \${projectName}-app
    ports:
      - "{{PORT}}:8000"
    environment:
      - DJANGO_SETTINGS_MODULE=config.settings
      - SECRET_KEY={{SECRET_KEY}}
    restart: unless-stopped
`,
    dockerfile: `FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

# Copy application
COPY . .

# Collect static files
RUN python manage.py collectstatic --noinput

EXPOSE 8000

CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "config.wsgi:application"]
`,
    envHints: [
        { key: 'DJANGO_SETTINGS_MODULE', description: 'Django settings module', required: true, default: 'config.settings', type: 'string' },
        { key: 'SECRET_KEY', description: 'Django secret key', required: true, type: 'secret' },
        { key: 'DATABASE_URL', description: 'Database connection string', required: false, type: 'secret' },
        { key: 'ALLOWED_HOSTS', description: 'Comma-separated allowed hosts', required: false, default: '*', type: 'string' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '8000' },
        { name: 'SECRET_KEY', description: 'Django secret key', default: '' },
    ],
});
const goTemplate = normalizeTemplate({
    id: 'builtin-go',
    name: 'Go API',
    description: 'Golang HTTP service with multi-stage build',
    category: 'go',
    icon: '🐹',
    minMemoryMB: 128,
    frameworks: ['go'],
    recommendedPort: 8080,
    compose: `services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{{PORT}}:8080"
    environment:
      - GO_ENV=production
    restart: unless-stopped
`,
    dockerfile: `# Build stage
FROM golang:1.21-alpine AS builder
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

# Production stage
FROM alpine:latest
RUN apk --no-cache add ca-certificates wget

WORKDIR /app
COPY --from=builder /app/main .

EXPOSE 8080
CMD ["./main"]
`,
    envHints: [
        { key: 'GO_ENV', description: 'Go environment', required: true, default: 'production', type: 'string' },
        { key: 'DATABASE_URL', description: 'Database connection string', required: false, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '8080' },
    ],
});
const postgresTemplate = normalizeTemplate({
    id: 'builtin-postgres',
    name: 'PostgreSQL',
    description: 'PostgreSQL database with persistent storage',
    category: 'database',
    icon: '🐘',
    minMemoryMB: 256,
    recommendedPort: 5432,
    compose: `services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "{{PORT}}:5432"
    environment:
      - POSTGRES_USER={{POSTGRES_USER}}
      - POSTGRES_PASSWORD={{POSTGRES_PASSWORD}}
      - POSTGRES_DB={{POSTGRES_DB}}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U {{POSTGRES_USER}} -d {{POSTGRES_DB}}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
`,
    envHints: [
        { key: 'POSTGRES_USER', description: 'PostgreSQL username', required: true, default: 'postgres', type: 'string' },
        { key: 'POSTGRES_PASSWORD', description: 'PostgreSQL password', required: true, type: 'secret' },
        { key: 'POSTGRES_DB', description: 'Database name', required: true, default: 'app', type: 'string' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '5432' },
        { name: 'POSTGRES_USER', description: 'Database username', default: 'postgres' },
        { name: 'POSTGRES_PASSWORD', description: 'Database password', default: '' },
        { name: 'POSTGRES_DB', description: 'Database name', default: 'app' },
    ],
});
const mysqlTemplate = normalizeTemplate({
    id: 'builtin-mysql',
    name: 'MySQL',
    description: 'MySQL database with persistent storage',
    category: 'database',
    icon: '🐬',
    minMemoryMB: 512,
    recommendedPort: 3306,
    compose: `services:
  mysql:
    image: mysql:8
    ports:
      - "{{PORT}}:3306"
    environment:
      - MYSQL_ROOT_PASSWORD={{MYSQL_ROOT_PASSWORD}}
      - MYSQL_DATABASE={{MYSQL_DATABASE}}
      - MYSQL_USER={{MYSQL_USER}}
      - MYSQL_PASSWORD={{MYSQL_PASSWORD}}
    volumes:
      - mysql_data:/var/lib/mysql
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h localhost -u root -p$$MYSQL_ROOT_PASSWORD || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  mysql_data:
`,
    envHints: [
        { key: 'MYSQL_ROOT_PASSWORD', description: 'MySQL root password', required: true, type: 'secret' },
        { key: 'MYSQL_DATABASE', description: 'Database name', required: true, default: 'app', type: 'string' },
        { key: 'MYSQL_USER', description: 'MySQL username', required: true, default: 'app', type: 'string' },
        { key: 'MYSQL_PASSWORD', description: 'MySQL user password', required: true, type: 'secret' },
    ],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '3306' },
        { name: 'MYSQL_ROOT_PASSWORD', description: 'Root password', default: '' },
        { name: 'MYSQL_DATABASE', description: 'Database name', default: 'app' },
        { name: 'MYSQL_USER', description: 'Database username', default: 'app' },
        { name: 'MYSQL_PASSWORD', description: 'Database password', default: '' },
    ],
});
const redisTemplate = normalizeTemplate({
    id: 'builtin-redis',
    name: 'Redis',
    description: 'Redis cache with optional persistence',
    category: 'database',
    icon: '🔴',
    minMemoryMB: 64,
    recommendedPort: 6379,
    compose: `services:
  redis:
    image: redis:7-alpine
    ports:
      - "{{PORT}}:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  redis_data:
`,
    envHints: [],
    variables: [
        { name: 'PORT', description: 'Host port to expose', default: '6379' },
    ],
});
// ============ Template Registry ============
// Built-in templates are defined in JSON files and synced into the DB.
// Keep an in-memory cache for framework resolution, but allow refreshing when files change.
let BUILTIN_TEMPLATES = [];
exports.BUILTIN_TEMPLATES = BUILTIN_TEMPLATES;
let lastBuiltinTemplatesSignature = null;
function syncBuiltinTemplatesFromConfig(options) {
    const { force = false } = options || {};
    const { templates, signature } = loadTemplatesFromConfigWithSignature();
    if (!force && lastBuiltinTemplatesSignature === signature && BUILTIN_TEMPLATES.length > 0) {
        return { updated: false, count: BUILTIN_TEMPLATES.length, signature };
    }
    const stmt = db_1.db.prepare(`
    INSERT OR REPLACE INTO docker_compose_templates (
      id, name, description, category, extra_categories, db_classification, compose_content, dockerfile_content,
      env_hints, variables, documentation, min_memory_mb, icon, recommended_port,
      app_type, subcategory, requires_build, volume_hints, ports_hints,
      is_builtin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
    const now = Date.now();
    const ids = templates.map((t) => t.id);
    const tx = db_1.db.transaction(() => {
        for (const template of templates) {
            stmt.run(template.id, template.name, template.description, template.category, template.extraCategories ? JSON.stringify(template.extraCategories) : null, template.dbClassification || null, template.compose, template.dockerfile || null, JSON.stringify(template.envHints), JSON.stringify(template.variables), template.documentation || null, template.minMemoryMB, template.icon, template.recommendedPort || null, template.appType, template.subcategory || null, template.requiresBuild ? 1 : 0, template.volumeHints ? JSON.stringify(template.volumeHints) : null, template.portsHints ? JSON.stringify(template.portsHints) : null, now, now);
        }
        // Remove built-in templates removed from config, but keep user-created templates.
        // IMPORTANT: Skip cleanup if we fell back due to config loading failure (avoid nuking templates on I/O issues).
        if (signature !== 'fallback' && ids.length > 0) {
            const placeholders = ids.map(() => '?').join(', ');
            db_1.db.prepare(`
        DELETE FROM docker_compose_templates
        WHERE is_builtin = 1 AND id NOT IN (${placeholders})
      `).run(...ids);
        }
    });
    tx();
    exports.BUILTIN_TEMPLATES = BUILTIN_TEMPLATES = templates;
    lastBuiltinTemplatesSignature = signature;
    try {
        db_1.queries.setSetting('docker_templates_config_signature', signature);
    }
    catch {
        // Non-fatal: keep working even if settings cannot be written.
    }
    return { updated: true, count: templates.length, signature };
}
function getBuiltinTemplates() {
    if (BUILTIN_TEMPLATES.length === 0) {
        syncBuiltinTemplatesFromConfig({ force: true });
    }
    return BUILTIN_TEMPLATES;
}
/**
 * Ensure BUILTIN_TEMPLATES is populated from JSON config files.
 * This is used by getAllTemplates() and getTemplateById() to provide
 * accurate envHints/variables even if DB data is stale.
 */
function ensureBuiltinTemplatesLoaded() {
    if (BUILTIN_TEMPLATES.length === 0) {
        // Load from JSON config without DB sync (to avoid potential DB errors)
        const { templates } = loadTemplatesFromConfigWithSignature();
        exports.BUILTIN_TEMPLATES = BUILTIN_TEMPLATES = templates;
    }
}
function normalizeFramework(framework) {
    return (framework || '').trim().toLowerCase();
}
function getFrameworkAliases(template) {
    const aliases = new Set();
    // Explicit aliases defined on the template
    (template.frameworks || []).forEach(f => {
        const normalized = normalizeFramework(f);
        if (normalized)
            aliases.add(normalized);
    });
    const textSources = [
        template.id,
        template.name,
        template.category,
    ].map(s => s.toLowerCase());
    const addIfMatches = (needle, alias = needle) => {
        if (textSources.some(src => src.includes(needle))) {
            aliases.add(alias);
        }
    };
    addIfMatches('next', 'nextjs');
    addIfMatches('express');
    addIfMatches('fastapi');
    addIfMatches('flask');
    addIfMatches('django');
    addIfMatches('rails');
    addIfMatches('laravel');
    addIfMatches('nest', 'nestjs');
    addIfMatches('node');
    addIfMatches('static');
    addIfMatches('go');
    return Array.from(aliases);
}
/**
 * Resolve a template by detected framework identifier (e.g., rails, django).
 * Uses built-in templates first, then falls back to any stored templates.
 */
function resolveTemplateByFramework(framework) {
    const normalized = normalizeFramework(framework);
    if (!normalized)
        return null;
    const builtin = getBuiltinTemplates().find(t => getFrameworkAliases(t).includes(normalized));
    if (builtin) {
        return builtin;
    }
    const allTemplates = getAllTemplates();
    return allTemplates.find(t => getFrameworkAliases(t).includes(normalized)) || null;
}
/**
 * Initialize built-in templates in the database
 */
function initializeBuiltinTemplates() {
    const result = syncBuiltinTemplatesFromConfig({ force: true });
    console.log(`[DockerTemplates] Initialized ${result.count} built-in templates`);
}
/**
 * Get all templates (built-in + custom)
 */
function getAllTemplates() {
    // Ensure in-memory templates are loaded (for fallback when DB has stale data)
    ensureBuiltinTemplatesLoaded();
    // IMPORTANT: templates are persisted in the user DB; ensure older installs (or dev edits)
    // get the latest config-backed built-in templates before returning results.
    try {
        syncBuiltinTemplatesFromConfig();
    }
    catch (error) {
        console.error('[DockerTemplates] Failed to sync built-in templates before listing:', error);
    }
    const dbTemplates = db_1.queries.getDockerComposeTemplates();
    return dbTemplates.map((t) => {
        // Use stored variables if available, otherwise extract from compose content (fallback for old data)
        const storedVariables = t.variables ? parseJson(t.variables, []) : [];
        const variables = storedVariables.length > 0 ? storedVariables : extractVariables(t.compose_content);
        // For built-in templates, use in-memory envHints/variables as authoritative source
        // This ensures we always have up-to-date data even if DB sync was skipped or has stale data
        const builtinTemplate = t.is_builtin ? BUILTIN_TEMPLATES.find(bt => bt.id === t.id) : null;
        const envHints = builtinTemplate?.envHints ?? parseJson(t.env_hints, []);
        const finalVariables = builtinTemplate?.variables ?? variables;
        return normalizeTemplate({
            id: t.id,
            name: t.name,
            description: t.description || '',
            category: t.category,
            extraCategories: t.extra_categories ? parseJson(t.extra_categories, []) : undefined,
            dbClassification: t.db_classification || undefined,
            icon: t.icon || '📦',
            minMemoryMB: t.min_memory_mb,
            recommendedPort: t.recommended_port ?? undefined,
            compose: builtinTemplate?.compose ?? t.compose_content,
            dockerfile: builtinTemplate?.dockerfile ?? t.dockerfile_content ?? undefined,
            envHints,
            variables: finalVariables,
            documentation: builtinTemplate?.documentation ?? t.documentation ?? undefined,
            appType: t.app_type,
            subcategory: t.subcategory || undefined,
            requiresBuild: typeof t.requires_build === 'number' ? Boolean(t.requires_build) : undefined,
            volumeHints: t.volume_hints ? parseJson(t.volume_hints, []) : undefined,
            portsHints: t.ports_hints ? parseJson(t.ports_hints, []) : undefined,
        });
    });
}
/**
 * Get a specific template by ID
 */
function getTemplateById(templateId) {
    // Ensure in-memory templates are loaded (for fallback when DB has stale data)
    ensureBuiltinTemplatesLoaded();
    try {
        syncBuiltinTemplatesFromConfig();
    }
    catch (error) {
        console.error('[DockerTemplates] Failed to sync built-in templates before getTemplateById:', error);
    }
    const t = db_1.queries.getDockerComposeTemplate(templateId);
    if (!t)
        return null;
    // Use stored variables if available, otherwise extract from compose content (fallback for old data)
    const storedVariables = t.variables ? parseJson(t.variables, []) : [];
    const variables = storedVariables.length > 0 ? storedVariables : extractVariables(t.compose_content);
    // For built-in templates, use in-memory envHints/variables as authoritative source
    // This ensures we always have up-to-date data even if DB sync was skipped or has stale data
    const builtinTemplate = t.is_builtin ? BUILTIN_TEMPLATES.find(bt => bt.id === t.id) : null;
    const envHints = builtinTemplate?.envHints ?? parseJson(t.env_hints, []);
    const finalVariables = builtinTemplate?.variables ?? variables;
    return normalizeTemplate({
        id: t.id,
        name: t.name,
        description: t.description || '',
        category: t.category,
        extraCategories: t.extra_categories ? parseJson(t.extra_categories, []) : undefined,
        dbClassification: t.db_classification || undefined,
        icon: t.icon || '📦',
        minMemoryMB: t.min_memory_mb,
        recommendedPort: t.recommended_port ?? undefined,
        compose: builtinTemplate?.compose ?? t.compose_content,
        dockerfile: builtinTemplate?.dockerfile ?? t.dockerfile_content ?? undefined,
        envHints,
        variables: finalVariables,
        documentation: builtinTemplate?.documentation ?? t.documentation ?? undefined,
        externalAccessInstructions: builtinTemplate?.externalAccessInstructions ?? undefined,
        securityNotes: builtinTemplate?.securityNotes ?? undefined,
        postDeploymentSteps: builtinTemplate?.postDeploymentSteps ?? undefined,
        preDeployCommands: builtinTemplate?.preDeployCommands ?? undefined,
        appType: t.app_type,
        subcategory: t.subcategory || undefined,
        requiresBuild: typeof t.requires_build === 'number' ? Boolean(t.requires_build) : undefined,
        volumeHints: t.volume_hints ? parseJson(t.volume_hints, []) : undefined,
        portsHints: t.ports_hints ? parseJson(t.ports_hints, []) : undefined,
    });
}
/**
 * Extract variable names from template content
 */
function extractVariables(content) {
    const regex = /\{\{(\w+)\}\}/g;
    const variables = new Set();
    let match;
    while ((match = regex.exec(content)) !== null) {
        variables.add(match[1]);
    }
    return Array.from(variables).map(name => ({
        name,
        description: `Value for ${name}`,
        default: getDefaultForVariable(name, content),
    }));
}
/**
 * Get sensible default for common variable names
 */
function getDefaultForVariable(name, content) {
    const defaults = {
        PORT: '3000',
        // PostgreSQL defaults
        POSTGRES_USER: 'postgres',
        POSTGRES_DB: 'app',
        // MySQL defaults
        MYSQL_DATABASE: 'app',
        MYSQL_USER: 'app',
        // MongoDB defaults
        MONGO_USER: 'admin',
        MONGO_DATABASE: 'app',
        // CouchDB defaults
        COUCHDB_USER: 'admin',
        // Elasticsearch defaults
        ELASTIC_USER: 'elastic',
        // Cassandra defaults
        CASSANDRA_USER: 'cassandra',
        // Supabase multi-port template defaults
        DB_PORT: '5432',
        REST_PORT: '3001',
        META_PORT: '8080',
        STUDIO_PORT: '3000',
        // SurrealDB defaults
        SURREAL_USER: 'root',
    };
    // Heuristic defaults based on compose content keywords to keep app-specific DB names/users sensible
    if (name === 'DB_NAME' || name === 'DB_USER') {
        const lower = (content || '').toLowerCase();
        if (lower.includes('wordpress'))
            return 'wordpress';
        if (lower.includes('ghost'))
            return 'ghost';
        if (lower.includes('strapi'))
            return 'strapi';
        if (lower.includes('supabase'))
            return 'postgres';
        return 'app';
    }
    return defaults[name] || '';
}
/**
 * Render a template with variable substitution
 *
 * Note: Generated passwords exclude $ to avoid Docker Compose variable expansion issues.
 * See electron/ipc/docker-stacks.ts:generateSecret() for password generation.
 */
function renderTemplate(templateId, variables) {
    const template = getTemplateById(templateId);
    if (!template) {
        throw new Error(`Template not found: ${templateId}`);
    }
    let compose = template.compose;
    let dockerfile = template.dockerfile;
    for (const [key, value] of Object.entries(variables)) {
        const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        // For docker-compose.yml: Escape $ as $$ so Docker Compose treats it literally
        // Docker Compose interprets $ as variable references (e.g., $VAR or ${VAR})
        // Using $$ makes it a literal $ character
        // This is critical for passwords containing $ (though we now exclude $ from generation)
        const composeValue = value.replace(/\$/g, '$$$$');
        compose = compose.replace(pattern, composeValue);
        // For Dockerfile: Use value as-is (different variable syntax)
        if (dockerfile) {
            dockerfile = dockerfile.replace(pattern, value);
        }
    }
    return { compose, dockerfile };
}
//# sourceMappingURL=index.js.map