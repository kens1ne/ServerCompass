"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerStackDetectUnmanagedSchema = exports.DockerStackCheckProjectNameSchema = exports.DockerDeploymentByIdSchema = exports.DockerServerDeploymentsSchema = exports.DockerStackDeploymentsSchema = exports.DockerStackLogsSchema = exports.DockerStackUpdateEnvSchema = exports.DockerStackUpdateComposeSchema = exports.DockerStackDeleteSchema = exports.DockerStackRestartSchema = exports.DockerStackStopSchema = exports.DockerStackIdSchema = exports.DockerStackClearPendingFailureSchema = exports.DockerStackRollbackSchema = exports.DockerStackUpdateBuildLocationSchema = exports.DockerStackUpdateStrategySchema = exports.DockerStackRedeploySchema = exports.DockerStackDeploySchema = exports.BuildLocationSchema = exports.RegistryTypeSchema = exports.PullPolicySchema = exports.StackStatusSchema = exports.SourceTypeSchema = exports.DockerUpdateComposeSchema = exports.DockerTestRegistrySchema = exports.DockerLogsSchema = exports.DockerServiceSchema = exports.DockerProjectSchema = exports.DockerRedeploySchema = exports.DockerDeploySchema = exports.BackupJobStatusSchema = exports.BackupListFromS3Schema = exports.ServerBackupRestoreSchema = exports.ServerBackupListJobsSchema = exports.ServerBackupCancelSchema = exports.ServerBackupRunNowSchema = exports.ServerBackupConfigUpdateSchema = exports.AppBackupScheduleUpdateSchema = exports.BackupFrequencySchema = exports.BackupPassphraseVerifySchema = exports.BackupPassphraseSetSchema = exports.BackupStorageTestSchema = exports.BackupStorageUpdateSchema = exports.BackupStorageConfigIdSchema = exports.BackupStorageConfigInputSchema = exports.S3ProviderSchema = exports.FavoritePathIdSchema = exports.UpdateFavoritePathSchema = exports.CreateFavoritePathSchema = exports.FavoritePathServerSchema = void 0;
exports.DockerProxyRenewSslSchema = exports.DockerProxyIdSchema = exports.DockerProxyConfigureSchema = exports.DockerPM2RollbackSchema = exports.DockerPM2ValidateSchema = exports.DockerPM2MigrateSchema = exports.DockerPM2GenerateComposeSchema = exports.DockerPM2ListSchema = exports.DockerHostInstallSchema = exports.DockerHostCheckSchema = exports.DockerComposeSanitizeSchema = exports.DockerComposeValidateSchema = exports.DockerTemplateCreateSchema = exports.DockerSupabaseJwtGenerateSchema = exports.DockerTemplateRenderSchema = exports.DockerTemplateIdSchema = exports.DockerRegistryTestSchema = exports.DockerRegistryIdSchema = exports.DockerRegistryUpdateSchema = exports.DockerRegistryAddSchema = void 0;
const zod_1 = require("zod");
// Favorite Paths schemas
exports.FavoritePathServerSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.CreateFavoritePathSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    name: zod_1.z.string().min(1),
    path: zod_1.z.string().min(1),
});
exports.UpdateFavoritePathSchema = zod_1.z.object({
    id: zod_1.z.string(),
    name: zod_1.z.string().min(1).optional(),
    path: zod_1.z.string().min(1).optional(),
    displayOrder: zod_1.z.number().int().nonnegative().optional(),
});
exports.FavoritePathIdSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
// ============ S3 Backup Schemas ============
exports.S3ProviderSchema = zod_1.z.enum([
    'aws',
    'backblaze',
    'wasabi',
    'minio',
    'r2',
    'do_spaces',
    'vultr',
    'hetzner',
    'custom',
]);
exports.BackupStorageConfigInputSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    provider: exports.S3ProviderSchema,
    bucket: zod_1.z.string().min(1).max(255),
    region: zod_1.z.string().max(50).optional(),
    endpoint: zod_1.z.string().url().optional(),
    accessKey: zod_1.z.string().min(1).max(255),
    secretKey: zod_1.z.string().min(1).max(255),
    pathPrefix: zod_1.z.string().max(255).default('servercompass-backups'),
    isDefault: zod_1.z.boolean().default(false),
});
exports.BackupStorageConfigIdSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
exports.BackupStorageUpdateSchema = zod_1.z.object({
    id: zod_1.z.string(),
    name: zod_1.z.string().min(1).max(100).optional(),
    provider: exports.S3ProviderSchema.optional(),
    bucket: zod_1.z.string().min(1).max(255).optional(),
    region: zod_1.z.string().max(50).optional().nullable(),
    endpoint: zod_1.z.string().url().optional().nullable(),
    accessKey: zod_1.z.string().min(1).max(255).optional(),
    secretKey: zod_1.z.string().min(1).max(255).optional(),
    pathPrefix: zod_1.z.string().max(255).optional(),
    isDefault: zod_1.z.boolean().optional(),
});
exports.BackupStorageTestSchema = zod_1.z.object({
    provider: exports.S3ProviderSchema,
    bucket: zod_1.z.string().min(1),
    region: zod_1.z.string().optional(),
    endpoint: zod_1.z.string().url().optional(),
    accessKey: zod_1.z.string().min(1),
    secretKey: zod_1.z.string().min(1),
    pathPrefix: zod_1.z.string().optional(),
});
exports.BackupPassphraseSetSchema = zod_1.z.object({
    passphrase: zod_1.z.string().min(8, 'Passphrase must be at least 8 characters'),
});
exports.BackupPassphraseVerifySchema = zod_1.z.object({
    passphrase: zod_1.z.string().min(1),
});
exports.BackupFrequencySchema = zod_1.z.enum(['hourly', 'daily', 'weekly', 'monthly']);
exports.AppBackupScheduleUpdateSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().optional(),
    storageConfigId: zod_1.z.string().nullable().optional(),
    frequency: exports.BackupFrequencySchema.optional(),
    time: zod_1.z.string().regex(/^\d{2}:\d{2}$/).optional(),
    dayOfWeek: zod_1.z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: zod_1.z.number().int().min(1).max(28).nullable().optional(),
    timezone: zod_1.z.string().optional(),
    retentionCount: zod_1.z.number().int().min(1).max(365).optional(),
});
exports.ServerBackupConfigUpdateSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    enabled: zod_1.z.boolean().optional(),
    storageConfigId: zod_1.z.string().nullable().optional(),
    frequency: exports.BackupFrequencySchema.optional(),
    time: zod_1.z.string().regex(/^\d{2}:\d{2}$/).optional(),
    dayOfWeek: zod_1.z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: zod_1.z.number().int().min(1).max(28).nullable().optional(),
    timezone: zod_1.z.string().optional(),
    retentionCount: zod_1.z.number().int().min(1).max(100).optional(),
    backupVolumes: zod_1.z.boolean().optional(),
    backupDatabases: zod_1.z.boolean().optional(),
    backupComposeFiles: zod_1.z.boolean().optional(),
    backupEnvFiles: zod_1.z.boolean().optional(),
    backupSslCerts: zod_1.z.boolean().optional(),
    backupCronJobs: zod_1.z.boolean().optional(),
    stopContainersForConsistency: zod_1.z.boolean().optional(),
    exclusions: zod_1.z.array(zod_1.z.object({
        type: zod_1.z.enum(['stack', 'volume', 'database']),
        value: zod_1.z.string(),
    })).optional(),
});
exports.ServerBackupRunNowSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    storageConfigId: zod_1.z.string().optional(),
});
exports.ServerBackupCancelSchema = zod_1.z.object({
    jobId: zod_1.z.string(),
});
exports.ServerBackupListJobsSchema = zod_1.z.object({
    serverId: zod_1.z.string().optional(),
    limit: zod_1.z.number().int().positive().max(100).default(50).optional(),
});
exports.ServerBackupRestoreSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    storageConfigId: zod_1.z.string(),
    manifestKey: zod_1.z.string(),
    restoreVolumes: zod_1.z.boolean().optional(),
    restoreDatabases: zod_1.z.boolean().optional(),
    restoreComposeFiles: zod_1.z.boolean().optional(),
    restoreEnvFiles: zod_1.z.boolean().optional(),
    restoreSslCerts: zod_1.z.boolean().optional(),
    restoreCronJobs: zod_1.z.boolean().optional(),
    selectedVolumes: zod_1.z.array(zod_1.z.string()).optional(),
    selectedDatabases: zod_1.z.array(zod_1.z.string()).optional(),
    selectedStacks: zod_1.z.array(zod_1.z.string()).optional(),
    stopContainersFirst: zod_1.z.boolean().optional(),
});
exports.BackupListFromS3Schema = zod_1.z.object({
    serverId: zod_1.z.string(),
    storageConfigId: zod_1.z.string(),
});
// Backup job status type
exports.BackupJobStatusSchema = zod_1.z.enum([
    'pending',
    'running',
    'success',
    'failed',
    'partial',
    'cancelled',
]);
// Docker Compose schemas
exports.DockerDeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Project name must contain only lowercase letters, numbers, and hyphens'),
    composeFileContent: zod_1.z.string().min(1),
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    registryType: zod_1.z.enum(['ghcr', 'gitlab', 'dockerhub', 'self_hosted', 'custom']).optional(),
    registryUrl: zod_1.z.string().optional(),
    registryUsername: zod_1.z.string().optional(),
    registryPassword: zod_1.z.string().optional(),
    autoUpdate: zod_1.z.boolean().optional(),
});
exports.DockerRedeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string(),
});
exports.DockerProjectSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string(),
});
exports.DockerServiceSchema = exports.DockerProjectSchema.extend({
    serviceName: zod_1.z.string().optional(),
});
exports.DockerLogsSchema = exports.DockerServiceSchema.extend({
    tail: zod_1.z.number().int().positive().default(100).optional(),
    follow: zod_1.z.boolean().default(false).optional(),
});
exports.DockerTestRegistrySchema = zod_1.z.object({
    type: zod_1.z.enum(['ghcr', 'gitlab', 'dockerhub', 'self_hosted', 'custom']),
    url: zod_1.z.string().optional(),
    username: zod_1.z.string(),
    password: zod_1.z.string(),
});
exports.DockerUpdateComposeSchema = zod_1.z.object({
    deploymentId: zod_1.z.string(),
    composeFileContent: zod_1.z.string().min(1),
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
});
// ============ Docker Stack Schemas (Enhanced API) ============
exports.SourceTypeSchema = zod_1.z.enum(['template', 'paste', 'registry', 'pm2_migration', 'github', 'upload']);
exports.StackStatusSchema = zod_1.z.enum(['pending', 'deploying', 'running', 'partial', 'stopped', 'error']);
exports.PullPolicySchema = zod_1.z.enum(['always', 'missing', 'never']);
exports.RegistryTypeSchema = zod_1.z.enum(['dockerhub', 'ghcr', 'gitlab', 'ecr', 'gcr', 'custom']);
exports.BuildLocationSchema = zod_1.z.enum(['vps', 'github-actions', 'local-build']);
// Stack deployment input
exports.DockerStackDeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9-_]*[a-z0-9]$|^[a-z0-9]$/, 'Project name must start/end with alphanumeric and contain only lowercase letters, numbers, hyphens, and underscores'),
    sourceType: exports.SourceTypeSchema,
    templateId: zod_1.z.string().optional(),
    composeContent: zod_1.z.string().optional(), // Optional for GitHub source (will read from repo)
    dockerfileContent: zod_1.z.string().optional(),
    dockerfileOverridePath: zod_1.z.string().min(1).max(128).optional(), // GitHub-only: e.g. "Dockerfile.servercompass"
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    stackPath: zod_1.z.string().default('/root/server-compass/apps'),
    registryCredentialId: zod_1.z.string().optional(),
    buildOnDeploy: zod_1.z.boolean().default(false),
    notifyOnCompletion: zod_1.z.boolean().optional(),
    pullPolicy: exports.PullPolicySchema.default('missing'),
    // GitHub repository fields
    gitAccountId: zod_1.z.string().optional(),
    gitRepository: zod_1.z.string().optional(), // Format: "owner/repo"
    gitBranch: zod_1.z.string().default('main').optional(),
    gitPullOnRedeploy: zod_1.z.boolean().default(true).optional(),
    useGitHubActions: zod_1.z.boolean().default(false).optional(), // Use GitHub Actions CI/CD for Docker deployment
    appPort: zod_1.z.number().int().min(1).max(65535).optional(), // Port for Docker container
    buildLocation: exports.BuildLocationSchema.default('vps').optional(), // How the image was built (affects redeploy behavior)
    uploadFolderPath: zod_1.z.string().optional(), // Upload source: path to uploaded code on VPS (e.g. /tmp/servercompass-upload-...)
});
// Stack redeploy input
exports.DockerStackRedeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    pullImages: zod_1.z.boolean().default(true),
    force: zod_1.z.boolean().default(false),
    pullLatestCode: zod_1.z.boolean().default(false), // Pull latest code from GitHub before redeploy
    updateEnvOnly: zod_1.z.boolean().default(false), // Just restart containers with updated env (no rebuild)
    // Zero-downtime options
    zeroDowntime: zod_1.z.boolean().default(false), // Use zero-downtime deployment strategy
    gracePeriod: zod_1.z.number().default(30000), // Post-switch verification period
    readinessTimeout: zod_1.z.number().default(60000), // Pre-switch readiness timeout
    // Build location change (for switching build type on redeploy)
    buildLocation: exports.BuildLocationSchema.optional(),
});
// Update deployment strategy
exports.DockerStackUpdateStrategySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    deploymentStrategy: zod_1.z.enum(['standard', 'zero_downtime']),
});
// Update build location (how images are built)
exports.DockerStackUpdateBuildLocationSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    buildLocation: exports.BuildLocationSchema,
});
// Stack rollback input
exports.DockerStackRollbackSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    targetDeploymentId: zod_1.z.string(),
});
// Clear pending failure input
exports.DockerStackClearPendingFailureSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
});
// Stack ID operations
exports.DockerStackIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
});
// Stack stop with options
exports.DockerStackStopSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    removeVolumes: zod_1.z.boolean().default(false),
});
// Stack restart with optional service
exports.DockerStackRestartSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    serviceName: zod_1.z.string().optional(),
});
// Stack delete with options
exports.DockerStackDeleteSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    removeVolumes: zod_1.z.boolean().default(false),
    force: zod_1.z.boolean().default(false),
});
// Update compose content
exports.DockerStackUpdateComposeSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    content: zod_1.z.string().min(1),
});
// Update environment variables
exports.DockerStackUpdateEnvSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()),
});
// Stack logs
exports.DockerStackLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    serviceName: zod_1.z.string().optional(),
    tail: zod_1.z.number().int().positive().default(100),
    follow: zod_1.z.boolean().default(false),
});
// Deployment history
exports.DockerStackDeploymentsSchema = zod_1.z.object({
    stackId: zod_1.z.string(),
    limit: zod_1.z.number().int().positive().default(10),
});
// Server-wide deployment history
exports.DockerServerDeploymentsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    limit: zod_1.z.number().int().positive().default(50),
});
// Get single deployment by ID
exports.DockerDeploymentByIdSchema = zod_1.z.object({
    deploymentId: zod_1.z.string(),
});
// Check project name availability
exports.DockerStackCheckProjectNameSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    projectName: zod_1.z.string().min(1).max(64),
});
// Detect unmanaged Docker apps
exports.DockerStackDetectUnmanagedSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// ============ Docker Registry Schemas ============
exports.DockerRegistryAddSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    type: exports.RegistryTypeSchema,
    name: zod_1.z.string().min(1).max(100),
    url: zod_1.z.string().optional(),
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
});
exports.DockerRegistryUpdateSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    registryId: zod_1.z.string(),
    name: zod_1.z.string().min(1).max(100).optional(),
    type: exports.RegistryTypeSchema.optional(),
    url: zod_1.z.string().optional(),
    username: zod_1.z.string().min(1).optional(),
    password: zod_1.z.string().min(1).optional(),
});
exports.DockerRegistryIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    registryId: zod_1.z.string(),
});
exports.DockerRegistryTestSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    type: exports.RegistryTypeSchema,
    url: zod_1.z.string().optional(),
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
});
// ============ Docker Template Schemas ============
exports.DockerTemplateIdSchema = zod_1.z.object({
    templateId: zod_1.z.string(),
});
exports.DockerTemplateRenderSchema = zod_1.z.object({
    templateId: zod_1.z.string(),
    variables: zod_1.z.record(zod_1.z.string(), zod_1.z.string()),
});
exports.DockerSupabaseJwtGenerateSchema = zod_1.z.object({
    secret: zod_1.z.string().min(1),
    role: zod_1.z.enum(['anon', 'service_role']),
});
exports.DockerTemplateCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().optional(),
    category: zod_1.z.enum(['nextjs', 'express', 'nestjs', 'static', 'python', 'go', 'database', 'fullstack', 'custom', 'cms']),
    composeContent: zod_1.z.string().min(1),
    dockerfileContent: zod_1.z.string().optional(),
    envHints: zod_1.z.string().optional(), // JSON string of EnvHint[]
    documentation: zod_1.z.string().optional(),
    minMemoryMb: zod_1.z.number().int().positive().default(512),
    icon: zod_1.z.string().optional(),
    recommendedPort: zod_1.z.number().int().positive().optional(),
    appType: zod_1.z.enum(['app', 'service', 'database']).optional(),
    subcategory: zod_1.z.string().optional(),
    requiresBuild: zod_1.z.boolean().optional(),
    volumeHints: zod_1.z.string().optional(),
    portsHints: zod_1.z.string().optional(),
});
// ============ Docker Compose Validation Schemas ============
exports.DockerComposeValidateSchema = zod_1.z.object({
    content: zod_1.z.string().min(1),
});
exports.DockerComposeSanitizeSchema = zod_1.z.object({
    content: zod_1.z.string().min(1),
});
// ============ Docker Host Schemas ============
exports.DockerHostCheckSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.DockerHostInstallSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// ============ PM2 Migration Schemas ============
exports.DockerPM2ListSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.DockerPM2GenerateComposeSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
});
exports.DockerPM2MigrateSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    projectName: zod_1.z.string().optional(),
    autoStopPM2: zod_1.z.boolean().default(true),
});
exports.DockerPM2ValidateSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    migrationId: zod_1.z.string(),
});
exports.DockerPM2RollbackSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    migrationId: zod_1.z.string(),
});
// ============ Docker Proxy Schemas ============
exports.DockerProxyConfigureSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string().optional(),
    domain: zod_1.z.string().min(1),
    targetPort: zod_1.z.number().int().min(1).max(65535),
    proxyType: zod_1.z.enum(['nginx', 'caddy']).optional(),
    sslEnabled: zod_1.z.boolean().default(true),
    sslEmail: zod_1.z.string().email().optional(),
    customConfig: zod_1.z.string().optional(),
});
exports.DockerProxyIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    domain: zod_1.z.string(),
});
exports.DockerProxyRenewSslSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    domain: zod_1.z.string(),
});
//# sourceMappingURL=backup-docker-schemas.js.map