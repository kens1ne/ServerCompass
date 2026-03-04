"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFileHandlers = registerFileHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const SSHService_1 = require("../services/SSHService");
// Helper function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Helper to show open dialog with retry mechanism for macOS XPC issues
async function showOpenDialogWithRetry(parentWindow, options, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = parentWindow
                ? await electron_1.dialog.showOpenDialog(parentWindow, options)
                : await electron_1.dialog.showOpenDialog(options);
            return result;
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(`[File Dialog] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
            if (attempt < maxRetries) {
                // Wait before retrying (increasing delay with each attempt)
                await delay(200 * attempt);
                // Try to get a fresh window reference
                if (parentWindow && parentWindow.isDestroyed()) {
                    parentWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
                }
            }
        }
    }
    throw lastError || new Error('Dialog failed after multiple attempts');
}
// Check if we likely have file access permission issues on macOS
function getPermissionHint() {
    if (process.platform === 'darwin') {
        return ' If this persists, please check System Settings > Privacy & Security > Files and Folders to ensure ServerCompass has access.';
    }
    return '';
}
function registerFileHandlers() {
    // Select file(s) from local system
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FILE_SELECT, async (_event, input) => {
        try {
            const options = types_1.SelectFileSchema.parse(input || {});
            // Get the focused window or first available window for proper macOS dialog handling
            const parentWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
            const dialogOptions = {
                title: options.title || 'Select File(s) to Upload',
                properties: ['openFile', 'multiSelections'],
            };
            // Show dialog with retry mechanism
            const result = await showOpenDialogWithRetry(parentWindow, dialogOptions);
            if (result.canceled) {
                return { success: false, error: 'File selection canceled' };
            }
            return { success: true, data: result.filePaths };
        }
        catch (error) {
            console.error('Error selecting files:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const hint = getPermissionHint();
            return { success: false, error: `Failed to open file dialog: ${errorMessage}.${hint}` };
        }
    });
    // Select folder from local system
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FOLDER_SELECT, async (_event, input) => {
        try {
            const options = types_1.SelectFolderSchema.parse(input || {});
            // Get the focused window or first available window for proper macOS dialog handling
            const parentWindow = electron_1.BrowserWindow.getFocusedWindow() || electron_1.BrowserWindow.getAllWindows()[0] || null;
            const dialogOptions = {
                title: options.title || 'Select Folder to Upload',
                properties: ['openDirectory'],
            };
            // Show dialog with retry mechanism
            const result = await showOpenDialogWithRetry(parentWindow, dialogOptions);
            if (result.canceled) {
                return { success: false, error: 'Folder selection canceled' };
            }
            return { success: true, data: result.filePaths[0] };
        }
        catch (error) {
            console.error('Error selecting folder:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const hint = getPermissionHint();
            return { success: false, error: `Failed to open folder dialog: ${errorMessage}.${hint}` };
        }
    });
    // Upload file
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FILE_UPLOAD, async (_event, input) => {
        try {
            const { serverId, localPath, remotePath } = types_1.UploadFileSchema.parse(input);
            console.log('[File Upload] Starting upload:', { serverId, localPath, remotePath });
            // Get the main window to send progress updates
            const mainWindow = electron_1.BrowserWindow.getAllWindows()[0];
            await SSHService_1.sshService.uploadFile(serverId, localPath, remotePath, (transferred, total) => {
                // Send progress update to renderer
                if (mainWindow) {
                    mainWindow.webContents.send('file:upload:progress', {
                        localPath,
                        transferred,
                        total,
                        percent: Math.round((transferred / total) * 100),
                    });
                }
            });
            console.log('[File Upload] Upload completed successfully');
            return { success: true };
        }
        catch (error) {
            console.error('[File Upload] Error uploading file:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Upload failed: ${errorMessage}` };
        }
    });
    // Upload folder
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FOLDER_UPLOAD, async (_event, input) => {
        try {
            const { serverId, localPath, remotePath, excludeDirs, includeHidden } = types_1.UploadFolderSchema.parse(input);
            console.log('[Folder Upload] Starting upload:', { serverId, localPath, remotePath, excludeDirs, includeHidden });
            // Get the main window to send progress updates
            const mainWindow = electron_1.BrowserWindow.getAllWindows()[0];
            const uploadOptions = (excludeDirs || includeHidden !== undefined)
                ? { excludeDirs, includeHidden }
                : undefined;
            await SSHService_1.sshService.uploadFolder(serverId, localPath, remotePath, (currentFile, fileIndex, totalFiles) => {
                // Send progress update to renderer
                if (mainWindow) {
                    mainWindow.webContents.send('folder:upload:progress', {
                        localPath,
                        currentFile,
                        fileIndex,
                        totalFiles,
                        percent: Math.round((fileIndex / totalFiles) * 100),
                    });
                }
            }, uploadOptions);
            console.log('[Folder Upload] Upload completed successfully');
            return { success: true };
        }
        catch (error) {
            console.error('[Folder Upload] Error uploading folder:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Upload failed: ${errorMessage}` };
        }
    });
    // Download file
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FILE_DOWNLOAD, async (_event, input) => {
        try {
            const { serverId, remotePath, localPath } = types_1.DownloadFileSchema.parse(input);
            console.log('[File Download] Starting download:', { serverId, remotePath, localPath });
            // Get the main window to send progress updates
            const mainWindow = electron_1.BrowserWindow.getAllWindows()[0];
            await SSHService_1.sshService.downloadFile(serverId, remotePath, localPath, (transferred, total) => {
                // Send progress update to renderer
                if (mainWindow) {
                    mainWindow.webContents.send('file:download:progress', {
                        remotePath,
                        localPath,
                        transferred,
                        total,
                        percent: Math.round((transferred / total) * 100),
                    });
                }
            });
            console.log('[File Download] Download completed successfully');
            return { success: true };
        }
        catch (error) {
            console.error('[File Download] Error downloading file:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Download failed: ${errorMessage}` };
        }
    });
    // Create folder
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FOLDER_CREATE, async (_event, input) => {
        try {
            const { serverId, remotePath, folderName } = types_1.CreateFolderSchema.parse(input);
            console.log('[Create Folder] Creating folder:', { serverId, remotePath, folderName });
            // Escape double quotes in folder name for safety
            const safeFolderName = folderName.replace(/"/g, '\\"');
            // Build command - keep ~ outside quotes so it expands, but quote the folder name
            let command;
            if (remotePath === '~') {
                command = `mkdir -p ~/"${safeFolderName}"`;
            }
            else if (remotePath.startsWith('~/')) {
                const subPath = remotePath.slice(2);
                command = `mkdir -p ~/"${subPath}/${safeFolderName}"`;
            }
            else {
                command = `mkdir -p "${remotePath}/${safeFolderName}"`;
            }
            // Create folder using SSH command
            const result = await SSHService_1.sshService.executeCommand(serverId, command);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr || 'Failed to create folder');
            }
            console.log('[Create Folder] Folder created successfully');
            return { success: true };
        }
        catch (error) {
            console.error('[Create Folder] Error creating folder:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to create folder: ${errorMessage}` };
        }
    });
    // Reveal file or folder in the native file explorer
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.FILE_REVEAL, async (_event, input) => {
        try {
            const { path } = types_1.RevealFileSchema.parse(input);
            electron_1.shell.showItemInFolder(path);
            return { success: true };
        }
        catch (error) {
            console.error('[Reveal File] Error revealing path:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Unable to reveal path: ${errorMessage}` };
        }
    });
}
//# sourceMappingURL=files.js.map