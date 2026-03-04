"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetSettingSchema = exports.GetSettingSchema = exports.ExportCommandLogsSchema = exports.DeleteAllCommandLogsSchema = exports.GetCommandLogsSizeSchema = exports.GetCommandLogsSchema = exports.UpdaterPreferencesSchema = exports.UpdaterSkipVersionSchema = exports.OpenTerminalWindowSchema = exports.TerminalResizeSchema = exports.TerminalInputSchema = exports.CreateTerminalSchema = exports.GetMetricsSchema = exports.ConfigureDomainSchema = exports.ProvisionServerSchema = exports.InstallRecommendedSchema = exports.RemovePackageSchema = exports.UpdatePackageSchema = exports.ListPackagesSchema = exports.DNSLookupSchema = exports.GetNetworkInterfacesSchema = exports.SSHTestConnectionSchema = exports.SSHCommandSchema = exports.DeploymentIdSchema = exports.CreateDeploymentSchema = exports.DatabaseImportListTablesSchema = exports.DatabaseImportStartSchema = exports.DatabaseImportPreviewSchema = exports.DatabaseImportOptionsSchema = exports.DatabaseImportMappingSchema = exports.DatabaseLogsSchema = exports.DatabaseCredentialsSchema = exports.DatabaseDeleteSchema = exports.DatabaseToggleAccessSchema = exports.DatabaseRotateSchema = exports.DatabaseVerifySchema = exports.DatabaseRetrySchema = exports.DatabaseIdSchema = exports.CreateDatabaseSchema = exports.DatabasePreflightSchema = exports.DatabaseAccessSchema = exports.DatabaseTypeSchema = exports.LicenseCountSchema = exports.LicenseActivateSchema = exports.InstallNginxCertbotSchema = exports.ReorderServersSchema = exports.ServerIdSchema = exports.UpdateServerSchema = exports.CreateServerSchema = exports.ServerAuthSchema = void 0;
exports.GitAccountMappingsSchema = exports.GitFixRepositoryRemotesSchema = exports.GitDetectMismatchedReposSchema = exports.GitTestSSHKeySchema = exports.GitBindAppSchema = exports.GitGetReposSchema = exports.GitSetDefaultAccountSchema = exports.GitAccountStatusSchema = exports.GitAccountIdSchema = exports.ListGitAccountsSchema = exports.UpdateGitAccountSchema = exports.CreateGitAccountSchema = exports.GitRenameServerKeySchema = exports.GitDeleteServerKeySchema = exports.GitTestKeyConnectionSchema = exports.GitListServerKeysSchema = exports.GitFetchBranchesSchema = exports.GitAuthStatusSchema = exports.GitAuthenticateSchema = exports.GitListSSHKeysSchema = exports.GitDetectFrameworkSchema = exports.GitListRepositoriesSchema = exports.GitProviderSchema = exports.GitConfigureSSHSchema = exports.GitReadPrivateKeySchema = exports.GitReadPublicKeySchema = exports.GitGenerateKeySchema = exports.GitCheckConnectionSchema = exports.RevealFileSchema = exports.CreateFolderSchema = exports.SelectFolderSchema = exports.SelectFileSchema = exports.DownloadFileSchema = exports.UploadFolderSchema = exports.UploadFileSchema = exports.DeleteSSHKeySchema = exports.ReadSSHKeySchema = exports.ListSSHKeysProgressiveSchema = exports.ListSSHKeysSchema = exports.GenerateSSHKeySchema = exports.CronWrapCommandSchema = exports.CronGetLogInfoSchema = exports.CronClearLogsSchema = exports.CronGetLogsSchema = exports.CronAddJobSchema = exports.CronDeleteJobSchema = exports.CronToggleJobSchema = exports.CronUpdateJobSchema = exports.CronSaveMetadataSchema = exports.CronListSchema = void 0;
exports.CleanupExpiredEnvironmentsSchema = exports.ReconcileEnvironmentsSchema = exports.DeployBranchSchema = exports.UpdateEnvironmentSettingsSchema = exports.PromoteEnvironmentSchema = exports.DeleteEnvironmentSchema = exports.ListEnvironmentsSchema = exports.CreateEnvironmentSchema = exports.NonProductionEnvironmentTypeSchema = exports.EnvironmentTypeSchema = exports.TunnelStatusSchema = exports.TunnelCloseSchema = exports.TunnelOpenSchema = exports.ListTemplatesSchema = exports.TemplateDeploySchema = exports.OpenExternalURLSchema = exports.LocalLinkGitSchema = exports.LocalReuploadSchema = exports.LocalDeploySchema = exports.LocalDetectFrameworkSchema = exports.LocalFolderInfoSchema = exports.CheckPortAvailabilitySchema = exports.SetMaxLogLinesSchema = exports.GetDeploymentByIdSchema = exports.GetAppsFromDeploymentsSchema = exports.UpdateDeploymentStatusSchema = exports.GetAppDeploymentsSchema = exports.SimpleReloadSchema = exports.ForceFreshDeploySchema = exports.ManualBuildSchema = exports.DeleteAppSchema = exports.DeployServiceSchema = exports.GitSwitchRepoAccountSchema = exports.GitCloneWithAccountSchema = void 0;
const zod_1 = require("zod");
// Server schemas
exports.ServerAuthSchema = zod_1.z.object({
    type: zod_1.z.enum(['password', 'private_key']),
    value: zod_1.z.string(),
});
exports.CreateServerSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().int().min(1).max(65535).default(22),
    username: zod_1.z.string().min(1),
    auth: exports.ServerAuthSchema,
    keyPath: zod_1.z.string().optional(), // Path to script-generated SSH private key for cleanup on server delete
});
exports.UpdateServerSchema = zod_1.z.object({
    id: zod_1.z.string(),
    updates: zod_1.z.object({
        name: zod_1.z.string().optional(),
        host: zod_1.z.string().optional(),
        port: zod_1.z.number().int().min(1).max(65535).optional(),
        username: zod_1.z.string().min(1).optional(),
        auth: exports.ServerAuthSchema.optional(),
        keyPath: zod_1.z.string().nullable().optional(),
        status: zod_1.z.enum(['pending', 'provisioning', 'ready', 'error']).optional(),
        last_check_in: zod_1.z.number().optional(),
    }),
});
exports.ServerIdSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
exports.ReorderServersSchema = zod_1.z.object({
    serverIds: zod_1.z.array(zod_1.z.string()).min(1),
});
exports.InstallNginxCertbotSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.LicenseActivateSchema = zod_1.z.object({
    licenseKey: zod_1.z.string().min(8),
    email: zod_1.z.string().min(3).optional(),
});
exports.LicenseCountSchema = zod_1.z.object({
    currentCount: zod_1.z.number().int().nonnegative().optional(),
});
// Database schemas
exports.DatabaseTypeSchema = zod_1.z.enum(['postgres', 'mysql', 'supabase']);
exports.DatabaseAccessSchema = zod_1.z.enum(['internal', 'public']);
exports.DatabasePreflightSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    type: exports.DatabaseTypeSchema,
    name: zod_1.z.string().min(3).max(40).regex(/^[a-z0-9-]+$/i).optional(),
    engineVersion: zod_1.z.string().optional(),
    access: exports.DatabaseAccessSchema.optional(),
    requestedPort: zod_1.z.number().int().min(1).max(65535).optional(),
    advanced: zod_1.z.object({
        maxConnections: zod_1.z.number().int().min(10).max(2000).optional(),
        charset: zod_1.z.string().optional(),
        timezone: zod_1.z.string().optional(),
    }).optional(),
});
exports.CreateDatabaseSchema = exports.DatabasePreflightSchema.omit({ name: true }).extend({
    name: zod_1.z.string().min(3).max(40).regex(/^[a-z0-9-]+$/),
});
exports.DatabaseIdSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    databaseId: zod_1.z.string(),
});
exports.DatabaseRetrySchema = exports.DatabaseIdSchema.extend({
    retryAll: zod_1.z.boolean().optional(),
    commandIndex: zod_1.z.number().int().nonnegative().optional(),
});
exports.DatabaseVerifySchema = exports.DatabaseIdSchema;
exports.DatabaseRotateSchema = exports.DatabaseIdSchema;
exports.DatabaseToggleAccessSchema = exports.DatabaseIdSchema.extend({
    enabled: zod_1.z.boolean(),
    cidrAllowList: zod_1.z.array(zod_1.z.string()).optional(),
    reason: zod_1.z.string().optional(),
});
exports.DatabaseDeleteSchema = exports.DatabaseIdSchema.extend({
    force: zod_1.z.boolean().optional(),
});
exports.DatabaseCredentialsSchema = exports.DatabaseIdSchema;
exports.DatabaseLogsSchema = exports.DatabaseIdSchema.extend({
    limit: zod_1.z.number().int().positive().default(100).optional(),
});
exports.DatabaseImportMappingSchema = zod_1.z.object({
    sourceIndex: zod_1.z.number().int().nonnegative(),
    sourceName: zod_1.z.string(),
    targetColumn: zod_1.z.string(),
    dataType: zod_1.z.string().optional(),
    nullable: zod_1.z.boolean().optional(),
});
exports.DatabaseImportOptionsSchema = zod_1.z.object({
    tableName: zod_1.z.string().min(1),
    mode: zod_1.z.enum(['create', 'append', 'replace']),
    delimiter: zod_1.z.string().min(1).default(','),
    hasHeader: zod_1.z.boolean().default(true),
    quoteChar: zod_1.z.string().length(1).optional(),
    escapeChar: zod_1.z.string().length(1).optional(),
    nullAs: zod_1.z.string().optional(),
    schema: zod_1.z.string().optional(),
});
exports.DatabaseImportPreviewSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    databaseId: zod_1.z.string(),
    filePath: zod_1.z.string(),
    delimiter: zod_1.z.string().optional(),
    hasHeader: zod_1.z.boolean().optional(),
    sampleSize: zod_1.z.number().int().positive().max(200).optional(),
});
exports.DatabaseImportStartSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    databaseId: zod_1.z.string(),
    filePath: zod_1.z.string(),
    format: zod_1.z.enum(['csv']),
    mapping: zod_1.z.array(exports.DatabaseImportMappingSchema).min(1),
    options: exports.DatabaseImportOptionsSchema,
});
exports.DatabaseImportListTablesSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    databaseId: zod_1.z.string(),
});
// Deployment schemas
exports.CreateDeploymentSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    type: zod_1.z.enum(['git', 'local']),
    repoUrl: zod_1.z.string().optional(),
    branch: zod_1.z.string().optional(),
    localPath: zod_1.z.string().optional(),
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
});
exports.DeploymentIdSchema = zod_1.z.object({
    id: zod_1.z.string(),
});
// SSH schemas
exports.SSHCommandSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    command: zod_1.z.string(),
});
exports.SSHTestConnectionSchema = zod_1.z.object({
    host: zod_1.z.string(),
    port: zod_1.z.number().int().min(1).max(65535),
    username: zod_1.z.string(),
    auth: exports.ServerAuthSchema,
});
exports.GetNetworkInterfacesSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.DNSLookupSchema = zod_1.z.object({
    domain: zod_1.z.string().min(1),
    bypassCache: zod_1.z.boolean().optional(), // Use public DNS servers to bypass local cache
});
// Package management schemas
exports.ListPackagesSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.UpdatePackageSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    packageName: zod_1.z.string(),
});
exports.RemovePackageSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    packageName: zod_1.z.string(),
});
exports.InstallRecommendedSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// Provisioning schemas
exports.ProvisionServerSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// Domain schemas
exports.ConfigureDomainSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    domain: zod_1.z.string(),
    appName: zod_1.z.string(),
    port: zod_1.z.number().int().min(1).max(65535),
    ssl: zod_1.z.boolean().default(true),
});
// Metrics schemas
exports.GetMetricsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// Terminal schemas
exports.CreateTerminalSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    cols: zod_1.z.number().int().positive().default(80),
    rows: zod_1.z.number().int().positive().default(24),
});
exports.TerminalInputSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    data: zod_1.z.string(),
});
exports.TerminalResizeSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    cols: zod_1.z.number().int().positive(),
    rows: zod_1.z.number().int().positive(),
});
exports.OpenTerminalWindowSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    serverName: zod_1.z.string().optional(),
    initialCommand: zod_1.z.string().optional(),
});
exports.UpdaterSkipVersionSchema = zod_1.z.object({
    version: zod_1.z.string().min(1),
});
exports.UpdaterPreferencesSchema = zod_1.z.object({
    skippedVersion: zod_1.z.string().nullable(),
});
// Command logs schemas
exports.GetCommandLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    limit: zod_1.z.number().int().positive().default(100).optional(),
});
exports.GetCommandLogsSizeSchema = zod_1.z.object({
    serverId: zod_1.z.string().optional(),
});
exports.DeleteAllCommandLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.ExportCommandLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    content: zod_1.z.string(),
    suggestedFileName: zod_1.z.string().optional(),
});
// Settings schemas
exports.GetSettingSchema = zod_1.z.object({
    key: zod_1.z.string(),
});
exports.SetSettingSchema = zod_1.z.object({
    key: zod_1.z.string(),
    value: zod_1.z.string(),
});
// Cron schemas
exports.CronListSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.CronSaveMetadataSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    jobSignature: zod_1.z.string(),
    cronId: zod_1.z.string().optional(),
    name: zod_1.z.string().optional(),
    description: zod_1.z.string().optional(),
    type: zod_1.z.string().optional(),
    createdBy: zod_1.z.string().optional(),
});
exports.CronUpdateJobSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    lineNumber: zod_1.z.number().int().nonnegative(),
    originalLine: zod_1.z.string(),
    schedule: zod_1.z.string(),
    command: zod_1.z.string(),
    isActive: zod_1.z.boolean(),
    owner: zod_1.z.enum(['user', 'root']),
    name: zod_1.z.string().optional(),
    description: zod_1.z.string().optional(),
    type: zod_1.z.string().optional(),
    createdBy: zod_1.z.string().optional(),
});
exports.CronToggleJobSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    lineNumber: zod_1.z.number().int().nonnegative(),
    originalLine: zod_1.z.string(),
    active: zod_1.z.boolean(),
    owner: zod_1.z.enum(['user', 'root']),
});
exports.CronDeleteJobSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    lineNumber: zod_1.z.number().int().nonnegative(),
    originalLine: zod_1.z.string(),
    owner: zod_1.z.enum(['user', 'root']),
});
exports.CronAddJobSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    schedule: zod_1.z.string(),
    command: zod_1.z.string(),
    isActive: zod_1.z.boolean().default(true),
    owner: zod_1.z.enum(['user', 'root']).default('user'),
    name: zod_1.z.string().optional(),
    description: zod_1.z.string().optional(),
    type: zod_1.z.string().optional(),
    createdBy: zod_1.z.string().optional(),
    /** Seconds interval for sub-minute scheduling (5, 10, 15, 20, 30) */
    secondsInterval: zod_1.z.number().optional(),
    /** Enable logging for this job */
    enableLogging: zod_1.z.boolean().optional(),
});
// Cron log schemas
exports.CronGetLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    cronId: zod_1.z.string(),
    tailLines: zod_1.z.number().int().positive().optional().default(500),
});
exports.CronClearLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    cronId: zod_1.z.string(),
});
exports.CronGetLogInfoSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    cronId: zod_1.z.string(),
});
exports.CronWrapCommandSchema = zod_1.z.object({
    command: zod_1.z.string(),
    cronId: zod_1.z.string(),
    maxSizeBytes: zod_1.z.number().int().positive().optional(),
    maxLines: zod_1.z.number().int().positive().optional(),
    backupCount: zod_1.z.number().int().positive().optional(),
});
// Key generation schemas
exports.GenerateSSHKeySchema = zod_1.z.object({
    filename: zod_1.z.string(),
    passphrase: zod_1.z.string().optional(),
    comment: zod_1.z.string().optional(),
});
exports.ListSSHKeysSchema = zod_1.z.object({});
exports.ListSSHKeysProgressiveSchema = zod_1.z.object({
    additionalPaths: zod_1.z.array(zod_1.z.string()).optional(),
});
exports.ReadSSHKeySchema = zod_1.z.object({
    path: zod_1.z.string().min(1),
});
exports.DeleteSSHKeySchema = zod_1.z.object({
    keyPath: zod_1.z.string().min(1),
});
// File upload schemas
exports.UploadFileSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    localPath: zod_1.z.string(),
    remotePath: zod_1.z.string(),
});
exports.UploadFolderSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    localPath: zod_1.z.string(),
    remotePath: zod_1.z.string(),
    excludeDirs: zod_1.z.array(zod_1.z.string()).optional(),
    includeHidden: zod_1.z.boolean().optional(),
});
exports.DownloadFileSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    remotePath: zod_1.z.string(),
    localPath: zod_1.z.string(),
});
exports.SelectFileSchema = zod_1.z.object({
    title: zod_1.z.string().optional(),
});
exports.SelectFolderSchema = zod_1.z.object({
    title: zod_1.z.string().optional(),
});
exports.CreateFolderSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    remotePath: zod_1.z.string(),
    folderName: zod_1.z.string(),
});
exports.RevealFileSchema = zod_1.z.object({
    path: zod_1.z.string().min(1),
});
// Git setup schemas
exports.GitCheckConnectionSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GitGenerateKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    keyName: zod_1.z.string().optional(),
});
exports.GitReadPublicKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    keyPath: zod_1.z.string(),
});
exports.GitReadPrivateKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    keyPath: zod_1.z.string(),
});
exports.GitConfigureSSHSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    keyPath: zod_1.z.string(),
});
exports.GitProviderSchema = zod_1.z.enum(['github', 'gitlab']);
exports.GitListRepositoriesSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GitDetectFrameworkSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    repoUrl: zod_1.z.string(),
    branch: zod_1.z.string().optional(),
});
exports.GitListSSHKeysSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GitAuthenticateSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    token: zod_1.z.string(),
    sshKeyPath: zod_1.z.string().optional(),
});
exports.GitAuthStatusSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GitFetchBranchesSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    workingDirectory: zod_1.z.string().optional(),
});
exports.GitListServerKeysSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GitTestKeyConnectionSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    keyPath: zod_1.z.string(),
});
exports.GitDeleteServerKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    keyPath: zod_1.z.string(),
});
exports.GitRenameServerKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    oldPath: zod_1.z.string(),
    newName: zod_1.z.string().min(1),
});
exports.CreateGitAccountSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    provider: exports.GitProviderSchema.default('github'),
    alias: zod_1.z.string().min(2),
    token: zod_1.z.string().min(10),
    sshKeyPath: zod_1.z.string().optional(),
});
exports.UpdateGitAccountSchema = zod_1.z.object({
    accountId: zod_1.z.string(),
    serverId: zod_1.z.string(),
    alias: zod_1.z.string().min(2).optional(),
    token: zod_1.z.string().min(10).optional(),
    sshKeyPath: zod_1.z.string().optional(),
});
exports.ListGitAccountsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    provider: exports.GitProviderSchema.optional(),
});
exports.GitAccountIdSchema = zod_1.z.object({
    accountId: zod_1.z.string(),
});
exports.GitAccountStatusSchema = exports.GitAccountIdSchema;
exports.GitSetDefaultAccountSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    gitAccountId: zod_1.z.string(),
});
exports.GitGetReposSchema = zod_1.z.object({
    gitAccountId: zod_1.z.string(),
    page: zod_1.z.number().int().positive().optional(),
    perPage: zod_1.z.number().int().positive().max(100).optional(),
});
exports.GitBindAppSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    gitAccountId: zod_1.z.string(),
    repository: zod_1.z.string(),
    branch: zod_1.z.string().default('main'),
});
exports.GitTestSSHKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    accountId: zod_1.z.string(),
});
exports.GitDetectMismatchedReposSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    accountId: zod_1.z.string(),
});
exports.GitFixRepositoryRemotesSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    accountId: zod_1.z.string(),
    repoPaths: zod_1.z.array(zod_1.z.string()),
});
exports.GitAccountMappingsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GitCloneWithAccountSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    gitAccountId: zod_1.z.string(),
    repository: zod_1.z.string(),
    targetPath: zod_1.z.string(),
    branch: zod_1.z.string().default('main'),
});
exports.GitSwitchRepoAccountSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    repoPath: zod_1.z.string(),
    gitAccountId: zod_1.z.string(),
    repository: zod_1.z.string(),
});
// New deployment schemas with template support
exports.DeployServiceSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    runtime: zod_1.z.enum(['node']).default('node'), // Changed from template to runtime, focusing on Node.js for now
    repoUrl: zod_1.z.string(),
    gitAccountId: zod_1.z.string().optional(),
    repository: zod_1.z.string().optional(),
    branch: zod_1.z.string().default('main'),
    appName: zod_1.z.string(),
    port: zod_1.z.number().int().min(1000).max(65535).optional(),
    buildCommand: zod_1.z.string().optional(), // Custom build command, e.g., "npm install && npm run build"
    startCommand: zod_1.z.string().optional(), // Custom start command, e.g., "npm start" or "node server.js"
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    isRedeploy: zod_1.z.boolean().optional(), // If true, skip port check and use pm2 reload instead of delete+start
});
exports.DeleteAppSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    pmId: zod_1.z.number().int().nonnegative().nullable(),
    workingDirectory: zod_1.z.string().optional().nullable(),
});
exports.ManualBuildSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    pmId: zod_1.z.number().int().nonnegative().nullable(),
    workingDirectory: zod_1.z.string(),
    buildCommand: zod_1.z.string().optional(),
    repoUrl: zod_1.z.string().optional(),
    branch: zod_1.z.string().optional(),
});
exports.ForceFreshDeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    workingDirectory: zod_1.z.string(),
    port: zod_1.z.number().int().min(1000).max(65535),
    buildCommand: zod_1.z.string().optional(),
    startCommand: zod_1.z.string(),
    repoUrl: zod_1.z.string().optional(),
    branch: zod_1.z.string().optional(),
});
exports.SimpleReloadSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    workingDirectory: zod_1.z.string(),
    buildCommand: zod_1.z.string().optional(),
    repoUrl: zod_1.z.string().optional(),
    branch: zod_1.z.string().optional(),
});
exports.GetAppDeploymentsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
});
exports.UpdateDeploymentStatusSchema = zod_1.z.object({
    deploymentId: zod_1.z.string(),
    status: zod_1.z.enum(['running', 'succeeded', 'failed', 'stopped']),
    finishedAt: zod_1.z.number().optional(),
});
exports.GetAppsFromDeploymentsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.GetDeploymentByIdSchema = zod_1.z.object({
    deploymentId: zod_1.z.string(),
});
exports.SetMaxLogLinesSchema = zod_1.z.object({
    lines: zod_1.z.number().int().min(100).max(10000),
});
exports.CheckPortAvailabilitySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    port: zod_1.z.number().int().min(1).max(65535),
});
// Local deployment schemas
exports.LocalFolderInfoSchema = zod_1.z.object({
    localPath: zod_1.z.string(),
});
exports.LocalDetectFrameworkSchema = zod_1.z.object({
    localPath: zod_1.z.string(),
});
exports.LocalDeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    localPath: zod_1.z.string(),
    appName: zod_1.z.string(),
    port: zod_1.z.number().int().min(1000).max(65535).optional(),
    buildCommand: zod_1.z.string().optional(),
    startCommand: zod_1.z.string().optional(),
    envVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    runtime: zod_1.z.enum(['node']).default('node'),
});
exports.LocalReuploadSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    localPath: zod_1.z.string(),
});
exports.LocalLinkGitSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    appName: zod_1.z.string(),
    repoUrl: zod_1.z.string(),
    branch: zod_1.z.string(),
    gitAccountId: zod_1.z.string(),
});
// Browser navigation schemas
exports.OpenExternalURLSchema = zod_1.z.object({
    url: zod_1.z.string().url(),
});
// Template deployment schemas
exports.TemplateDeploySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    templateId: zod_1.z.string(),
    appName: zod_1.z.string().min(1),
    siteName: zod_1.z.string().optional(),
    domain: zod_1.z.string().optional(),
});
exports.ListTemplatesSchema = zod_1.z.object({});
// Tunnel schemas
exports.TunnelOpenSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    remoteHost: zod_1.z.string().default('127.0.0.1'),
    remotePort: zod_1.z.number(),
    /** Local port to bind. Use 0 or omit to auto-assign an available port. */
    localPort: zod_1.z.number().default(0),
});
exports.TunnelCloseSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    localPort: zod_1.z.number(),
});
exports.TunnelStatusSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// Environment (staging/preview) schemas
exports.EnvironmentTypeSchema = zod_1.z.enum([
    'production',
    'staging',
    'preview',
    'alpha',
    'beta',
    'qa',
    'demo',
    'development',
    'test',
]);
exports.NonProductionEnvironmentTypeSchema = zod_1.z.enum([
    'staging',
    'preview',
    'alpha',
    'beta',
    'qa',
    'demo',
    'development',
    'test',
]);
exports.CreateEnvironmentSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    productionStackId: zod_1.z.string(),
    environmentType: exports.NonProductionEnvironmentTypeSchema,
    environmentName: zod_1.z.string().min(1).max(50).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
        message: 'Name must be lowercase alphanumeric with hyphens, starting and ending with alphanumeric',
    }),
    subdomainPrefix: zod_1.z.string().min(1).max(50).optional(),
    customDomain: zod_1.z.string().optional(),
    branchName: zod_1.z.string().optional(),
    buildLocation: zod_1.z.enum(['vps', 'github-actions']).optional(),
    copyEnvVars: zod_1.z.boolean().optional().default(true),
    customEnvVars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    hostPort: zod_1.z.number().int().min(1).max(65535).optional(),
});
exports.ListEnvironmentsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    productionStackId: zod_1.z.string(),
});
exports.DeleteEnvironmentSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
});
exports.PromoteEnvironmentSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stagingStackId: zod_1.z.string(),
    deploymentStrategy: zod_1.z.enum(['standard', 'zero_downtime']).optional().default('zero_downtime'),
    keepStaging: zod_1.z.boolean().optional().default(false),
    createBackup: zod_1.z.boolean().optional().default(true),
});
exports.UpdateEnvironmentSettingsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    stackId: zod_1.z.string(),
    autoDeployRules: zod_1.z.array(zod_1.z.object({
        branchPattern: zod_1.z.string(),
        environmentType: exports.NonProductionEnvironmentTypeSchema,
        autoCreate: zod_1.z.boolean(),
    })).optional(),
    previewUrlPattern: zod_1.z.string().optional(),
});
exports.DeployBranchSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    productionStackId: zod_1.z.string(),
    branchName: zod_1.z.string().min(1),
    environmentType: exports.NonProductionEnvironmentTypeSchema.optional().default('preview'),
});
exports.ReconcileEnvironmentsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    productionStackId: zod_1.z.string(),
});
exports.CleanupExpiredEnvironmentsSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
//# sourceMappingURL=core-schemas.js.map