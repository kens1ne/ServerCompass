"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRemoveKeySchema = exports.UserListKeysSchema = exports.UserAddKeySchema = exports.UserDeleteSchema = exports.UserCreateSchema = exports.UserListSchema = exports.SecurityAuditSchema = exports.AutoUpdatesConfigSchema = exports.SSHTestUsernameSchema = exports.SSHPortChangeSchema = exports.SSHConfigSchema = exports.UFWSetDefaultSchema = exports.UFWDeleteRuleSchema = exports.UFWRuleSchema = exports.Fail2BanWhitelistSchema = exports.Fail2BanUnbanSchema = exports.Fail2BanConfigSchema = exports.UpdateTraefikEmailSchema = exports.GetTraefikLogsSchema = exports.GetCertificateInfoSchema = exports.ServerIdOnlySchema = exports.DeleteDomainSchema = exports.UpdateDomainSchema = exports.BasicAuthUserSchema = exports.SecurityHeadersSchema = exports.ConfigureTraefikDomainSchema = exports.SetupTraefikSchema = void 0;
const zod_1 = require("zod");
// Traefik schemas
exports.SetupTraefikSchema = zod_1.z.object({
    serverId: zod_1.z.string().uuid(),
    email: zod_1.z.string().email(),
});
// Custom UUID validator that accepts both standard UUIDs and prefixed UUIDs (stack-, deploy-)
const uuidOrPrefixedUuid = () => zod_1.z.string().refine((val) => {
    const standardUuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    const prefixedUuidRegex = /^(stack|deploy)-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    return standardUuidRegex.test(val) || prefixedUuidRegex.test(val);
}, { message: 'Invalid UUID or prefixed UUID format' });
exports.ConfigureTraefikDomainSchema = zod_1.z.object({
    serverId: zod_1.z.string().uuid(),
    deploymentId: uuidOrPrefixedUuid().optional(),
    stackId: uuidOrPrefixedUuid().optional(),
    domain: zod_1.z.string().min(3).max(255),
    port: zod_1.z.number().int().min(1).max(65535),
    hostPort: zod_1.z.number().int().min(1).max(65535).optional(),
    ssl: zod_1.z.boolean().default(true),
    httpsRedirect: zod_1.z.boolean().default(true),
    wwwRedirect: zod_1.z.boolean().default(true),
    customHeaders: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
});
// Security headers configuration
exports.SecurityHeadersSchema = zod_1.z.object({
    hstsEnabled: zod_1.z.boolean().optional(),
    hstsMaxAge: zod_1.z.number().int().min(0).optional(),
    hstsIncludeSubdomains: zod_1.z.boolean().optional(),
    hstsPreload: zod_1.z.boolean().optional(),
    xFrameOptions: zod_1.z.enum(['DENY', 'SAMEORIGIN', '']).optional(),
    xContentTypeOptions: zod_1.z.boolean().optional(),
    xXssProtection: zod_1.z.boolean().optional(),
    referrerPolicy: zod_1.z.enum(['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url', '']).optional(),
    contentSecurityPolicy: zod_1.z.string().optional(),
});
// Basic auth user
exports.BasicAuthUserSchema = zod_1.z.object({
    username: zod_1.z.string().min(1),
    password: zod_1.z.string().min(1),
});
exports.UpdateDomainSchema = zod_1.z.object({
    domainId: zod_1.z.string().uuid(),
    port: zod_1.z.number().int().min(1).max(65535).optional(),
    ssl: zod_1.z.boolean().optional(),
    httpsRedirect: zod_1.z.boolean().optional(),
    wwwRedirect: zod_1.z.boolean().optional(),
    customHeaders: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional(),
    // When true, auto-update PORT env var and port mapping in docker-compose.yml, then redeploy
    // Used when the user confirms they want to change the app's listening port
    forceRedeploy: zod_1.z.boolean().optional(),
    // Security headers
    securityHeaders: exports.SecurityHeadersSchema.optional(),
    // Rate limiting
    rateLimitEnabled: zod_1.z.boolean().optional(),
    rateLimitAverage: zod_1.z.number().int().min(1).optional(),
    rateLimitBurst: zod_1.z.number().int().min(1).optional(),
    // Basic authentication
    basicAuthEnabled: zod_1.z.boolean().optional(),
    basicAuthUsers: zod_1.z.array(exports.BasicAuthUserSchema).optional(),
    // IP whitelist
    ipWhitelistEnabled: zod_1.z.boolean().optional(),
    ipWhitelist: zod_1.z.array(zod_1.z.string()).optional(),
});
exports.DeleteDomainSchema = zod_1.z.object({
    domainId: zod_1.z.string().uuid(),
});
exports.ServerIdOnlySchema = zod_1.z.object({
    serverId: zod_1.z.string().uuid(),
});
exports.GetCertificateInfoSchema = zod_1.z.object({
    serverId: zod_1.z.string().uuid(),
    domain: zod_1.z.string(),
});
exports.GetTraefikLogsSchema = zod_1.z.object({
    serverId: zod_1.z.string().uuid(),
    lines: zod_1.z.number().int().positive().default(100).optional(),
});
exports.UpdateTraefikEmailSchema = zod_1.z.object({
    serverId: zod_1.z.string().uuid(),
    email: zod_1.z.string().email(),
});
// ============ Security Schemas ============
// fail2ban schemas
exports.Fail2BanConfigSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    enabled: zod_1.z.boolean(),
    banTime: zod_1.z.number().min(60).max(604800), // 1 minute to 1 week
    findTime: zod_1.z.number().min(60).max(86400), // 1 minute to 1 day
    maxRetry: zod_1.z.number().min(1).max(20),
    whitelistIPs: zod_1.z.array(zod_1.z.string()),
});
exports.Fail2BanUnbanSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    ip: zod_1.z.string(),
    jail: zod_1.z.string().default('sshd'),
});
exports.Fail2BanWhitelistSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    ips: zod_1.z.array(zod_1.z.string()),
});
// UFW Firewall schemas
exports.UFWRuleSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    action: zod_1.z.enum(['allow', 'deny', 'reject', 'limit']),
    port: zod_1.z.string().regex(/^\d+(-\d+)?$/),
    protocol: zod_1.z.enum(['tcp', 'udp', 'any']).default('tcp'),
    from: zod_1.z.string().optional(),
    comment: zod_1.z.string().optional(),
});
exports.UFWDeleteRuleSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    ruleNumber: zod_1.z.number().int().positive(),
});
exports.UFWSetDefaultSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    direction: zod_1.z.enum(['incoming', 'outgoing']),
    policy: zod_1.z.enum(['allow', 'deny', 'reject']),
});
// SSH Hardening schemas
exports.SSHConfigSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    permitRootLogin: zod_1.z.boolean(),
    passwordAuthentication: zod_1.z.boolean(),
    permitEmptyPasswords: zod_1.z.boolean(),
    maxAuthTries: zod_1.z.number().min(1).max(10),
    port: zod_1.z.number().min(1).max(65535),
});
exports.SSHPortChangeSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    currentPort: zod_1.z.number().min(1).max(65535),
    newPort: zod_1.z.number().min(1).max(65535),
});
exports.SSHTestUsernameSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    username: zod_1.z.string().min(1),
});
// Auto Updates schemas
exports.AutoUpdatesConfigSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    enabled: zod_1.z.boolean(),
    securityOnly: zod_1.z.boolean(),
    autoReboot: zod_1.z.boolean(),
    rebootTime: zod_1.z.string().regex(/^\d{2}:\d{2}$/), // HH:MM format
});
// Security Audit schema
exports.SecurityAuditSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
// User Management schemas
exports.UserListSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
});
exports.UserCreateSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    username: zod_1.z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*[$]?$/, 'Invalid username format'),
    withSudo: zod_1.z.boolean(),
    passwordMode: zod_1.z.enum(['generate', 'set', 'none']),
    password: zod_1.z.string().min(8).optional(),
});
exports.UserDeleteSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    username: zod_1.z.string().min(1),
    removeHome: zod_1.z.boolean().default(false),
});
exports.UserAddKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    username: zod_1.z.string().min(1),
    publicKey: zod_1.z.string().min(1),
});
exports.UserListKeysSchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    username: zod_1.z.string().min(1),
});
exports.UserRemoveKeySchema = zod_1.z.object({
    serverId: zod_1.z.string(),
    username: zod_1.z.string().min(1),
    keyIndex: zod_1.z.number().int().nonnegative(),
});
//# sourceMappingURL=security-schemas.js.map