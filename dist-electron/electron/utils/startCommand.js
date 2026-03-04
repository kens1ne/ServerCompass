"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeStartCommand = void 0;
/**
 * Normalize start commands coming from stored deployments or PM2.
 * Returns undefined when the command is missing or set to legacy placeholders like "none".
 */
const sanitizeStartCommand = (command) => {
    if (!command)
        return undefined;
    const trimmed = command.trim();
    if (!trimmed)
        return undefined;
    if (/^none(\s|$)/i.test(trimmed)) {
        return undefined;
    }
    return trimmed;
};
exports.sanitizeStartCommand = sanitizeStartCommand;
//# sourceMappingURL=startCommand.js.map