"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraefikService = void 0;
const SSHService_1 = require("./SSHService");
// ============================================================================
// TRAEFIK PORT CONFIGURATION
// ============================================================================
// These match the reserved ports in src/lib/portUtils.ts
/**
 * Essential ports that Traefik MUST have access to
 * If these are in use, Traefik setup will fail with a clear error
 */
const TRAEFIK_ESSENTIAL_PORTS = {
    HTTP: 80,
    HTTPS: 443,
};
/**
 * Optional ports that can be reassigned if already in use
 */
const TRAEFIK_OPTIONAL_PORTS = {
    DASHBOARD: 8080,
};
class TraefikService {
    sshService;
    constructor(sshService) {
        this.sshService = sshService || new SSHService_1.SSHService();
    }
    /**
     * Check if a port is in use on the server
     */
    async isPortInUse(serverId, port) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, `ss -tlnH | grep -E ':${port}\\s' | head -1`);
            return result.stdout.trim().length > 0;
        }
        catch {
            return false;
        }
    }
    /**
     * Find an available port for Traefik dashboard
     * Returns 0 if no port is available (dashboard will be disabled)
     */
    async findAvailableDashboardPort(serverId) {
        // Try default port first
        if (!(await this.isPortInUse(serverId, TRAEFIK_OPTIONAL_PORTS.DASHBOARD))) {
            return TRAEFIK_OPTIONAL_PORTS.DASHBOARD;
        }
        // Try alternative ports
        for (let port = 8081; port <= 8099; port++) {
            if (!(await this.isPortInUse(serverId, port))) {
                return port;
            }
        }
        // No port available - disable dashboard
        return 0;
    }
    /**
     * Check if essential ports (80, 443) are available
     */
    async checkEssentialPorts(serverId) {
        const blockedPorts = [];
        // Check port 80
        if (await this.isPortInUse(serverId, TRAEFIK_ESSENTIAL_PORTS.HTTP)) {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, `ss -tlnp | grep ':80\\s' | head -1`);
            const processInfo = result.stdout.trim() || 'unknown process';
            blockedPorts.push({
                port: 80,
                reason: `Port 80 is in use by: ${processInfo}`,
            });
        }
        // Check port 443
        if (await this.isPortInUse(serverId, TRAEFIK_ESSENTIAL_PORTS.HTTPS)) {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, `ss -tlnp | grep ':443\\s' | head -1`);
            const processInfo = result.stdout.trim() || 'unknown process';
            blockedPorts.push({
                port: 443,
                reason: `Port 443 is in use by: ${processInfo}`,
            });
        }
        return {
            available: blockedPorts.length === 0,
            blockedPorts,
        };
    }
    /**
     * Install and configure Traefik on the VPS
     * Creates docker-compose.yml for Traefik container
     */
    async setupTraefik(serverId, email) {
        // 0. Check if Traefik is already running — don't try to re-install
        const alreadyInstalled = await this.isTraefikInstalled(serverId);
        if (alreadyInstalled) {
            const isRunning = await this.verifyTraefikRunning(serverId);
            if (isRunning) {
                // Traefik is already running, nothing to do
                return;
            }
            // Traefik container exists but is not running — try to start it
            try {
                await this.startTraefik(serverId);
                const started = await this.verifyTraefikRunning(serverId);
                if (started) {
                    return;
                }
            }
            catch {
                // Fall through to fresh install
            }
        }
        // 1. Check if essential ports (80, 443) are available
        const portCheck = await this.checkEssentialPorts(serverId);
        if (!portCheck.available) {
            const portDetails = portCheck.blockedPorts
                .map(p => `Port ${p.port}: ${p.reason}`)
                .join('\n');
            throw new Error(`Cannot install Traefik: Essential ports are in use.\n\n${portDetails}\n\n` +
                `Traefik requires ports 80 (HTTP) and 443 (HTTPS) to function. ` +
                `Please stop the services using these ports before installing Traefik.`);
        }
        // 0.5. Find available dashboard port (optional, can be skipped)
        const dashboardPort = await this.findAvailableDashboardPort(serverId);
        // 1. Create traefik directory structure
        await this.createTraefikDirectories(serverId);
        // 2. Generate traefik.yml config (static config)
        await this.writeTraefikConfig(serverId, email);
        // 3. Generate docker-compose.yml for Traefik (with dynamic dashboard port)
        await this.writeTraefikComposeFile(serverId, dashboardPort);
        // 4. Start Traefik container
        await this.startTraefik(serverId);
        // 5. Verify Traefik is running with proper port bindings
        const isRunning = await this.verifyTraefikRunning(serverId);
        if (!isRunning) {
            throw new Error('Traefik failed to start. Check server logs for details.');
        }
        // 6. Verify port bindings are correct
        const hasPortBindings = await this.verifyPortBindings(serverId);
        if (!hasPortBindings) {
            throw new Error('Traefik started but port bindings failed. ' +
                'This usually means another service grabbed the ports. ' +
                'Run "docker logs traefik" on the server for details.');
        }
    }
    /**
     * Creates directory structure:
     * /opt/traefik/
     * ├── traefik.yml (static config)
     * ├── docker-compose.yml
     * ├── acme.json (Let's Encrypt certs - auto-created)
     * └── dynamic/ (dynamic config files - optional)
     */
    async createTraefikDirectories(serverId) {
        const commands = [
            'mkdir -p /opt/traefik/dynamic',
            'touch /opt/traefik/acme.json',
            'chmod 600 /opt/traefik/acme.json',
        ];
        for (const cmd of commands) {
            const client = await this.sshService.connect(serverId);
            await this.sshService.executeCommand(client, cmd);
        }
    }
    /**
     * Generate Traefik static configuration
     * Follows Dokploy pattern
     */
    async writeTraefikConfig(serverId, email) {
        // NOTE: Do NOT add global HTTP-to-HTTPS redirect at entrypoint level
        // Per-domain redirects are handled via the redirect-to-https middleware on each domain's HTTP router
        // This allows Force HTTPS to be toggled per-domain
        const config = `api:
  dashboard: true
  insecure: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: traefik-public

certificatesResolvers:
  letsencrypt:
    acme:
      email: ${email}
      storage: /acme.json
      httpChallenge:
        entryPoint: web

log:
  level: INFO
`;
        await this.writeRemoteFile(serverId, '/opt/traefik/traefik.yml', config);
    }
    /**
     * Generate docker-compose.yml for Traefik container
     * @param dashboardPort - Port for dashboard (0 to disable)
     */
    async writeTraefikComposeFile(serverId, dashboardPort = 8080) {
        // Build ports array - always include 80 and 443, optionally include dashboard
        const ports = [
            '      - "80:80"',
            '      - "443:443"',
        ];
        if (dashboardPort > 0) {
            ports.push(`      - "${dashboardPort}:8080"`);
        }
        const compose = `services:
  traefik:
    image: traefik:latest
    container_name: traefik
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    environment:
      - DOCKER_API_VERSION=1.44
    networks:
      - traefik-public
    ports:
${ports.join('\n')}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/traefik/traefik.yml:/etc/traefik/traefik.yml:ro
      - /opt/traefik/acme.json:/acme.json
      - /opt/traefik/dynamic:/etc/traefik/dynamic:ro
      - /var/log/traefik:/var/log/traefik
    labels:
      - "traefik.enable=true"

networks:
  traefik-public:
    external: true
`;
        await this.writeRemoteFile(serverId, '/opt/traefik/docker-compose.yml', compose);
    }
    /**
     * Start Traefik container
     */
    async startTraefik(serverId) {
        const client = await this.sshService.connect(serverId);
        // Create network if doesn't exist
        await this.sshService.executeCommand(client, 'docker network create traefik-public 2>/dev/null || true');
        // Create log directory
        await this.sshService.executeCommand(client, 'mkdir -p /var/log/traefik');
        // Start Traefik
        await this.sshService.executeCommand(client, 'cd /opt/traefik && docker compose up -d');
    }
    /**
     * Verify Traefik is running and healthy
     */
    async verifyTraefikRunning(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, 'docker ps --filter name=traefik --format "{{.Status}}"');
            return result.stdout.includes('Up');
        }
        catch (error) {
            console.error('Error verifying Traefik status:', error);
            return false;
        }
    }
    /**
     * Verify Traefik has proper port bindings (80 and 443)
     * This catches the bug where Traefik starts but without port bindings
     */
    async verifyPortBindings(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, 'docker ps --filter name=traefik --format "{{.Ports}}"');
            const ports = result.stdout.trim();
            // Check for both 80 and 443 port bindings
            const has80 = ports.includes(':80->') || ports.includes(':80/');
            const has443 = ports.includes(':443->') || ports.includes(':443/');
            if (!has80 || !has443) {
                console.error('Traefik port bindings missing:', {
                    ports,
                    has80,
                    has443,
                });
                return false;
            }
            return true;
        }
        catch (error) {
            console.error('Error verifying Traefik port bindings:', error);
            return false;
        }
    }
    /**
     * Get Traefik version
     */
    async getTraefikVersion(serverId) {
        const client = await this.sshService.connect(serverId);
        const result = await this.sshService.executeCommand(client, 'docker exec traefik traefik version');
        return result.stdout.trim();
    }
    /**
     * Restart Traefik (usually not needed - auto-reloads)
     */
    async restartTraefik(serverId) {
        const client = await this.sshService.connect(serverId);
        await this.sshService.executeCommand(client, 'cd /opt/traefik && docker compose restart');
    }
    /**
     * Check if Traefik is installed
     */
    async isTraefikInstalled(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            const dockerResult = await this.sshService.executeCommand(client, '(command -v docker >/dev/null 2>&1 && docker ps -a --format "{{.Names}}|{{.Image}}" | grep -i "traefik") || true');
            if (dockerResult.stdout.trim().length > 0) {
                return true;
            }
            const processCheck = await this.sshService.executeCommand(client, 'ps aux | grep "[t]raefik" | head -n1');
            if (processCheck.stdout.trim().length > 0) {
                return true;
            }
            const serviceCheck = await this.sshService.executeCommand(client, 'systemctl is-active traefik 2>/dev/null || echo "INACTIVE"');
            // CRITICAL: "inactive".includes("active") === true, so check for exact match
            return serviceCheck.stdout.trim().split('\n').some(line => line.trim() === 'active');
        }
        catch {
            return false;
        }
    }
    /**
     * Get certificate information for a domain
     */
    async getCertificateInfo(serverId, domain) {
        try {
            const client = await this.sshService.connect(serverId);
            // Read acme.json and parse certificate info
            const result = await this.sshService.executeCommand(client, 'cat /opt/traefik/acme.json 2>/dev/null || echo "{}"');
            const stdout = result.stdout?.trim() || '{}';
            // Handle empty or invalid JSON
            if (!stdout || stdout === '' || stdout === '{}') {
                return { status: 'pending', message: 'Waiting for certificate generation' };
            }
            let acmeData;
            try {
                acmeData = JSON.parse(stdout);
            }
            catch (parseError) {
                console.warn('Failed to parse acme.json, may be empty or corrupted:', parseError);
                return { status: 'pending', message: 'Certificate file not ready' };
            }
            return this.parseCertificateData(acmeData, domain);
        }
        catch (error) {
            console.error('Error getting certificate info:', error);
            return { status: 'error', message: String(error) };
        }
    }
    /**
     * Parse certificate data from acme.json
     */
    parseCertificateData(acmeData, domain) {
        try {
            if (!acmeData.letsencrypt || !acmeData.letsencrypt.Certificates) {
                return { status: 'not_found' };
            }
            const certificates = acmeData.letsencrypt.Certificates;
            const cert = certificates.find((c) => c.domain?.main === domain || c.domain?.sans?.includes(domain));
            if (!cert) {
                return { status: 'not_found' };
            }
            // Parse certificate to get expiry date
            // The certificate data is in cert.certificate (base64 encoded)
            // For now, we'll return basic info
            return {
                status: 'active',
                domain: cert.domain?.main || domain,
                sans: cert.domain?.sans || [],
            };
        }
        catch (error) {
            console.error('Error parsing certificate data:', error);
            return { status: 'error', error: error?.message || 'Unknown error' };
        }
    }
    /**
     * Write content to a remote file
     */
    async writeRemoteFile(serverId, remotePath, content) {
        const client = await this.sshService.connect(serverId);
        const command = `cat > ${remotePath} << 'TRAEFIKEOF'
${content}
TRAEFIKEOF`;
        await this.sshService.executeCommand(client, command);
    }
    /**
     * Get Traefik dashboard URL
     */
    async getDashboardUrl(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, 'docker inspect traefik --format "{{.NetworkSettings.IPAddress}}"');
            const ip = result.stdout.trim();
            if (ip) {
                return `http://${ip}:8080/dashboard/`;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * Get Traefik logs
     */
    async getTraefikLogs(serverId, lines = 100) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, `docker logs traefik --tail ${lines}`);
            return result.stdout + result.stderr;
        }
        catch (error) {
            return `Error getting logs: ${error?.message || 'Unknown error'}`;
        }
    }
    /**
     * Get Traefik configuration including email
     */
    async getTraefikConfig(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, 'cat /opt/traefik/traefik.yml 2>/dev/null || echo ""');
            const configContent = result.stdout?.trim() || '';
            if (!configContent) {
                return { email: null, dashboardEnabled: false, httpRedirect: false };
            }
            // Parse email from YAML (simple regex extraction)
            const emailMatch = configContent.match(/email:\s*([^\s\n]+)/);
            const email = emailMatch ? emailMatch[1] : null;
            // Check if dashboard is enabled
            const dashboardEnabled = configContent.includes('dashboard: true');
            // Check if HTTP redirect is enabled
            const httpRedirect = configContent.includes('redirections:') && configContent.includes('to: websecure');
            return { email, dashboardEnabled, httpRedirect };
        }
        catch (error) {
            console.error('Error getting Traefik config:', error);
            return { email: null, dashboardEnabled: false, httpRedirect: false };
        }
    }
    /**
     * Update Traefik email configuration
     */
    async updateTraefikEmail(serverId, newEmail) {
        const client = await this.sshService.connect(serverId);
        // Read existing config
        const result = await this.sshService.executeCommand(client, 'cat /opt/traefik/traefik.yml');
        const configContent = result.stdout || '';
        // Replace email in the config
        const updatedConfig = configContent.replace(/email:\s*[^\s\n]+/, `email: ${newEmail}`);
        // Write updated config
        const writeCommand = `cat > /opt/traefik/traefik.yml << 'TRAEFIKEOF'
${updatedConfig}
TRAEFIKEOF`;
        await this.sshService.executeCommand(client, writeCommand);
        // Restart Traefik to apply changes
        await this.restartTraefik(serverId);
    }
    /**
     * Remove global HTTP-to-HTTPS redirect from Traefik config
     * This allows per-domain Force HTTPS settings to work correctly
     */
    async removeGlobalHttpRedirect(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            // Read existing config
            const result = await this.sshService.executeCommand(client, 'cat /opt/traefik/traefik.yml');
            const configContent = result.stdout || '';
            // Check if redirect is present
            if (!configContent.includes('redirections:') || !configContent.includes('to: websecure')) {
                console.log('[TraefikService] No global HTTP redirect found in config');
                return false;
            }
            // Remove the redirections block from web entrypoint
            // The block looks like:
            //   web:
            //     address: ":80"
            //     http:
            //       redirections:
            //         entryPoint:
            //           to: websecure
            //           scheme: https
            const updatedConfig = configContent.replace(/(\s+web:\s+address:\s*":80")\s+http:\s+redirections:\s+entryPoint:\s+to:\s*websecure\s+scheme:\s*https/, '$1');
            // Verify the replacement worked
            if (updatedConfig === configContent) {
                console.warn('[TraefikService] Failed to remove redirect block - pattern not matched');
                return false;
            }
            console.log('[TraefikService] Removing global HTTP redirect from Traefik config');
            // Write updated config
            const writeCommand = `cat > /opt/traefik/traefik.yml << 'TRAEFIKEOF'
${updatedConfig}
TRAEFIKEOF`;
            await this.sshService.executeCommand(client, writeCommand);
            // Restart Traefik to apply changes
            await this.restartTraefik(serverId);
            console.log('[TraefikService] Global HTTP redirect removed successfully');
            return true;
        }
        catch (error) {
            console.error('[TraefikService] Error removing global HTTP redirect:', error);
            throw error;
        }
    }
    /**
     * Delete SSL certificate for a domain from acme.json
     * Removes the certificate entry and writes the updated acme.json
     */
    async deleteCertificate(serverId, domain) {
        try {
            const client = await this.sshService.connect(serverId);
            // Read acme.json
            const result = await this.sshService.executeCommand(client, 'cat /opt/traefik/acme.json 2>/dev/null || echo "{}"');
            const stdout = result.stdout?.trim() || '{}';
            // Handle empty or invalid JSON
            if (!stdout || stdout === '' || stdout === '{}') {
                console.log('No certificates found in acme.json');
                return;
            }
            let acmeData;
            try {
                acmeData = JSON.parse(stdout);
            }
            catch (parseError) {
                console.warn('Failed to parse acme.json:', parseError);
                return;
            }
            // Check if letsencrypt resolver exists and has certificates
            if (!acmeData.letsencrypt || !acmeData.letsencrypt.Certificates) {
                console.log('No certificates found for letsencrypt resolver');
                return;
            }
            const certificates = acmeData.letsencrypt.Certificates;
            const originalLength = certificates.length;
            // Filter out certificates for this domain
            acmeData.letsencrypt.Certificates = certificates.filter((cert) => {
                const mainDomain = cert.domain?.main;
                const sans = cert.domain?.sans || [];
                // Remove if the main domain matches or if domain is in SANs
                return mainDomain !== domain && !sans.includes(domain);
            });
            const newLength = acmeData.letsencrypt.Certificates.length;
            // Only write back if we actually removed something
            if (originalLength === newLength) {
                console.log(`No certificate found for domain: ${domain}`);
                return;
            }
            console.log(`Removed ${originalLength - newLength} certificate(s) for domain: ${domain}`);
            // Write updated acme.json back
            const updatedAcmeJson = JSON.stringify(acmeData, null, 2);
            const writeCommand = `cat > /opt/traefik/acme.json << 'ACMEEOF'
${updatedAcmeJson}
ACMEEOF`;
            await this.sshService.executeCommand(client, writeCommand);
            // Ensure correct permissions
            await this.sshService.executeCommand(client, 'chmod 600 /opt/traefik/acme.json');
            console.log(`Successfully deleted certificate for domain: ${domain}`);
        }
        catch (error) {
            console.error('Error deleting certificate:', error);
            throw new Error(`Failed to delete certificate: ${error?.message || 'Unknown error'}`);
        }
    }
    /**
     * Ensure Traefik has file provider enabled for zero-downtime deployment
     * This is required for instant traffic switching via dynamic config files.
     *
     * Returns true if file provider was already enabled or was successfully added.
     * The file provider watches /etc/traefik/dynamic and auto-reloads on changes.
     */
    async ensureFileProviderEnabled(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            // Check if file provider is already configured
            const result = await this.sshService.executeCommand(client, 'grep -q "file:" /opt/traefik/traefik.yml && echo "yes" || echo "no"');
            if (result.stdout.trim() === 'yes') {
                return true; // Already configured
            }
            console.log('File provider not configured, updating Traefik config...');
            // Get current email from config
            const config = await this.getTraefikConfig(serverId);
            if (!config.email) {
                throw new Error('Cannot migrate Traefik config: email not found');
            }
            // Rewrite config with file provider
            await this.writeTraefikConfigWithFileProvider(serverId, config.email);
            // Restart Traefik to apply (file provider requires restart to add)
            await this.restartTraefik(serverId);
            // Wait for Traefik to be ready
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Verify Traefik is running
            const isRunning = await this.verifyTraefikRunning(serverId);
            if (!isRunning) {
                throw new Error('Traefik failed to restart after config update');
            }
            console.log('File provider enabled successfully');
            return true;
        }
        catch (error) {
            console.error('Error enabling file provider:', error);
            throw error;
        }
    }
    /**
     * Generate Traefik static configuration WITH file provider
     * Used when enabling zero-downtime deployment
     */
    async writeTraefikConfigWithFileProvider(serverId, email) {
        // NOTE: Do NOT add global HTTP-to-HTTPS redirect at entrypoint level
        // Per-domain redirects are handled via the redirect-to-https middleware on each domain's HTTP router
        // This allows Force HTTPS to be toggled per-domain
        const config = `api:
  dashboard: true
  insecure: true

entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: traefik-public
  file:
    directory: "/etc/traefik/dynamic"
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: ${email}
      storage: /acme.json
      httpChallenge:
        entryPoint: web

log:
  level: INFO
`;
        await this.writeRemoteFile(serverId, '/opt/traefik/traefik.yml', config);
    }
    /**
     * Check if file provider is enabled
     */
    async isFileProviderEnabled(serverId) {
        try {
            const client = await this.sshService.connect(serverId);
            const result = await this.sshService.executeCommand(client, 'grep -q "file:" /opt/traefik/traefik.yml && echo "yes" || echo "no"');
            return result.stdout.trim() === 'yes';
        }
        catch {
            return false;
        }
    }
}
exports.TraefikService = TraefikService;
//# sourceMappingURL=TraefikService.js.map