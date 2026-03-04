"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReverseProxyDetector = void 0;
/**
 * Detects existing reverse proxy installations on a remote server
 * Checks for: Nginx, Caddy, Traefik, Apache
 */
class ReverseProxyDetector {
    /**
     * Comprehensive detection of reverse proxies on the server
     */
    static async detect(sshClient) {
        const proxies = [];
        // Run all detection methods in parallel
        const [nginxInfo, caddyInfo, traefikInfo, apacheInfo, dockerProxies, portListeners, httpHeaders,] = await Promise.all([
            this.detectNginx(sshClient),
            this.detectCaddy(sshClient),
            this.detectTraefik(sshClient),
            this.detectApache(sshClient),
            this.detectDockerProxies(sshClient),
            this.detectPortListeners(sshClient),
            this.detectViaHttpHeaders(sshClient),
        ]);
        // Collect all detected proxies
        if (nginxInfo.detected)
            proxies.push(nginxInfo);
        if (caddyInfo.detected)
            proxies.push(caddyInfo);
        if (traefikInfo.detected)
            proxies.push(traefikInfo);
        if (apacheInfo.detected)
            proxies.push(apacheInfo);
        // Add Docker-detected proxies (avoid duplicates, prefer active containers over config-only hits)
        dockerProxies.forEach(dockerProxy => {
            const existingIndex = proxies.findIndex(p => p.name === dockerProxy.name);
            if (existingIndex === -1) {
                proxies.push(dockerProxy);
            }
            else if (proxies[existingIndex].detectionMethod === 'config_dir') {
                proxies[existingIndex] = dockerProxy;
            }
        });
        // Add port listener detections (captures port 80/443 conflicts)
        portListeners.forEach(portProxy => {
            const existingIndex = proxies.findIndex(p => p.name === portProxy.name);
            if (existingIndex === -1) {
                proxies.push(portProxy);
            }
            else if (proxies[existingIndex].detectionMethod === 'config_dir') {
                proxies[existingIndex] = portProxy;
            }
        });
        // Add HTTP header detection if no other method found it, or upgrade config-only hits
        if (httpHeaders.detected) {
            const existingIndex = proxies.findIndex(p => p.name === httpHeaders.name);
            if (existingIndex === -1) {
                proxies.push(httpHeaders);
            }
            else if (proxies[existingIndex].detectionMethod === 'config_dir') {
                proxies[existingIndex] = httpHeaders;
            }
        }
        const hasReverseProxy = proxies.length > 0;
        const recommendations = this.generateRecommendations(proxies);
        return {
            hasReverseProxy,
            proxies,
            recommendations,
        };
    }
    /**
     * Detect Nginx via running processes and active services
     * Falls back to config directory presence to flag installed-but-stopped instances
     */
    static async detectNginx(sshClient) {
        const result = {
            name: 'nginx',
            detected: false,
            detectionMethod: '',
            details: '',
        };
        try {
            // PRIORITY 1: Check running processes (most reliable)
            const processCheck = await this.execCommand(sshClient, 'ps aux | grep "[n]ginx: master process" | head -n1');
            if (processCheck && processCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'process';
                result.details = 'Nginx master process is running';
                // Try to get version
                const versionCheck = await this.execCommand(sshClient, 'nginx -v 2>&1 | head -n1');
                if (versionCheck && !versionCheck.includes('command not found')) {
                    result.details += ` - ${versionCheck.trim()}`;
                }
                return result;
            }
            // PRIORITY 2: Check systemd service status
            // CRITICAL: systemctl is-active returns "inactive" when stopped.
            // "inactive".includes("active") === true, so we must check for exact "active" match.
            const serviceCheck = await this.execCommand(sshClient, 'systemctl is-active nginx 2>/dev/null || echo "INACTIVE"');
            if (serviceCheck.trim().split('\n').some(line => line.trim() === 'active')) {
                result.detected = true;
                result.detectionMethod = 'systemd_service';
                result.details = 'Nginx service is active';
                return result;
            }
            // PRIORITY 3: Network listeners (captures running instances even if process grep misses)
            const netstatCheck = await this.execCommand(sshClient, 'command -v ss >/dev/null 2>&1 && ss -tulpn 2>/dev/null | grep -Ei "nginx|openresty" || netstat -tulpn 2>/dev/null | grep -Ei "nginx|openresty" || echo ""');
            if (netstatCheck && netstatCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'network_port';
                result.details = `Nginx listening:\n${netstatCheck.trim()}`;
                return result;
            }
            // FALLBACK: Config directory presence (installed but not running)
            const configCheck = await this.execCommand(sshClient, 'for dir in /etc/nginx /etc/nginx/sites-enabled; do [ -d "$dir" ] && echo "$dir"; done');
            if (configCheck && configCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'config_dir';
                result.details = `Nginx config found at ${configCheck.trim().replace(/\n/g, ', ')}`;
                return result;
            }
        }
        catch (error) {
            console.error('Error detecting Nginx:', error);
        }
        return result;
    }
    /**
     * Detect Caddy via running processes and active services
     * Falls back to config directory presence to flag installed-but-stopped instances
     */
    static async detectCaddy(sshClient) {
        const result = {
            name: 'caddy',
            detected: false,
            detectionMethod: '',
            details: '',
        };
        try {
            // PRIORITY 1: Check running processes (most reliable)
            const processCheck = await this.execCommand(sshClient, 'ps aux | grep "[c]addy run" | head -n1');
            if (processCheck && processCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'process';
                result.details = 'Caddy process is running';
                // Try to get version
                const versionCheck = await this.execCommand(sshClient, 'caddy version 2>&1 | head -n1');
                if (versionCheck && !versionCheck.includes('command not found')) {
                    result.details += ` - ${versionCheck.trim()}`;
                }
                return result;
            }
            // PRIORITY 2: Check systemd service status
            const serviceCheck = await this.execCommand(sshClient, 'systemctl is-active caddy 2>/dev/null || echo "INACTIVE"');
            if (serviceCheck.trim().split('\n').some(line => line.trim() === 'active')) {
                result.detected = true;
                result.detectionMethod = 'systemd_service';
                result.details = 'Caddy service is active';
                return result;
            }
            // PRIORITY 3: Network listeners (captures running instances even if process grep misses)
            const netstatCheck = await this.execCommand(sshClient, 'command -v ss >/dev/null 2>&1 && ss -tulpn 2>/dev/null | grep -Ei "caddy" || netstat -tulpn 2>/dev/null | grep -Ei "caddy" || echo ""');
            if (netstatCheck && netstatCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'network_port';
                result.details = `Caddy listening:\n${netstatCheck.trim()}`;
                return result;
            }
            // FALLBACK: Config directory presence (installed but not running)
            const configCheck = await this.execCommand(sshClient, 'for path in /etc/caddy /etc/caddy/Caddyfile /var/lib/caddy/.local/share/caddy /var/lib/caddy/.local/share/caddy/config; do [ -e "$path" ] && echo "$path"; done');
            if (configCheck && configCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'config_dir';
                result.details = `Caddy config found at ${configCheck.trim().replace(/\n/g, ', ')}`;
                return result;
            }
        }
        catch (error) {
            console.error('Error detecting Caddy:', error);
        }
        return result;
    }
    /**
     * Detect Traefik via running processes and active services
     * Falls back to config presence to flag installed-but-stopped instances
     */
    static async detectTraefik(sshClient) {
        const result = {
            name: 'traefik',
            detected: false,
            detectionMethod: '',
            details: '',
        };
        try {
            // PRIORITY 1: Check running processes (most reliable)
            const processCheck = await this.execCommand(sshClient, 'ps aux | grep "[t]raefik" | head -n1');
            if (processCheck && processCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'process';
                result.details = 'Traefik process is running';
                return result;
            }
            // PRIORITY 2: Check systemd service status
            const serviceCheck = await this.execCommand(sshClient, 'systemctl is-active traefik 2>/dev/null || echo "INACTIVE"');
            if (serviceCheck.trim().split('\n').some(line => line.trim() === 'active')) {
                result.detected = true;
                result.detectionMethod = 'systemd_service';
                result.details = 'Traefik service is active';
                return result;
            }
            // PRIORITY 3: Network listeners (captures running instances even if process grep misses)
            const netstatCheck = await this.execCommand(sshClient, 'command -v ss >/dev/null 2>&1 && ss -tulpn 2>/dev/null | grep -Ei "traefik" || netstat -tulpn 2>/dev/null | grep -Ei "traefik" || echo ""');
            if (netstatCheck && netstatCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'network_port';
                result.details = `Traefik listening:\n${netstatCheck.trim()}`;
                return result;
            }
            // FALLBACK: Config presence (installed but not running)
            // Include /opt/traefik where ServerCompass installs Traefik
            const configCheck = await this.execCommand(sshClient, 'for path in /etc/traefik /etc/traefik/traefik.yml /etc/traefik/traefik.toml /opt/traefik /opt/traefik/traefik.yml ~/traefik.yml; do [ -e "$path" ] && echo "$path"; done');
            if (configCheck && configCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'config_dir';
                result.details = `Traefik config found at ${configCheck.trim().replace(/\n/g, ', ')}`;
                return result;
            }
        }
        catch (error) {
            console.error('Error detecting Traefik:', error);
        }
        return result;
    }
    /**
     * Detect Apache via running processes and active services
     * Falls back to config directory presence to flag installed-but-stopped instances
     */
    static async detectApache(sshClient) {
        const result = {
            name: 'apache',
            detected: false,
            detectionMethod: '',
            details: '',
        };
        try {
            // PRIORITY 1: Check running processes (most reliable)
            const processCheck = await this.execCommand(sshClient, 'ps aux | grep -E "[a]pache2|[h]ttpd" | grep -v grep | head -n1');
            if (processCheck && processCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'process';
                result.details = 'Apache/httpd process is running';
                // Try to get version
                const versionCheck = await this.execCommand(sshClient, 'apache2 -v 2>&1 | head -n1 || httpd -v 2>&1 | head -n1');
                if (versionCheck && !versionCheck.includes('command not found')) {
                    result.details += ` - ${versionCheck.trim()}`;
                }
                return result;
            }
            // PRIORITY 2: Check systemd service status
            const serviceCheck = await this.execCommand(sshClient, 'systemctl is-active apache2 2>/dev/null || systemctl is-active httpd 2>/dev/null || echo "INACTIVE"');
            if (serviceCheck.trim().split('\n').some(line => line.trim() === 'active')) {
                result.detected = true;
                result.detectionMethod = 'systemd_service';
                result.details = 'Apache service is active';
                return result;
            }
            // PRIORITY 3: Network listeners (captures running instances even if process grep misses)
            const netstatCheck = await this.execCommand(sshClient, 'command -v ss >/dev/null 2>&1 && ss -tulpn 2>/dev/null | grep -Ei "apache2|httpd" || netstat -tulpn 2>/dev/null | grep -Ei "apache2|httpd" || echo ""');
            if (netstatCheck && netstatCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'network_port';
                result.details = `Apache listening:\n${netstatCheck.trim()}`;
                return result;
            }
            // FALLBACK: Config directory presence (installed but not running)
            const configCheck = await this.execCommand(sshClient, 'for dir in /etc/apache2 /etc/httpd; do [ -d "$dir" ] && echo "$dir"; done');
            if (configCheck && configCheck.trim().length > 0) {
                result.detected = true;
                result.detectionMethod = 'config_dir';
                result.details = `Apache config found at ${configCheck.trim().replace(/\n/g, ', ')}`;
                return result;
            }
        }
        catch (error) {
            console.error('Error detecting Apache:', error);
        }
        return result;
    }
    /**
     * Detect reverse proxies running in Docker containers
     */
    static async detectDockerProxies(sshClient) {
        const proxies = [];
        try {
            // Check if Docker is available
            const dockerCheck = await this.execCommand(sshClient, 'command -v docker >/dev/null 2>&1 && echo "AVAILABLE" || echo "NOT_AVAILABLE"');
            if (!dockerCheck.includes('AVAILABLE')) {
                return proxies;
            }
            // Get running containers with proxy images
            const containersCheck = await this.execCommand(sshClient, 'docker ps --format "{{.Names}}|{{.Image}}" 2>/dev/null | grep -Ei "traefik|caddy|nginx|apache|httpd" || echo ""');
            if (containersCheck && containersCheck.trim().length > 0) {
                const lines = containersCheck.trim().split('\n');
                for (const line of lines) {
                    const [containerName, image] = line.split('|');
                    if (image.toLowerCase().includes('traefik')) {
                        proxies.push({
                            name: 'traefik',
                            detected: true,
                            detectionMethod: 'docker_container',
                            details: `Container: ${containerName} (${image})`,
                        });
                    }
                    else if (image.toLowerCase().includes('caddy')) {
                        proxies.push({
                            name: 'caddy',
                            detected: true,
                            detectionMethod: 'docker_container',
                            details: `Container: ${containerName} (${image})`,
                        });
                    }
                    else if (image.toLowerCase().includes('nginx')) {
                        proxies.push({
                            name: 'nginx',
                            detected: true,
                            detectionMethod: 'docker_container',
                            details: `Container: ${containerName} (${image})`,
                        });
                    }
                    else if (image.toLowerCase().includes('apache') || image.toLowerCase().includes('httpd')) {
                        proxies.push({
                            name: 'apache',
                            detected: true,
                            detectionMethod: 'docker_container',
                            details: `Container: ${containerName} (${image})`,
                        });
                    }
                }
            }
        }
        catch (error) {
            console.error('Error detecting Docker proxies:', error);
        }
        return proxies;
    }
    /**
     * Detect listeners on ports 80 and 443 to catch running proxies occupying standard HTTP/HTTPS ports
     * Handles both tcp and tcp6 (IPv4 and IPv6) connections
     */
    static async detectPortListeners(sshClient) {
        const proxies = [];
        try {
            // Use grep to match both tcp and tcp6 on ports 80/443 (IPv4 and IPv6)
            const portCheck = await this.execCommand(sshClient, '(command -v ss >/dev/null 2>&1 && ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null) | grep -E "^tcp6?\\s+.*:(80|443)\\b" || echo ""');
            if (!portCheck || portCheck.trim().length === 0) {
                return proxies;
            }
            const lower = portCheck.toLowerCase();
            const hasDockerProxy = lower.includes('docker-proxy');
            const pushProxy = (name, detailsOverride) => {
                // Avoid duplicates within this detection pass
                if (proxies.some(p => p.name === name))
                    return;
                const detailsLines = (detailsOverride ??
                    portCheck
                        .split('\n')
                        .filter(line => line.toLowerCase().includes(name))
                        .join('\n')
                        .trim());
                proxies.push({
                    name,
                    detected: true,
                    detectionMethod: 'port_listener',
                    details: detailsLines.length > 0 ? detailsLines : `Ports 80/443 in use (matched ${name})`,
                });
            };
            // Check for known reverse proxies in the netstat/ss output
            if (lower.includes('traefik'))
                pushProxy('traefik');
            if (lower.includes('nginx') || lower.includes('openresty'))
                pushProxy('nginx');
            if (lower.includes('caddy'))
                pushProxy('caddy');
            if (lower.includes('apache') || lower.includes('httpd'))
                pushProxy('apache');
            // If docker-proxy is detected check Docker containers for the real proxy
            if (hasDockerProxy) {
                const dockerProxies = await this.detectDockerProxyServices(sshClient);
                dockerProxies.forEach(proxy => {
                    const alreadyPresent = proxies.some(existing => existing.name === proxy.name && existing.detectionMethod === proxy.detectionMethod);
                    if (!alreadyPresent) {
                        proxies.push(proxy);
                    }
                });
                // If docker-proxy is present but we could not map it to a known proxy, surface it explicitly
                if (dockerProxies.length === 0) {
                    const dockerProxyLines = portCheck
                        .split('\n')
                        .filter(line => line.toLowerCase().includes('docker-proxy'))
                        .join('\n')
                        .trim();
                    pushProxy('docker-proxy', dockerProxyLines.length > 0 ? dockerProxyLines : undefined);
                }
            }
            // If ports are occupied but still no proxy matched, add an unknown entry so UI can warn
            if (proxies.length === 0) {
                proxies.push({
                    name: 'unknown',
                    detected: true,
                    detectionMethod: 'port_listener',
                    details: `Ports 80/443 in use:\n${portCheck.trim()}`,
                });
            }
        }
        catch (error) {
            console.error('Error detecting port listeners:', error);
        }
        return proxies;
    }
    /**
     * When docker-proxy is detected on ports 80/443, check which reverse proxy containers are actually running
     */
    static async detectDockerProxyServices(sshClient) {
        const proxies = [];
        try {
            const dockerAvailable = await this.execCommand(sshClient, 'command -v docker >/dev/null 2>&1 && echo "AVAILABLE" || echo "NOT_AVAILABLE"');
            if (!dockerAvailable.includes('AVAILABLE')) {
                return proxies;
            }
            // Check for containers exposing ports 80 or 443
            const dockerCheck = await this.execCommand(sshClient, 'docker ps --format "{{.Names}}|{{.Image}}|{{.Ports}}" 2>/dev/null | grep -E ":(80|443)->" || echo ""');
            if (!dockerCheck || dockerCheck.trim().length === 0) {
                return proxies;
            }
            const lines = dockerCheck.trim().split('\n');
            for (const line of lines) {
                const [containerName, image, ports] = line.split('|');
                const lowerImage = image.toLowerCase();
                const lowerName = containerName.toLowerCase();
                const signature = `${lowerName} ${lowerImage}`;
                // Check which reverse proxy is in the container
                if (signature.includes('traefik')) {
                    proxies.push({
                        name: 'traefik',
                        detected: true,
                        detectionMethod: 'docker_container',
                        details: `Container: ${containerName} (${image}) - Ports: ${ports}`,
                    });
                }
                else if (signature.includes('caddy')) {
                    proxies.push({
                        name: 'caddy',
                        detected: true,
                        detectionMethod: 'docker_container',
                        details: `Container: ${containerName} (${image}) - Ports: ${ports}`,
                    });
                }
                else if (signature.includes('nginx')) {
                    proxies.push({
                        name: 'nginx',
                        detected: true,
                        detectionMethod: 'docker_container',
                        details: `Container: ${containerName} (${image}) - Ports: ${ports}`,
                    });
                }
                else if (signature.includes('apache') || signature.includes('httpd')) {
                    proxies.push({
                        name: 'apache',
                        detected: true,
                        detectionMethod: 'docker_container',
                        details: `Container: ${containerName} (${image}) - Ports: ${ports}`,
                    });
                }
            }
            // If we found containers on 80/443 but none matched known proxies
            if (proxies.length === 0) {
                proxies.push({
                    name: 'docker-proxy',
                    detected: true,
                    detectionMethod: 'docker_container',
                    details: `Docker containers using ports 80/443:\n${dockerCheck.trim()}`,
                });
            }
        }
        catch (error) {
            console.error('Error detecting Docker proxy services:', error);
        }
        return proxies;
    }
    /**
     * Detect reverse proxy via HTTP headers
     */
    static async detectViaHttpHeaders(sshClient) {
        const result = {
            name: 'unknown',
            detected: false,
            detectionMethod: 'http_header',
            details: '',
        };
        try {
            const targets = [
                'http://localhost',
                'http://localhost:8080', // common Traefik/Caddy dashboards
            ];
            for (const target of targets) {
                const headerCheck = await this.execCommand(sshClient, `curl -s -I ${target} 2>/dev/null | grep -i "^server:" | head -n1 || echo ""`);
                if (!headerCheck || headerCheck.trim().length === 0) {
                    continue;
                }
                const serverHeader = headerCheck.trim();
                const lowerHeader = serverHeader.toLowerCase();
                result.details = `${serverHeader} (${target})`;
                if (lowerHeader.includes('nginx') || lowerHeader.includes('openresty')) {
                    result.name = 'nginx';
                    result.detected = true;
                }
                else if (lowerHeader.includes('caddy')) {
                    result.name = 'caddy';
                    result.detected = true;
                }
                else if (lowerHeader.includes('traefik')) {
                    result.name = 'traefik';
                    result.detected = true;
                }
                else if (lowerHeader.includes('apache') || lowerHeader.includes('httpd')) {
                    result.name = 'apache';
                    result.detected = true;
                }
                else {
                    // Avoid false positives for non-proxy HTTP servers (Express, Django, etc.)
                    result.details = `HTTP server header present but no known reverse proxy signature (${serverHeader} at ${target})`;
                }
                break;
            }
        }
        catch (error) {
            console.error('Error detecting via HTTP headers:', error);
        }
        return result;
    }
    /**
     * Generate user-friendly recommendations based on detected proxies
     */
    static generateRecommendations(proxies) {
        const recommendations = [];
        if (proxies.length === 0) {
            recommendations.push('No reverse proxy detected. Traefik can be installed safely.');
            return recommendations;
        }
        const activeTraefik = proxies.some(p => p.name === 'traefik' &&
            p.detected &&
            p.detectionMethod !== 'config_dir');
        const hasTraefikConfigOnly = proxies.some(p => p.name === 'traefik' && p.detectionMethod === 'config_dir');
        const otherProxies = proxies.filter(p => p.name !== 'traefik');
        const proxyNames = otherProxies
            .map(p => p.name)
            .filter((name, index, self) => self.indexOf(name) === index);
        // Traefik running with no other reverse proxies
        if (proxyNames.length === 0 && activeTraefik) {
            recommendations.push('Traefik detected and ready for automatic domain management.');
            return recommendations;
        }
        // Traefik running alongside other proxies
        if (proxyNames.length > 0 && activeTraefik) {
            recommendations.push(`Traefik is running, but other reverse proxies are also active: ${proxyNames.join(', ')}.`, 'Traefik can manage domains, but consider disabling other proxies to avoid port conflicts on ports 80 and 443.');
            return recommendations;
        }
        // Traefik config found but not running
        if (!activeTraefik && hasTraefikConfigOnly) {
            if (proxyNames.length === 0) {
                recommendations.push('Traefik configuration found, but Traefik is not running. Start Traefik to enable automatic domain management.');
            }
            else {
                recommendations.push(`Traefik configuration found, but Traefik is not running. Other reverse proxies detected: ${proxyNames.join(', ')}.`, 'Start Traefik or disable other proxies to avoid conflicts on ports 80 and 443.');
            }
            return recommendations;
        }
        if (proxyNames.length === 1) {
            const proxyName = proxyNames[0];
            recommendations.push(`You already have ${proxyName} installed and managing your domains.`, `Server Compass automatic domain management requires Traefik.`, `You'll need to configure domains manually in your ${proxyName} configuration files.`);
        }
        else {
            recommendations.push(`Multiple reverse proxies detected: ${proxyNames.join(', ')}.`, `This may cause port conflicts on ports 80 and 443.`, `Consider using only one reverse proxy to avoid conflicts.`);
        }
        return recommendations;
    }
    /**
     * Helper: Execute command via SSH and return output
     */
    static execCommand(sshClient, command) {
        return new Promise((resolve, reject) => {
            sshClient.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                let output = '';
                let errorOutput = '';
                stream.on('data', (data) => {
                    output += data.toString();
                });
                stream.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });
                stream.on('close', (code) => {
                    if (code !== 0 && output.length === 0) {
                        resolve(errorOutput);
                    }
                    else {
                        resolve(output);
                    }
                });
            });
        });
    }
}
exports.ReverseProxyDetector = ReverseProxyDetector;
//# sourceMappingURL=ReverseProxyDetector.js.map