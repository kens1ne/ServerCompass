"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.provisioningService = exports.ProvisioningService = void 0;
const events_1 = require("events");
const SSHService_1 = require("./SSHService");
const db_1 = require("../db");
class ProvisioningService extends events_1.EventEmitter {
    // Track ongoing package installations to prevent concurrent installations
    ongoingInstallations = new Set();
    /**
     * Provision a server with baseline setup
     */
    async provisionServer(serverId) {
        const server = db_1.queries.getServerById(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        try {
            // Update server status
            db_1.queries.updateServer(serverId, { status: 'provisioning' });
            const steps = [
                { name: 'Verify OS and prerequisites', fn: this.verifyPrerequisites.bind(this) },
                { name: 'Create deploy user', fn: this.createDeployUser.bind(this) },
                { name: 'Install core packages', fn: this.installCorePackages.bind(this) },
                { name: 'Install Node.js LTS', fn: this.installNodeJS.bind(this) },
                { name: 'Install PM2', fn: this.installPM2.bind(this) },
                { name: 'Install Nginx & Certbot', fn: this.installNginx.bind(this) },
                { name: 'Configure firewall', fn: this.configureFirewall.bind(this) },
            ];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                this.emitProgress(serverId, step.name, 'running', (i / steps.length) * 100);
                try {
                    await step.fn(serverId);
                    this.emitProgress(serverId, step.name, 'completed', ((i + 1) / steps.length) * 100);
                }
                catch (error) {
                    this.emitProgress(serverId, step.name, 'failed', ((i + 1) / steps.length) * 100);
                    throw error;
                }
            }
            // Update server status to ready and mark packages as installed
            db_1.queries.updateServer(serverId, { status: 'ready' });
            db_1.queries.setPackageInstallationStatus(serverId, true);
        }
        catch (error) {
            db_1.queries.updateServer(serverId, { status: 'error' });
            throw error;
        }
    }
    /**
     * Background check and install essential packages (fallback mechanism)
     * This runs silently and ensures critical packages are available
     *
     * @param serverId - The server ID to check
     * @param force - Force check even if packages are marked as installed in database
     * @returns Promise<boolean> - true if all packages are ok or installed successfully
     */
    async ensureEssentialPackages(serverId, force = false) {
        try {
            // Check database to see if packages are already installed
            const status = db_1.queries.getPackageInstallationStatus(serverId);
            if (!force && status?.packagesInstalled) {
                console.log(`[ProvisioningService] Skipping package check for ${serverId} (packages already installed in database)`);
                return true;
            }
            // Check if already installing packages for this server
            if (this.ongoingInstallations.has(serverId)) {
                console.log(`[ProvisioningService] Package installation already in progress for ${serverId}`);
                return false;
            }
            this.ongoingInstallations.add(serverId);
            console.log(`[ProvisioningService] Running background package check for server ${serverId}...`);
            // Check and install essential packages
            const packages = [
                {
                    name: 'curl',
                    checkCommand: 'command -v curl',
                    installCommand: 'apt-get update -qq && apt-get install -y -qq curl',
                },
                {
                    name: 'git',
                    checkCommand: 'command -v git',
                    installCommand: 'apt-get install -y -qq git',
                },
                {
                    name: 'build-essential',
                    checkCommand: 'dpkg -l | grep build-essential',
                    installCommand: 'apt-get install -y -qq build-essential',
                },
                {
                    name: 'Node.js',
                    checkCommand: 'command -v node',
                    installCommand: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y -qq nodejs',
                },
                {
                    name: 'PM2',
                    checkCommand: 'command -v pm2',
                    installCommand: 'npm install -g pm2 && pm2 startup systemd -u root --hp /root || true',
                },
            ];
            let allPackagesOk = true;
            for (const pkg of packages) {
                try {
                    // Check if package exists
                    const checkResult = await SSHService_1.sshService.executeCommand(serverId, `${pkg.checkCommand} &>/dev/null && echo "installed" || echo "missing"`);
                    const isInstalled = checkResult.stdout.trim().includes('installed');
                    if (!isInstalled) {
                        console.log(`[ProvisioningService] Package ${pkg.name} is missing, installing...`);
                        // Install the package
                        const installResult = await SSHService_1.sshService.executeCommand(serverId, `export DEBIAN_FRONTEND=noninteractive && ${pkg.installCommand}`);
                        if (installResult.exitCode !== 0) {
                            console.error(`[ProvisioningService] Failed to install ${pkg.name}:`, installResult.stderr);
                            allPackagesOk = false;
                        }
                        else {
                            console.log(`[ProvisioningService] Successfully installed ${pkg.name}`);
                        }
                    }
                }
                catch (error) {
                    console.error(`[ProvisioningService] Error checking/installing ${pkg.name}:`, error);
                    allPackagesOk = false;
                }
            }
            // Update database with installation status
            db_1.queries.setPackageInstallationStatus(serverId, allPackagesOk);
            this.ongoingInstallations.delete(serverId);
            console.log(`[ProvisioningService] Background package check completed for ${serverId}. All OK: ${allPackagesOk}`);
            return allPackagesOk;
        }
        catch (error) {
            console.error(`[ProvisioningService] Error in ensureEssentialPackages for ${serverId}:`, error);
            this.ongoingInstallations.delete(serverId);
            return false;
        }
    }
    /**
     * Reset package installation status for a server
     * This will force a recheck next time ensureEssentialPackages is called
     */
    resetPackageStatus(serverId) {
        db_1.queries.resetPackageInstallationStatus(serverId);
        console.log(`[ProvisioningService] Package status reset for ${serverId}`);
    }
    /**
     * Get package installation status from database
     */
    getPackageStatus(serverId) {
        return db_1.queries.getPackageInstallationStatus(serverId);
    }
    async verifyPrerequisites(serverId) {
        const result = await SSHService_1.sshService.executeCommand(serverId, `
      cat /etc/os-release | grep -i ubuntu &&
      df -h / | awk 'NR==2 {print $4}' &&
      nproc &&
      free -h | grep Mem
    `);
        if (result.exitCode !== 0 || !result.stdout.includes('ubuntu')) {
            throw new Error('Server does not meet prerequisites (Ubuntu required)');
        }
    }
    async createDeployUser(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      if ! id -u deploy > /dev/null 2>&1; then
        useradd -m -s /bin/bash deploy
        usermod -aG sudo deploy
        echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy
        chmod 0440 /etc/sudoers.d/deploy
      fi
    `);
    }
    async installCorePackages(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq curl git ufw fail2ban build-essential
    `);
    }
    async installNodeJS(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
        apt-get install -y -qq nodejs
      fi
    `);
    }
    async installPM2(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      if ! command -v pm2 &> /dev/null; then
        npm install -g pm2
        pm2 startup systemd -u root --hp /root
      fi
    `);
    }
    async installNginx(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      if ! command -v nginx &> /dev/null; then
        apt-get install -y -qq nginx certbot python3-certbot-nginx
        systemctl enable nginx
        systemctl start nginx
      fi
    `);
        // Setup certbot auto-renewal cron job
        await this.setupCertbotCron(serverId);
    }
    /**
     * Install nginx and certbot independently (for domain configuration)
     */
    async installNginxAndCertbot(serverId) {
        const server = db_1.queries.getServerById(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        // Update package list first
        this.emitProgress(serverId, 'Updating package list', 'running', 10);
        await SSHService_1.sshService.executeCommand(serverId, 'apt-get update -qq');
        this.emitProgress(serverId, 'Updating package list', 'completed', 20);
        // Install nginx
        this.emitProgress(serverId, 'Installing Nginx', 'running', 30);
        const nginxResult = await SSHService_1.sshService.executeCommand(serverId, `
      if ! command -v nginx &> /dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
        systemctl enable nginx
        systemctl start nginx
      else
        echo "Nginx already installed"
      fi
    `);
        if (nginxResult.exitCode !== 0) {
            this.emitProgress(serverId, 'Installing Nginx', 'failed', 40);
            throw new Error('Failed to install Nginx');
        }
        this.emitProgress(serverId, 'Installing Nginx', 'completed', 50);
        // Install certbot
        this.emitProgress(serverId, 'Installing Certbot', 'running', 60);
        const certbotResult = await SSHService_1.sshService.executeCommand(serverId, `
      if ! command -v certbot &> /dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
      else
        echo "Certbot already installed"
      fi
    `);
        if (certbotResult.exitCode !== 0) {
            this.emitProgress(serverId, 'Installing Certbot', 'failed', 70);
            throw new Error('Failed to install Certbot');
        }
        this.emitProgress(serverId, 'Installing Certbot', 'completed', 80);
        // Verify installations
        this.emitProgress(serverId, 'Verifying installations', 'running', 90);
        const verifyResult = await SSHService_1.sshService.executeCommand(serverId, 'command -v nginx && command -v certbot');
        if (verifyResult.exitCode !== 0) {
            this.emitProgress(serverId, 'Verifying installations', 'failed', 95);
            throw new Error('Installation verification failed');
        }
        this.emitProgress(serverId, 'Verifying installations', 'completed', 90);
        // Setup certbot auto-renewal cron job
        this.emitProgress(serverId, 'Setting up certbot auto-renewal', 'running', 95);
        await this.setupCertbotCron(serverId);
        this.emitProgress(serverId, 'Setting up certbot auto-renewal', 'completed', 100);
    }
    async configureFirewall(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      ufw --force enable
      ufw allow 22/tcp
      ufw allow 80/tcp
      ufw allow 443/tcp
      ufw status
    `);
    }
    /**
     * Setup certbot auto-renewal cron job
     * Checks if the cron entry already exists before adding it
     */
    async setupCertbotCron(serverId) {
        await SSHService_1.sshService.executeCommand(serverId, `
      # Check if certbot renew cron entry already exists
      if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
        # Add the cron entry for certbot auto-renewal
        (crontab -l 2>/dev/null || true; echo "0 * * * * sudo certbot renew --quiet") | crontab -
        echo "Certbot auto-renewal cron job added"
      else
        echo "Certbot auto-renewal cron job already exists"
      fi
    `);
    }
    emitProgress(serverId, step, status, progress) {
        const event = {
            id: serverId,
            type: 'provisioning',
            step,
            status,
            message: `${status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Failed'}: ${step}`,
            progress,
        };
        this.emit('progress', event);
    }
}
exports.ProvisioningService = ProvisioningService;
exports.provisioningService = new ProvisioningService();
//# sourceMappingURL=ProvisioningService.js.map