"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLocalSSHHandlers = registerLocalSSHHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const zod_1 = require("zod");
const LocalSSHKeyscanSchema = zod_1.z.object({
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().int().positive(),
});
const LocalSSHTestSchema = zod_1.z.object({
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().int().positive(),
    keyPath: zod_1.z.string().min(1).optional(),
});
const LocalSSHConfigureSchema = zod_1.z.object({
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().int().positive(),
    keyPath: zod_1.z.string().min(1),
    alias: zod_1.z.string().min(1),
});
function registerLocalSSHHandlers() {
    // Run ssh-keyscan locally and append to ~/.ssh/known_hosts
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_SSH_KEYSCAN, async (_event, input) => {
        try {
            const { host, port } = LocalSSHKeyscanSchema.parse(input);
            const keyscanOutput = await new Promise((resolve, reject) => {
                (0, child_process_1.execFile)('ssh-keyscan', ['-p', String(port), '-H', host], { timeout: 15000 }, (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(`ssh-keyscan failed: ${stderr || error.message}`));
                    }
                    else if (!stdout.trim()) {
                        reject(new Error('ssh-keyscan returned no keys. Is the SSH port open?'));
                    }
                    else {
                        resolve(stdout.trim());
                    }
                });
            });
            // Append to ~/.ssh/known_hosts
            const sshDir = path_1.default.join(os_1.default.homedir(), '.ssh');
            const knownHostsPath = path_1.default.join(sshDir, 'known_hosts');
            // Ensure ~/.ssh directory exists
            if (!fs_1.default.existsSync(sshDir)) {
                fs_1.default.mkdirSync(sshDir, { mode: 0o700 });
            }
            // Append with a newline separator
            const existingContent = fs_1.default.existsSync(knownHostsPath) ? fs_1.default.readFileSync(knownHostsPath, 'utf-8') : '';
            const separator = existingContent.endsWith('\n') || existingContent === '' ? '' : '\n';
            fs_1.default.appendFileSync(knownHostsPath, `${separator}${keyscanOutput}\n`, { mode: 0o644 });
            return { success: true, data: { added: true } };
        }
        catch (error) {
            console.error('[LocalSSH] keyscan error:', error);
            return { success: false, error: String(error) };
        }
    });
    // Test SSH connection to a Gitea/Forgejo instance from user's local machine
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_SSH_TEST, async (_event, input) => {
        try {
            const { host, port, keyPath } = LocalSSHTestSchema.parse(input);
            const result = await new Promise((resolve) => {
                const args = ['-T', '-p', String(port), '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10'];
                if (keyPath) {
                    args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
                }
                args.push(`git@${host}`);
                (0, child_process_1.execFile)('ssh', args, { timeout: 15000 }, (error, stdout, stderr) => {
                    const output = (stdout + '\n' + stderr).trim();
                    // Gitea/Forgejo SSH returns exit code 1 with a welcome message on success
                    // e.g., "Hi there, <user>! You've successfully authenticated..."
                    if (output.toLowerCase().includes('successfully authenticated') || output.toLowerCase().includes('hi there')) {
                        resolve({ connected: true, message: output });
                    }
                    else if (error) {
                        resolve({ connected: false, message: output || error.message });
                    }
                    else {
                        resolve({ connected: true, message: output });
                    }
                });
            });
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[LocalSSH] test error:', error);
            return { success: false, error: String(error) };
        }
    });
    // Write SSH config entries so git commands use the correct port, key, and user.
    // We write TWO Host entries:
    //   1. "Host <host>" with a "Match" on user=git so only git@ connections use Gitea port/key
    //      (won't break regular SSH to the same server on port 22)
    //   2. "Host <alias>" as a convenience alias
    // However, OpenSSH "Host" matching is simple: if the user types "git@5.223.67.58",
    // SSH matches "Host 5.223.67.58". We can't conditionally match on user without Match blocks
    // (which require OpenSSH 6.5+). Instead, we use a dedicated Host alias approach BUT
    // also write a "Host <host>" block specifically for git user.
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOCAL_SSH_CONFIGURE, async (_event, input) => {
        try {
            const { host, port, keyPath, alias } = LocalSSHConfigureSchema.parse(input);
            const sshDir = path_1.default.join(os_1.default.homedir(), '.ssh');
            const configPath = path_1.default.join(sshDir, 'config');
            if (!fs_1.default.existsSync(sshDir)) {
                fs_1.default.mkdirSync(sshDir, { mode: 0o700 });
            }
            let config = fs_1.default.existsSync(configPath) ? fs_1.default.readFileSync(configPath, 'utf-8') : '';
            // Helper: upsert a Host block in the SSH config
            const upsertHostBlock = (hostValue, block) => {
                const escaped = hostValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const existsRegex = new RegExp(`^Host\\s+${escaped}\\s*$`, 'm');
                if (existsRegex.test(config)) {
                    // Replace existing block
                    const blockRegex = new RegExp(`(^Host\\s+${escaped}\\s*\\n)((?:[ \\t]+[^\\n]*\\n?)*)`, 'm');
                    config = config.replace(blockRegex, block);
                }
                else {
                    // Append
                    const sep = config.length > 0 && !config.endsWith('\n') ? '\n\n' : config.length > 0 ? '\n' : '';
                    config += sep + block;
                }
            };
            const blockContent = (hostValue, hostname) => {
                const lines = [`Host ${hostValue}\n`];
                if (hostname)
                    lines.push(`  HostName ${hostname}\n`);
                lines.push(`  Port ${port}\n`);
                lines.push(`  User git\n`);
                lines.push(`  IdentityFile ${keyPath}\n`);
                lines.push(`  IdentitiesOnly yes\n`);
                return lines.join('');
            };
            // 1. Write "Host <alias>" (e.g., "Host gitea-5.223.67.58") with HostName
            upsertHostBlock(alias, blockContent(alias, host));
            // 2. Write "Host <host>" (e.g., "Host 5.223.67.58") so git@<host>:user/repo works directly
            //    This matches when the user copies the URL from Gitea's web UI
            upsertHostBlock(host, blockContent(host));
            fs_1.default.writeFileSync(configPath, config, { mode: 0o600 });
            return { success: true, data: { configured: true, alias } };
        }
        catch (error) {
            console.error('[LocalSSH] configure error:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=local-ssh.js.map