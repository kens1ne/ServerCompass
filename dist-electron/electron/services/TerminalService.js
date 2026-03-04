"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.terminalService = void 0;
const electron_1 = require("electron");
const crypto_1 = require("crypto");
const types_1 = require("../ipc/types");
const SSHService_1 = require("./SSHService");
class TerminalService {
    sessions = new Map();
    async createSession(options) {
        const client = await this.ensureConnection(options.serverId);
        const sessionId = (0, crypto_1.randomUUID)();
        const stream = await new Promise((resolve, reject) => {
            client.shell({
                term: 'xterm-256color',
                cols: options.cols,
                rows: options.rows,
            }, (error, channel) => {
                if (error || !channel) {
                    reject(error ?? new Error('Failed to establish interactive shell.'));
                    return;
                }
                resolve(channel);
            });
        });
        const onData = (chunk) => {
            this.emitData(options.webContentsId, sessionId, chunk);
        };
        const onStderr = (chunk) => {
            this.emitData(options.webContentsId, sessionId, chunk);
        };
        const onClose = () => {
            this.handleExit(sessionId, null, null);
        };
        const onExit = (code, signal) => {
            this.handleExit(sessionId, code, signal);
        };
        const onError = (error) => {
            this.emitData(options.webContentsId, sessionId, `\r\n${error.message}\r\n`);
            this.handleExit(sessionId, null, null);
        };
        stream.on('data', onData);
        // For shell channels stderr is multiplexed; stream.stderr may still emit
        if (stream.stderr) {
            stream.stderr.on('data', onStderr);
        }
        stream.on('close', onClose);
        stream.on('exit', onExit);
        stream.on('error', onError);
        this.sessions.set(sessionId, {
            sessionId,
            serverId: options.serverId,
            stream,
            webContentsId: options.webContentsId,
            closed: false,
            listeners: { onData, onStderr, onClose, onExit, onError },
        });
        return { sessionId };
    }
    async write(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (!session || session.closed) {
            throw new Error('Terminal session not found.');
        }
        session.stream.write(data);
    }
    async resize(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (!session || session.closed) {
            return;
        }
        try {
            // The SSH spec expects rows first, then cols. Height/width in pixels are optional.
            session.stream.setWindow(rows, cols, 0, 0);
        }
        catch (error) {
            // Ignore resize errors; remote shells may not support window resizing.
        }
    }
    async close(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        try {
            session.stream.end();
        }
        catch {
            // ignore
        }
        this.handleExit(sessionId, null, null);
    }
    async ensureConnection(serverId) {
        return SSHService_1.sshService.connect(serverId);
    }
    emitData(targetId, sessionId, chunk) {
        const contents = electron_1.webContents.fromId(targetId);
        if (!contents || contents.isDestroyed()) {
            return;
        }
        const payload = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        if (!payload) {
            return;
        }
        contents.send(types_1.IPC_CHANNELS.TERMINAL_DATA, {
            sessionId,
            data: payload,
        });
    }
    handleExit(sessionId, code, signal) {
        const session = this.sessions.get(sessionId);
        if (!session || session.closed) {
            return;
        }
        const contents = electron_1.webContents.fromId(session.webContentsId);
        this.cleanup(sessionId);
        if (contents && !contents.isDestroyed()) {
            contents.send(types_1.IPC_CHANNELS.TERMINAL_EXIT, { sessionId, code, signal });
        }
    }
    cleanup(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        session.closed = true;
        this.sessions.delete(sessionId);
        const { stream, listeners } = session;
        stream.off('data', listeners.onData);
        if (stream.stderr) {
            stream.stderr.off('data', listeners.onStderr);
        }
        stream.off('close', listeners.onClose);
        stream.off('exit', listeners.onExit);
        stream.off('error', listeners.onError);
    }
}
exports.terminalService = new TerminalService();
//# sourceMappingURL=TerminalService.js.map