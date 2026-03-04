"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureNextjsStandaloneMode = ensureNextjsStandaloneMode;
/**
 * Ensure Next.js builds output the standalone bundle required by our Dockerfile.
 * This lives in a helper to make the main service easier to read and test.
 */
async function ensureNextjsStandaloneMode(options) {
    const { sshService, uploadFile, emitLog, serverId, repoPath, stackId } = options;
    try {
        emitLog('🔍 Checking Next.js configuration...', 'info', stackId);
        const configCheck = await sshService.executeCommand(serverId, `cd "${repoPath}" && (test -f next.config.ts && echo "next.config.ts") || (test -f next.config.js && echo "next.config.js") || (test -f next.config.mjs && echo "next.config.mjs") || echo "none"`);
        const configFile = configCheck.stdout.trim();
        if (configFile === 'none') {
            emitLog('📝 Creating next.config.js with standalone output mode...', 'info', stackId);
            const newConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
};

module.exports = nextConfig;
`;
            await uploadFile(serverId, `${repoPath}/next.config.js`, newConfig);
            emitLog('✅ Created next.config.js with standalone mode enabled', 'success', stackId);
            return;
        }
        const readResult = await sshService.executeCommand(serverId, `cat "${repoPath}/${configFile}"`);
        if (readResult.exitCode !== 0) {
            emitLog(`⚠️ Could not read ${configFile}, skipping standalone check`, 'warning', stackId);
            return;
        }
        const configContent = readResult.stdout;
        const hasStandalone = /output\s*:\s*['"]standalone['"]/i.test(configContent);
        if (hasStandalone) {
            emitLog('✅ Next.js standalone mode already enabled', 'success', stackId);
            return;
        }
        emitLog('⚙️ Adding standalone output mode to Next.js config...', 'info', stackId);
        let modifiedConfig = configContent;
        if (/export\s+default\s+\{/.test(configContent)) {
            modifiedConfig = configContent.replace(/(export\s+default\s+\{)/, `$1\n  output: 'standalone',`);
        }
        else if (/module\.exports\s*=\s*\{/.test(configContent)) {
            modifiedConfig = configContent.replace(/(module\.exports\s*=\s*\{)/, `$1\n  output: 'standalone',`);
        }
        else if (/const\s+\w+Config\s*=\s*\{/.test(configContent)) {
            modifiedConfig = configContent.replace(/(const\s+\w+Config\s*=\s*\{)/, `$1\n  output: 'standalone',`);
        }
        else {
            emitLog('⚠️ Complex config format detected, creating backup...', 'warning', stackId);
            await sshService.executeCommand(serverId, `cp "${repoPath}/${configFile}" "${repoPath}/${configFile}.backup-$(date +%s)"`);
            const isTypeScript = configFile.endsWith('.ts');
            if (isTypeScript) {
                modifiedConfig = `import type { NextConfig } from 'next';

// Original config (modified by ServerCompass to add standalone mode)
${configContent}

// Ensure standalone mode is enabled for Docker deployments
const config: NextConfig = {
  ...nextConfig,
  output: 'standalone',
};

export default config;
`;
            }
            else {
                modifiedConfig = `// Original config (modified by ServerCompass to add standalone mode)
${configContent}

// Ensure standalone mode is enabled for Docker deployments
module.exports = {
  ...module.exports,
  output: 'standalone',
};
`;
            }
        }
        await uploadFile(serverId, `${repoPath}/${configFile}`, modifiedConfig);
        emitLog(`✅ Added standalone mode to ${configFile}`, 'success', stackId);
        emitLog('💡 This prevents Docker build failures related to missing .next/standalone directory', 'info', stackId);
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        emitLog(`⚠️ Could not automatically configure Next.js standalone mode: ${errorMsg}`, 'warning', stackId);
        emitLog('💡 If build fails, manually add output: "standalone" to your next.config file', 'info', stackId);
    }
}
//# sourceMappingURL=nextjsConfig.js.map