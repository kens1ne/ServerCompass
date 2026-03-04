"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogFilePath = exports.logger = exports.initLogger = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
let logStream = null;
let logFilePath = null;
const serialize = (value) => {
    if (value instanceof Error) {
        return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        }
        catch (error) {
            return `Unserializable object: ${error.message}`;
        }
    }
    return String(value);
};
const write = (level, args) => {
    const timestamp = new Date().toISOString();
    const message = args.map(serialize).join(' ');
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    // Mirror to console for local debugging
    if (level === 'error') {
        console.error(message);
    }
    else if (level === 'warn') {
        console.warn(message);
    }
    else {
        console.log(message);
    }
    if (!logStream) {
        return;
    }
    logStream.write(line);
};
const initLogger = () => {
    if (logStream) {
        return logFilePath;
    }
    const logDir = path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    fs_1.default.mkdirSync(logDir, { recursive: true });
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    logFilePath = path_1.default.join(logDir, `servercompass-main-${safeTimestamp}.log`);
    logStream = fs_1.default.createWriteStream(logFilePath, { flags: 'a' });
    write('info', [`Logger initialized. Writing to ${logFilePath}`]);
    return logFilePath;
};
exports.initLogger = initLogger;
exports.logger = {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
};
const getLogFilePath = () => logFilePath;
exports.getLogFilePath = getLogFilePath;
//# sourceMappingURL=logger.js.map