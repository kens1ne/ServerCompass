"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraefikLabelGenerator = void 0;
class TraefikLabelGenerator {
    /**
     * Generate Traefik labels for a service
     * Returns array of Docker labels
     */
    generateLabels(config) {
        const labels = [];
        const { routerName, domain, port, ssl, httpsRedirect, wwwRedirect } = config;
        // Enable Traefik
        labels.push('traefik.enable=true');
        // Network
        labels.push('traefik.docker.network=traefik-public');
        // Collect all middlewares for the main router
        const mainMiddlewares = [];
        // Add security middlewares
        if (config.securityHeaders) {
            const hasAnySecurityHeader = config.securityHeaders.hstsEnabled ||
                config.securityHeaders.xFrameOptions ||
                config.securityHeaders.xContentTypeOptions ||
                config.securityHeaders.referrerPolicy ||
                config.securityHeaders.contentSecurityPolicy;
            if (hasAnySecurityHeader) {
                labels.push(...this.generateSecurityHeaderLabels(routerName, config.securityHeaders));
                mainMiddlewares.push(`${routerName}-security-headers`);
            }
        }
        // Add basic auth middleware
        if (config.basicAuthEnabled && config.basicAuthUsers && config.basicAuthUsers.length > 0) {
            labels.push(...this.generateBasicAuthLabels(routerName, config.basicAuthUsers));
            mainMiddlewares.push(`${routerName}-basic-auth`);
        }
        // Add IP whitelist middleware
        if (config.ipWhitelistEnabled && config.ipWhitelist && config.ipWhitelist.length > 0) {
            labels.push(...this.generateIpWhitelistLabels(routerName, config.ipWhitelist));
            mainMiddlewares.push(`${routerName}-ip-whitelist`);
        }
        // Add rate limit middleware
        if (config.rateLimitEnabled) {
            labels.push(...this.generateRateLimitLabels(routerName, config.rateLimitAverage || 100, config.rateLimitBurst || 50));
            mainMiddlewares.push(`${routerName}-rate-limit`);
        }
        // Add any additional middlewares from config
        if (config.middlewares && config.middlewares.length > 0) {
            mainMiddlewares.push(...config.middlewares);
        }
        if (ssl) {
            // HTTPS Router
            labels.push(`traefik.http.routers.${routerName}.rule=Host(\`${domain}\`)`, `traefik.http.routers.${routerName}.entrypoints=websecure`, `traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`, `traefik.http.services.${routerName}.loadbalancer.server.port=${port}`);
            // Apply all middlewares to the main router
            if (mainMiddlewares.length > 0) {
                labels.push(`traefik.http.routers.${routerName}.middlewares=${mainMiddlewares.join(',')}`);
            }
            if (httpsRedirect) {
                // HTTP to HTTPS redirect
                labels.push(`traefik.http.routers.${routerName}-http.rule=Host(\`${domain}\`)`, `traefik.http.routers.${routerName}-http.entrypoints=web`, `traefik.http.routers.${routerName}-http.middlewares=redirect-to-https`);
                // Define the redirect middleware if it doesn't exist
                labels.push('traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https', 'traefik.http.middlewares.redirect-to-https.redirectscheme.permanent=true');
            }
            else {
                // HTTP router without redirect - serve HTTP traffic directly
                // This allows accessing the site via http:// when Force HTTPS is disabled
                labels.push(`traefik.http.routers.${routerName}-http.rule=Host(\`${domain}\`)`, `traefik.http.routers.${routerName}-http.entrypoints=web`, `traefik.http.routers.${routerName}-http.service=${routerName}`);
            }
        }
        else {
            // HTTP only
            labels.push(`traefik.http.routers.${routerName}.rule=Host(\`${domain}\`)`, `traefik.http.routers.${routerName}.entrypoints=web`, `traefik.http.services.${routerName}.loadbalancer.server.port=${port}`);
            // Apply all middlewares to the main router
            if (mainMiddlewares.length > 0) {
                labels.push(`traefik.http.routers.${routerName}.middlewares=${mainMiddlewares.join(',')}`);
            }
        }
        // WWW redirect (if enabled)
        if (wwwRedirect && this.shouldAddWwwRedirect(domain)) {
            labels.push(...this.generateWwwRedirectLabels(routerName, domain, ssl));
        }
        // Custom headers
        if (config.customHeaders) {
            labels.push(...this.generateCustomHeaderLabels(routerName, config.customHeaders));
        }
        return labels;
    }
    /**
     * Generate WWW redirect labels
     * Redirects www.domain.com -> domain.com
     *
     * For SSL enabled:
     * - https://www.domain.com -> https://domain.com (via www-redirect middleware)
     * - http://www.domain.com -> https://domain.com (via www-http-redirect middleware)
     *   Note: This combines www removal + HTTPS upgrade in one redirect for efficiency
     */
    generateWwwRedirectLabels(routerName, domain, ssl) {
        const wwwDomain = `www.${domain}`;
        const labels = [];
        if (ssl) {
            // HTTPS www redirect: https://www.domain.com -> https://domain.com
            // Note: Traefik redirectregex uses ${1} syntax for capture groups (not $1)
            // Docker Compose interprets ${} as variable interpolation, so we escape $ as $$
            // \$\${1} in TypeScript → $${1} in YAML → Docker Compose sees ${1} → Traefik gets ${1}
            labels.push(`traefik.http.routers.${routerName}-www.rule=Host(\`${wwwDomain}\`)`, `traefik.http.routers.${routerName}-www.entrypoints=websecure`, `traefik.http.routers.${routerName}-www.tls.certresolver=letsencrypt`, `traefik.http.routers.${routerName}-www.middlewares=${routerName}-www-redirect`, `traefik.http.routers.${routerName}-www.service=${routerName}`, `traefik.http.middlewares.${routerName}-www-redirect.redirectregex.regex=^https://www\\.(.*)`, `traefik.http.middlewares.${routerName}-www-redirect.redirectregex.replacement=https://\$\${1}`, `traefik.http.middlewares.${routerName}-www-redirect.redirectregex.permanent=true`);
            // HTTP www redirect: http://www.domain.com -> https://domain.com
            // Uses separate middleware because the regex must match http:// not https://
            // Also upgrades to HTTPS in the same redirect for efficiency
            labels.push(`traefik.http.routers.${routerName}-www-http.rule=Host(\`${wwwDomain}\`)`, `traefik.http.routers.${routerName}-www-http.entrypoints=web`, `traefik.http.routers.${routerName}-www-http.middlewares=${routerName}-www-http-redirect`, `traefik.http.routers.${routerName}-www-http.service=${routerName}`, `traefik.http.middlewares.${routerName}-www-http-redirect.redirectregex.regex=^http://www\\.(.*)`, `traefik.http.middlewares.${routerName}-www-http-redirect.redirectregex.replacement=https://\$\${1}`, `traefik.http.middlewares.${routerName}-www-http-redirect.redirectregex.permanent=true`);
        }
        else {
            // HTTP only www redirect: http://www.domain.com -> http://domain.com
            labels.push(`traefik.http.routers.${routerName}-www.rule=Host(\`${wwwDomain}\`)`, `traefik.http.routers.${routerName}-www.entrypoints=web`, `traefik.http.routers.${routerName}-www.middlewares=${routerName}-www-redirect`, `traefik.http.routers.${routerName}-www.service=${routerName}`, `traefik.http.middlewares.${routerName}-www-redirect.redirectregex.regex=^http://www\\.(.*)`, `traefik.http.middlewares.${routerName}-www-redirect.redirectregex.replacement=http://\$\${1}`, `traefik.http.middlewares.${routerName}-www-redirect.redirectregex.permanent=true`);
        }
        return labels;
    }
    /**
     * Generate custom header labels (for CORS, security headers, etc.)
     */
    generateCustomHeaderLabels(routerName, headers) {
        const labels = [];
        const middlewareName = `${routerName}-headers`;
        Object.entries(headers).forEach(([key, value]) => {
            // Normalize header key to be lowercase with dashes
            const normalizedKey = key.toLowerCase().replace(/_/g, '-');
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.customresponseheaders.${normalizedKey}=${value}`);
        });
        return labels;
    }
    /**
     * Generate security header labels (HSTS, X-Frame-Options, etc.)
     */
    generateSecurityHeaderLabels(routerName, headers) {
        const labels = [];
        const middlewareName = `${routerName}-security-headers`;
        // HSTS (HTTP Strict Transport Security)
        if (headers.hstsEnabled) {
            let hstsValue = `max-age=${headers.hstsMaxAge || 31536000}`;
            if (headers.hstsIncludeSubdomains) {
                hstsValue += '; includeSubDomains';
            }
            if (headers.hstsPreload) {
                hstsValue += '; preload';
            }
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.stsSeconds=${headers.hstsMaxAge || 31536000}`, `traefik.http.middlewares.${middlewareName}.headers.stsIncludeSubdomains=${headers.hstsIncludeSubdomains || false}`, `traefik.http.middlewares.${middlewareName}.headers.stsPreload=${headers.hstsPreload || false}`);
        }
        // X-Frame-Options
        if (headers.xFrameOptions) {
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.frameDeny=${headers.xFrameOptions === 'DENY'}`, `traefik.http.middlewares.${middlewareName}.headers.customFrameOptionsValue=${headers.xFrameOptions}`);
        }
        // X-Content-Type-Options
        if (headers.xContentTypeOptions) {
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.contentTypeNosniff=true`);
        }
        // X-XSS-Protection (deprecated but still used)
        if (headers.xXssProtection) {
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.browserXssFilter=true`);
        }
        // Referrer-Policy
        if (headers.referrerPolicy) {
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.referrerPolicy=${headers.referrerPolicy}`);
        }
        // Content-Security-Policy
        if (headers.contentSecurityPolicy) {
            labels.push(`traefik.http.middlewares.${middlewareName}.headers.contentSecurityPolicy=${headers.contentSecurityPolicy}`);
        }
        return labels;
    }
    /**
     * Generate basic auth middleware labels
     * Uses htpasswd format for credentials
     */
    generateBasicAuthLabels(routerName, users) {
        const labels = [];
        const middlewareName = `${routerName}-basic-auth`;
        // Generate htpasswd-style users
        // Format: user:password (Traefik will hash if not already hashed)
        // Using apr1 or bcrypt is more secure, but for simplicity we use plain text
        // which Traefik will handle appropriately
        const userList = users.map(u => `${u.username}:${u.password}`).join(',');
        labels.push(`traefik.http.middlewares.${middlewareName}.basicauth.users=${userList}`);
        return labels;
    }
    /**
     * Generate IP whitelist middleware labels
     */
    generateIpWhitelistLabels(routerName, whitelist) {
        const labels = [];
        const middlewareName = `${routerName}-ip-whitelist`;
        // Join IPs with comma for Traefik
        const sourceRange = whitelist.join(',');
        labels.push(`traefik.http.middlewares.${middlewareName}.ipwhitelist.sourcerange=${sourceRange}`);
        return labels;
    }
    /**
     * Generate rate limit middleware labels
     */
    generateRateLimitLabels(routerName, average, burst) {
        const labels = [];
        const middlewareName = `${routerName}-rate-limit`;
        labels.push(`traefik.http.middlewares.${middlewareName}.ratelimit.average=${average}`, `traefik.http.middlewares.${middlewareName}.ratelimit.burst=${burst}`);
        return labels;
    }
    /**
     * Check if domain should get www redirect (2-level domain only)
     */
    shouldAddWwwRedirect(domain) {
        const parts = domain.split('.');
        return parts.length === 2; // example.com, not sub.example.com
    }
    /**
     * Generate router name from domain
     * example.com -> example-com
     * app.example.com -> app-example-com
     */
    static generateRouterName(domain, suffix) {
        const baseName = domain.replace(/\./g, '-').replace(/[^a-z0-9-]/gi, '');
        return suffix ? `${baseName}-${suffix}` : baseName;
    }
    /**
     * Parse labels from a docker-compose service
     * Useful for reading existing Traefik configuration
     */
    static parseLabels(labels) {
        const labelMap = new Map();
        // Normalize labels to Map
        if (Array.isArray(labels)) {
            labels.forEach((label) => {
                const [key, ...valueParts] = label.split('=');
                labelMap.set(key, valueParts.join('='));
            });
        }
        else {
            Object.entries(labels).forEach(([key, value]) => {
                labelMap.set(key, value);
            });
        }
        const config = {};
        // Extract domain from rule
        for (const [key, value] of labelMap.entries()) {
            if (key.includes('.rule') && value.includes('Host')) {
                const match = value.match(/Host\(`([^`]+)`\)/);
                if (match) {
                    config.domain = match[1];
                }
            }
            // Extract port
            if (key.includes('.loadbalancer.server.port')) {
                config.port = parseInt(value, 10);
            }
            // Check SSL
            if (key.includes('.tls.certresolver')) {
                config.ssl = true;
            }
        }
        return config;
    }
}
exports.TraefikLabelGenerator = TraefikLabelGenerator;
//# sourceMappingURL=TraefikLabelGenerator.js.map