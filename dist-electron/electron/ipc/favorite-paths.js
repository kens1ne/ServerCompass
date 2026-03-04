"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFavoritePathsHandlers = registerFavoritePathsHandlers;
const electron_1 = require("electron");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const types_1 = require("./types");
const db_1 = require("../db");
function registerFavoritePathsHandlers() {
    // List favorite paths for a server
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FAVORITE_PATHS_LIST, async (_event, input) => {
        try {
            const { serverId } = types_1.FavoritePathServerSchema.parse(input);
            const paths = db_1.queries.getFavoritePathsByServer(serverId);
            return { success: true, data: paths };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list favorite paths',
            };
        }
    });
    // Create a favorite path
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FAVORITE_PATHS_CREATE, async (_event, input) => {
        try {
            const { serverId, name, path } = types_1.CreateFavoritePathSchema.parse(input);
            const existing = db_1.queries.getFavoritePathsByServer(serverId);
            const maxOrder = existing.reduce((max, f) => Math.max(max, f.display_order), 0);
            const id = (0, crypto_1.randomUUID)();
            db_1.queries.createFavoritePath({
                id,
                server_id: serverId,
                name,
                path,
                display_order: maxOrder + 1,
            });
            const created = db_1.queries.getFavoritePathsByServer(serverId).find(f => f.id === id);
            return { success: true, data: created };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create favorite path',
            };
        }
    });
    // Update a favorite path
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FAVORITE_PATHS_UPDATE, async (_event, input) => {
        try {
            const { id, name, path, displayOrder } = types_1.UpdateFavoritePathSchema.parse(input);
            const updates = {};
            if (name !== undefined)
                updates.name = name;
            if (path !== undefined)
                updates.path = path;
            if (displayOrder !== undefined)
                updates.display_order = displayOrder;
            db_1.queries.updateFavoritePath(id, updates);
            return { success: true };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update favorite path',
            };
        }
    });
    // Delete a favorite path
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FAVORITE_PATHS_DELETE, async (_event, input) => {
        try {
            const { id } = types_1.FavoritePathIdSchema.parse(input);
            db_1.queries.deleteFavoritePath(id);
            return { success: true };
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return { success: false, error: error.issues[0]?.message || 'Validation failed' };
            }
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete favorite path',
            };
        }
    });
}
//# sourceMappingURL=favorite-paths.js.map