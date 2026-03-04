"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainService = void 0;
const SSHService_1 = require("./SSHService");
class DomainService {
    /**
     * Configure domain with Nginx and SSL
     */
    async configureDomain(input) {
        const { serverId, domain, appName, port, ssl } = input;
        // Write shared proxy configuration
        await this.writeProxyConfig(serverId);
        // Write site-specific Nginx config
        await this.writeSiteConfig(serverId, domain, appName, port);
        // Test Nginx configuration
        const testResult = await SSHService_1.sshService.executeCommand(serverId, 'nginx -t');
        if (testResult.exitCode !== 0) {
            throw new Error(`Nginx configuration test failed: ${testResult.stderr}`);
        }
        // Reload Nginx
        await SSHService_1.sshService.executeCommand(serverId, 'systemctl reload nginx');
        // Configure SSL if requested
        if (ssl) {
            await this.configureSSL(serverId, domain);
        }
    }
    async writeProxyConfig(serverId) {
        const proxyConfig = `
# Proxy buffer settings
proxy_buffers 32 4m;
proxy_busy_buffers_size 25m;
proxy_buffer_size 512k;
proxy_ignore_headers "Cache-Control" "Expires";
proxy_max_temp_file_size 0;

# Proxy headers
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_set_header Connection "";

# Client settings
client_max_body_size 1024m;
client_body_buffer_size 4m;

# Timeouts
proxy_connect_timeout 300;
proxy_read_timeout 300;
proxy_send_timeout 300;
proxy_intercept_errors off;
`;
        await SSHService_1.sshService.executeCommand(serverId, `
      cat > /etc/nginx/conf.d/proxy.conf << 'EOF'
${proxyConfig}
EOF
    `);
    }
    async writeSiteConfig(serverId, domain, appName, port) {
        const siteConfig = `
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        include /etc/nginx/conf.d/proxy.conf;
    }
}
`;
        await SSHService_1.sshService.executeCommand(serverId, `
      cat > /etc/nginx/sites-available/${appName}.conf << 'EOF'
${siteConfig}
EOF
      ln -sf /etc/nginx/sites-available/${appName}.conf /etc/nginx/sites-enabled/
    `);
    }
    async configureSSL(serverId, domain) {
        // Install Certbot
        await SSHService_1.sshService.executeCommand(serverId, `
      apt-get update -qq
      apt-get install -y -qq certbot python3-certbot-nginx
    `);
        // Kill any stuck certbot processes before running certbot
        await SSHService_1.sshService.executeCommand(serverId, `
      ps aux | grep -E '[c]ertbot' | awk '{print $2}' | xargs -r sudo kill -9 2>/dev/null || true
    `);
        // Try Nginx plugin first
        const nginxResult = await SSHService_1.sshService.executeCommand(serverId, `certbot --nginx -d ${domain} --non-interactive --agree-tos --email admin@${domain}`);
        if (nginxResult.exitCode !== 0) {
            // Fallback to standalone mode
            await SSHService_1.sshService.executeCommand(serverId, 'systemctl stop nginx');
            await SSHService_1.sshService.executeCommand(serverId, `certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email admin@${domain}`);
            await SSHService_1.sshService.executeCommand(serverId, 'systemctl start nginx');
        }
        // Verify certificate
        const verifyResult = await SSHService_1.sshService.executeCommand(serverId, `test -d /etc/letsencrypt/live/${domain} && echo "Certificate found"`);
        if (verifyResult.exitCode !== 0 || !verifyResult.stdout.includes('Certificate found')) {
            throw new Error('SSL certificate verification failed');
        }
    }
}
exports.DomainService = DomainService;
//# sourceMappingURL=DomainService.js.map