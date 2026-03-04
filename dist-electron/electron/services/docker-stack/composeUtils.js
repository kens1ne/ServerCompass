"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.countServicesInCompose = countServicesInCompose;
exports.injectPortMapping = injectPortMapping;
exports.rewriteComposeBuildContextsForGitHub = rewriteComposeBuildContextsForGitHub;
exports.injectBuildNetworkHost = injectBuildNetworkHost;
exports.rewriteComposeDockerfileForOverride = rewriteComposeDockerfileForOverride;
exports.escapeDollarInEnvVars = escapeDollarInEnvVars;
exports.parsePortsString = parsePortsString;
exports.parsePorts = parsePorts;
const yaml_1 = __importDefault(require("yaml"));
// Utilities for docker-compose manipulation and parsing. Pulled out of the
// service to make the multi-service port handling and $-escaping easier to test
// and to keep the main service file under the 2,500 line limit from AGENTS.md.
/**
 * Count the number of services defined in a docker-compose.yml.
 * Keeps the multi-service port injection guard described in
 * docs/common-errors/multi_service_port_injection.md.
 */
function countServicesInCompose(composeContent) {
    const servicesMatch = composeContent.match(/^services:\s*$/m);
    if (!servicesMatch)
        return 0;
    const lines = composeContent.split('\n');
    let inServices = false;
    let serviceIndent = -1;
    let serviceCount = 0;
    for (const line of lines) {
        const trimmedLine = line.trim();
        const indent = line.search(/\S|$/);
        if (trimmedLine === 'services:') {
            inServices = true;
            serviceIndent = -1;
            continue;
        }
        if (inServices && trimmedLine && !trimmedLine.startsWith('#')) {
            if (serviceIndent === -1 && indent > 0 && trimmedLine.endsWith(':') && !trimmedLine.includes(' ')) {
                serviceIndent = indent;
                serviceCount++;
            }
            else if (serviceIndent > 0 && indent === serviceIndent && trimmedLine.endsWith(':') && !trimmedLine.includes(' ')) {
                serviceCount++;
            }
            if (indent === 0 && trimmedLine.endsWith(':') && !trimmedLine.startsWith('-')) {
                inServices = false;
            }
        }
    }
    return serviceCount;
}
/**
 * Inject custom port mapping into docker-compose.yml by replacing the first
 * published port entry.
 */
function injectPortMapping(composeContent, hostPort) {
    const shortSyntaxReplaced = composeContent.replace(/^(\s*-\s*)(["']?)(\d+)(:\d+)(["']?)$/m, `$1$2${hostPort}$4$5`);
    if (shortSyntaxReplaced !== composeContent) {
        return shortSyntaxReplaced;
    }
    const longSyntaxReplaced = composeContent.replace(/^(\s*published:\s*)(\d+)$/m, `$1${hostPort}`);
    return longSyntaxReplaced;
}
/**
 * GitHub stacks clone code into `<workingDir>/repo` while `docker-compose.yml` lives in `<workingDir>`.
 * Rewrite relative Docker build contexts so `docker compose` can run from `<workingDir>` and still build
 * from the cloned repository.
 *
 * Example: `context: .` → `context: ./repo`
 *          `context: ./backend` → `context: ./repo/backend`
 *          `build: .` → `build: ./repo`
 */
function rewriteComposeBuildContextsForGitHub(composeContent, repoDir = './repo') {
    const normalizedRepoDir = repoDir.replace(/\/+$/, '');
    const normalizeForCompare = (p) => {
        let out = p.trim().replace(/\\/g, '/');
        while (out.startsWith('./'))
            out = out.slice(2);
        out = out.replace(/\/+$/, '');
        return out;
    };
    const isRemoteOrDynamic = (p) => {
        const v = p.trim();
        if (!v)
            return false;
        if (v.includes('${'))
            return true;
        if (/^[a-zA-Z]+:\/\//.test(v))
            return true;
        if (v.startsWith('git@'))
            return true;
        if (v.startsWith('ssh://'))
            return true;
        return false;
    };
    const rewritePath = (p) => {
        const original = p.trim().replace(/\\/g, '/');
        if (!original)
            return { path: p, changed: false };
        if (original.startsWith('/') || original.startsWith('~'))
            return { path: p, changed: false };
        if (original.startsWith('../'))
            return { path: p, changed: false };
        if (isRemoteOrDynamic(original))
            return { path: p, changed: false };
        const repoCmp = normalizeForCompare(normalizedRepoDir);
        const valueCmp = normalizeForCompare(original);
        if (valueCmp === repoCmp || valueCmp.startsWith(`${repoCmp}/`)) {
            return { path: p, changed: false };
        }
        if (valueCmp === '.' || valueCmp === '') {
            return { path: normalizedRepoDir, changed: true };
        }
        if (original === '.' || original === './' || original === './.') {
            return { path: normalizedRepoDir, changed: true };
        }
        const join = (base, rel) => {
            const b = base.replace(/\/+$/, '');
            const r = rel.replace(/^\/+/, '');
            return `${b}/${r}`;
        };
        if (original.startsWith('./')) {
            const rest = original.slice(2);
            if (!rest || rest === '.' || rest === '/')
                return { path: normalizedRepoDir, changed: true };
            return { path: join(normalizedRepoDir, rest), changed: true };
        }
        return { path: join(normalizedRepoDir, original), changed: true };
    };
    const unwrapScalar = (raw) => {
        const trimmed = raw.trim();
        if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
            const q = trimmed[0];
            if (trimmed.endsWith(q)) {
                return { quote: q, value: trimmed.slice(1, -1) };
            }
        }
        return { quote: null, value: trimmed };
    };
    const wrapScalar = (value, quote) => {
        if (!quote)
            return value;
        return `${quote}${value}${quote}`;
    };
    const lines = composeContent.split('\n');
    let rewrites = 0;
    let inBuildBlock = false;
    let buildIndent = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const indent = line.search(/\S|$/);
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (inBuildBlock && indent <= buildIndent && !trimmed.startsWith('-')) {
            inBuildBlock = false;
        }
        const buildKeyOnly = /^(\s*)build:\s*(?:#.*)?$/.exec(line);
        if (!inBuildBlock && buildKeyOnly) {
            inBuildBlock = true;
            buildIndent = indent;
            continue;
        }
        const buildShort = /^(\s*build:\s*)(.+?)(\s*(?:#.*)?)$/.exec(line);
        if (!inBuildBlock && buildShort && trimmed !== 'build:') {
            const [, prefix, rawValuePart, comment = ''] = buildShort;
            const rawValue = rawValuePart.trim();
            // Skip inline object/array syntax to avoid corrupting complex YAML.
            if (rawValue.startsWith('{') || rawValue.startsWith('[') || rawValue === '|' || rawValue === '>') {
                continue;
            }
            const { quote, value } = unwrapScalar(rawValue);
            const rewritten = rewritePath(value);
            if (rewritten.changed) {
                lines[i] = `${prefix}${wrapScalar(rewritten.path, quote)}${comment}`;
                rewrites++;
            }
            continue;
        }
        if (inBuildBlock) {
            const contextMatch = /^(\s*context:\s*)(.+?)(\s*(?:#.*)?)$/.exec(line);
            if (!contextMatch)
                continue;
            const [, prefix, rawValuePart, comment = ''] = contextMatch;
            const rawValue = rawValuePart.trim();
            if (rawValue.startsWith('{') || rawValue.startsWith('[') || rawValue === '|' || rawValue === '>') {
                continue;
            }
            const { quote, value } = unwrapScalar(rawValue);
            const rewritten = rewritePath(value);
            if (rewritten.changed) {
                lines[i] = `${prefix}${wrapScalar(rewritten.path, quote)}${comment}`;
                rewrites++;
            }
        }
    }
    return { content: lines.join('\n'), rewrites };
}
/**
 * Inject `build.network: host` into services that build from source.
 *
 * This is a pragmatic workaround for VPSes where Docker containers cannot resolve DNS
 * on the default bridge network (often due to firewall/forwarding rules), while the host
 * itself can still reach the internet (image pulls succeed but `apt-get`/`curl` inside
 * build steps fail with "Temporary failure resolving ...").
 *
 * Note: This affects build-time networking only. It does not change runtime container networks.
 */
function injectBuildNetworkHost(composeContent) {
    try {
        const parsed = yaml_1.default.parse(composeContent);
        if (!parsed || typeof parsed !== 'object')
            return { content: composeContent, rewrites: 0 };
        const services = parsed.services;
        if (!services || typeof services !== 'object')
            return { content: composeContent, rewrites: 0 };
        let rewrites = 0;
        for (const service of Object.values(services)) {
            if (!service || typeof service !== 'object')
                continue;
            const build = service.build;
            if (!build)
                continue;
            if (typeof build === 'string') {
                service.build = { context: build, network: 'host' };
                rewrites++;
                continue;
            }
            if (typeof build === 'object' && !Array.isArray(build)) {
                if (build.network === undefined || build.network === null || String(build.network).trim() === '') {
                    build.network = 'host';
                    rewrites++;
                }
            }
        }
        if (rewrites === 0)
            return { content: composeContent, rewrites: 0 };
        return {
            content: yaml_1.default.stringify(parsed),
            rewrites,
        };
    }
    catch {
        return { content: composeContent, rewrites: 0 };
    }
}
/**
 * Rewrite dockerfile references inside `build:` blocks to use a specific Dockerfile path.
 * This is used for GitHub "override Dockerfile" deployments where we keep the repo's
 * original `Dockerfile` intact and instead point Compose at `Dockerfile.servercompass`.
 */
function rewriteComposeDockerfileForOverride(composeContent, dockerfilePath) {
    const targetPath = dockerfilePath.trim();
    if (!targetPath) {
        return { content: composeContent, rewrites: 0 };
    }
    const unwrapScalar = (raw) => {
        const trimmed = raw.trim();
        if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
            const q = trimmed[0];
            if (trimmed.endsWith(q)) {
                return { quote: q, value: trimmed.slice(1, -1) };
            }
        }
        return { quote: null, value: trimmed };
    };
    const wrapScalar = (value, quote) => {
        if (!quote)
            return value;
        return `${quote}${value}${quote}`;
    };
    const lines = composeContent.split('\n');
    let rewrites = 0;
    let inBuildBlock = false;
    let buildIndent = 0;
    let buildStartIndex = -1;
    let buildChildIndent = null;
    let dockerfileLineIndex = null;
    let contextLineIndex = null;
    const insertDockerfileLine = (insertAtIndex, indentSpaces) => {
        const indent = ' '.repeat(indentSpaces);
        lines.splice(insertAtIndex, 0, `${indent}dockerfile: ${targetPath}`);
        rewrites++;
    };
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        const indent = line.search(/\S|$/);
        if (!trimmed || trimmed.startsWith('#')) {
            i++;
            continue;
        }
        // If we left a build block, inject dockerfile if missing and reprocess this line.
        if (inBuildBlock && indent <= buildIndent && !trimmed.startsWith('-')) {
            if (dockerfileLineIndex === null) {
                const childIndent = buildChildIndent ?? (buildIndent + 2);
                const insertAt = (contextLineIndex ?? buildStartIndex) + 1;
                insertDockerfileLine(insertAt, childIndent);
                if (insertAt <= i) {
                    i++;
                }
            }
            inBuildBlock = false;
            buildStartIndex = -1;
            buildChildIndent = null;
            dockerfileLineIndex = null;
            contextLineIndex = null;
            continue;
        }
        const buildKeyOnly = /^(\s*)build:\s*(?:#.*)?$/.exec(line);
        if (!inBuildBlock && buildKeyOnly) {
            inBuildBlock = true;
            buildIndent = indent;
            buildStartIndex = i;
            buildChildIndent = null;
            dockerfileLineIndex = null;
            contextLineIndex = null;
            i++;
            continue;
        }
        const buildShort = /^(\s*)build:\s*(.+?)(\s*(?:#.*)?)$/.exec(line);
        if (!inBuildBlock && buildShort && trimmed !== 'build:') {
            const [, indentStr, rawValuePart, comment = ''] = buildShort;
            const rawValue = rawValuePart.trim();
            // Skip inline object/array syntax to avoid corrupting complex YAML.
            if (rawValue.startsWith('{') || rawValue.startsWith('[') || rawValue === '|' || rawValue === '>') {
                i++;
                continue;
            }
            // Convert `build: .` into a block so we can specify `dockerfile:`.
            lines[i] = `${indentStr}build:`;
            const childIndentStr = `${indentStr}  `;
            lines.splice(i + 1, 0, `${childIndentStr}context: ${rawValue}${comment}`);
            lines.splice(i + 2, 0, `${childIndentStr}dockerfile: ${targetPath}`);
            rewrites++;
            i += 3;
            continue;
        }
        if (inBuildBlock) {
            if (buildChildIndent === null && indent > buildIndent) {
                buildChildIndent = indent;
            }
            const contextMatch = /^(\s*context:\s*)(.+?)(\s*(?:#.*)?)$/.exec(line);
            if (contextMatch) {
                contextLineIndex = i;
                i++;
                continue;
            }
            const dockerfileMatch = /^(\s*dockerfile:\s*)(.+?)(\s*(?:#.*)?)$/.exec(line);
            if (dockerfileMatch) {
                const [, prefix, rawValuePart, comment = ''] = dockerfileMatch;
                const { quote, value } = unwrapScalar(rawValuePart);
                const nextValue = value === targetPath ? rawValuePart.trim() : wrapScalar(targetPath, quote);
                if (nextValue !== rawValuePart.trim()) {
                    lines[i] = `${prefix}${nextValue}${comment}`;
                    rewrites++;
                }
                dockerfileLineIndex = i;
                i++;
                continue;
            }
        }
        i++;
    }
    // End-of-file: if we're still in a build block, inject dockerfile if missing.
    if (inBuildBlock && dockerfileLineIndex === null) {
        const childIndent = buildChildIndent ?? (buildIndent + 2);
        const insertAt = (contextLineIndex ?? buildStartIndex) + 1;
        insertDockerfileLine(insertAt, childIndent);
    }
    return { content: lines.join('\n'), rewrites };
}
/**
 * Escape $ characters in docker-compose.yml environment variable values.
 * Protects all deployment sources as documented in
 * docs/common-errors/docker_compose_dollar_sign_comprehensive.md.
 */
function escapeDollarInEnvVars(composeContent) {
    let escaped = composeContent.replace(/^(\s*-\s*)([A-Z_][A-Z0-9_]*=)([^\n]*)/gm, (_match, prefix, envKey, envValue) => {
        const escapedValue = envValue.replace(/\$/g, '$$$$');
        return `${prefix}${envKey}${escapedValue}`;
    });
    escaped = escaped.replace(/^(\s*)([A-Z_][A-Z0-9_]*:\s*)([^\n]*)/gm, (_match, indent, envKey, envValue) => {
        const key = envKey.trim().replace(':', '');
        const specialKeys = [
            'services',
            'volumes',
            'networks',
            'configs',
            'secrets',
            'build',
            'image',
            'ports',
            'depends_on',
            'environment',
            'env_file',
            'healthcheck',
            'restart',
            'container_name',
            'command',
            'entrypoint',
        ];
        if (specialKeys.includes(key)) {
            return _match;
        }
        const escapedValue = envValue.replace(/\$/g, '$$$$');
        return `${indent}${envKey}${escapedValue}`;
    });
    return escaped;
}
function parsePortsString(portsStr) {
    const ports = [];
    if (!portsStr)
        return ports;
    const portMatches = portsStr.matchAll(/(?:[\d.:[\]]+:)?(\d+)->(\d+)\/(tcp|udp)|(\d+)\/(tcp|udp)/g);
    for (const match of portMatches) {
        if (match[1] && match[2]) {
            ports.push({
                host: parseInt(match[1]),
                container: parseInt(match[2]),
                protocol: match[3] || 'tcp',
            });
        }
        else if (match[4]) {
            ports.push({
                container: parseInt(match[4]),
                protocol: match[5] || 'tcp',
            });
        }
    }
    return ports;
}
function parsePorts(publishers) {
    const ports = [];
    for (const pub of publishers) {
        if (typeof pub === 'string') {
            const match = pub.match(/(?:(\d+):)?(\d+)\/?(tcp|udp)?/);
            if (match) {
                ports.push({
                    host: match[1] ? parseInt(match[1]) : undefined,
                    container: parseInt(match[2]),
                    protocol: match[3] || 'tcp',
                });
            }
        }
        else if (typeof pub === 'object' && pub !== null) {
            const p = pub;
            ports.push({
                host: (p.PublishedPort || p.HostPort),
                container: (p.TargetPort || p.ContainerPort),
                protocol: (p.Protocol || 'tcp'),
            });
        }
    }
    return ports;
}
//# sourceMappingURL=composeUtils.js.map