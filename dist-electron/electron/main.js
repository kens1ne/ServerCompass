"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Load environment variables from .env file (must be first)
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Load .env from the project root
const envPath = path_1.default.resolve(__dirname, '../../.env');
const result = dotenv_1.default.config({ path: envPath });
if (result.error) {
    console.error('Error loading .env file:', result.error);
}
else {
    console.log('✓ Environment variables loaded from:', envPath);
    console.log('✓ SENTRY_DSN present:', !!process.env.SENTRY_DSN);
}
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const db_1 = require("./db");
const servers_1 = require("./ipc/servers");
const apps_1 = require("./ipc/apps");
const ssh_1 = require("./ipc/ssh");
const metrics_1 = require("./ipc/metrics");
const cron_1 = require("./ipc/cron");
const files_1 = require("./ipc/files");
const git_1 = require("./ipc/git");
const commandLogs_1 = require("./ipc/commandLogs");
const settings_1 = require("./ipc/settings");
const packages_1 = require("./ipc/packages");
const provisioning_1 = require("./ipc/provisioning");
const SSHService_1 = require("./services/SSHService");
const databases_1 = require("./ipc/databases");
const browser_1 = require("./ipc/browser");
// import { registerAutoDeployHandlers } from './ipc/auto-deploy'; // DEPRECATED: Replaced by GitHub Actions
const github_actions_1 = require("./ipc/github-actions");
const github_actions_docker_1 = require("./ipc/github-actions-docker");
const logger_1 = require("./logger");
const license_1 = require("./ipc/license");
const updater_1 = require("./ipc/updater");
const docker_1 = require("./ipc/docker");
const docker_stacks_1 = require("./ipc/docker-stacks");
const traefik_1 = require("./ipc/traefik");
const LicenseService_1 = require("./services/LicenseService");
const UpdatePreferences_1 = require("./services/UpdatePreferences");
const terminal_1 = require("./ipc/terminal");
const templates_1 = require("./ipc/templates");
const CrashReportService_1 = require("./services/CrashReportService");
const crash_reporter_1 = require("./ipc/crash-reporter");
const GitHubAuthService_1 = require("./services/GitHubAuthService");
const GitHubApiService_1 = require("./services/GitHubApiService");
const DeepLinkService_1 = require("./services/DeepLinkService");
const github_1 = require("./ipc/github");
const system_1 = require("./ipc/system");
const SecureStorageService_1 = require("./services/SecureStorageService");
const backup_1 = require("./ipc/backup");
const security_1 = require("./ipc/security");
const monitoring_1 = require("./ipc/monitoring");
const local_docker_1 = require("./ipc/local-docker");
const secrets_1 = require("./ipc/secrets");
const one_click_1 = require("./ipc/one-click");
const tunnel_1 = require("./ipc/tunnel");
const favorite_paths_1 = require("./ipc/favorite-paths");
const backup_s3_1 = require("./ipc/backup-s3");
const migration_1 = require("./ipc/migration");
const local_ssh_1 = require("./ipc/local-ssh");
const BackupSchedulerService_1 = require("./services/BackupSchedulerService");
let mainWindow = null;
let githubAuthService = null;
let githubApiService = null;
let deepLinkService = null;
let allowQuit = false;
let backgroundNoticeKey = null;
const ACTIVE_DEPLOYMENT_STATUSES = ['pending', 'pulling', 'building', 'starting'];
function hasActiveDockerDeployments() {
    try {
        const placeholders = ACTIVE_DEPLOYMENT_STATUSES.map(() => '?').join(', ');
        const row = db_1.db
            .prepare(`SELECT COUNT(*) as count FROM docker_stack_deployments WHERE status IN (${placeholders})`)
            .get(...ACTIVE_DEPLOYMENT_STATUSES);
        return row.count > 0;
    }
    catch (error) {
        console.warn('[Main] Failed to check active deployments:', error);
        return false;
    }
}
function getActiveDockerDeploymentsSummary(limit = 3) {
    try {
        const placeholders = ACTIVE_DEPLOYMENT_STATUSES.map(() => '?').join(', ');
        const countRow = db_1.db
            .prepare(`SELECT COUNT(*) as count FROM docker_stack_deployments WHERE status IN (${placeholders})`)
            .get(...ACTIVE_DEPLOYMENT_STATUSES);
        const rows = db_1.db
            .prepare(`
          SELECT
            d.id as deploymentId,
            s.server_id as serverId,
            sv.name as serverName,
            s.project_name as projectName
          FROM docker_stack_deployments d
          LEFT JOIN docker_stacks s ON s.id = d.stack_id
          LEFT JOIN servers sv ON sv.id = s.server_id
          WHERE d.status IN (${placeholders})
          ORDER BY d.started_at DESC
          LIMIT ?
        `)
            .all(...ACTIVE_DEPLOYMENT_STATUSES, limit);
        return {
            count: typeof countRow?.count === 'number' ? countRow.count : rows.length,
            targets: rows,
        };
    }
    catch (error) {
        console.warn('[Main] Failed to load active deployment summary:', error);
        return { count: 0, targets: [] };
    }
}
function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed())
        return;
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
}
function showDeploymentBackgroundNotice() {
    if (!electron_1.Notification.isSupported())
        return;
    const summary = getActiveDockerDeploymentsSummary(3);
    if (summary.count <= 0)
        return;
    const noticeKey = `${summary.count}:${summary.targets.map((target) => target.deploymentId).join(',')}`;
    if (backgroundNoticeKey === noticeKey)
        return;
    backgroundNoticeKey = noticeKey;
    const primaryTarget = summary.targets[0] ?? null;
    const primaryAppName = primaryTarget?.projectName?.trim() || 'app';
    const serverName = primaryTarget?.serverName?.trim() || null;
    const displayNames = summary.targets
        .map((target) => target.projectName?.trim())
        .filter((name) => Boolean(name));
    const uniqueDisplayNames = Array.from(new Set(displayNames));
    const shownNames = uniqueDisplayNames.slice(0, 2);
    const namesLabel = (() => {
        if (shownNames.length === 0)
            return null;
        const remainingCount = Math.max(0, summary.count - shownNames.length);
        return remainingCount > 0 ? `${shownNames.join(', ')} +${remainingCount} more` : shownNames.join(', ');
    })();
    const title = summary.count === 1 ? `Deploying ${primaryAppName}` : `Deploying ${summary.count} apps`;
    const subtitle = summary.count === 1
        ? (serverName ? `Deployment running • ${serverName}` : 'Deployment running')
        : `Deployments running${namesLabel ? ` • ${namesLabel}` : ''}`;
    const body = summary.count === 1
        ? `Deploying ${primaryAppName} in the background. Click to reopen Server Compass.`
        : namesLabel
            ? `Deploying ${namesLabel} in the background. Click to reopen Server Compass.`
            : 'Server Compass will keep deploying in the background. Click to reopen.';
    const notification = new electron_1.Notification({
        title,
        subtitle,
        body,
    });
    notification.on('click', () => {
        focusMainWindow();
        if (!mainWindow || mainWindow.isDestroyed())
            return;
        if (!primaryTarget?.serverId || !primaryTarget.projectName)
            return;
        const encodedName = encodeURIComponent(primaryTarget.projectName);
        const hashPath = `#/servers/${primaryTarget.serverId}/docker/${encodedName}`;
        void mainWindow.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(hashPath)};`);
    });
    notification.show();
}
// Configure auto-updater logging
electron_updater_1.autoUpdater.logger = logger_1.logger;
electron_updater_1.autoUpdater.autoDownload = false; // Manual download control based on license
electron_updater_1.autoUpdater.autoInstallOnAppQuit = true;
// Use consistent manifest naming: latest-windows.yml, latest-mac.yml, latest-linux.yml
if (process.platform === 'win32') {
    electron_updater_1.autoUpdater.channel = 'latest-windows';
}
const isDev = !electron_1.app.isPackaged && process.env.NODE_ENV !== 'production';
// Set app name early, before app.whenReady()
// In dev mode, Electron doesn't automatically use productName from package.json
electron_1.app.setName('Server Compass');
// Handle single instance lock (must be before app.whenReady())
// This ensures only one instance of the app can run at a time
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.log('[Main] Another instance is running, quitting...');
    electron_1.app.quit();
}
// Note: second-instance handler will be set up by DeepLinkService after app is ready
// Initialize crash reporting before Electron emits 'ready' so Sentry can hook protocols
CrashReportService_1.crashReportService.initialize();
const resolveRendererEntry = () => {
    const appPath = electron_1.app.getAppPath();
    const candidates = [
        { path: path_1.default.resolve(__dirname, '..', '..', 'dist-renderer', 'index.html'), source: 'relative-to-main' },
        { path: path_1.default.join(appPath, 'dist-renderer', 'index.html'), source: 'app-root' },
        { path: path_1.default.join(process.resourcesPath, 'dist-renderer', 'index.html'), source: 'resources-root' },
    ];
    for (const candidate of candidates) {
        if (fs_1.default.existsSync(candidate.path)) {
            return candidate;
        }
    }
    logger_1.logger.error('Renderer index.html not found at expected locations', { appPath, candidates });
    return { ...candidates[0], source: 'missing' };
};
function setupApplicationMenu() {
    const isMac = process.platform === 'darwin';
    const openUpdateCenter = () => {
        if (!mainWindow)
            return;
        mainWindow.webContents.send('updater:open-center');
    };
    const triggerManualUpdateCheck = () => {
        if (!mainWindow)
            return;
        openUpdateCenter();
        mainWindow.webContents.send('updater:menu-check');
    };
    const sendSupportEmail = () => {
        electron_1.shell.openExternal('mailto:hello@stoicsoft.com').catch((error) => {
            logger_1.logger.error('Failed to open email client', error);
        });
    };
    const openDiscord = () => {
        electron_1.shell.openExternal('https://discord.com/invite/666g8mBu5d').catch((error) => {
            logger_1.logger.error('Failed to open Discord link', error);
        });
    };
    const openDocs = () => {
        electron_1.shell.openExternal('https://servercompass.app/docs').catch((error) => {
            logger_1.logger.error('Failed to open Docs link', error);
        });
    };
    const openGettingStarted = () => {
        if (!mainWindow)
            return;
        mainWindow.webContents.send('onboarding:open');
    };
    const updateMenuItems = [
        {
            label: 'Check for Updates…',
            accelerator: 'CmdOrCtrl+Shift+U',
            click: triggerManualUpdateCheck,
        },
        {
            label: 'Software Update…',
            click: openUpdateCenter,
        },
    ];
    const supportMenuItem = {
        label: 'Send Email to Support',
        click: sendSupportEmail,
    };
    const viewSubmenu = [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
    ];
    if (isDev) {
        viewSubmenu.push({ role: 'toggleDevTools' });
    }
    const template = [
        ...(isMac
            ? [
                {
                    label: 'Server Compass',
                    submenu: [
                        { role: 'about' },
                        { type: 'separator' },
                        ...updateMenuItems,
                        { type: 'separator' },
                        { role: 'services' },
                        { type: 'separator' },
                        { role: 'hide' },
                        { role: 'hideOthers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit' },
                    ],
                },
            ]
            : []),
        {
            label: 'File',
            submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                ...(isMac
                    ? [
                        { role: 'pasteAndMatchStyle' },
                        { role: 'delete' },
                        { role: 'selectAll' },
                        { type: 'separator' },
                        {
                            label: 'Speech',
                            submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
                        },
                    ]
                    : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
            ],
        },
        {
            label: 'View',
            submenu: viewSubmenu,
        },
        {
            label: 'Docs',
            submenu: [
                {
                    label: 'Open Documentation',
                    accelerator: 'CmdOrCtrl+Shift+D',
                    click: openDocs,
                },
            ],
        },
        {
            label: 'Support',
            submenu: [
                {
                    label: 'Getting Started',
                    accelerator: 'CmdOrCtrl+Shift+G',
                    click: openGettingStarted,
                },
                { type: 'separator' },
                supportMenuItem,
                {
                    label: 'Join Discord Community',
                    click: openDiscord,
                },
                {
                    label: 'Documentation',
                    click: openDocs,
                },
            ],
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                ...(isMac
                    ? [
                        { type: 'separator' },
                        { role: 'front' },
                        { type: 'separator' },
                        { role: 'window' },
                    ]
                    : [{ role: 'close' }]),
            ],
        },
        ...(!isMac
            ? [
                {
                    label: 'Support',
                    submenu: [
                        {
                            label: 'Getting Started',
                            accelerator: 'CmdOrCtrl+Shift+G',
                            click: openGettingStarted,
                        },
                        { type: 'separator' },
                        supportMenuItem,
                        {
                            label: 'Join Discord Community',
                            click: openDiscord,
                        },
                        {
                            label: 'Documentation',
                            click: openDocs,
                        },
                        { type: 'separator' },
                        ...updateMenuItems,
                    ],
                },
            ]
            : []),
    ];
    const menu = electron_1.Menu.buildFromTemplate(template);
    electron_1.Menu.setApplicationMenu(menu);
}
async function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 768,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webviewTag: true, // Enable <webview> for embedded browser to bypass X-Frame-Options
        },
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        show: false,
    });
    const window = mainWindow;
    if (!window) {
        logger_1.logger.error('Failed to create main window instance');
        return;
    }
    const devServerURL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    const { path: rendererIndexPath, source: rendererSource } = electron_1.app.isPackaged
        ? resolveRendererEntry()
        : { path: path_1.default.join(__dirname, '../../dist-renderer/index.html'), source: 'dev-build' };
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        logger_1.logger.error('Renderer failed to load', { errorCode, errorDescription, validatedURL, isMainFrame, rendererIndexPath });
    });
    window.webContents.once('did-finish-load', () => {
        logger_1.logger.info('Renderer finished loading successfully');
    });
    window.webContents.on('render-process-gone', (_event, details) => {
        logger_1.logger.error('Renderer process terminated unexpectedly', details);
    });
    // Show window when ready
    window.once('ready-to-show', () => {
        logger_1.logger.info('Main window ready to show');
        window.show();
    });
    window.on('close', (event) => {
        if (allowQuit)
            return;
        if (hasActiveDockerDeployments()) {
            event.preventDefault();
            window.hide();
            showDeploymentBackgroundNotice();
        }
    });
    window.on('closed', () => {
        mainWindow = null;
    });
    try {
        if (isDev) {
            logger_1.logger.info('Loading renderer from dev server', devServerURL);
            await window.loadURL(devServerURL);
        }
        else {
            logger_1.logger.info('Loading renderer from file', { rendererIndexPath, rendererSource });
            await window.loadFile(rendererIndexPath);
        }
    }
    catch (error) {
        logger_1.logger.error('Failed to load renderer', error);
        const logFilePath = (0, logger_1.getLogFilePath)();
        const fallbackHtml = `
      <html>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>ServerCompass failed to load.</h2>
          <p>Check the debug log file for details.</p>
          ${logFilePath ? `<p>Log file: ${logFilePath}</p>` : ''}
        </body>
      </html>
    `;
        await window.loadURL(`data:text/html,${encodeURIComponent(fallbackHtml)}`);
    }
}
// Auto-updater event handlers
function setupAutoUpdater() {
    // Only check for updates in production builds
    if (isDev) {
        logger_1.logger.info('Auto-updater disabled in development mode');
        return;
    }
    electron_updater_1.autoUpdater.on('checking-for-update', () => {
        logger_1.logger.info('Checking for updates...');
        mainWindow?.webContents.send('updater:checking-for-update');
    });
    electron_updater_1.autoUpdater.on('update-available', (info) => {
        logger_1.logger.info('Update available', info);
        const skippedVersion = UpdatePreferences_1.updatePreferences.getSkippedVersion();
        if (skippedVersion && skippedVersion === info.version) {
            logger_1.logger.info('Update matches skipped version; notifying renderer but not downloading.', {
                version: info.version,
            });
            mainWindow?.webContents.send('updater:update-skipped', info);
            return;
        }
        // Validate license with Lemon Squeezy API before allowing update
        // This prevents cheating by modifying local expires_at in the database
        const validateAndNotify = async () => {
            const initialInfo = LicenseService_1.licenseService.getLicenseInfo();
            // If user has a license, validate with server to get fresh expires_at
            if (initialInfo.isLicensed && initialInfo.licenseKey && initialInfo.instanceId) {
                logger_1.logger.info('Validating license with server for automatic update check');
                try {
                    await LicenseService_1.licenseService.validateLicense();
                    logger_1.logger.info('License validated successfully with server');
                }
                catch (validationError) {
                    // For automatic checks, allow grace period - user may be offline temporarily
                    logger_1.logger.warn('License validation failed during auto-update check, using cached data', validationError);
                }
            }
            // Re-fetch license info after validation (may have updated expires_at from server)
            const licenseInfo = LicenseService_1.licenseService.getLicenseInfo();
            if (!licenseInfo.canUpdate) {
                logger_1.logger.info('Update available but user license does not permit updates', {
                    isLicensed: licenseInfo.isLicensed,
                    updatesUntil: licenseInfo.updatesUntil,
                });
                mainWindow?.webContents.send('updater:update-not-eligible', {
                    version: info.version,
                    isLicensed: licenseInfo.isLicensed,
                    updatesUntil: licenseInfo.updatesUntil,
                });
                return;
            }
            mainWindow?.webContents.send('updater:update-available', info);
        };
        void validateAndNotify();
    });
    electron_updater_1.autoUpdater.on('update-not-available', (info) => {
        logger_1.logger.info('Update not available', info);
        mainWindow?.webContents.send('updater:update-not-available', info);
    });
    electron_updater_1.autoUpdater.on('download-progress', (progress) => {
        logger_1.logger.info('Download progress', {
            percent: progress.percent.toFixed(2),
            transferred: progress.transferred,
            total: progress.total,
        });
        mainWindow?.webContents.send('updater:download-progress', progress);
    });
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        logger_1.logger.info('Update downloaded', info);
        mainWindow?.webContents.send('updater:update-downloaded', info);
    });
    electron_updater_1.autoUpdater.on('error', (error) => {
        logger_1.logger.error('Auto-updater error', error);
        mainWindow?.webContents.send('updater:error', {
            message: 'Auto-updater error',
            error: error.message,
        });
    });
}
// Initialize app
electron_1.app.whenReady().then(async () => {
    const logFilePath = (0, logger_1.initLogger)();
    logger_1.logger.info('App is ready, initializing...');
    if (logFilePath) {
        logger_1.logger.info('Main process log file:', logFilePath);
    }
    // Setup application menu
    setupApplicationMenu();
    // Run database migrations
    try {
        (0, db_1.runMigrations)();
        logger_1.logger.info('Database initialized successfully');
    }
    catch (error) {
        logger_1.logger.error('Failed to initialize database:', error);
        electron_1.app.quit();
        return;
    }
    // Register IPC handlers
    (0, servers_1.registerServerHandlers)();
    (0, apps_1.registerAppHandlers)();
    (0, ssh_1.registerSSHHandlers)();
    (0, metrics_1.registerMetricsHandlers)();
    (0, cron_1.registerCronHandlers)();
    (0, files_1.registerFileHandlers)();
    (0, git_1.registerGitHandlers)();
    (0, commandLogs_1.registerCommandLogsHandlers)();
    (0, settings_1.registerSettingsHandlers)();
    (0, packages_1.registerPackagesHandlers)();
    (0, provisioning_1.registerProvisioningHandlers)();
    (0, databases_1.registerDatabaseHandlers)();
    (0, browser_1.registerBrowserHandlers)();
    // registerAutoDeployHandlers(); // DEPRECATED: Replaced by GitHub Actions
    (0, github_actions_1.registerGitHubActionsHandlers)();
    (0, github_actions_docker_1.registerGitHubActionsDockerHandlers)();
    (0, license_1.registerLicenseHandlers)();
    (0, updater_1.registerUpdaterHandlers)();
    (0, terminal_1.registerTerminalHandlers)();
    (0, templates_1.registerTemplateHandlers)();
    (0, crash_reporter_1.registerCrashReportHandlers)();
    (0, docker_1.registerDockerHandlers)();
    (0, docker_stacks_1.registerDockerStackHandlers)();
    (0, traefik_1.registerTraefikHandlers)();
    (0, backup_1.registerBackupHandlers)();
    (0, security_1.registerSecurityHandlers)();
    (0, monitoring_1.registerMonitoringHandlers)();
    (0, local_docker_1.registerLocalDockerHandlers)();
    (0, secrets_1.registerSecretVaultHandlers)();
    (0, one_click_1.registerOneClickHandlers)();
    (0, tunnel_1.registerTunnelHandlers)();
    (0, favorite_paths_1.registerFavoritePathsHandlers)();
    (0, backup_s3_1.registerBackupS3Handlers)();
    (0, migration_1.registerMigrationHandlers)();
    (0, local_ssh_1.registerLocalSSHHandlers)();
    // Register system handlers with secure storage
    const secureStorage = new SecureStorageService_1.SecureStorageService();
    (0, system_1.registerSystemHandlers)(secureStorage);
    // Create main window first (needed for GitHub services)
    await createWindow();
    // Initialize GitHub services after window is created
    if (mainWindow) {
        githubAuthService = new GitHubAuthService_1.GitHubAuthService();
        githubApiService = new GitHubApiService_1.GitHubApiService();
        deepLinkService = new DeepLinkService_1.DeepLinkService(mainWindow);
        // Register GitHub handlers
        (0, github_1.registerGitHubHandlers)(githubAuthService, githubApiService);
        // Register deep link protocol
        deepLinkService.registerProtocol();
        // Set main window for local docker service
        (0, local_docker_1.setLocalDockerMainWindow)(mainWindow);
        // Initialize backup scheduler
        BackupSchedulerService_1.backupSchedulerService.setMainWindow(mainWindow);
        void BackupSchedulerService_1.backupSchedulerService.initialize();
        logger_1.logger.info('GitHub services initialized');
    }
    // Periodic license verification - DISABLED
    // setInterval(() => { ... }, 24 * 60 * 60 * 1000);
    // setTimeout(() => { ... }, 30_000);
    // Setup auto-updater - DISABLED
    // setupAutoUpdater();
    // Check for updates - DISABLED
    logger_1.logger.info('Auto-updater and periodic license verification disabled');
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            void createWindow();
        }
        else if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
});
// Cleanup on quit
electron_1.app.on('before-quit', async (event) => {
    if (hasActiveDockerDeployments()) {
        event.preventDefault();
        allowQuit = false;
        mainWindow?.hide();
        showDeploymentBackgroundNotice();
        return;
    }
    allowQuit = true;
    logger_1.logger.info('App is quitting, cleaning up...');
    BackupSchedulerService_1.backupSchedulerService.shutdown();
    (0, tunnel_1.closeAllTunnels)();
    SSHService_1.sshService.disconnectAll();
    // Cleanup GitHub services
    if (githubAuthService) {
        githubAuthService.destroy();
    }
    if (deepLinkService) {
        deepLinkService.destroy();
    }
    await CrashReportService_1.crashReportService.shutdown();
});
// Quit when all windows are closed (except on macOS)
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger_1.logger.error('Uncaught exception:', error);
    CrashReportService_1.crashReportService.captureError(error, {
        type: 'uncaughtException',
        timestamp: new Date().toISOString(),
    });
    // Notify renderer to show crash report dialog
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('crash-report:show-dialog');
    }
});
process.on('unhandledRejection', (reason, promise) => {
    logger_1.logger.error('Unhandled rejection', { promise, reason });
    const error = reason instanceof Error ? reason : new Error(String(reason));
    CrashReportService_1.crashReportService.captureError(error, {
        type: 'unhandledRejection',
        timestamp: new Date().toISOString(),
        promise: String(promise),
    });
    // Notify renderer to show crash report dialog
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('crash-report:show-dialog');
    }
});
//# sourceMappingURL=main.js.map