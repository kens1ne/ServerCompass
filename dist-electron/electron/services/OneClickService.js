"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.oneClickService = void 0;
const db_1 = require("../db");
const SSHService_1 = require("./SSHService");
const crypto_1 = require("crypto");
const electron_1 = require("electron");
// ─── Constants ───────────────────────────────────────────────────────────────
const REDACTION_WINDOW_MS = 500;
const STALL_TIER1_MS = 15_000;
const STALL_TIER2_MS = 30_000;
const PROMPT_LIKE_CHARS = /[?:>\]]$/;
// ─── Shell quoting ───────────────────────────────────────────────────────────
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
// ─── ANSI strip ──────────────────────────────────────────────────────────────
function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}
// ─── Templates ───────────────────────────────────────────────────────────────
const ONE_CLICK_TEMPLATES = [
    {
        id: 'openclaw',
        name: 'OpenClaw',
        description: 'Personal AI assistant with sandboxed tool execution',
        icon: 'Brain',
        enabled: true,
        minMemoryMB: 2048,
        installUrl: 'https://openclaw.ai/install.sh',
        installCommand: 'curl -fsSL https://openclaw.ai/install.sh | bash',
        scriptPreviewUrl: 'https://openclaw.ai/install.sh',
        serviceManager: 'systemd-user',
        discovery: {
            detectCommand: 'command -v openclaw >/dev/null 2>&1 && [ -f ~/.config/systemd/user/openclaw-gateway.service ]',
            versionCommand: "openclaw --version | head -n 1 | awk '{print $2}'",
        },
        lifecycle: {
            start: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && systemctl --user start openclaw-gateway.service',
            stop: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && systemctl --user stop openclaw-gateway.service',
            restart: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && systemctl --user restart openclaw-gateway.service',
            status: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && systemctl --user status openclaw-gateway.service --no-pager',
            logs: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && journalctl --user -u openclaw-gateway.service --no-pager -n 200',
            uninstall: [
                'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"',
                'systemctl --user stop openclaw-gateway.service 2>/dev/null || true',
                'systemctl --user disable openclaw-gateway.service 2>/dev/null || true',
                'openclaw uninstall --yes 2>/dev/null || true',
                'npm uninstall -g openclaw 2>/dev/null || true',
                'rm -f $(npm bin -g 2>/dev/null)/openclaw 2>/dev/null || true',
                'rm -rf ~/.openclaw ~/.clawdbot ~/.moltbot ~/.molthub /root/.openclaw',
                'echo "Verify removal:" && ! command -v openclaw 2>/dev/null && echo "openclaw removed successfully" || echo "Warning: openclaw binary still found"',
            ].join(' && '),
            uninstallSteps: [
                { label: 'Stopping service', command: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && systemctl --user stop openclaw-gateway.service 2>/dev/null || true' },
                { label: 'Disabling service', command: 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" && systemctl --user disable openclaw-gateway.service 2>/dev/null || true' },
                { label: 'Running openclaw uninstall', command: 'openclaw uninstall --yes 2>/dev/null || true' },
                { label: 'Removing npm package', command: 'npm uninstall -g openclaw 2>/dev/null || true' },
                { label: 'Cleaning up binaries', command: 'rm -f $(npm bin -g 2>/dev/null)/openclaw 2>/dev/null || true' },
                { label: 'Removing config files', command: 'rm -rf ~/.openclaw ~/.clawdbot ~/.moltbot ~/.molthub /root/.openclaw' },
                { label: 'Verifying removal', command: '! command -v openclaw 2>/dev/null && echo "openclaw removed successfully" || echo "Warning: openclaw binary still found"' },
            ],
            update: 'openclaw update',
        },
        systemdMainUnit: 'openclaw-gateway.service',
        interactivePrompts: [
            {
                id: 'generate-token',
                match: 'Generate and configure a gateway token now\\?',
                message: 'Generate and configure a gateway token now?',
                choices: [
                    { label: 'Yes', input: 'y\n', isDefault: true },
                    { label: 'No', input: 'n\n' },
                ],
                autoAnswer: 'y\n',
            },
            {
                id: 'chmod-config',
                match: '[Tt]ighten permissions on.*\\?',
                message: 'Tighten permissions on config directory to 700?',
                choices: [
                    { label: 'Yes', input: 'y\n', isDefault: true },
                    { label: 'No', input: 'n\n' },
                ],
                autoAnswer: 'y\n',
            },
            {
                id: 'session-dir',
                match: '[Cc]reate [Ss]ession store dir',
                message: 'Create session store directory?',
                choices: [
                    { label: 'Yes', input: 'y\n', isDefault: true },
                    { label: 'No', input: 'n\n' },
                ],
                autoAnswer: 'y\n',
            },
            {
                id: 'oauth-dir',
                match: '[Cc]reate OAuth dir',
                message: 'Create OAuth directory?',
                choices: [
                    { label: 'Yes', input: 'y\n', isDefault: true },
                    { label: 'No', input: 'n\n' },
                ],
                autoAnswer: 'y\n',
            },
            {
                id: 'shell-completion',
                match: '[Ee]nable.*shell completion',
                message: 'Enable shell completion for openclaw?',
                choices: [
                    { label: 'Yes', input: 'y\n', isDefault: true },
                    { label: 'No', input: 'n\n' },
                ],
                autoAnswer: 'y\n',
            },
            {
                id: 'runtime-selection',
                match: '[Rr]untime|[Ss]elect.*runtime|[Gg]ateway service runtime',
                message: 'Select runtime',
                choices: null,
                autoAnswer: '\n',
            },
            {
                id: 'install-service',
                match: 'Install gateway service now\\?',
                message: 'Install gateway service now?',
                choices: [
                    { label: 'Yes', input: 'y\n', isDefault: true },
                    { label: 'No', input: 'n\n' },
                ],
                autoAnswer: 'y\n',
            },
        ],
        installPhases: [
            { label: 'Downloading installer', match: 'install|download|fetch|curl' },
            { label: 'Installing Node.js', match: '[Nn]ode|[Nn]ode\\.js|nvm|npm.*install' },
            { label: 'Installing OpenClaw', match: '[Ii]nstalling.*[Oo]pen[Cc]law|npm.*-g.*openclaw|openclaw' },
            { label: 'Configuring', match: '[Cc]onfigur|[Ss]etting up|[Pp]ermission|[Tt]oken|[Cc]reate.*dir' },
            { label: 'Setting up service', match: '[Ss]ystemd|[Ss]ervice|gateway|[Dd]aemon' },
            { label: 'Starting OpenClaw', match: '[Ss]tart|[Rr]unning|[Ll]aunch|[Aa]ctive' },
        ],
        prerequisites: [
            { name: 'curl', checkCommand: 'command -v curl' },
            { name: 'systemctl', checkCommand: 'command -v systemctl' },
            {
                name: 'systemd user linger (non-root only)',
                checkCommand: '[ "$(id -u)" = "0" ] || loginctl show-user $(whoami) --property=Linger 2>/dev/null | grep -q "Linger=yes"',
                installHint: 'Non-root users need linger enabled. Run: sudo loginctl enable-linger $(whoami)',
            },
        ],
        postInstallSteps: [
            'If prompts were skipped, run: openclaw doctor --fix',
            'For remote access: ssh -N -L 18789:127.0.0.1:18789 <user>@<server>',
            'Then open http://localhost:18789/',
        ],
        websiteUrl: 'https://openclaw.ai',
        actions: [
            // ── Overview ──
            { id: 'status', label: 'Status', icon: 'Activity', group: 'Overview', type: 'display', command: 'openclaw status --deep', description: 'Channel health, sessions, and model usage' },
            { id: 'health', label: 'Gateway Health', icon: 'HeartPulse', group: 'Overview', type: 'display', command: 'openclaw health --json', description: 'Fetch health from the running gateway', requiresRunning: true },
            { id: 'doctor', label: 'Run Doctor', icon: 'Stethoscope', group: 'Overview', type: 'display', command: 'openclaw doctor --deep', description: 'Health checks for config, gateway, and channels' },
            { id: 'doctor-fix', label: 'Doctor (Auto-fix)', icon: 'Wrench', group: 'Overview', type: 'execute', command: 'openclaw doctor --fix --yes', confirm: 'This will attempt to auto-fix detected issues. Proceed?' },
            { id: 'security-audit', label: 'Security Audit', icon: 'Shield', group: 'Overview', type: 'display', command: 'openclaw security audit --deep', description: 'Audit config and local state for security issues' },
            // ── Models ──
            { id: 'models-list', label: 'List Models', icon: 'List', group: 'Models', type: 'display', command: 'openclaw models list --all', description: 'All available models across providers' },
            { id: 'models-status', label: 'Auth Status', icon: 'Key', group: 'Models', type: 'display', command: 'openclaw models status --probe', description: 'Provider auth overview and OAuth expiry' },
            { id: 'models-set', label: 'Set Default Model', icon: 'Settings', group: 'Models', type: 'form', command: 'openclaw models set {{MODEL}}', inputs: [{ name: 'MODEL', label: 'Model', type: 'text', placeholder: 'e.g., claude-sonnet-4-5-20250929, gpt-4o' }] },
            { id: 'models-aliases', label: 'List Aliases', icon: 'Tag', group: 'Models', type: 'display', command: 'openclaw models aliases list' },
            { id: 'models-fallbacks', label: 'List Fallbacks', icon: 'LifeBuoy', group: 'Models', type: 'display', command: 'openclaw models fallbacks list' },
            // ── Channels ──
            { id: 'channels-list', label: 'List Channels', icon: 'MessageSquare', group: 'Channels', type: 'display', command: 'openclaw channels list', description: 'Configured channel accounts and auth profiles' },
            { id: 'channels-status', label: 'Channel Health', icon: 'HeartPulse', group: 'Channels', type: 'display', command: 'openclaw channels status --probe', description: 'Gateway reachability and channel health', requiresRunning: true },
            { id: 'channels-logs', label: 'Channel Logs', icon: 'ScrollText', group: 'Channels', type: 'display', command: 'openclaw channels logs --channel all --lines 50', description: 'Recent channel activity from gateway log' },
            // ── Agents ──
            { id: 'agents-list', label: 'List Agents', icon: 'Bot', group: 'Agents', type: 'display', command: 'openclaw agents list --json', description: 'Isolated agent workspaces, bindings, and models' },
            // ── Devices & Nodes ──
            { id: 'devices-list', label: 'List Devices', icon: 'Smartphone', group: 'Devices & Nodes', type: 'display', command: 'openclaw devices' },
            { id: 'nodes-list', label: 'List Nodes', icon: 'Server', group: 'Devices & Nodes', type: 'display', command: 'openclaw nodes list', description: 'Connected compute nodes' },
            { id: 'nodes-status', label: 'Node Status', icon: 'Activity', group: 'Devices & Nodes', type: 'display', command: 'openclaw nodes status', description: 'Node health overview' },
            // ── Sessions & Memory ──
            { id: 'sessions-list', label: 'List Sessions', icon: 'MessagesSquare', group: 'Sessions & Memory', type: 'display', command: 'openclaw sessions --json', description: 'Stored conversation sessions' },
            { id: 'memory-status', label: 'Memory Status', icon: 'Brain', group: 'Sessions & Memory', type: 'display', command: 'openclaw memory status', description: 'Vector index stats' },
            { id: 'memory-search', label: 'Search Memory', icon: 'Search', group: 'Sessions & Memory', type: 'form', command: 'openclaw memory search {{QUERY}}', inputs: [{ name: 'QUERY', label: 'Search query', type: 'text', placeholder: 'Semantic search over memory files' }] },
            // ── Plugins & Skills ──
            { id: 'plugins-list', label: 'List Plugins', icon: 'Puzzle', group: 'Plugins & Skills', type: 'display', command: 'openclaw plugins list' },
            { id: 'plugins-doctor', label: 'Plugin Doctor', icon: 'Stethoscope', group: 'Plugins & Skills', type: 'display', command: 'openclaw plugins doctor', description: 'Report plugin load errors' },
            { id: 'skills-list', label: 'List Skills', icon: 'Sparkles', group: 'Plugins & Skills', type: 'display', command: 'openclaw skills list --json' },
            { id: 'skills-check', label: 'Skills Check', icon: 'CheckCircle', group: 'Plugins & Skills', type: 'display', command: 'openclaw skills check', description: 'Ready vs missing skill requirements' },
            // ── Automation ──
            { id: 'cron-list', label: 'List Cron Jobs', icon: 'Clock', group: 'Automation', type: 'display', command: 'openclaw cron list', description: 'Scheduled jobs' },
            { id: 'hooks-list', label: 'List Hooks', icon: 'Webhook', group: 'Automation', type: 'display', command: 'openclaw hooks list' },
            // ── Gateway ──
            { id: 'gateway-status', label: 'Gateway Status', icon: 'Radio', group: 'Gateway', type: 'display', command: 'openclaw gateway status --deep --json', description: 'RPC and service status probe' },
            { id: 'gateway-logs', label: 'Gateway Logs', icon: 'ScrollText', group: 'Gateway', type: 'display', command: 'openclaw logs --limit 100 --no-color', requiresRunning: true },
            { id: 'config-show', label: 'Show Config', icon: 'FileText', group: 'Gateway', type: 'display', command: 'openclaw config get' },
            { id: 'config-set', label: 'Set Config', icon: 'Edit', group: 'Gateway', type: 'form', command: 'openclaw config set {{PATH}} {{VALUE}}', inputs: [{ name: 'PATH', label: 'Config path', type: 'text', placeholder: 'e.g., gateway.port' }, { name: 'VALUE', label: 'Value', type: 'text', placeholder: 'e.g., 18789' }] },
            // ── Sandbox ──
            { id: 'sandbox-list', label: 'List Sandboxes', icon: 'Box', group: 'Sandbox', type: 'display', command: 'openclaw sandbox list', description: 'Isolated execution environments' },
            // ── Maintenance ──
            { id: 'update', label: 'Update OpenClaw', icon: 'Download', group: 'Maintenance', type: 'execute', command: 'openclaw update', confirm: 'Update OpenClaw to the latest version?' },
            { id: 'reset', label: 'Reset Config', icon: 'RotateCcw', group: 'Maintenance', type: 'execute', command: 'openclaw reset --scope config', confirm: 'This will reset local config (keeps credentials and sessions). Are you sure?' },
            { id: 'security-fix', label: 'Fix Security', icon: 'ShieldCheck', group: 'Maintenance', type: 'execute', command: 'openclaw security audit --fix', confirm: 'This will tighten security defaults. Proceed?' },
        ],
    },
    {
        id: 'ollama',
        name: 'Ollama',
        description: 'Run large language models locally. Supports Llama, Mistral, Gemma, and more.',
        icon: 'Sparkles',
        enabled: false,
        minMemoryMB: 8192,
        installUrl: 'https://ollama.com/install.sh',
        installCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
        scriptPreviewUrl: 'https://ollama.com/install.sh',
        serviceManager: 'systemd',
        discovery: {
            detectCommand: 'command -v ollama >/dev/null 2>&1',
            versionCommand: "ollama --version 2>/dev/null | awk '{print $NF}'",
        },
        lifecycle: {
            start: 'sudo systemctl start ollama',
            stop: 'sudo systemctl stop ollama',
            restart: 'sudo systemctl restart ollama',
            status: 'sudo systemctl status ollama --no-pager',
            logs: 'sudo journalctl -u ollama --no-pager -n 200',
            uninstall: [
                'sudo systemctl stop ollama 2>/dev/null',
                'sudo systemctl disable ollama 2>/dev/null',
                'sudo rm -f /etc/systemd/system/ollama.service',
                'sudo systemctl daemon-reload',
                'sudo rm -f /usr/local/bin/ollama',
                'sudo rm -rf /usr/share/ollama',
                'sudo userdel ollama 2>/dev/null',
                'sudo groupdel ollama 2>/dev/null',
            ].join(' && '),
        },
        interactivePrompts: [],
        installPhases: [],
        prerequisites: [
            { name: 'curl', checkCommand: 'command -v curl' },
            { name: 'systemctl', checkCommand: 'command -v systemctl' },
            { name: 'sudo', checkCommand: 'command -v sudo' },
        ],
        postInstallSteps: [
            'Pull a model: ollama pull llama3.2',
            'Run a model: ollama run llama3.2',
            'API available at http://localhost:11434',
            'For remote access: ssh -N -L 11434:127.0.0.1:11434 <user>@<server>',
        ],
        websiteUrl: 'https://ollama.com',
        actions: [],
    },
    {
        id: 'tailscale',
        name: 'Tailscale',
        description: 'Zero-config VPN mesh network. Securely connect your devices and servers.',
        icon: 'Network',
        enabled: false,
        minMemoryMB: 512,
        installUrl: 'https://tailscale.com/install.sh',
        installCommand: 'curl -fsSL https://tailscale.com/install.sh | sh',
        scriptPreviewUrl: 'https://tailscale.com/install.sh',
        serviceManager: 'systemd',
        discovery: {
            detectCommand: 'command -v tailscale >/dev/null 2>&1',
            versionCommand: 'tailscale version 2>/dev/null | head -n 1',
        },
        lifecycle: {
            start: 'sudo systemctl start tailscaled',
            stop: 'sudo systemctl stop tailscaled',
            restart: 'sudo systemctl restart tailscaled',
            status: 'sudo systemctl status tailscaled --no-pager && tailscale status',
            logs: 'sudo journalctl -u tailscaled --no-pager -n 200',
            uninstall: [
                'sudo tailscale down 2>/dev/null',
                'sudo systemctl stop tailscaled 2>/dev/null',
                'sudo systemctl disable tailscaled 2>/dev/null',
                'sudo apt-get remove -y tailscale 2>/dev/null || sudo dnf remove -y tailscale 2>/dev/null || sudo yum remove -y tailscale 2>/dev/null',
            ].join(' && '),
        },
        interactivePrompts: [],
        installPhases: [],
        prerequisites: [
            { name: 'curl', checkCommand: 'command -v curl' },
            { name: 'systemctl', checkCommand: 'command -v systemctl' },
            { name: 'sudo', checkCommand: 'command -v sudo' },
        ],
        postInstallSteps: [
            'Authenticate: sudo tailscale up',
            'Check status: tailscale status',
            'To use as exit node: sudo tailscale up --advertise-exit-node',
        ],
        websiteUrl: 'https://tailscale.com',
        actions: [],
    },
];
const activeInstalls = new Map();
// ─── Service ─────────────────────────────────────────────────────────────────
class OneClickService {
    // ─── Templates ──────────────────────────────────────
    getTemplates() {
        return ONE_CLICK_TEMPLATES;
    }
    getTemplate(id) {
        return ONE_CLICK_TEMPLATES.find((t) => t.id === id) ?? null;
    }
    // ─── Prerequisites ─────────────────────────────────
    async checkPrerequisites(serverId, templateId) {
        const template = this.getTemplate(templateId);
        if (!template)
            throw new Error(`Template not found: ${templateId}`);
        const results = [];
        for (const prereq of template.prerequisites) {
            try {
                const result = await SSHService_1.sshService.executeCommand(serverId, prereq.checkCommand);
                results.push({
                    name: prereq.name,
                    passed: result.exitCode === 0,
                    installHint: prereq.installHint,
                });
            }
            catch {
                results.push({
                    name: prereq.name,
                    passed: false,
                    installHint: prereq.installHint,
                });
            }
        }
        return {
            passed: results.every((r) => r.passed),
            results,
        };
    }
    // ─── Installation ──────────────────────────────────
    async install(serverId, templateId, window) {
        const template = this.getTemplate(templateId);
        if (!template)
            throw new Error(`Template not found: ${templateId}`);
        if (!template.enabled)
            throw new Error(`Template ${templateId} is not enabled`);
        // Check for existing active install on this server
        const existing = this.getInstallations(serverId).find((i) => i.templateId === templateId && i.status === 'installing');
        if (existing)
            throw new Error('Installation already in progress');
        const installationId = (0, crypto_1.randomUUID)();
        const now = Date.now();
        // Create DB row
        const stmt = db_1.db.prepare(`
      INSERT INTO one_click_installations (
        id, server_id, template_id, name, install_command_redacted, install_url,
        service_manager, lifecycle_commands, discovery_config, systemd_main_unit,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?)
    `);
        stmt.run(installationId, serverId, template.id, template.name, template.installCommand, // No secrets in curl command
        template.installUrl, template.serviceManager, JSON.stringify(template.lifecycle), JSON.stringify(template.discovery), template.systemdMainUnit ?? null, now, now);
        // Run install in background (don't await — stream to renderer)
        this.runInstall(serverId, installationId, template, window).catch((error) => {
            console.error(`[OneClick] Install failed for ${installationId}:`, error);
            this.updateInstallationStatus(installationId, 'error', String(error));
        });
        return { installationId };
    }
    async runInstall(serverId, installationId, template, window) {
        const client = await SSHService_1.sshService.connect(serverId);
        return new Promise((resolve, reject) => {
            // Allocate PTY for interactive install
            client.exec(template.installCommand, { pty: true }, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                let outputBuffer = '';
                let stallTimer = null;
                let currentPhaseIndex = -1;
                const totalPhases = template.installPhases.length;
                const checkPhase = (data) => {
                    if (totalPhases === 0)
                        return;
                    const stripped = stripAnsi(data);
                    for (let i = currentPhaseIndex + 1; i < totalPhases; i++) {
                        const phase = template.installPhases[i];
                        if (new RegExp(phase.match, 'i').test(stripped)) {
                            currentPhaseIndex = i;
                            window.webContents.send('oneClick:progress', {
                                installationId,
                                step: i + 1,
                                total: totalPhases,
                                message: phase.label,
                            });
                            break;
                        }
                    }
                };
                const activeInstall = {
                    writeToStdin: (data) => {
                        stream.write(data);
                    },
                    lastInputTimestamp: 0,
                };
                activeInstalls.set(installationId, activeInstall);
                const resetStallTimer = () => {
                    if (stallTimer)
                        clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        this.checkForUnmatchedPrompt(installationId, outputBuffer, window, STALL_TIER1_MS);
                    }, STALL_TIER1_MS);
                };
                const checkPrompt = (data) => {
                    const stripped = stripAnsi(data);
                    outputBuffer += stripped;
                    // Check against known prompts
                    for (const prompt of template.interactivePrompts) {
                        const regex = new RegExp(prompt.match);
                        if (regex.test(stripped)) {
                            if (prompt.autoAnswer) {
                                // Auto-answer: write to stdin directly, no UI prompt
                                console.log(`[OneClick] Auto-answering prompt "${prompt.id}" with "${prompt.autoAnswer.replace(/\n/g, '\\n')}"`);
                                stream.write(prompt.autoAnswer);
                                activeInstall.lastInputTimestamp = Date.now();
                            }
                            else {
                                // Send to frontend for user input
                                window.webContents.send('oneClick:prompt', {
                                    installationId,
                                    promptId: prompt.id,
                                    message: prompt.message,
                                    choices: prompt.choices,
                                });
                            }
                            outputBuffer = ''; // Reset buffer after match
                            return;
                        }
                    }
                };
                stream.on('data', (data) => {
                    const chunk = data.toString();
                    resetStallTimer();
                    checkPhase(chunk);
                    // Redaction check
                    const isRedacted = Date.now() - activeInstall.lastInputTimestamp < REDACTION_WINDOW_MS;
                    // Send to renderer (redact if within window)
                    const lines = chunk.split('\n');
                    const outputChunk = isRedacted
                        ? lines.map(() => '[redacted]').join('\n')
                        : chunk;
                    window.webContents.send('oneClick:log', {
                        installationId,
                        data: outputChunk,
                    });
                    // Check for prompts (always use raw, non-redacted data for matching)
                    checkPrompt(chunk);
                });
                stream.on('close', async (code) => {
                    if (stallTimer)
                        clearTimeout(stallTimer);
                    activeInstalls.delete(installationId);
                    if (code === 0) {
                        // Success — run discovery probe
                        try {
                            await this.runDiscovery(serverId, installationId, template);
                            resolve();
                        }
                        catch (discoverErr) {
                            this.updateInstallationStatus(installationId, 'error', 'Install completed but service not detected');
                            reject(discoverErr);
                        }
                    }
                    else {
                        const errorMsg = `Install exited with code ${code}`;
                        this.updateInstallationStatus(installationId, 'error', errorMsg);
                        reject(new Error(errorMsg));
                    }
                });
                stream.on('error', (streamErr) => {
                    if (stallTimer)
                        clearTimeout(stallTimer);
                    activeInstalls.delete(installationId);
                    this.updateInstallationStatus(installationId, 'error', streamErr.message);
                    reject(streamErr);
                });
                resetStallTimer();
            });
        });
    }
    checkForUnmatchedPrompt(installationId, buffer, window, tierMs) {
        const stripped = stripAnsi(buffer);
        const lines = stripped.split('\n').filter((l) => l.trim().length > 0);
        const lastLine = lines[lines.length - 1] ?? '';
        const isTier1 = tierMs === STALL_TIER1_MS;
        if (isTier1) {
            // Tier 1: require prompt-like character at end
            if (!PROMPT_LIKE_CHARS.test(lastLine.trim())) {
                // Not prompt-like, schedule tier 2
                setTimeout(() => {
                    this.checkForUnmatchedPrompt(installationId, buffer, window, STALL_TIER2_MS);
                }, STALL_TIER2_MS - STALL_TIER1_MS);
                return;
            }
        }
        // Auto-answer unmatched prompts by sending Enter
        const activeInstall = activeInstalls.get(installationId);
        if (activeInstall) {
            const lastThreeLines = lines.slice(-3).join('\n');
            console.log(`[OneClick] Auto-answering unmatched prompt with Enter. Last output: ${lastThreeLines.substring(0, 100)}`);
            activeInstall.writeToStdin('\n');
            activeInstall.lastInputTimestamp = Date.now();
        }
    }
    async runDiscovery(serverId, installationId, template) {
        const now = Date.now();
        // Detect if installed
        const detectResult = await SSHService_1.sshService.executeCommand(serverId, template.discovery.detectCommand);
        if (detectResult.exitCode !== 0) {
            throw new Error('Service not detected after install');
        }
        // Get version
        let version = null;
        try {
            const versionResult = await SSHService_1.sshService.executeCommand(serverId, template.discovery.versionCommand);
            if (versionResult.exitCode === 0 && versionResult.stdout.trim()) {
                version = versionResult.stdout.trim();
            }
        }
        catch {
            // Version detection is non-critical
        }
        // Defensive unit-path detection for OpenClaw
        let serviceManager = template.serviceManager;
        if (template.systemdMainUnit) {
            try {
                const probe = await SSHService_1.sshService.executeCommand(serverId, `[ -f ~/.config/systemd/user/${template.systemdMainUnit} ] && echo user-unit || ` +
                    `([ -f /etc/systemd/system/${template.systemdMainUnit} ] && echo system-unit || echo not-found)`);
                const probeResult = probe.stdout.trim();
                if (probeResult === 'system-unit') {
                    serviceManager = 'systemd';
                }
                else {
                    serviceManager = 'systemd-user';
                }
            }
            catch {
                // Keep template default
            }
        }
        // Update DB
        const stmt = db_1.db.prepare(`
      UPDATE one_click_installations
      SET status = 'installed', installed_version = ?, service_manager = ?,
          installed_at = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ?
    `);
        stmt.run(version, serviceManager, now, now, now, installationId);
    }
    // ─── Interactive Input ─────────────────────────────
    sendInput(installationId, input) {
        const activeInstall = activeInstalls.get(installationId);
        if (!activeInstall) {
            throw new Error(`No active install found for ${installationId}`);
        }
        activeInstall.lastInputTimestamp = Date.now();
        activeInstall.writeToStdin(input);
    }
    // ─── Lifecycle ─────────────────────────────────────
    async start(serverId, installationId) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        const result = await SSHService_1.sshService.executeCommand(serverId, lifecycle.start);
        if (result.exitCode === 0) {
            this.updateInstallationStatus(installationId, 'running');
        }
        return result;
    }
    async stop(serverId, installationId) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        const result = await SSHService_1.sshService.executeCommand(serverId, lifecycle.stop);
        if (result.exitCode === 0) {
            this.updateInstallationStatus(installationId, 'stopped');
        }
        return result;
    }
    async restart(serverId, installationId) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        const result = await SSHService_1.sshService.executeCommand(serverId, lifecycle.restart);
        if (result.exitCode === 0) {
            this.updateInstallationStatus(installationId, 'running');
        }
        return result;
    }
    async getStatus(serverId, installationId) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        const result = await SSHService_1.sshService.executeCommand(serverId, lifecycle.status);
        const running = result.exitCode === 0;
        // Update DB status
        const newStatus = running ? 'running' : 'stopped';
        const now = Date.now();
        db_1.db.prepare('UPDATE one_click_installations SET status = ?, last_checked_at = ?, updated_at = ? WHERE id = ?')
            .run(newStatus, now, now, installationId);
        return {
            running,
            statusOutput: result.stdout || result.stderr,
        };
    }
    async getLogs(serverId, installationId, lines) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        let logsCommand = lifecycle.logs;
        // Override line count if specified
        if (lines && logsCommand) {
            logsCommand = logsCommand.replace(/-n \d+/, `-n ${lines}`);
        }
        const result = await SSHService_1.sshService.executeCommand(serverId, logsCommand);
        return result.stdout || result.stderr;
    }
    async update(serverId, installationId) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        if (!lifecycle.update)
            throw new Error('Template does not support update');
        const result = await SSHService_1.sshService.executeCommand(serverId, lifecycle.update);
        // Re-run version detection after update
        if (result.exitCode === 0) {
            const template = this.getTemplate(installation.templateId);
            if (template) {
                try {
                    const versionResult = await SSHService_1.sshService.executeCommand(serverId, template.discovery.versionCommand);
                    if (versionResult.exitCode === 0 && versionResult.stdout.trim()) {
                        const now = Date.now();
                        db_1.db.prepare('UPDATE one_click_installations SET installed_version = ?, updated_at = ? WHERE id = ?')
                            .run(versionResult.stdout.trim(), now, installationId);
                    }
                }
                catch {
                    // Non-critical
                }
            }
        }
        return result;
    }
    async uninstall(serverId, installationId) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const lifecycle = JSON.parse(installation.lifecycleCommands || '{}');
        // Use structured steps if the template defines them (for progress tracking)
        const template = this.getTemplate(installation.templateId);
        const steps = template?.lifecycle.uninstallSteps;
        if (steps && steps.length > 0) {
            const windows = electron_1.BrowserWindow.getAllWindows();
            const window = windows[0];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                // Emit progress
                if (window) {
                    window.webContents.send('oneClick:progress', {
                        installationId,
                        step: i + 1,
                        total: steps.length,
                        message: step.label,
                    });
                }
                try {
                    await SSHService_1.sshService.executeCommand(serverId, step.command);
                }
                catch (err) {
                    console.warn(`[OneClick] Uninstall step "${step.label}" failed:`, err);
                    // Continue — don't abort uninstall on individual step failure
                }
            }
        }
        else {
            // Fallback: run the single uninstall command
            await SSHService_1.sshService.executeCommand(serverId, lifecycle.uninstall);
        }
        const now = Date.now();
        db_1.db.prepare('UPDATE one_click_installations SET status = ?, updated_at = ? WHERE id = ?')
            .run('uninstalled', now, installationId);
    }
    // ─── Actions ───────────────────────────────────────
    getActions(templateId) {
        const template = this.getTemplate(templateId);
        if (!template)
            return [];
        return template.actions;
    }
    async executeAction(serverId, installationId, actionId, inputs) {
        const installation = this.getInstallation(installationId);
        if (!installation)
            throw new Error('Installation not found');
        const template = this.getTemplate(installation.templateId);
        if (!template)
            throw new Error('Template not found');
        const action = template.actions.find((a) => a.id === actionId);
        if (!action)
            throw new Error(`Action not found: ${actionId}`);
        // Check if service needs to be running
        if (action.requiresRunning) {
            const status = await this.getStatus(serverId, installationId);
            if (!status.running) {
                throw new Error('Service must be running to execute this action');
            }
        }
        // Interpolate inputs
        let command = action.command;
        if (inputs) {
            for (const [key, value] of Object.entries(inputs)) {
                command = command.replace(`{{${key}}}`, shellQuote(value));
            }
        }
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
        };
    }
    async getActionOptions(serverId, templateId, actionId, inputName) {
        const template = this.getTemplate(templateId);
        if (!template)
            throw new Error('Template not found');
        const action = template.actions.find((a) => a.id === actionId);
        if (!action || !action.inputs)
            throw new Error('Action or inputs not found');
        const input = action.inputs.find((i) => i.name === inputName);
        if (!input || !input.optionsCommand)
            throw new Error('Input or optionsCommand not found');
        const result = await SSHService_1.sshService.executeCommand(serverId, input.optionsCommand);
        if (result.exitCode !== 0)
            return [];
        return result.stdout.split('\n').filter((line) => line.trim().length > 0);
    }
    // ─── Queries ───────────────────────────────────────
    getInstallations(serverId) {
        const rows = db_1.db.prepare('SELECT * FROM one_click_installations WHERE server_id = ? AND status != ? ORDER BY created_at DESC').all(serverId, 'uninstalled');
        return rows.map(this.mapRow);
    }
    getInstallation(installationId) {
        const row = db_1.db.prepare('SELECT * FROM one_click_installations WHERE id = ?').get(installationId);
        if (!row)
            return null;
        return this.mapRow(row);
    }
    // ─── Helpers ───────────────────────────────────────
    updateInstallationStatus(installationId, status, error) {
        const now = Date.now();
        if (error) {
            db_1.db.prepare('UPDATE one_click_installations SET status = ?, install_error = ?, updated_at = ? WHERE id = ?')
                .run(status, error, now, installationId);
        }
        else {
            db_1.db.prepare('UPDATE one_click_installations SET status = ?, updated_at = ? WHERE id = ?')
                .run(status, now, installationId);
        }
    }
    mapRow(row) {
        return {
            id: row.id,
            serverId: row.server_id,
            templateId: row.template_id,
            name: row.name,
            installCommandRedacted: row.install_command_redacted,
            installUrl: row.install_url,
            serviceManager: row.service_manager,
            lifecycleCommands: row.lifecycle_commands,
            discoveryConfig: row.discovery_config,
            systemdMainUnit: row.systemd_main_unit,
            status: row.status,
            installedVersion: row.installed_version,
            installPath: row.install_path,
            installError: row.install_error,
            installedAt: row.installed_at,
            lastCheckedAt: row.last_checked_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
exports.oneClickService = new OneClickService();
//# sourceMappingURL=OneClickService.js.map