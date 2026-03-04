"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEnvFile = createEnvFile;
exports.ensureEnvFileDirective = ensureEnvFileDirective;
exports.syncEnvVarsForStack = syncEnvVarsForStack;
const db_1 = require("../../db");
const composeUtils_1 = require("./composeUtils");
async function createEnvFile(uploadFile, serverId, workingDir, envVars) {
    const envContent = Object.entries(envVars)
        .map(([key, value]) => {
        const strValue = String(value);
        // Escape $ as $$ for Docker Compose variable expansion
        // Docker Compose interprets $ as variable references in .env files
        // Using $$$$ in JavaScript replace() produces $$ in output (since $$ = literal $)
        const dollarEscaped = strValue.replace(/\$/g, '$$$$');
        const needsQuotes = dollarEscaped.includes(' ') || dollarEscaped.includes('\n') || dollarEscaped.includes('"');
        const escapedValue = dollarEscaped.replace(/"/g, '\\"');
        return needsQuotes ? `${key}="${escapedValue}"` : `${key}=${dollarEscaped}`;
    })
        .join('\n');
    await uploadFile(serverId, `${workingDir}/.env`, envContent);
}
/**
 * Ensure docker-compose.yml has env_file directive to load .env file
 * This is needed for containers to pick up environment variables from .env
 */
async function ensureEnvFileDirective(params) {
    const { sshService, uploadFile, emitLog, serverId, workingDir, stackId } = params;
    const composePath = `${workingDir}/docker-compose.yml`;
    const readResult = await sshService.executeCommand(serverId, `cat "${composePath}" 2>/dev/null || cat "${workingDir}/docker-compose.yaml" 2>/dev/null || echo ""`);
    if (readResult.exitCode !== 0 || !readResult.stdout.trim()) {
        return;
    }
    let composeContent = readResult.stdout;
    if (composeContent.includes('env_file:')) {
        return;
    }
    emitLog('Injecting env_file directive into docker-compose.yml...', 'info', stackId);
    let injected = false;
    if (composeContent.includes('restart:')) {
        composeContent = composeContent.replace(/^(\s*restart:\s*.+)$/gm, (_match, p1) => {
            const indent = p1.match(/^(\s*)/)?.[1] || '    ';
            return `${p1}\n${indent}env_file:\n${indent}  - .env`;
        });
        injected = true;
    }
    if (!injected && composeContent.includes('image:')) {
        composeContent = composeContent.replace(/^(\s*image:\s*.+)$/gm, (_match, p1) => {
            const indent = p1.match(/^(\s*)/)?.[1] || '    ';
            return `${p1}\n${indent}env_file:\n${indent}  - .env`;
        });
        injected = true;
    }
    if (!injected && composeContent.includes('build:')) {
        composeContent = composeContent.replace(/^(\s*build:\s*.+)$/gm, (_match, p1) => {
            const indent = p1.match(/^(\s*)/)?.[1] || '    ';
            return `${p1}\n${indent}env_file:\n${indent}  - .env`;
        });
    }
    composeContent = (0, composeUtils_1.escapeDollarInEnvVars)(composeContent);
    await uploadFile(serverId, composePath, composeContent);
    db_1.queries.updateDockerStack(stackId, { compose_content: composeContent });
}
async function syncEnvVarsForStack(params) {
    const { serverId, workingDir, stackId, templateId, envVars, uploadFile, emitLog, sshService, applySupabaseFullSmtpEnvVars, } = params;
    if (templateId === 'builtin-supabase-full' && applySupabaseFullSmtpEnvVars) {
        applySupabaseFullSmtpEnvVars(envVars, stackId);
    }
    await createEnvFile(uploadFile, serverId, workingDir, envVars);
    await ensureEnvFileDirective({
        sshService,
        uploadFile,
        emitLog,
        serverId,
        workingDir,
        stackId,
    });
}
//# sourceMappingURL=env.js.map