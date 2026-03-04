"use strict";
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
exports.securityService = exports.SecurityService = void 0;
const events_1 = require("events");
const SSHService_1 = require("./SSHService");
const CredentialVault_1 = require("./CredentialVault");
const db_1 = require("../db");
const crypto = __importStar(require("crypto"));
class SecurityService extends events_1.EventEmitter {
    // ============ fail2ban Methods ============
    /**
     * Get fail2ban status on server
     */
    async getFail2BanStatus(serverId) {
        // Check if installed
        const installCheck = await SSHService_1.sshService.executeCommand(serverId, 'which fail2ban-client && echo "installed" || echo "not-installed"');
        const installed = installCheck.stdout.includes('installed') &&
            !installCheck.stdout.includes('not-installed');
        if (!installed) {
            return {
                installed: false,
                running: false,
                jails: [],
                sshJail: {
                    enabled: false,
                    currentlyBanned: 0,
                    totalBanned: 0,
                    bannedIPs: [],
                },
            };
        }
        // Check if running
        const statusCheck = await SSHService_1.sshService.executeCommand(serverId, 'systemctl is-active fail2ban 2>/dev/null || echo "inactive"');
        const running = statusCheck.stdout.trim() === 'active';
        if (!running) {
            return {
                installed: true,
                running: false,
                jails: [],
                sshJail: {
                    enabled: false,
                    currentlyBanned: 0,
                    totalBanned: 0,
                    bannedIPs: [],
                },
            };
        }
        // Get jail list
        const jailsResult = await SSHService_1.sshService.executeCommand(serverId, 'fail2ban-client status 2>/dev/null | grep "Jail list" | sed "s/.*:\\s*//" | tr -d " " || echo ""');
        const jails = jailsResult.stdout.trim().split(',').filter(Boolean);
        // Get SSH jail status
        let sshJail = {
            enabled: false,
            currentlyBanned: 0,
            totalBanned: 0,
            bannedIPs: [],
        };
        if (jails.includes('sshd')) {
            const sshStatus = await SSHService_1.sshService.executeCommand(serverId, 'fail2ban-client status sshd 2>/dev/null || echo ""');
            sshJail = this.parseFail2BanJailStatus(sshStatus.stdout);
        }
        // Try to read configuration
        let config;
        try {
            const configResult = await SSHService_1.sshService.executeCommand(serverId, `cat /etc/fail2ban/jail.local 2>/dev/null || cat /etc/fail2ban/jail.conf 2>/dev/null || echo ""`);
            config = this.parseFail2BanConfig(configResult.stdout);
        }
        catch {
            // Config parsing failed, leave undefined
        }
        return {
            installed: true,
            running: true,
            jails,
            sshJail,
            config,
        };
    }
    /**
     * Install fail2ban on server
     */
    async installFail2Ban(serverId) {
        this.emitProgress(serverId, 'fail2ban-install', 'Detecting OS...', 'running', 10);
        // Detect OS and install
        const osCheck = await SSHService_1.sshService.executeCommand(serverId, 'cat /etc/os-release | grep -E "^ID=" | cut -d= -f2 | tr -d "\\"" || echo "unknown"');
        const os = osCheck.stdout.trim().toLowerCase();
        let installCmd;
        if (['ubuntu', 'debian'].includes(os)) {
            installCmd = 'DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y fail2ban';
        }
        else if (['centos', 'rhel', 'fedora', 'rocky', 'almalinux'].includes(os)) {
            installCmd = 'yum install -y epel-release && yum install -y fail2ban';
        }
        else {
            throw new Error(`Unsupported OS: ${os}. fail2ban installation requires Ubuntu, Debian, CentOS, RHEL, Fedora, Rocky, or AlmaLinux.`);
        }
        this.emitProgress(serverId, 'fail2ban-install', 'Running package manager...', 'running', 30);
        await SSHService_1.sshService.executeCommand(serverId, installCmd);
        this.emitProgress(serverId, 'fail2ban-install', 'Creating default configuration...', 'running', 60);
        // Create default jail.local with SSH protection
        const defaultConfig = `[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
bantime = 3600
`;
        await SSHService_1.sshService.executeCommand(serverId, `cat > /etc/fail2ban/jail.local << 'FAIL2BANEOF'
${defaultConfig}
FAIL2BANEOF`);
        this.emitProgress(serverId, 'fail2ban-install', 'Enabling service...', 'running', 80);
        await SSHService_1.sshService.executeCommand(serverId, 'systemctl enable fail2ban && systemctl start fail2ban');
        this.emitProgress(serverId, 'fail2ban-install', 'fail2ban installed successfully', 'completed', 100);
    }
    /**
     * Configure fail2ban with custom settings
     */
    async configureFail2Ban(serverId, config) {
        const whitelistStr = config.whitelistIPs.join(' ');
        const jailConfig = `[DEFAULT]
bantime = ${config.banTime}
findtime = ${config.findTime}
maxretry = ${config.maxRetry}
ignoreip = 127.0.0.1/8 ::1 ${whitelistStr}

[sshd]
enabled = ${config.enabled}
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = ${config.maxRetry}
bantime = ${config.banTime}
`;
        // Write configuration
        await SSHService_1.sshService.executeCommand(serverId, `cat > /etc/fail2ban/jail.local << 'FAIL2BANEOF'
${jailConfig}
FAIL2BANEOF`);
        // Restart fail2ban to apply changes
        await SSHService_1.sshService.executeCommand(serverId, 'systemctl restart fail2ban');
    }
    /**
     * Unban an IP address
     */
    async unbanIP(serverId, ip, jail = 'sshd') {
        await SSHService_1.sshService.executeCommand(serverId, `fail2ban-client set ${jail} unbanip ${ip}`);
    }
    parseFail2BanJailStatus(output) {
        const currentlyBannedMatch = output.match(/Currently banned:\s*(\d+)/);
        const totalBannedMatch = output.match(/Total banned:\s*(\d+)/);
        const bannedIPMatch = output.match(/Banned IP list:\s*(.+)/);
        return {
            enabled: true,
            currentlyBanned: currentlyBannedMatch ? parseInt(currentlyBannedMatch[1]) : 0,
            totalBanned: totalBannedMatch ? parseInt(totalBannedMatch[1]) : 0,
            bannedIPs: bannedIPMatch
                ? bannedIPMatch[1].trim().split(/\s+/).filter(Boolean)
                : [],
        };
    }
    parseFail2BanConfig(output) {
        if (!output.trim())
            return undefined;
        const sections = new Map();
        let currentSection = 'default';
        const getSection = (name) => {
            const normalizedName = name.toLowerCase();
            if (!sections.has(normalizedName)) {
                sections.set(normalizedName, {});
            }
            return sections.get(normalizedName);
        };
        getSection(currentSection);
        for (const rawLine of output.split('\n')) {
            const trimmedLine = rawLine.trim();
            if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
                continue;
            }
            const sectionMatch = trimmedLine.match(/^\[([^\]]+)\]$/);
            if (sectionMatch) {
                currentSection = sectionMatch[1].trim().toLowerCase();
                getSection(currentSection);
                continue;
            }
            const keyValueMatch = trimmedLine.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
            if (!keyValueMatch) {
                continue;
            }
            const key = keyValueMatch[1].toLowerCase();
            const value = keyValueMatch[2].replace(/\s+[;#].*$/, '').trim();
            if (!value) {
                continue;
            }
            getSection(currentSection)[key] = value;
        }
        const defaultSection = sections.get('default') ?? {};
        const sshdSection = sections.get('sshd') ?? {};
        const getValue = (key) => sshdSection[key] ?? defaultSection[key];
        return {
            banTime: this.parseFail2BanDuration(getValue('bantime')) ?? 3600,
            findTime: this.parseFail2BanDuration(getValue('findtime')) ?? 600,
            maxRetry: this.parseFail2BanNumber(getValue('maxretry')) ?? 5,
            whitelistIPs: this.parseFail2BanWhitelist(getValue('ignoreip')),
        };
    }
    parseFail2BanDuration(value) {
        if (!value)
            return undefined;
        const normalized = value.trim().toLowerCase();
        if (!normalized)
            return undefined;
        if (/^\d+$/.test(normalized)) {
            return parseInt(normalized, 10);
        }
        const unitSeconds = {
            s: 1,
            m: 60,
            h: 3600,
            d: 86400,
            w: 604800,
        };
        let total = 0;
        let hasMatches = false;
        const durationRegex = /(\d+)\s*([smhdw])/g;
        let match;
        while ((match = durationRegex.exec(normalized)) !== null) {
            hasMatches = true;
            total += parseInt(match[1], 10) * unitSeconds[match[2]];
        }
        return hasMatches ? total : undefined;
    }
    parseFail2BanNumber(value) {
        if (!value)
            return undefined;
        const parsed = parseInt(value.trim(), 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    parseFail2BanWhitelist(ignoreIpValue) {
        if (!ignoreIpValue)
            return [];
        const defaultEntries = new Set(['127.0.0.1/8', '::1', '127.0.0.1', 'localhost']);
        const seen = new Set();
        const whitelist = [];
        for (const candidate of ignoreIpValue.split(/[\s,]+/)) {
            const ip = candidate.trim();
            if (!ip)
                continue;
            if (defaultEntries.has(ip.toLowerCase()))
                continue;
            if (seen.has(ip))
                continue;
            seen.add(ip);
            whitelist.push(ip);
        }
        return whitelist;
    }
    // ============ UFW Firewall Methods ============
    /**
     * Get UFW firewall status
     */
    async getUFWStatus(serverId) {
        // Check if installed
        const installCheck = await SSHService_1.sshService.executeCommand(serverId, 'which ufw && echo "installed" || echo "not-installed"');
        if (!installCheck.stdout.includes('installed') ||
            installCheck.stdout.includes('not-installed')) {
            return {
                installed: false,
                enabled: false,
                defaultIncoming: 'deny',
                defaultOutgoing: 'allow',
                rules: [],
            };
        }
        // Get verbose status for defaults and enabled state
        const statusResult = await SSHService_1.sshService.executeCommand(serverId, 'ufw status verbose 2>/dev/null || echo "Status: inactive"');
        // Also get numbered status for better rule parsing
        const numberedResult = await SSHService_1.sshService.executeCommand(serverId, 'ufw status numbered 2>/dev/null || echo ""');
        return this.parseUFWStatus(statusResult.stdout, numberedResult.stdout);
    }
    /**
     * Install UFW firewall
     */
    async installUFW(serverId) {
        this.emitProgress(serverId, 'ufw-install', 'Detecting OS...', 'running', 10);
        const osCheck = await SSHService_1.sshService.executeCommand(serverId, 'cat /etc/os-release | grep -E "^ID=" | cut -d= -f2 | tr -d "\\"" || echo "unknown"');
        const os = osCheck.stdout.trim().toLowerCase();
        let installCmd;
        if (['ubuntu', 'debian'].includes(os)) {
            installCmd = 'DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y ufw';
        }
        else if (['centos', 'rhel', 'fedora', 'rocky', 'almalinux'].includes(os)) {
            installCmd = 'yum install -y epel-release && yum install -y ufw';
        }
        else {
            throw new Error(`Unsupported OS: ${os}. UFW installation requires Ubuntu, Debian, CentOS, RHEL, Fedora, Rocky, or AlmaLinux.`);
        }
        this.emitProgress(serverId, 'ufw-install', 'Running package manager...', 'running', 40);
        await SSHService_1.sshService.executeCommand(serverId, installCmd);
        this.emitProgress(serverId, 'ufw-install', 'UFW installed successfully', 'completed', 100);
    }
    /**
     * Enable UFW firewall
     */
    async enableUFW(serverId) {
        // Ensure SSH is allowed before enabling
        await SSHService_1.sshService.executeCommand(serverId, 'ufw allow 22/tcp');
        await SSHService_1.sshService.executeCommand(serverId, 'ufw --force enable');
    }
    /**
     * Disable UFW firewall
     */
    async disableUFW(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, 'ufw disable');
    }
    /**
     * Add a firewall rule
     */
    async addUFWRule(serverId, rule) {
        let cmd = `ufw ${rule.action} `;
        if (rule.from) {
            cmd += `from ${rule.from} to any `;
        }
        // Handle protocol: 'any' means no protocol suffix (allows both TCP and UDP)
        if (rule.protocol === 'any') {
            cmd += `${rule.port}`;
        }
        else {
            cmd += `${rule.port}/${rule.protocol}`;
        }
        if (rule.comment) {
            cmd += ` comment '${rule.comment.replace(/'/g, "\\'")}'`;
        }
        await SSHService_1.sshService.executeCommand(serverId, cmd);
    }
    /**
     * Delete a firewall rule
     */
    async deleteUFWRule(serverId, ruleNumber) {
        // Use yes command to auto-confirm deletion
        await SSHService_1.sshService.executeCommand(serverId, `yes | ufw delete ${ruleNumber}`);
    }
    /**
     * Set default policy
     */
    async setUFWDefault(serverId, direction, policy) {
        await SSHService_1.sshService.executeCommand(serverId, `ufw default ${policy} ${direction}`);
    }
    parseUFWStatus(verboseOutput, numberedOutput = '') {
        const lines = verboseOutput.split('\n');
        // Parse status (active/inactive)
        // Note: Must check for exact "Status: active" since "inactive" contains "active" as substring
        const statusLine = lines.find((l) => l.startsWith('Status:'));
        const enabled = statusLine?.trim() === 'Status: active';
        // Parse defaults
        const defaultLine = lines.find((l) => l.includes('Default:'));
        let defaultIncoming = 'deny';
        let defaultOutgoing = 'allow';
        if (defaultLine) {
            if (defaultLine.includes('deny (incoming)'))
                defaultIncoming = 'deny';
            else if (defaultLine.includes('allow (incoming)'))
                defaultIncoming = 'allow';
            else if (defaultLine.includes('reject (incoming)'))
                defaultIncoming = 'reject';
            if (defaultLine.includes('deny (outgoing)'))
                defaultOutgoing = 'deny';
            else if (defaultLine.includes('allow (outgoing)'))
                defaultOutgoing = 'allow';
        }
        // Parse rules from numbered output (more reliable format)
        // Format: "[ 1] 22/tcp                     ALLOW IN    Anywhere"
        const rules = [];
        const numberedLines = numberedOutput.split('\n');
        for (const line of numberedLines) {
            const trimmedLine = line.trim();
            if (!trimmedLine)
                continue;
            // Skip IPv6 rules (they have "(v6)" suffix) - we only show IPv4 rules
            if (trimmedLine.includes('(v6)'))
                continue;
            // Match numbered format: "[ 1] 22/tcp                     ALLOW IN    Anywhere"
            const numberedMatch = trimmedLine.match(/^\[\s*(\d+)\]\s+(\d+(?::\d+)?(?:\/\w+)?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT))?\s+(.+?)(?:\s+#\s*(.+))?$/i);
            if (numberedMatch) {
                const [, ruleNum, portProto, action, from, comment] = numberedMatch;
                const [port, protocol = 'any'] = portProto.split('/');
                rules.push({
                    number: parseInt(ruleNum, 10),
                    action: action.toUpperCase(),
                    direction: 'IN',
                    protocol: protocol.toLowerCase(),
                    port,
                    from: from.trim(),
                    to: 'Anywhere',
                    comment: comment?.trim(),
                });
                continue;
            }
            // Fallback: try to match verbose format without rule number
            // "22/tcp                     ALLOW IN    Anywhere"
            const verboseMatch = trimmedLine.match(/^(\d+(?::\d+)?(?:\/\w+)?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(?:IN|OUT))?\s+(.+?)(?:\s+#\s*(.+))?$/i);
            if (verboseMatch) {
                const [, portProto, action, from, comment] = verboseMatch;
                const [port, protocol = 'any'] = portProto.split('/');
                // Only add if not already in rules (avoid duplicates)
                const existingRule = rules.find(r => r.port === port && r.protocol === protocol.toLowerCase());
                if (!existingRule) {
                    rules.push({
                        number: rules.length + 1,
                        action: action.toUpperCase(),
                        direction: 'IN',
                        protocol: protocol.toLowerCase(),
                        port,
                        from: from.trim(),
                        to: 'Anywhere',
                        comment: comment?.trim(),
                    });
                }
            }
        }
        return {
            installed: true,
            enabled,
            defaultIncoming,
            defaultOutgoing,
            rules,
        };
    }
    // ============ SSH Hardening Methods ============
    /**
     * Get SSH configuration status
     */
    async getSSHStatus(serverId) {
        const configResult = await SSHService_1.sshService.executeCommand(serverId, 'cat /etc/ssh/sshd_config 2>/dev/null || echo ""');
        const config = configResult.stdout;
        // Parse SSH settings - note: values might be commented or have different formats
        const permitRootLogin = this.parseSSHBool(config, 'PermitRootLogin', true);
        const passwordAuth = this.parseSSHBool(config, 'PasswordAuthentication', true);
        const permitEmptyPasswords = this.parseSSHBool(config, 'PermitEmptyPasswords', false);
        const maxAuthTries = this.parseSSHNumber(config, 'MaxAuthTries', 6);
        const port = this.parseSSHNumber(config, 'Port', 22);
        // Calculate security score and issues
        const issues = [];
        let score = 100;
        // Root login check disabled for further testing
        // if (permitRootLogin) {
        //   issues.push('Root login is enabled');
        //   score -= 25;
        // }
        if (passwordAuth) {
            issues.push('Password authentication is enabled');
            score -= 20;
        }
        if (permitEmptyPasswords) {
            issues.push('Empty passwords are permitted');
            score -= 30;
        }
        if (maxAuthTries > 4) {
            issues.push(`Max auth attempts is high (${maxAuthTries})`);
            score -= 10;
        }
        if (port === 22) {
            issues.push('Using default SSH port 22');
            score -= 5;
        }
        return {
            permitRootLogin,
            passwordAuthentication: passwordAuth,
            permitEmptyPasswords,
            maxAuthTries,
            port,
            score: Math.max(0, score),
            issues,
        };
    }
    /**
     * Configure SSH settings
     */
    async configureSSH(serverId, config) {
        // Update directives without creating duplicates. This also updates commented
        // defaults and keeps Match blocks intact.
        const updates = [
            { key: 'PermitRootLogin', value: config.permitRootLogin ? 'yes' : 'no' },
            { key: 'PasswordAuthentication', value: config.passwordAuthentication ? 'yes' : 'no' },
            { key: 'PermitEmptyPasswords', value: config.permitEmptyPasswords ? 'yes' : 'no' },
            { key: 'MaxAuthTries', value: config.maxAuthTries.toString() },
            { key: 'Port', value: config.port.toString() },
        ];
        // Backup config first
        await SSHService_1.sshService.executeCommand(serverId, 'cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup');
        for (const update of updates) {
            await SSHService_1.sshService.executeCommand(serverId, this.buildSshConfigUpdateCommand(update.key, update.value));
        }
        // Validate config before restarting
        // Use -f to explicitly specify the config file
        const validateResult = await SSHService_1.sshService.executeCommand(serverId, 'sshd -t -f /etc/ssh/sshd_config 2>&1; echo "EXIT_CODE:$?"');
        // Parse the output to get both the validation message and exit code
        const output = validateResult.stdout || '';
        const exitCodeMatch = output.match(/EXIT_CODE:(\d+)/);
        const actualExitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : validateResult.exitCode;
        const validationOutput = output.replace(/EXIT_CODE:\d+/, '').trim();
        // "no hostkeys available" is not a config syntax error - it's a runtime warning
        // that can occur when sshd -t can't access host keys during the test
        const isHostKeyWarning = validationOutput.includes('no hostkeys available');
        if (actualExitCode !== 0 && !isHostKeyWarning) {
            // Restore backup on validation failure
            await SSHService_1.sshService.executeCommand(serverId, 'mv /etc/ssh/sshd_config.backup /etc/ssh/sshd_config');
            // Also get the current sshd_config for debugging
            const configCheck = await SSHService_1.sshService.executeCommand(serverId, 'head -50 /etc/ssh/sshd_config.backup 2>/dev/null || echo "Could not read config"');
            throw new Error(`SSH configuration validation failed (exit code ${actualExitCode}): ${validationOutput || 'No error message'}. Config preview: ${configCheck.stdout.slice(0, 200)}`);
        }
        // Restart SSH service
        await SSHService_1.sshService.executeCommand(serverId, 'systemctl restart sshd || systemctl restart ssh');
    }
    buildSshConfigUpdateCommand(key, value) {
        const directive = `${key} ${value}`;
        const awkScript = [
            'BEGIN { updated = 0; in_match = 0 }',
            '{',
            '  if ($0 ~ /^[[:space:]]*Match[[:space:]]+/ && !updated) {',
            `    print "${directive}"`,
            '    updated = 1',
            '  }',
            '  if (!in_match && $0 ~ /^[[:space:]]*Match[[:space:]]+/) {',
            '    in_match = 1',
            '  }',
            `  if (!in_match && $0 ~ /^[[:space:]]*#?[[:space:]]*${key}[[:space:]]+/) {`,
            '    if (!updated) {',
            `      print "${directive}"`,
            '      updated = 1',
            '    }',
            '    next',
            '  }',
            '  print',
            '}',
            'END {',
            '  if (!updated) {',
            `    print "${directive}"`,
            '  }',
            '}',
        ].join('\n');
        return `awk '${awkScript}' /etc/ssh/sshd_config > /tmp/sshd_config.servercompass.tmp && ` +
            `cat /tmp/sshd_config.servercompass.tmp > /etc/ssh/sshd_config && ` +
            'rm -f /tmp/sshd_config.servercompass.tmp';
    }
    /**
     * Safely change SSH port with verification and database update
     * This is a multi-step process:
     * 1. Check if firewall is enabled and add rule for new port
     * 2. Handle SELinux if present (for privileged ports)
     * 3. Add new port to SSH config (keeping old port temporarily)
     * 4. Restart SSH service
     * 5. Verify connection on new port
     * 6. Remove old port from SSH config
     * 7. Restart SSH and verify again
     * 8. Update local database with new port
     */
    async changeSSHPortSafely(serverId, currentPort, newPort, updateServerPort) {
        // Step 1: Check firewall status and add rule for new port
        let firewallEnabled = false;
        try {
            const ufwStatus = await this.getUFWStatus(serverId);
            firewallEnabled = ufwStatus.installed && ufwStatus.enabled;
            if (firewallEnabled) {
                // Check if new port is already allowed
                const portAllowed = ufwStatus.rules.some((r) => r.port === newPort.toString() && r.action === 'ALLOW');
                if (!portAllowed) {
                    // Add firewall rule for new port BEFORE changing SSH config
                    await this.addUFWRule(serverId, {
                        action: 'allow',
                        port: newPort.toString(),
                        protocol: 'tcp',
                        comment: 'SSH (new port)',
                    });
                }
            }
        }
        catch (err) {
            // Firewall check failed, but we can continue - user was warned
            console.warn('Firewall check failed:', err);
        }
        // Step 2: Handle SELinux for privileged ports (< 1024)
        if (newPort < 1024) {
            try {
                // Check if SELinux is enabled
                const selinuxCheck = await SSHService_1.sshService.executeCommand(serverId, 'getenforce 2>/dev/null || echo "Disabled"');
                const selinuxEnabled = selinuxCheck.stdout.trim().toLowerCase() === 'enforcing';
                if (selinuxEnabled) {
                    // Check if semanage is available
                    const semanageCheck = await SSHService_1.sshService.executeCommand(serverId, 'which semanage 2>/dev/null || echo "not-found"');
                    if (semanageCheck.stdout.includes('not-found')) {
                        // Try to install policycoreutils-python-utils
                        await SSHService_1.sshService.executeCommand(serverId, 'yum install -y policycoreutils-python-utils 2>/dev/null || dnf install -y policycoreutils-python-utils 2>/dev/null || true');
                    }
                    // Add the new port to SELinux allowed SSH ports
                    await SSHService_1.sshService.executeCommand(serverId, `semanage port -a -t ssh_port_t -p tcp ${newPort} 2>/dev/null || semanage port -m -t ssh_port_t -p tcp ${newPort} 2>/dev/null || true`);
                }
            }
            catch (err) {
                console.warn('SELinux configuration failed, continuing:', err);
            }
        }
        // Step 3: Backup and configure SSH to listen on BOTH ports temporarily
        try {
            await SSHService_1.sshService.executeCommand(serverId, 'cp /etc/ssh/sshd_config /etc/ssh/sshd_config.port_change_backup');
            // Remove any existing Port lines and add both ports
            // This ensures we keep listening on the old port as a fallback
            await SSHService_1.sshService.executeCommand(serverId, `sed -i '/^Port /d' /etc/ssh/sshd_config && sed -i '/^#.*Port /d' /etc/ssh/sshd_config`);
            // Add both ports - old port first (fallback), then new port
            await SSHService_1.sshService.executeCommand(serverId, `echo -e "Port ${currentPort}\\nPort ${newPort}" >> /etc/ssh/sshd_config`);
            // Validate config before restarting
            const validateResult = await SSHService_1.sshService.executeCommand(serverId, 'sshd -t -f /etc/ssh/sshd_config 2>&1');
            // "no hostkeys available" is not a config syntax error - it's a runtime warning
            const isHostKeyWarning = (validateResult.stdout || validateResult.stderr || '').includes('no hostkeys available');
            const hasRealError = validateResult.stderr.includes('error') && !isHostKeyWarning;
            if ((validateResult.exitCode !== 0 && !isHostKeyWarning) || hasRealError) {
                // Restore backup on validation failure
                await SSHService_1.sshService.executeCommand(serverId, 'mv /etc/ssh/sshd_config.port_change_backup /etc/ssh/sshd_config');
                throw new Error(`SSH configuration validation failed: ${validateResult.stderr}`);
            }
        }
        catch (err) {
            // Config change failed, remove firewall rule if we added it
            if (firewallEnabled) {
                try {
                    await SSHService_1.sshService.executeCommand(serverId, `ufw delete allow ${newPort}/tcp 2>/dev/null || true`);
                }
                catch {
                    // Ignore cleanup errors
                }
            }
            throw err;
        }
        // Step 4: Restart SSH service (keeping both ports active)
        try {
            await SSHService_1.sshService.executeCommand(serverId, 'systemctl restart sshd || systemctl restart ssh');
        }
        catch {
            // Connection may be briefly interrupted during restart
        }
        // Wait for SSH to restart
        await new Promise((resolve) => setTimeout(resolve, 2000));
        // Step 5: Verify we can connect on the NEW port
        const server = db_1.queries.getServerById(serverId);
        if (!server) {
            return {
                success: false,
                message: 'Server not found in database',
                needsManualRecovery: true,
            };
        }
        // Get credentials for reconnection
        const vault = new CredentialVault_1.CredentialVault();
        const credential = await vault.decrypt(server.encrypted_secret);
        // Build connection config based on auth type
        const buildConnectionConfig = (port) => {
            const config = {
                host: server.host,
                port,
                username: server.username,
            };
            if (server.auth_type === 'password') {
                config.password = credential;
            }
            else {
                config.privateKey = credential;
            }
            return config;
        };
        // Close existing connection and try new port
        SSHService_1.sshService.disconnect(serverId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        let newPortWorks = false;
        let retries = 3;
        while (retries > 0 && !newPortWorks) {
            try {
                newPortWorks = await SSHService_1.sshService.testConnection(buildConnectionConfig(newPort));
            }
            catch {
                retries--;
                if (retries > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                }
            }
        }
        if (!newPortWorks) {
            // New port doesn't work - check if old port still works (it should since we kept it)
            let oldPortWorks = false;
            try {
                oldPortWorks = await SSHService_1.sshService.testConnection(buildConnectionConfig(currentPort));
            }
            catch {
                oldPortWorks = false;
            }
            if (oldPortWorks) {
                // Restore original config since we still have access via old port
                try {
                    await SSHService_1.sshService.executeCommand(serverId, 'mv /etc/ssh/sshd_config.port_change_backup /etc/ssh/sshd_config && (systemctl restart sshd || systemctl restart ssh)');
                }
                catch {
                    // Ignore - best effort cleanup
                }
                // Clean up firewall rule
                if (firewallEnabled) {
                    try {
                        await SSHService_1.sshService.executeCommand(serverId, `ufw delete allow ${newPort}/tcp 2>/dev/null || true`);
                    }
                    catch {
                        // Ignore cleanup errors
                    }
                }
                return {
                    success: false,
                    message: `Could not connect on new port ${newPort}. SSH may not be able to bind to that port (check SELinux/AppArmor if using a privileged port < 1024). Original configuration has been restored.`,
                    needsManualRecovery: false,
                };
            }
            else {
                return {
                    success: false,
                    message: `Cannot connect to server on either port ${newPort} or ${currentPort}. You may need to use your hosting provider's console. The backup is at /etc/ssh/sshd_config.port_change_backup`,
                    needsManualRecovery: true,
                };
            }
        }
        // Step 6: New port works! Now remove the old port from config
        try {
            // Update config to only use new port
            await SSHService_1.sshService.executeCommand(serverId, `sed -i '/^Port /d' /etc/ssh/sshd_config && echo "Port ${newPort}" >> /etc/ssh/sshd_config`);
            // Restart SSH to apply single-port config
            await SSHService_1.sshService.executeCommand(serverId, 'systemctl restart sshd || systemctl restart ssh');
            // Wait and verify final connection
            SSHService_1.sshService.disconnect(serverId);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            let finalCheck = false;
            retries = 3;
            while (retries > 0 && !finalCheck) {
                try {
                    finalCheck = await SSHService_1.sshService.testConnection(buildConnectionConfig(newPort));
                }
                catch {
                    retries--;
                    if (retries > 0) {
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                    }
                }
            }
            if (!finalCheck) {
                // This shouldn't happen since it worked before, but handle it
                return {
                    success: false,
                    message: `Port change completed but final verification failed. The server should be accessible on port ${newPort}. Please verify manually.`,
                    needsManualRecovery: true,
                };
            }
        }
        catch (err) {
            // Final config update failed, but new port was working - partial success
            console.warn('Final config update failed:', err);
        }
        // Step 7: Update database with new port
        updateServerPort(serverId, newPort);
        // Clean up backup file
        try {
            await SSHService_1.sshService.executeCommand(serverId, 'rm -f /etc/ssh/sshd_config.port_change_backup');
        }
        catch {
            // Ignore cleanup errors
        }
        return {
            success: true,
            message: `SSH port successfully changed from ${currentPort} to ${newPort}. Database updated.`,
        };
    }
    parseSSHBool(config, key, defaultValue) {
        const value = this.readGlobalSSHDirective(config, key);
        if (!value) {
            return defaultValue;
        }
        const normalized = value.toLowerCase();
        if (['yes', 'true', 'on'].includes(normalized))
            return true;
        if (['no', 'false', 'off'].includes(normalized))
            return false;
        // PermitRootLogin can be "prohibit-password" or "forced-commands-only".
        // Treat any non-"no" value as enabled.
        if (key === 'PermitRootLogin') {
            return normalized !== 'no';
        }
        return defaultValue;
    }
    parseSSHNumber(config, key, defaultValue) {
        const value = this.readGlobalSSHDirective(config, key);
        if (!value) {
            return defaultValue;
        }
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : defaultValue;
    }
    readGlobalSSHDirective(config, key) {
        const keyLower = key.toLowerCase();
        let inMatchBlock = false;
        for (const rawLine of config.split('\n')) {
            const trimmedLine = rawLine.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) {
                continue;
            }
            if (/^match\s+/i.test(trimmedLine)) {
                inMatchBlock = true;
            }
            if (inMatchBlock) {
                continue;
            }
            const match = trimmedLine.match(/^([a-zA-Z][a-zA-Z0-9]*)\s+(.+)$/);
            if (!match) {
                continue;
            }
            if (match[1].toLowerCase() !== keyLower) {
                continue;
            }
            return match[2].replace(/\s+#.*$/, '').trim();
        }
        return undefined;
    }
    // ============ Auto Updates Methods ============
    /**
     * Get automatic updates status
     */
    async getAutoUpdatesStatus(serverId) {
        // Check if unattended-upgrades is installed
        const installCheck = await SSHService_1.sshService.executeCommand(serverId, 'dpkg -l | grep -q unattended-upgrades && echo "installed" || echo "not-installed"');
        const installed = installCheck.stdout.includes('installed') &&
            !installCheck.stdout.includes('not-installed');
        if (!installed) {
            return {
                installed: false,
                enabled: false,
                securityOnly: false,
                autoReboot: false,
                rebootTime: '02:00',
                pendingUpdates: 0,
                lastCheckTime: null,
                recentActivity: [],
            };
        }
        // Check if enabled
        const enabledCheck = await SSHService_1.sshService.executeCommand(serverId, 'systemctl is-enabled unattended-upgrades 2>/dev/null || echo "disabled"');
        const enabled = enabledCheck.stdout.trim() === 'enabled';
        // Read config
        const configResult = await SSHService_1.sshService.executeCommand(serverId, 'cat /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null || echo ""');
        const config = configResult.stdout;
        // Parse settings
        const securityOnly = config.includes('"${distro_id}:${distro_codename}-security"') &&
            !config.includes('//') ? true : false;
        const autoRebootMatch = config.match(/Unattended-Upgrade::Automatic-Reboot\s+"(true|false)"/);
        const autoReboot = autoRebootMatch ? autoRebootMatch[1] === 'true' : false;
        const rebootTimeMatch = config.match(/Unattended-Upgrade::Automatic-Reboot-Time\s+"(\d{2}:\d{2})"/);
        const rebootTime = rebootTimeMatch ? rebootTimeMatch[1] : '02:00';
        // Check pending updates
        const pendingResult = await SSHService_1.sshService.executeCommand(serverId, 'apt list --upgradable 2>/dev/null | grep -c upgradable || echo "0"');
        const pendingUpdates = parseInt(pendingResult.stdout.trim()) || 0;
        // Get last check time
        const lastCheckResult = await SSHService_1.sshService.executeCommand(serverId, 'stat -c "%Y" /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo ""');
        let lastCheckTime = null;
        if (lastCheckResult.stdout.trim()) {
            const timestamp = parseInt(lastCheckResult.stdout.trim());
            lastCheckTime = new Date(timestamp * 1000).toISOString();
        }
        // Get recent activity from logs
        const logsResult = await SSHService_1.sshService.executeCommand(serverId, 'tail -20 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null || echo ""');
        const recentActivity = this.parseUpdatesLog(logsResult.stdout);
        return {
            installed: true,
            enabled,
            securityOnly,
            autoReboot,
            rebootTime,
            pendingUpdates,
            lastCheckTime,
            recentActivity,
        };
    }
    /**
     * Install unattended-upgrades
     */
    async installAutoUpdates(serverId) {
        this.emitProgress(serverId, 'updates-install', 'Installing unattended-upgrades...', 'running', 30);
        await SSHService_1.sshService.executeCommand(serverId, 'DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y unattended-upgrades apt-listchanges');
        this.emitProgress(serverId, 'updates-install', 'Enabling automatic updates...', 'running', 70);
        await SSHService_1.sshService.executeCommand(serverId, 'dpkg-reconfigure -plow unattended-upgrades');
        this.emitProgress(serverId, 'updates-install', 'Automatic updates installed', 'completed', 100);
    }
    /**
     * Configure automatic updates
     */
    async configureAutoUpdates(serverId, config) {
        if (!config.enabled) {
            await SSHService_1.sshService.executeCommand(serverId, 'systemctl disable unattended-upgrades && systemctl stop unattended-upgrades');
            return;
        }
        // Enable service
        await SSHService_1.sshService.executeCommand(serverId, 'systemctl enable unattended-upgrades && systemctl start unattended-upgrades');
        // Update configuration
        const configContent = `
Unattended-Upgrade::Allowed-Origins {
    "\${distro_id}:\${distro_codename}";
    "\${distro_id}:\${distro_codename}-security";
    "\${distro_id}ESMApps:\${distro_codename}-apps-security";
    "\${distro_id}ESM:\${distro_codename}-infra-security";
${!config.securityOnly ? `    "\${distro_id}:\${distro_codename}-updates";` : ''}
};

Unattended-Upgrade::Package-Blacklist {
};

Unattended-Upgrade::DevRelease "auto";
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Dependencies "false";
Unattended-Upgrade::Automatic-Reboot "${config.autoReboot}";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "${config.rebootTime}";
`;
        await SSHService_1.sshService.executeCommand(serverId, `cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'UPDATESEOF'
${configContent}
UPDATESEOF`);
    }
    /**
     * Check for updates
     */
    async checkForUpdates(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, 'apt-get update');
        const result = await SSHService_1.sshService.executeCommand(serverId, 'apt list --upgradable 2>/dev/null | grep -c upgradable || echo "0"');
        return parseInt(result.stdout.trim()) || 0;
    }
    /**
     * Apply pending updates
     */
    async applyUpdates(serverId) {
        this.emitProgress(serverId, 'apply-updates', 'Updating package lists...', 'running', 10);
        await SSHService_1.sshService.executeCommand(serverId, 'apt-get update');
        this.emitProgress(serverId, 'apply-updates', 'Installing updates...', 'running', 30);
        await SSHService_1.sshService.executeCommand(serverId, 'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y');
        this.emitProgress(serverId, 'apply-updates', 'Updates applied successfully', 'completed', 100);
    }
    parseUpdatesLog(log) {
        const entries = [];
        const lines = log.split('\n').filter(Boolean);
        for (const line of lines.slice(-10)) {
            // Parse lines like: "2025-01-30 02:00:15,234 INFO Packages that will be upgraded: ..."
            const match = line.match(/^(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}.*?(INFO|WARNING|ERROR)\s+(.+)$/);
            if (match) {
                entries.push({
                    date: match[1],
                    message: match[3].substring(0, 50),
                    success: match[2] !== 'ERROR',
                });
            }
        }
        return entries.slice(-5);
    }
    // ============ Security Audit Methods ============
    /**
     * Run comprehensive security audit
     */
    async runSecurityAudit(serverId) {
        // Fetch all status in parallel
        const [fail2banStatus, ufwStatus, sshStatus, updatesStatus] = await Promise.all([
            this.getFail2BanStatus(serverId).catch(() => null),
            this.getUFWStatus(serverId).catch(() => null),
            this.getSSHStatus(serverId).catch(() => null),
            this.getAutoUpdatesStatus(serverId).catch(() => null),
        ]);
        // Calculate individual scores
        const fail2ban = {
            score: this.calculateFail2BanScore(fail2banStatus),
            status: this.getFail2BanStatusLabel(fail2banStatus),
            bannedCount: fail2banStatus?.sshJail.currentlyBanned || 0,
        };
        const firewall = {
            score: this.calculateFirewallScore(ufwStatus),
            status: this.getFirewallStatusLabel(ufwStatus),
            rulesCount: ufwStatus?.rules.length || 0,
        };
        const ssh = {
            score: sshStatus?.score || 0,
            issues: sshStatus?.issues || [],
        };
        const updates = {
            score: this.calculateUpdatesScore(updatesStatus),
            enabled: updatesStatus?.enabled || false,
            pendingCount: updatesStatus?.pendingUpdates || 0,
        };
        // Calculate overall score (weighted average) - excluding updates for now
        const overallScore = Math.round(fail2ban.score * 0.30 +
            firewall.score * 0.30 +
            ssh.score * 0.40);
        // Generate recommendations
        const recommendations = [];
        if (!fail2banStatus?.installed) {
            recommendations.push({
                type: 'warning',
                message: 'fail2ban is not installed',
                action: 'Install fail2ban to protect against brute force attacks',
            });
        }
        else if (!fail2banStatus?.running) {
            recommendations.push({
                type: 'warning',
                message: 'fail2ban is installed but not running',
                action: 'Start fail2ban service',
            });
        }
        if (!ufwStatus?.installed) {
            recommendations.push({
                type: 'warning',
                message: 'UFW firewall is not installed',
                action: 'Install UFW to control network access',
            });
        }
        else if (!ufwStatus?.enabled) {
            recommendations.push({
                type: 'warning',
                message: 'Firewall is installed but not enabled',
                action: 'Enable UFW firewall',
            });
        }
        // Root login check disabled for further testing
        // if (sshStatus?.permitRootLogin) {
        //   recommendations.push({
        //     type: 'warning',
        //     message: 'Root SSH login is enabled',
        //     action: 'Disable root login for better security',
        //   });
        // }
        if (sshStatus?.passwordAuthentication) {
            recommendations.push({
                type: 'warning',
                message: 'Password authentication is enabled',
                action: 'Use SSH keys and disable password authentication',
            });
        }
        if (!updatesStatus?.enabled) {
            recommendations.push({
                type: 'info',
                message: 'Automatic updates are not enabled',
                action: 'Enable automatic security updates',
            });
        }
        // Pending updates recommendation hidden for further testing
        // else if (updatesStatus.pendingUpdates > 0) {
        //   recommendations.push({
        //     type: 'info',
        //     message: `${updatesStatus.pendingUpdates} updates are pending`,
        //     action: 'Apply pending updates',
        //   });
        // }
        return {
            overallScore,
            fail2ban,
            firewall,
            ssh,
            updates,
            recommendations,
        };
    }
    /**
     * Quick harden - apply recommended security settings
     */
    async quickHarden(serverId) {
        this.emitProgress(serverId, 'quick-harden', 'Starting security hardening...', 'running', 5);
        // 1. Install and configure fail2ban
        const fail2banStatus = await this.getFail2BanStatus(serverId);
        if (!fail2banStatus.installed) {
            this.emitProgress(serverId, 'quick-harden', 'Installing fail2ban...', 'running', 15);
            await this.installFail2Ban(serverId);
        }
        else if (!fail2banStatus.running) {
            this.emitProgress(serverId, 'quick-harden', 'Starting fail2ban...', 'running', 15);
            await SSHService_1.sshService.executeCommand(serverId, 'systemctl start fail2ban');
        }
        // 2. Install and enable UFW
        const ufwStatus = await this.getUFWStatus(serverId);
        if (!ufwStatus.installed) {
            this.emitProgress(serverId, 'quick-harden', 'Installing firewall...', 'running', 35);
            await this.installUFW(serverId);
        }
        if (!ufwStatus.enabled) {
            this.emitProgress(serverId, 'quick-harden', 'Enabling firewall...', 'running', 45);
            await this.enableUFW(serverId);
        }
        // 3. Harden SSH
        this.emitProgress(serverId, 'quick-harden', 'Hardening SSH configuration...', 'running', 60);
        const sshStatus = await this.getSSHStatus(serverId);
        const server = db_1.queries.getServerById(serverId);
        const canDisableRootLogin = server ? server.username !== 'root' : false;
        const canDisablePasswordAuth = server ? server.auth_type !== 'password' : false;
        if (!canDisableRootLogin || !canDisablePasswordAuth) {
            const retainedSettings = [];
            if (!canDisableRootLogin)
                retainedSettings.push('PermitRootLogin');
            if (!canDisablePasswordAuth)
                retainedSettings.push('PasswordAuthentication');
            this.emitProgress(serverId, 'quick-harden', `Keeping ${retainedSettings.join(' and ')} to avoid locking current SSH access`, 'running', 62);
        }
        await this.configureSSH(serverId, {
            serverId,
            permitRootLogin: canDisableRootLogin ? false : sshStatus.permitRootLogin,
            passwordAuthentication: canDisablePasswordAuth ? false : sshStatus.passwordAuthentication,
            permitEmptyPasswords: false,
            maxAuthTries: 3,
            port: sshStatus.port, // Keep current port
        });
        // 4. Enable automatic updates
        this.emitProgress(serverId, 'quick-harden', 'Enabling automatic updates...', 'running', 80);
        const updatesStatus = await this.getAutoUpdatesStatus(serverId);
        if (!updatesStatus.installed) {
            await this.installAutoUpdates(serverId);
        }
        if (!updatesStatus.enabled) {
            await this.configureAutoUpdates(serverId, {
                serverId,
                enabled: true,
                securityOnly: true,
                autoReboot: false,
                rebootTime: '02:00',
            });
        }
        this.emitProgress(serverId, 'quick-harden', 'Security hardening complete', 'completed', 100);
    }
    calculateFail2BanScore(status) {
        if (!status?.installed)
            return 0;
        if (!status.running)
            return 25;
        if (!status.sshJail.enabled)
            return 50;
        return 100;
    }
    calculateFirewallScore(status) {
        if (!status?.installed)
            return 0;
        if (!status.enabled)
            return 25;
        // Check for basic rules (SSH at minimum)
        const hasSshRule = status.rules.some((r) => r.port === '22' || r.port === 'ssh');
        if (!hasSshRule)
            return 50;
        return 100;
    }
    calculateUpdatesScore(status) {
        if (!status?.installed)
            return 50; // Updates not installed but manual is possible
        if (!status.enabled)
            return 60;
        if (status.pendingUpdates > 10)
            return 75;
        if (status.pendingUpdates > 0)
            return 90;
        return 100;
    }
    getFail2BanStatusLabel(status) {
        if (!status?.installed)
            return 'not_installed';
        if (!status.running)
            return 'stopped';
        return 'running';
    }
    getFirewallStatusLabel(status) {
        if (!status?.installed)
            return 'not_installed';
        if (!status.enabled)
            return 'inactive';
        return 'active';
    }
    // ============ User Management Methods ============
    /**
     * List system users with login shells
     */
    async listUsers(serverId) {
        // Get all users with valid login shells (excluding nologin/false shells and nobody)
        const usersResult = await SSHService_1.sshService.executeCommand(serverId, `getent passwd | awk -F: '$7 !~ /nologin|false/ && $1 != "nobody" {print $1":"$3":"$6":"$7}'`);
        const users = [];
        const lines = usersResult.stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
            const [username, uid, homeDir, shell] = line.split(':');
            if (!username)
                continue;
            // Check if user has sudo access
            const sudoCheck = await SSHService_1.sshService.executeCommand(serverId, `groups ${username} 2>/dev/null | grep -qE '\\b(sudo|wheel)\\b' && echo "yes" || echo "no"`);
            const hasSudo = sudoCheck.stdout.trim() === 'yes';
            // Count SSH keys for this user (match ssh- anywhere in line to handle options prefix)
            const keyCountResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${homeDir}/.ssh/authorized_keys 2>/dev/null | grep -c 'ssh-' || echo "0"`);
            const sshKeyCount = parseInt(keyCountResult.stdout.trim()) || 0;
            users.push({
                username,
                uid: parseInt(uid) || 0,
                homeDir,
                shell,
                hasSudo,
                sshKeyCount,
            });
        }
        return users;
    }
    /**
     * Create a new user with optional sudo access
     */
    async createUser(serverId, input) {
        const { username, withSudo, passwordMode, password } = input;
        // Create user with home directory
        await SSHService_1.sshService.executeCommand(serverId, `useradd -m -s /bin/bash ${username}`);
        // Handle password
        let generatedPassword;
        if (passwordMode === 'generate') {
            // Generate a random 16-character password
            generatedPassword = crypto.randomBytes(12).toString('base64').slice(0, 16);
            await SSHService_1.sshService.executeCommand(serverId, `echo '${username}:${generatedPassword}' | chpasswd`);
        }
        else if (passwordMode === 'set' && password) {
            await SSHService_1.sshService.executeCommand(serverId, `echo '${username}:${password}' | chpasswd`);
        }
        else if (passwordMode === 'none') {
            // Lock password login for this user (SSH key only)
            await SSHService_1.sshService.executeCommand(serverId, `passwd -l ${username}`);
        }
        // Add to sudo/wheel group if requested
        if (withSudo) {
            // Try sudo group (Debian/Ubuntu) first, then wheel (RHEL/CentOS)
            await SSHService_1.sshService.executeCommand(serverId, `usermod -aG sudo ${username} 2>/dev/null || usermod -aG wheel ${username}`);
        }
        // Copy the current SSH key to the new user's authorized_keys
        try {
            const server = db_1.queries.getServerById(serverId);
            if (server && server.auth_type === 'private_key') {
                // Get the public key from the currently used private key
                const vault = new CredentialVault_1.CredentialVault();
                const privateKey = await vault.decrypt(server.encrypted_secret);
                // Extract public key from private key using ssh-keygen
                // First, write the private key to a temp file, generate public key, then clean up
                const tempKeyPath = `/tmp/.servercompass_temp_key_${Date.now()}`;
                await SSHService_1.sshService.executeCommand(serverId, `cat > ${tempKeyPath} << 'KEYEOF'
${privateKey}
KEYEOF
chmod 600 ${tempKeyPath}`);
                // Generate public key from private key
                const pubKeyResult = await SSHService_1.sshService.executeCommand(serverId, `ssh-keygen -y -f ${tempKeyPath} 2>/dev/null || echo ""`);
                // Clean up temp key
                await SSHService_1.sshService.executeCommand(serverId, `rm -f ${tempKeyPath}`);
                const publicKey = pubKeyResult.stdout.trim();
                if (publicKey && publicKey.startsWith('ssh-')) {
                    // Get the user's home directory
                    const homeResult = await SSHService_1.sshService.executeCommand(serverId, `getent passwd ${username} | cut -d: -f6`);
                    const homeDir = homeResult.stdout.trim();
                    // Create .ssh directory and add the key
                    await SSHService_1.sshService.executeCommand(serverId, `mkdir -p ${homeDir}/.ssh && chmod 700 ${homeDir}/.ssh && echo '${publicKey}' >> ${homeDir}/.ssh/authorized_keys && chmod 600 ${homeDir}/.ssh/authorized_keys && chown -R ${username}:${username} ${homeDir}/.ssh`);
                }
            }
        }
        catch (err) {
            // Non-fatal: continue even if SSH key copy fails
            console.warn('Failed to copy SSH key to new user:', err);
        }
        return { generatedPassword };
    }
    /**
     * Delete a user
     */
    async deleteUser(serverId, username, removeHome) {
        // Protect against deleting root or the current user
        if (username === 'root') {
            throw new Error('Cannot delete the root user');
        }
        const server = db_1.queries.getServerById(serverId);
        if (server && server.username === username) {
            throw new Error('Cannot delete the user currently used for SSH connection');
        }
        const cmd = removeHome ? `userdel -r ${username}` : `userdel ${username}`;
        await SSHService_1.sshService.executeCommand(serverId, cmd);
    }
    /**
     * Add an SSH public key to a user's authorized_keys
     */
    async addUserSSHKey(serverId, username, publicKey) {
        // Validate the public key format
        if (!publicKey.match(/^ssh-(rsa|ed25519|ecdsa|dss)\s+/)) {
            throw new Error('Invalid SSH public key format');
        }
        // Get the user's home directory
        const homeResult = await SSHService_1.sshService.executeCommand(serverId, `getent passwd ${username} | cut -d: -f6`);
        const homeDir = homeResult.stdout.trim();
        if (!homeDir) {
            throw new Error(`User ${username} not found`);
        }
        // Create .ssh directory if it doesn't exist, add the key
        await SSHService_1.sshService.executeCommand(serverId, `mkdir -p ${homeDir}/.ssh && chmod 700 ${homeDir}/.ssh && echo '${publicKey.replace(/'/g, "'\\''")}' >> ${homeDir}/.ssh/authorized_keys && chmod 600 ${homeDir}/.ssh/authorized_keys && chown -R ${username}:${username} ${homeDir}/.ssh`);
    }
    /**
     * List SSH keys for a user
     */
    async listUserSSHKeys(serverId, username) {
        // Get the user's home directory
        const homeResult = await SSHService_1.sshService.executeCommand(serverId, `getent passwd ${username} | cut -d: -f6`);
        const homeDir = homeResult.stdout.trim();
        if (!homeDir) {
            throw new Error(`User ${username} not found`);
        }
        // Read authorized_keys file
        const keysResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${homeDir}/.ssh/authorized_keys 2>/dev/null || echo ""`);
        const keys = [];
        const lines = keysResult.stdout.trim().split('\n').filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#'))
                continue;
            // Parse SSH key: [options] type base64-key [comment]
            // Options can appear before the key type (e.g., "no-pty,command=\"...\" ssh-rsa AAAA...")
            const match = line.match(/(?:^|\s)(ssh-\S+)\s+(\S+)(?:\s+(.*))?$/);
            if (match) {
                const [, type, keyData, comment = ''] = match;
                // Calculate fingerprint
                let fingerprint = '';
                try {
                    const fpResult = await SSHService_1.sshService.executeCommand(serverId, `echo '${line.replace(/'/g, "'\\''")}' | ssh-keygen -lf - 2>/dev/null | awk '{print $2}'`);
                    fingerprint = fpResult.stdout.trim();
                }
                catch {
                    // Fingerprint calculation failed, use truncated key data
                    fingerprint = keyData.slice(0, 20) + '...';
                }
                keys.push({
                    index: i,
                    type,
                    fingerprint,
                    comment,
                });
            }
        }
        return keys;
    }
    /**
     * Remove an SSH key from a user by index
     */
    async removeUserSSHKey(serverId, username, keyIndex) {
        // Get the user's home directory
        const homeResult = await SSHService_1.sshService.executeCommand(serverId, `getent passwd ${username} | cut -d: -f6`);
        const homeDir = homeResult.stdout.trim();
        if (!homeDir) {
            throw new Error(`User ${username} not found`);
        }
        // Use sed to delete the specific line (1-indexed in sed)
        await SSHService_1.sshService.executeCommand(serverId, `sed -i '${keyIndex + 1}d' ${homeDir}/.ssh/authorized_keys`);
    }
    emitProgress(serverId, operation, message, status, progress) {
        const event = {
            serverId,
            operation,
            message,
            status,
            progress,
        };
        this.emit('progress', event);
    }
}
exports.SecurityService = SecurityService;
exports.securityService = new SecurityService();
//# sourceMappingURL=SecurityService.js.map