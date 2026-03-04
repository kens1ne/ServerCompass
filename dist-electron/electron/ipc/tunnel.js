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
exports.registerTunnelHandlers = registerTunnelHandlers;
exports.closeAllTunnels = closeAllTunnels;
const electron_1 = require("electron");
const net = __importStar(require("net"));
const types_1 = require("./types");
const SSHService_1 = require("../services/SSHService");
// Map of "serverId:localPort" -> ActiveTunnel
const activeTunnels = new Map();
function tunnelKey(serverId, localPort) {
    return `${serverId}:${localPort}`;
}
function registerTunnelHandlers() {
    // tunnel:open — create a local TCP server that forwards to remote via SSH
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TUNNEL_OPEN, async (_event, input) => {
        try {
            const { serverId, remoteHost, remotePort, localPort: requestedPort } = types_1.TunnelOpenSchema.parse(input);
            // If a specific port was requested and is already tunneled, return it
            if (requestedPort > 0) {
                const key = tunnelKey(serverId, requestedPort);
                if (activeTunnels.has(key)) {
                    return { success: true, data: { localPort: requestedPort } };
                }
            }
            // Establish/reuse SSH connection (handles reconnect automatically)
            const sshClient = await SSHService_1.sshService.connect(serverId);
            const connections = new Set();
            const server = net.createServer((socket) => {
                connections.add(socket);
                socket.on('close', () => connections.delete(socket));
                sshClient.forwardOut('127.0.0.1', socket.localPort || 0, remoteHost, remotePort, (err, stream) => {
                    if (err) {
                        socket.end();
                        connections.delete(socket);
                        return;
                    }
                    stream.on('error', () => {
                        socket.destroy();
                        connections.delete(socket);
                    });
                    socket.on('error', () => {
                        stream.destroy();
                        connections.delete(socket);
                    });
                    socket.pipe(stream).pipe(socket);
                    stream.on('close', () => {
                        socket.end();
                        connections.delete(socket);
                    });
                });
            });
            // Listen on requested port, or 0 for OS auto-assign
            await new Promise((resolve, reject) => {
                server.on('error', reject);
                server.listen(requestedPort, '127.0.0.1', () => resolve());
            });
            // Get the actual bound port (important when requestedPort was 0)
            const boundPort = server.address().port;
            const key = tunnelKey(serverId, boundPort);
            activeTunnels.set(key, {
                serverId,
                localPort: boundPort,
                remoteHost,
                remotePort,
                server,
                connections,
            });
            console.log(`[Tunnel] Opened tunnel localhost:${boundPort} -> ${remoteHost}:${remotePort} (server ${serverId})`);
            return { success: true, data: { localPort: boundPort } };
        }
        catch (error) {
            console.error('[Tunnel] Failed to open tunnel:', error);
            return {
                success: false,
                error: error.message || 'Failed to open tunnel',
            };
        }
    });
    // tunnel:close — tear down a tunnel
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TUNNEL_CLOSE, async (_event, input) => {
        try {
            const { serverId, localPort } = types_1.TunnelCloseSchema.parse(input);
            const key = tunnelKey(serverId, localPort);
            const tunnel = activeTunnels.get(key);
            if (!tunnel) {
                return { success: true, data: undefined };
            }
            // Close all active socket connections
            for (const socket of tunnel.connections) {
                socket.destroy();
            }
            tunnel.connections.clear();
            // Close the TCP server
            await new Promise((resolve) => tunnel.server.close(() => resolve()));
            activeTunnels.delete(key);
            console.log(`[Tunnel] Closed tunnel localhost:${localPort} (server ${serverId})`);
            return { success: true, data: undefined };
        }
        catch (error) {
            console.error('[Tunnel] Failed to close tunnel:', error);
            return {
                success: false,
                error: error.message || 'Failed to close tunnel',
            };
        }
    });
    // tunnel:status — check active tunnels for a server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TUNNEL_STATUS, async (_event, input) => {
        try {
            const { serverId } = types_1.TunnelStatusSchema.parse(input);
            const tunnels = [];
            for (const [, tunnel] of activeTunnels) {
                if (tunnel.serverId === serverId) {
                    tunnels.push({
                        localPort: tunnel.localPort,
                        remoteHost: tunnel.remoteHost,
                        remotePort: tunnel.remotePort,
                    });
                }
            }
            return { success: true, data: { tunnels } };
        }
        catch (error) {
            return {
                success: false,
                error: error.message || 'Failed to get tunnel status',
            };
        }
    });
    // tunnel:list — list all active tunnels across all servers
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TUNNEL_LIST, async () => {
        const tunnels = Array.from(activeTunnels.values()).map((t) => ({
            serverId: t.serverId,
            localPort: t.localPort,
            remoteHost: t.remoteHost,
            remotePort: t.remotePort,
        }));
        return { success: true, data: { tunnels } };
    });
}
/**
 * Close all active tunnels. Called on app quit.
 */
function closeAllTunnels() {
    for (const [key, tunnel] of activeTunnels) {
        for (const socket of tunnel.connections) {
            socket.destroy();
        }
        tunnel.server.close();
        activeTunnels.delete(key);
    }
    console.log('[Tunnel] All tunnels closed');
}
//# sourceMappingURL=tunnel.js.map