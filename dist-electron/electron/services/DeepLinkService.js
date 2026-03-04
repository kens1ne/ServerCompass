"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepLinkService = void 0;
const electron_1 = require("electron");
const events_1 = require("events");
/**
 * Deep Link service for handling servercompass:// protocol
 *
 * Events:
 * - 'auth:callback': { code: string }
 * - 'open:project': { projectId: string }
 */
class DeepLinkService extends events_1.EventEmitter {
    protocol = 'servercompass';
    mainWindow;
    constructor(mainWindow) {
        super();
        this.mainWindow = mainWindow;
    }
    /**
     * Register custom protocol for deep links
     * Call this during app initialization
     */
    registerProtocol() {
        console.log('[DeepLink] Registering protocol:', this.protocol);
        // Set as default protocol client
        if (process.defaultApp) {
            // Development mode - need to pass electron executable and main script
            if (process.argv.length >= 2) {
                electron_1.app.setAsDefaultProtocolClient(this.protocol, process.execPath, [process.argv[1]]);
            }
        }
        else {
            // Production mode
            electron_1.app.setAsDefaultProtocolClient(this.protocol);
        }
        // Check if successfully registered
        const isRegistered = electron_1.app.isDefaultProtocolClient(this.protocol);
        console.log('[DeepLink] Protocol registered:', isRegistered);
        // macOS: Handle open-url event
        electron_1.app.on('open-url', (event, url) => {
            event.preventDefault();
            console.log('[DeepLink] Received via open-url:', url);
            this.handleDeepLink(url);
        });
        // Handle second instance (for all platforms)
        // Note: Single instance lock is now handled in main.ts before app.whenReady()
        electron_1.app.on('second-instance', (_event, commandLine, _workingDirectory) => {
            console.log('[DeepLink] Second instance detected');
            // Always focus the main window when second instance is attempted
            if (this.mainWindow) {
                if (this.mainWindow.isMinimized())
                    this.mainWindow.restore();
                this.mainWindow.focus();
            }
            // Check for deep link in command line (Windows/Linux)
            const url = commandLine.find(arg => arg.startsWith(`${this.protocol}://`));
            if (url) {
                console.log('[DeepLink] Received via second-instance:', url);
                this.handleDeepLink(url);
            }
        });
        // Windows/Linux: Handle deep link on startup
        if (process.platform === 'win32' || process.platform === 'linux') {
            const url = process.argv.find(arg => arg.startsWith(`${this.protocol}://`));
            if (url) {
                console.log('[DeepLink] Received on startup:', url);
                // Handle after app is ready
                electron_1.app.whenReady().then(() => {
                    this.handleDeepLink(url);
                });
            }
        }
    }
    /**
     * Process deep link URL
     */
    handleDeepLink(url) {
        console.log('[DeepLink] Processing:', url);
        try {
            // Validate protocol
            if (!url.startsWith(`${this.protocol}://`)) {
                console.error('[DeepLink] Invalid protocol');
                return;
            }
            // Parse URL
            const urlObj = new URL(url);
            const path = urlObj.hostname + urlObj.pathname;
            const params = Object.fromEntries(urlObj.searchParams);
            console.log('[DeepLink] Path:', path);
            console.log('[DeepLink] Params:', params);
            // Route to appropriate handler
            if (path === 'auth/callback') {
                this.handleAuthCallback(params);
            }
            else if (path === 'open/project') {
                this.handleOpenProject(params);
            }
            else {
                console.warn('[DeepLink] Unknown path:', path);
            }
            // Bring app to foreground
            this.focusWindow();
        }
        catch (error) {
            console.error('[DeepLink] Failed to parse URL:', error);
        }
    }
    /**
     * Handle OAuth callback (for future Web Flow if needed)
     */
    handleAuthCallback(params) {
        const { code, error, error_description } = params;
        if (error) {
            console.error('[DeepLink] Auth error:', error, error_description);
            this.emit('auth:error', {
                error,
                description: error_description,
            });
            return;
        }
        if (!code) {
            console.error('[DeepLink] No code in callback');
            this.emit('auth:error', {
                error: 'no_code',
                description: 'No authorization code received',
            });
            return;
        }
        console.log('[DeepLink] Auth code received');
        this.emit('auth:callback', { code });
    }
    /**
     * Handle open project deep link
     */
    handleOpenProject(params) {
        const { id } = params;
        if (!id) {
            console.error('[DeepLink] No project ID');
            return;
        }
        console.log('[DeepLink] Opening project:', id);
        this.emit('open:project', { projectId: id });
    }
    /**
     * Bring app window to foreground
     */
    focusWindow() {
        if (!this.mainWindow)
            return;
        // Show and focus window
        if (this.mainWindow.isMinimized()) {
            this.mainWindow.restore();
        }
        this.mainWindow.show();
        this.mainWindow.focus();
        // Platform-specific focus behavior
        if (process.platform === 'darwin') {
            // macOS: Bounce dock icon
            electron_1.app.dock?.bounce('informational');
        }
        if (process.platform === 'win32') {
            // Windows: Flash taskbar
            this.mainWindow.flashFrame(true);
            setTimeout(() => {
                this.mainWindow.flashFrame(false);
            }, 1000);
        }
    }
    /**
     * Clean up
     */
    destroy() {
        this.removeAllListeners();
        console.log('[DeepLink] Service destroyed');
    }
}
exports.DeepLinkService = DeepLinkService;
//# sourceMappingURL=DeepLinkService.js.map