"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSecretVaultHandlers = registerSecretVaultHandlers;
const electron_1 = require("electron");
const zod_1 = require("zod");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const types_1 = require("./types");
const SecretVaultService_1 = require("../services/SecretVaultService");
function registerSecretVaultHandlers() {
    // Get all collections (metadata only)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_GET_ALL, async () => {
        try {
            const collections = SecretVaultService_1.secretVaultService.getAllCollections();
            return { success: true, data: collections };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get collections',
            };
        }
    });
    // Get collection by ID with decrypted secrets
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_GET_BY_ID, async (_event, input) => {
        try {
            const { id } = types_1.SecretCollectionIdSchema.parse(input);
            const collection = await SecretVaultService_1.secretVaultService.getCollectionSecrets(id);
            if (!collection)
                return { success: false, error: 'Collection not found' };
            return { success: true, data: collection };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get collection',
            };
        }
    });
    // Get secrets as Record<string, string> for import into env editors
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_GET_SECRETS, async (_event, input) => {
        try {
            const { id } = types_1.SecretCollectionIdSchema.parse(input);
            const secrets = await SecretVaultService_1.secretVaultService.getSecretsAsRecord(id);
            if (!secrets)
                return { success: false, error: 'Collection not found' };
            return { success: true, data: secrets };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get secrets',
            };
        }
    });
    // Create collection
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_CREATE, async (_event, input) => {
        try {
            const parsed = types_1.CreateSecretCollectionSchema.parse(input);
            const collection = await SecretVaultService_1.secretVaultService.createCollection(parsed);
            return { success: true, data: collection };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create collection',
            };
        }
    });
    // Update collection
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_UPDATE, async (_event, input) => {
        try {
            const { id, updates } = types_1.UpdateSecretCollectionSchema.parse(input);
            await SecretVaultService_1.secretVaultService.updateCollection(id, updates);
            return { success: true };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update collection',
            };
        }
    });
    // Delete collection
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_DELETE, async (_event, input) => {
        try {
            const { id } = types_1.SecretCollectionIdSchema.parse(input);
            SecretVaultService_1.secretVaultService.deleteCollection(id);
            return { success: true };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete collection',
            };
        }
    });
    // Import from .env file content
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_IMPORT_ENV, async (_event, input) => {
        try {
            const { name, description, tags, envContent } = types_1.ImportEnvFileSchema.parse(input);
            const secrets = SecretVaultService_1.secretVaultService.parseEnvContent(envContent);
            const collection = await SecretVaultService_1.secretVaultService.createCollection({
                name,
                description,
                tags,
                secrets,
            });
            return { success: true, data: collection };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to import env file',
            };
        }
    });
    // Select .env files from filesystem (native dialog)
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_SELECT_ENV_FILES, async () => {
        try {
            const parentWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
            const dialogOpts = {
                title: 'Select .env Files',
                properties: ['openFile', 'multiSelections'],
                filters: [
                    { name: 'Environment Files', extensions: ['env'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            };
            const result = parentWindow
                ? await electron_1.dialog.showOpenDialog(parentWindow, dialogOpts)
                : await electron_1.dialog.showOpenDialog(dialogOpts);
            if (result.canceled || result.filePaths.length === 0) {
                return { success: true, data: [] };
            }
            const files = result.filePaths.map((filePath) => ({
                name: path_1.default.basename(filePath, path_1.default.extname(filePath)),
                content: fs_1.default.readFileSync(filePath, 'utf-8'),
            }));
            return { success: true, data: files };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to select files',
            };
        }
    });
    // Export collection as .env file
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SECRETS_EXPORT_ENV, async (_event, input) => {
        try {
            const { id } = types_1.SecretCollectionIdSchema.parse(input);
            const secrets = await SecretVaultService_1.secretVaultService.getSecretsAsRecord(id);
            if (!secrets)
                return { success: false, error: 'Collection not found' };
            const envContent = Object.entries(secrets)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n');
            const parentWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
            const dialogOpts = {
                title: 'Export .env File',
                defaultPath: 'exported.env',
                filters: [{ name: 'Environment Files', extensions: ['env'] }],
            };
            const result = parentWindow
                ? await electron_1.dialog.showSaveDialog(parentWindow, dialogOpts)
                : await electron_1.dialog.showSaveDialog(dialogOpts);
            if (result.canceled || !result.filePath) {
                return { success: true, data: '' };
            }
            fs_1.default.writeFileSync(result.filePath, envContent, 'utf-8');
            return { success: true, data: result.filePath };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to export',
            };
        }
    });
}
//# sourceMappingURL=secrets.js.map