"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MigrationScanEngine = void 0;
const electron_1 = require("electron");
const SSHService_1 = require("../SSHService");
const RawVpsProvider_1 = require("./providers/RawVpsProvider");
const CoolifyProvider_1 = require("./providers/CoolifyProvider");
const DokployProvider_1 = require("./providers/DokployProvider");
const RunCloudProvider_1 = require("./providers/RunCloudProvider");
const ForgeProvider_1 = require("./providers/ForgeProvider");
class MigrationScanEngine {
    providers;
    constructor() {
        this.providers = [
            new RunCloudProvider_1.RunCloudProvider(),
            new ForgeProvider_1.ForgeProvider(),
            new CoolifyProvider_1.CoolifyProvider(),
            new DokployProvider_1.DokployProvider(),
            new RawVpsProvider_1.RawVpsProvider(), // Always last — fallback
        ];
    }
    async detectAndScan(migrationId, serverId) {
        // 1. Run all providers' detect() in parallel
        const detections = await Promise.allSettled(this.providers.map(p => p.detect(serverId, SSHService_1.sshService)));
        // 2. Pick highest confidence
        let winner = this.providers[this.providers.length - 1]; // RawVps fallback
        let winnerDetection = null;
        let maxConfidence = 0;
        for (let i = 0; i < detections.length; i++) {
            const result = detections[i];
            if (result.status === 'fulfilled' && result.value.confidence > maxConfidence) {
                maxConfidence = result.value.confidence;
                winner = this.providers[i];
                winnerDetection = result.value;
            }
        }
        const warnings = [];
        const errors = [];
        // 3. Scan with winner
        const ctx = {
            migrationId,
            serverId,
            sshService: SSHService_1.sshService,
            emitProgress: (progress) => this.emitProgress(progress),
        };
        let items = [];
        try {
            items = await winner.scan(ctx);
        }
        catch (err) {
            errors.push(`Scan failed for ${winner.displayName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // 4. If winner !== raw_vps, also scan with raw_vps for supplemental items
        if (winner.providerId !== 'raw_vps') {
            try {
                const rawVps = this.providers.find(p => p.providerId === 'raw_vps');
                const supplementalItems = await rawVps.scan(ctx);
                // Deduplicate by remoteKey
                const existingKeys = new Set(items.map(i => i.remoteKey));
                const newItems = supplementalItems.filter(i => !existingKeys.has(i.remoteKey));
                if (newItems.length > 0) {
                    items.push(...newItems);
                    warnings.push(`Found ${newItems.length} additional items not managed by ${winner.displayName}`);
                }
            }
            catch (err) {
                warnings.push(`Supplemental raw VPS scan failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return {
            migrationId,
            provider: winner.providerId,
            providerVersion: winnerDetection?.version ?? null,
            items,
            warnings,
            errors,
        };
    }
    async getDecommissionPlan(provider, serverId) {
        const providerInstance = this.providers.find(p => p.providerId === provider);
        if (!providerInstance)
            return null;
        return providerInstance.getDecommissionPlan(serverId, SSHService_1.sshService);
    }
    async executeDecommissionStep(provider, serverId, step) {
        const providerInstance = this.providers.find(p => p.providerId === provider);
        if (!providerInstance)
            return { success: false, output: 'Provider not found' };
        return providerInstance.executeDecommissionStep(serverId, SSHService_1.sshService, step);
    }
    emitProgress(progress) {
        electron_1.BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed())
                w.webContents.send('migration:scanProgress', progress);
        });
    }
}
exports.MigrationScanEngine = MigrationScanEngine;
//# sourceMappingURL=MigrationScanEngine.js.map