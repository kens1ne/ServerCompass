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
exports.waitForAptLock = waitForAptLock;
exports.ensureDockerInstalled = ensureDockerInstalled;
exports.uploadFile = uploadFile;
const path = __importStar(require("path"));
function shellQuote(str) {
    // Safe for POSIX shells: wrap in single quotes and escape existing single quotes.
    return `'${str.replace(/'/g, `'\\''`)}'`;
}
async function waitForAptLock(sshService, emitLog, serverId, maxWaitSeconds = 120) {
    const checkLockCmd = `
      SECONDS=0
      while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || fuser /var/lib/dpkg/lock >/dev/null 2>&1; do
        if [ $SECONDS -ge ${maxWaitSeconds} ]; then
          echo "Timeout waiting for apt lock"
          exit 1
        fi
        sleep 2
      done
    `;
    emitLog('Waiting for apt locks to be released...', 'info');
    const result = await sshService.executeCommand(serverId, checkLockCmd);
    if (result.exitCode !== 0) {
        emitLog('Warning: apt lock wait timed out, proceeding anyway...', 'warning');
    }
    else {
        emitLog('Apt locks released', 'info');
    }
}
async function ensureDockerInstalled(sshService, emitLog, serverId) {
    const dockerCheck = await sshService.executeCommand(serverId, 'docker --version');
    if (dockerCheck.exitCode !== 0) {
        emitLog('Docker not found, installing...', 'info');
        await waitForAptLock(sshService, emitLog, serverId);
        await sshService.executeCommand(serverId, 'apt-get update');
        const installResult = await sshService.executeCommand(serverId, 'curl -fsSL https://get.docker.com | sh');
        if (installResult.exitCode !== 0) {
            throw new Error(`Failed to install Docker: ${installResult.stderr}`);
        }
        await sshService.executeCommand(serverId, 'systemctl start docker && systemctl enable docker');
        emitLog('Docker installed successfully', 'success');
    }
    const composeCheck = await sshService.executeCommand(serverId, 'docker compose version');
    if (composeCheck.exitCode !== 0) {
        emitLog('Docker Compose not found, installing...', 'info');
        await waitForAptLock(sshService, emitLog, serverId);
        const installResult = await sshService.executeCommand(serverId, 'apt-get install -y docker-compose-plugin');
        if (installResult.exitCode !== 0) {
            throw new Error(`Failed to install Docker Compose: ${installResult.stderr}`);
        }
        emitLog('Docker Compose installed successfully', 'success');
    }
}
async function uploadFile(sshService, serverId, remotePath, content) {
    const remoteDir = path.posix.dirname(remotePath);
    const command = `mkdir -p ${shellQuote(remoteDir)} && cat > ${shellQuote(remotePath)} << 'SERVERCOMPASS_EOF'
${content}
SERVERCOMPASS_EOF`;
    const result = await sshService.executeCommand(serverId, command);
    if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file ${remotePath}: ${result.stderr}`);
    }
}
//# sourceMappingURL=system.js.map