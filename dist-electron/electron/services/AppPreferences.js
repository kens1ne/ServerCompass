"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appPreferences = exports.AppPreferences = void 0;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DEFAULT_PREFERENCES = {
    maxDeploymentLogLines: 1000, // Default: store 1000 lines of logs
};
class AppPreferences {
    cache = null;
    get filePath() {
        const dir = electron_1.app.getPath('userData');
        return path_1.default.join(dir, 'app-preferences.json');
    }
    load() {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = fs_1.default.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            this.cache = {
                maxDeploymentLogLines: parsed.maxDeploymentLogLines ?? DEFAULT_PREFERENCES.maxDeploymentLogLines,
            };
        }
        catch {
            this.cache = { ...DEFAULT_PREFERENCES };
        }
        return this.cache;
    }
    persist(data) {
        this.cache = data;
        try {
            fs_1.default.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (error) {
            console.error('[AppPreferences] Failed to persist preferences:', error);
        }
    }
    getMaxDeploymentLogLines() {
        const data = this.load();
        return data.maxDeploymentLogLines ?? DEFAULT_PREFERENCES.maxDeploymentLogLines;
    }
    setMaxDeploymentLogLines(lines) {
        // Validate range: 100-10000
        const validatedLines = Math.max(100, Math.min(10000, lines));
        const data = this.load();
        if (data.maxDeploymentLogLines === validatedLines) {
            return;
        }
        this.persist({
            ...data,
            maxDeploymentLogLines: validatedLines,
        });
    }
    getAll() {
        return this.load();
    }
}
exports.AppPreferences = AppPreferences;
exports.appPreferences = new AppPreferences();
//# sourceMappingURL=AppPreferences.js.map