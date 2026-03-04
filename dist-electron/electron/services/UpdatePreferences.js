"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updatePreferences = exports.UpdatePreferences = void 0;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DEFAULT_PREFERENCES = {
    skippedVersion: null,
};
class UpdatePreferences {
    cache = null;
    get filePath() {
        const dir = electron_1.app.getPath('userData');
        return path_1.default.join(dir, 'update-preferences.json');
    }
    load() {
        if (this.cache) {
            return this.cache;
        }
        try {
            const raw = fs_1.default.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            this.cache = {
                skippedVersion: parsed.skippedVersion ?? null,
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
        catch {
            // Ignore write errors; failing to persist preferences is non-fatal.
        }
    }
    getSkippedVersion() {
        const data = this.load();
        return data.skippedVersion ?? null;
    }
    setSkippedVersion(version) {
        const data = this.load();
        if (data.skippedVersion === version) {
            return;
        }
        this.persist({
            ...data,
            skippedVersion: version,
        });
    }
    clearSkippedVersion() {
        const data = this.load();
        if (!data.skippedVersion) {
            return;
        }
        this.persist({
            ...data,
            skippedVersion: null,
        });
    }
}
exports.UpdatePreferences = UpdatePreferences;
exports.updatePreferences = new UpdatePreferences();
//# sourceMappingURL=UpdatePreferences.js.map