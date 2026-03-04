"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const types_1 = require("./ipc/types");
// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
electron_1.contextBridge.exposeInMainWorld('api', {
    license: {
        getInfo: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_GET_INFO),
        getLimits: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_GET_LIMITS),
        activate: (licenseKey, email) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_ACTIVATE, { licenseKey, email }),
        validate: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_VALIDATE),
        deactivate: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_DEACTIVATE),
        canAddServer: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_SERVER),
        canAddDeployment: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_DEPLOYMENT),
        canAddDomain: (currentCount = 0) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_DOMAIN, { currentCount }),
        canAddCron: (currentCount = 0) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_CAN_ADD_CRON, { currentCount }),
        canUseAutoDeploy: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_CAN_USE_AUTO_DEPLOY),
        canUseDatabases: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LICENSE_CAN_USE_DATABASES),
    },
    // Server operations
    servers: {
        getAll: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_GET_ALL),
        getById: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_GET_BY_ID, input),
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_CREATE, input),
        update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_UPDATE, input),
        delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_DELETE, input),
        reorder: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_REORDER, input),
        updateGeolocation: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVERS_UPDATE_GEOLOCATION, input),
    },
    // App operations (note: deployments namespace kept for backward compatibility, but renamed to apps)
    apps: {
        getByServer: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APPS_GET_BY_SERVER, input),
        getDeployments: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_GET_DEPLOYMENTS, input),
        updateDeploymentStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_UPDATE_DEPLOYMENT_STATUS, input),
        getAppsFromDeployments: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_GET_FROM_DEPLOYMENTS, input),
        getDeploymentById: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DEPLOYMENT_GET_BY_ID, input),
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DEPLOYMENTS_CREATE, input),
        delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_DELETE, input),
        manualBuild: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_MANUAL_BUILD, input),
        forceFreshDeploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_FORCE_FRESH_DEPLOY, input),
        simpleReload: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_SIMPLE_RELOAD, input),
        checkPortAvailability: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_CHECK_PORT_AVAILABILITY, input),
        // Local deployment operations
        localSelectFolder: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_LOCAL_SELECT_FOLDER),
        localGetFolderInfo: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_LOCAL_GET_FOLDER_INFO, input),
        localDetectFramework: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_LOCAL_DETECT_FRAMEWORK, input),
        localDeploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_LOCAL_DEPLOY, input),
        localReupload: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_LOCAL_REUPLOAD, input),
        localLinkGit: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_LOCAL_LINK_GIT, input),
    },
    // Database operations
    databases: {
        list: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_GET_BY_SERVER, { id: input.serverId }),
        preflight: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_PREFLIGHT, input),
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_CREATE, input),
        status: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_STATUS, input),
        retry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_RETRY, input),
        verify: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_VERIFY, input),
        rotate: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_ROTATE, input),
        toggleAccess: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_TOGGLE_ACCESS, input),
        remove: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_DELETE, input),
        credentials: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_CREDENTIALS, input),
        logs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_LOGS, input),
        onProvisionProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.DATABASE_PROGRESS, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.DATABASE_PROGRESS, handler);
        },
        import: {
            preview: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_IMPORT_PREVIEW, input),
            listTables: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_IMPORT_TABLES, input),
            start: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DATABASES_IMPORT_START, input),
            onProgress: (callback) => {
                const handler = (_event, data) => callback(data);
                electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.DATABASE_IMPORT_PROGRESS, handler);
                return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.DATABASE_IMPORT_PROGRESS, handler);
            },
        },
    },
    // Service deployment operations
    service: {
        deploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SERVICE_DEPLOY, input),
        onDeploymentLog: (callback) => {
            const listener = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.DEPLOYMENT_LOG, listener);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.DEPLOYMENT_LOG, listener);
        },
    },
    // Template operations
    template: {
        list: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TEMPLATE_LIST, {}),
        deploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TEMPLATE_DEPLOY, input),
    },
    // SSH operations
    ssh: {
        testConnection: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_TEST_CONNECTION, input),
        testExistingConnection: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_TEST_EXISTING_CONNECTION, { id: input.serverId }),
        executeCommand: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_EXECUTE_COMMAND, input),
        generateKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_GENERATE_KEY, input),
        listKeys: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_LIST_KEYS),
        listKeysProgressive: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_LIST_KEYS_PROGRESSIVE, input),
        onKeyScanProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.SSH_KEY_SCAN_PROGRESS, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.SSH_KEY_SCAN_PROGRESS, handler);
        },
        readKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_READ_KEY, input),
        deleteKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_DELETE_KEY, input),
        getNetworkInterfaces: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_GET_NETWORK_INTERFACES, input),
        dnsLookup: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SSH_DNS_LOOKUP, input),
    },
    // Local SSH operations (runs on user's machine)
    localSSH: {
        keyscan: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_SSH_KEYSCAN, input),
        test: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_SSH_TEST, input),
        configure: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_SSH_CONFIGURE, input),
    },
    // Provisioning operations
    provision: {
        server: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.PROVISION_SERVER, input),
        installNginxCertbot: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.PROVISION_INSTALL_NGINX_CERTBOT, input),
    },
    // Domain operations
    domain: {
        configure: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOMAIN_CONFIGURE, input),
    },
    // Metrics operations
    metrics: {
        get: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.METRICS_GET, input),
        getQuick: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.METRICS_GET_QUICK, input),
    },
    // Cron operations
    cron: {
        list: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_LIST, input),
        saveMetadata: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_SAVE_METADATA, input),
        updateJob: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_UPDATE_JOB, input),
        toggleJob: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_TOGGLE_JOB, input),
        deleteJob: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_DELETE_JOB, input),
        addJob: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_ADD_JOB, input),
        // Cron log operations
        getLogs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_GET_LOGS, input),
        clearLogs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_CLEAR_LOGS, input),
        getLogInfo: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_GET_LOG_INFO, input),
        wrapCommand: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRON_WRAP_COMMAND, input),
    },
    // Terminal operations
    terminal: {
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TERMINAL_CREATE, input),
        input: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TERMINAL_INPUT, input),
        resize: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TERMINAL_RESIZE, input),
        close: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TERMINAL_CLOSE, input),
        openWindow: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TERMINAL_OPEN_WINDOW, input),
        onData: (callback) => {
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.TERMINAL_DATA, (_event, data) => callback(data));
        },
        onExit: (callback) => {
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.TERMINAL_EXIT, (_event, data) => callback(data));
        },
    },
    // File operations
    files: {
        selectFile: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FILE_SELECT, input),
        selectFolder: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FOLDER_SELECT, input),
        uploadFile: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FILE_UPLOAD, input),
        uploadFolder: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FOLDER_UPLOAD, input),
        downloadFile: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FILE_DOWNLOAD, input),
        createFolder: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FOLDER_CREATE, input),
        reveal: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FILE_REVEAL, input),
        onFileUploadProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('file:upload:progress', handler);
            // Return cleanup function
            return () => electron_1.ipcRenderer.removeListener('file:upload:progress', handler);
        },
        onFolderUploadProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('folder:upload:progress', handler);
            // Return cleanup function
            return () => electron_1.ipcRenderer.removeListener('folder:upload:progress', handler);
        },
        onCompressionProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('files:compression:progress', handler);
            // Return cleanup function
            return () => electron_1.ipcRenderer.removeListener('files:compression:progress', handler);
        },
        onFileDownloadProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('file:download:progress', handler);
            // Return cleanup function
            return () => electron_1.ipcRenderer.removeListener('file:download:progress', handler);
        },
    },
    // Git setup operations
    git: {
        checkConnection: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_CHECK_CONNECTION, input),
        generateKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_GENERATE_KEY, input),
        readPublicKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_READ_PUBLIC_KEY, input),
        readPrivateKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_READ_PRIVATE_KEY, input),
        configureSSH: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_CONFIGURE_SSH, input),
        detectFramework: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_DETECT_FRAMEWORK, input),
        listSSHKeys: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_LIST_SSH_KEYS, input),
        fetchBranches: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_FETCH_BRANCHES, input),
        listServerKeys: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_LIST_SERVER_KEYS, input),
        testKeyConnection: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_TEST_KEY_CONNECTION, input),
        deleteServerKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_DELETE_SERVER_KEY, input),
        renameServerKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_RENAME_SERVER_KEY, input),
        listAccounts: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_LIST_ACCOUNTS, input),
        createAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_CREATE_ACCOUNT, input),
        updateAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_UPDATE_ACCOUNT, input),
        deleteAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_DELETE_ACCOUNT, input),
        revokeAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_REVOKE_ACCOUNT, input),
        checkAccountStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_CHECK_ACCOUNT_STATUS, input),
        testSSHKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_TEST_SSH_KEY, input),
        detectMismatchedRepos: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_DETECT_MISMATCHED_REPOS, input),
        fixRepositoryRemotes: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_FIX_REPOSITORY_REMOTES, input),
        setDefaultAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_SET_DEFAULT_ACCOUNT, input),
        getRepos: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_GET_REPOS, input),
        bindApp: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_BIND_APP, input),
        getAccountMappings: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_GET_ACCOUNT_MAPPINGS, input),
        cloneWithAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_CLONE_WITH_ACCOUNT, input),
        switchRepoAccount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.GIT_SWITCH_REPO_ACCOUNT, input),
    },
    // Progress events
    onProgress: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.PROGRESS_UPDATE, (_event, data) => callback(data));
    },
    onLogStream: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.LOG_STREAM, (_event, data) => callback(data));
    },
    // Command logs operations
    commandLogs: {
        get: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.COMMAND_LOGS_GET, input),
        getSize: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.COMMAND_LOGS_GET_SIZE, input),
        deleteAll: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.COMMAND_LOGS_DELETE_ALL, input),
        export: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.COMMAND_LOGS_EXPORT, input),
    },
    // Settings operations
    settings: {
        get: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SETTINGS_GET, input),
        set: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SETTINGS_SET, input),
    },
    // App preferences operations
    appPreferences: {
        get: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_PREFERENCES_GET),
        set: (prefs) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_PREFERENCES_SET, prefs),
        getMaxLogLines: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_PREFERENCES_GET_MAX_LOG_LINES),
        setMaxLogLines: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_PREFERENCES_SET_MAX_LOG_LINES, input),
    },
    // App operations
    app: {
        getVersion: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.APP_GET_VERSION),
    },
    // Package management operations
    packages: {
        list: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.PACKAGES_LIST, input),
        update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.PACKAGES_UPDATE, input),
        remove: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.PACKAGES_REMOVE, input),
        installRecommended: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.PACKAGES_INSTALL_RECOMMENDED, input),
    },
    // Browser navigation operations
    browser: {
        openExternal: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, input),
    },
    // Shell operations
    shell: {
        openExternal: (url) => electron_1.shell.openExternal(url),
    },
    // Auto-deploy operations
    autoDeploy: {
        enable: (input) => electron_1.ipcRenderer.invoke('auto-deploy:enable', input),
        disable: (input) => electron_1.ipcRenderer.invoke('auto-deploy:disable', input),
        getStatus: (input) => electron_1.ipcRenderer.invoke('auto-deploy:get-status', input),
        getAll: (input) => electron_1.ipcRenderer.invoke('auto-deploy:get-all', input),
        getSettings: (input) => electron_1.ipcRenderer.invoke('auto-deploy:get-settings', input),
        checkNow: (input) => electron_1.ipcRenderer.invoke('auto-deploy:check-now', input),
        getLogs: (input) => electron_1.ipcRenderer.invoke('auto-deploy:get-logs', input),
        updateTick: (input) => electron_1.ipcRenderer.invoke('auto-deploy:update-tick', input),
        setupInfrastructure: (input) => electron_1.ipcRenderer.invoke('auto-deploy:setup-infrastructure', input),
    },
    // GitHub Actions deployment operations
    githubActions: {
        enable: (input) => electron_1.ipcRenderer.invoke('github-actions:enable', input),
        disable: (input) => electron_1.ipcRenderer.invoke('github-actions:disable', input),
        getConfig: (input) => electron_1.ipcRenderer.invoke('github-actions:get-config', input),
        isEnabled: (input) => electron_1.ipcRenderer.invoke('github-actions:is-enabled', input),
        getWorkflowRuns: (input) => electron_1.ipcRenderer.invoke('github-actions:get-workflow-runs', input),
        triggerDeploy: (input) => electron_1.ipcRenderer.invoke('github-actions:trigger-deploy', input),
        syncWorkflow: (input) => electron_1.ipcRenderer.invoke('github-actions:sync-workflow', input),
        updateConfig: (input) => electron_1.ipcRenderer.invoke('github-actions:update-config', input),
    },
    githubActionsDocker: {
        previewWorkflow: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:preview-workflow', input),
        setup: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:setup', input),
        wait: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:wait', input),
        getJobStatus: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:get-job-status', input),
        getJobLogs: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:get-job-logs', input),
        pushEnvSecret: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:push-env-secret', input),
        pushNextPublicSecret: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:push-next-public-secret', input),
        saveDeploymentLogs: (input) => electron_1.ipcRenderer.invoke('github-actions-docker:save-deployment-logs', input),
    },
    // Auto-updater operations
    updater: {
        checkForUpdates: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_CHECK_FOR_UPDATES),
        downloadUpdate: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE),
        quitAndInstall: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL),
        getCurrentVersion: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_GET_CURRENT_VERSION),
        skipVersion: (version) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_SKIP_VERSION, { version }),
        clearSkippedVersion: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_CLEAR_SKIPPED_VERSION),
        getPreferences: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.UPDATER_GET_PREFERENCES),
        onCheckingForUpdate: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_CHECKING_FOR_UPDATE, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_CHECKING_FOR_UPDATE, handler);
        },
        onUpdateAvailable: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_UPDATE_AVAILABLE, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_UPDATE_AVAILABLE, handler);
        },
        onUpdateNotAvailable: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_UPDATE_NOT_AVAILABLE, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_UPDATE_NOT_AVAILABLE, handler);
        },
        onUpdateNotEligible: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_UPDATE_NOT_ELIGIBLE, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_UPDATE_NOT_ELIGIBLE, handler);
        },
        onDownloadProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_DOWNLOAD_PROGRESS, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_DOWNLOAD_PROGRESS, handler);
        },
        onUpdateDownloaded: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_UPDATE_DOWNLOADED, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_UPDATE_DOWNLOADED, handler);
        },
        onError: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_ERROR, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_ERROR, handler);
        },
        onUpdateSkipped: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.UPDATER_UPDATE_SKIPPED, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.UPDATER_UPDATE_SKIPPED, handler);
        },
        onOpenSoftwareUpdate: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('updater:open-center', handler);
            return () => electron_1.ipcRenderer.removeListener('updater:open-center', handler);
        },
        onMenuCheckForUpdates: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('updater:menu-check', handler);
            return () => electron_1.ipcRenderer.removeListener('updater:menu-check', handler);
        },
        // DEV ONLY: Simulate update for testing UI
        // devSimulateUpdate: (mockInfo?: any): Promise<ApiResult<void>> =>
        //   ipcRenderer.invoke('updater:dev-simulate-update', mockInfo),
    },
    // Crash report operations
    docker: {
        deploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_DEPLOY, input),
        redeploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REDEPLOY, input),
        getDeployments: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_GET_DEPLOYMENTS, { id: serverId }),
        getDeployment: (deploymentId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_GET_DEPLOYMENT, deploymentId),
        ps: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_PS, input),
        logs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_LOGS, input),
        startLogStream: (input) => {
            electron_1.ipcRenderer.send(types_1.IPC_CHANNELS.DOCKER_LOGS_STREAM_START, input);
        },
        stopLogStream: (streamId) => {
            electron_1.ipcRenderer.send(types_1.IPC_CHANNELS.DOCKER_LOGS_STREAM_STOP, streamId);
        },
        onLogsData: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.DOCKER_LOGS_DATA, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.DOCKER_LOGS_DATA, handler);
        },
        restart: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_RESTART, input),
        stop: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STOP, input),
        start: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_START, input),
        testRegistry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_TEST_REGISTRY, input),
        getStats: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_GET_STATS, input),
        updateCompose: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_UPDATE_COMPOSE, input),
        onLog: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.DOCKER_LOG, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.DOCKER_LOG, handler);
        },
    },
    // Enhanced Docker Stack API
    dockerStacks: {
        // Stack operations
        deploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_DEPLOY, input),
        list: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_LIST, { id: serverId }),
        get: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_GET, input),
        getStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_STATUS, input),
        // Batch fetch all containers for a server (much faster than individual getStatus calls)
        getAllContainers: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_ALL_CONTAINERS, { id: serverId }),
        // Get container stats (CPU, memory) - separate for progressive loading
        getContainerStats: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_CONTAINER_STATS, { id: serverId }),
        redeploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_REDEPLOY, input),
        rollback: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_ROLLBACK, input),
        updateDeploymentStrategy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_STRATEGY, input),
        updateBuildLocation: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_BUILD_LOCATION, input),
        clearPendingFailure: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_CLEAR_PENDING_FAILURE, input),
        start: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_START, input),
        stop: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_STOP, input),
        restart: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_RESTART, input),
        delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_DELETE, input),
        updateCompose: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_COMPOSE, input),
        updateEnv: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_UPDATE_ENV, input),
        logs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_LOGS, input),
        getDeployments: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_DEPLOYMENTS, input),
        // Get all deployments for a server (across all stacks)
        getServerDeployments: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_SERVER_DEPLOYMENTS, input),
        // Get single deployment by ID (with logs)
        getDeploymentById: (deploymentId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_DEPLOYMENT_BY_ID, { deploymentId }),
        checkProjectName: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_CHECK_PROJECT_NAME, input),
        /**
         * Detect unmanaged applications on the server
         *
         * Identifies applications that are running on the server but NOT deployed/managed by Server Compass.
         * This helps users discover existing applications that were deployed manually or by other tools.
         *
         * DETECTION PROCESS:
         * ==================
         *
         * 1. PORT SCANNING
         *    - Scans all listening ports using `ss` (preferred) or `netstat` (fallback)
         *    - Extracts: port number, process name, and PID for each listening port
         *
         * 2. FILTERING
         *    - Excludes reserved infrastructure ports (22=SSH, 80=HTTP, 443=HTTPS)
         *    - Excludes system services (sshd, systemd, mail servers, FTP servers)
         *    - Groups ports by process (handles apps on multiple ports)
         *
         * 3. CLASSIFICATION
         *    Detects and classifies:
         *    - Docker containers: Via docker-proxy processes, enriched with container metadata
         *    - PM2 apps: Node.js applications managed by PM2
         *    - Databases: PostgreSQL, MySQL, Redis, MongoDB
         *    - Web servers: Nginx, Apache
         *    - Application runtimes: Node.js, Next.js, Python, Java, PHP, Ruby
         *
         * 4. MANAGEMENT CHECK
         *    - Docker: Checks if project name exists in docker_stacks database table
         *    - PM2: Checks if app name exists in deployments database table
         *    - Returns only applications NOT managed by Server Compass
         *
         * RETURNED DATA:
         * ==============
         * {
         *   hasUnmanaged: boolean,  // Quick check if any unmanaged apps exist
         *   unmanagedApps: [
         *     {
         *       containerId: string,    // Unique ID (e.g., "docker-12345", "pm2-3", "proc-9876")
         *       name: string,           // Display name (container name, app name, or process name)
         *       image: string,          // Type/category (e.g., "Next.js App", "PostgreSQL", "Docker Container")
         *       status: "running",      // Always "running" (only active processes are detected)
         *       ports: [                // Array of listening ports
         *         {
         *           hostPort: number,
         *           containerPort: number,
         *           protocol: "tcp" | "udp"
         *         }
         *       ],
         *       created: string,        // Creation timestamp (empty for most non-Docker apps)
         *       projectName?: string    // Project identifier (if applicable)
         *     }
         *   ]
         * }
         *
         * EXAMPLE DETECTIONS:
         * ===================
         * - Next.js app on port 3000 → { name: "next-server", image: "Next.js App", ports: [3000] }
         * - PostgreSQL on 5432 → { name: "PostgreSQL", image: "Database (PostgreSQL)", ports: [5432] }
         * - Nginx on 7777, 8888 → { name: "Nginx", image: "Web Server (Nginx)", ports: [7777, 8888] }
         * - Docker container on 5502 → { name: "my-app", image: "node:18", ports: [5502] }
         *
         * @param serverId - The server ID to scan for unmanaged applications
         * @returns Promise with detection results
         *
         * @see UnmanagedAppDetectionService in electron/services/UnmanagedAppDetectionService.ts
         *      for detailed implementation documentation
         */
        detectUnmanaged: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_DETECT_UNMANAGED, { serverId }),
        /**
         * Remove an unmanaged application from the server.
         *
         * This removes Docker containers (docker rm) or kills processes (kill).
         * WARNING: This action cannot be undone!
         *
         * @param serverId - The server ID
         * @param containerId - The container/process ID to remove
         * @param force - Force removal (default: true)
         */
        removeUnmanaged: (serverId, containerId, force = true) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_STACK_REMOVE_UNMANAGED, {
            serverId,
            containerId,
            force,
        }),
        onStackLog: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.DOCKER_STACK_LOG, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.DOCKER_STACK_LOG, handler);
        },
        // Real-time analysis progress logs (user-friendly messages from docker-stacks.ts)
        onAnalysisLog: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('docker:analysis:log', handler);
            return () => electron_1.ipcRenderer.removeListener('docker:analysis:log', handler);
        },
        // Buildpack operations
        checkBuildpackTools: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_CHECK, { id: serverId }),
        installNixpacks: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_INSTALL, { serverId }),
        previewBuildpack: (params) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_PREVIEW, params),
        previewGithubWithBuildpack: (params) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_BUILDPACK_PREVIEW_GITHUB, params),
        // Registry operations
        listRegistries: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REGISTRY_LIST, { id: serverId }),
        addRegistry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REGISTRY_ADD, input),
        updateRegistry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REGISTRY_UPDATE, input),
        deleteRegistry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REGISTRY_DELETE, input),
        testRegistry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REGISTRY_TEST, input),
        loginRegistry: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_REGISTRY_LOGIN, input),
        // Template operations
        listTemplates: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_TEMPLATE_LIST),
        getTemplate: (templateId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_TEMPLATE_GET, { templateId }),
        renderTemplate: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_TEMPLATE_RENDER, input),
        generateSupabaseJWT: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_SUPABASE_JWT_GENERATE, input),
        // Compose validation
        validateCompose: (content) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_COMPOSE_VALIDATE, { content }),
        sanitizeCompose: (content) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_COMPOSE_SANITIZE, { content }),
        // Host operations
        checkDocker: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_HOST_CHECK, { serverId }),
        installDocker: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_HOST_INSTALL, { serverId }),
        // Generate compose from framework
        generateCompose: (input) => electron_1.ipcRenderer.invoke('docker:generate-compose', input),
    },
    // Staging/Preview Environments API
    environments: {
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_CREATE, input),
        list: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_LIST, input),
        delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_DELETE, input),
        promote: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_PROMOTE, input),
        updateSettings: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_UPDATE_SETTINGS, input),
        deployBranch: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_DEPLOY_BRANCH, input),
        reconcile: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_RECONCILE, input),
        cleanupExpired: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DOCKER_ENVIRONMENT_CLEANUP_EXPIRED, { serverId }),
    },
    github: {
        startAuth: () => electron_1.ipcRenderer.invoke('github:start-auth'),
        checkAuth: () => electron_1.ipcRenderer.invoke('github:check-auth'),
        getRepos: () => electron_1.ipcRenderer.invoke('github:get-repos'),
        detectFramework: (owner, repo) => electron_1.ipcRenderer.invoke('github:detect-framework', owner, repo),
        getBranches: (owner, repo) => electron_1.ipcRenderer.invoke('github:get-branches', owner, repo),
        signOut: () => electron_1.ipcRenderer.invoke('github:sign-out'),
        uploadSSHKey: (title, publicKey) => electron_1.ipcRenderer.invoke('github:upload-ssh-key', title, publicKey),
        listSSHKeys: () => electron_1.ipcRenderer.invoke('github:list-ssh-keys'),
        deleteSSHKey: (keyId) => electron_1.ipcRenderer.invoke('github:delete-ssh-key', keyId),
        listAccounts: () => electron_1.ipcRenderer.invoke('github:list-accounts'),
        getActiveAccount: () => electron_1.ipcRenderer.invoke('github:get-active-account'),
        switchAccount: (username) => electron_1.ipcRenderer.invoke('github:switch-account', username),
        signOutAccount: (username) => electron_1.ipcRenderer.invoke('github:sign-out-account', username),
        getReposForAccount: (username) => electron_1.ipcRenderer.invoke('github:get-repos-for-account', username),
        getAccountIdByUsername: (username, provider) => electron_1.ipcRenderer.invoke('github:get-account-id-by-username', username, provider || 'github'),
        analyzeRepoForDocker: (owner, repo) => electron_1.ipcRenderer.invoke('github:analyze-repo-for-docker', owner, repo),
        // Server-scoped Git account management
        getServerAccounts: (serverId) => electron_1.ipcRenderer.invoke('github:get-server-accounts', serverId),
        getAllAccounts: () => electron_1.ipcRenderer.invoke('github:get-all-accounts'),
        linkToServer: (serverId, gitAccountId, isDefault = false) => electron_1.ipcRenderer.invoke('github:link-to-server', serverId, gitAccountId, isDefault),
        unlinkFromServer: (serverId, gitAccountId) => electron_1.ipcRenderer.invoke('github:unlink-from-server', serverId, gitAccountId),
        setServerDefault: (serverId, gitAccountId) => electron_1.ipcRenderer.invoke('github:set-server-default', serverId, gitAccountId),
        getServerDefault: (serverId) => electron_1.ipcRenderer.invoke('github:get-server-default', serverId),
        getServerRepos: (serverId) => electron_1.ipcRenderer.invoke('github:get-server-repos', serverId),
        createRepo: (options) => electron_1.ipcRenderer.invoke('github:createRepo', options),
        commitFiles: (options) => electron_1.ipcRenderer.invoke('github:commitFiles', options),
        onAuthenticated: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('github:authenticated', handler);
            return () => electron_1.ipcRenderer.removeListener('github:authenticated', handler);
        },
        onAuthError: (callback) => {
            const handler = (_event, error) => callback(error);
            electron_1.ipcRenderer.on('github:auth-error', handler);
            return () => electron_1.ipcRenderer.removeListener('github:auth-error', handler);
        },
        onSignedOut: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('github:signed-out', handler);
            return () => electron_1.ipcRenderer.removeListener('github:signed-out', handler);
        },
        onAccountSwitched: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('github:account-switched', handler);
            return () => electron_1.ipcRenderer.removeListener('github:account-switched', handler);
        },
        onAccountRemoved: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on('github:account-removed', handler);
            return () => electron_1.ipcRenderer.removeListener('github:account-removed', handler);
        },
    },
    system: {
        checkKeychainAccess: (forceCheck) => electron_1.ipcRenderer.invoke('system:check-keychain-access', { forceCheck }),
        clearKeychainCache: () => electron_1.ipcRenderer.invoke('system:clear-keychain-cache'),
        openKeychainSettings: () => electron_1.ipcRenderer.invoke('system:open-keychain-settings'),
    },
    traefik: {
        setup: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_SETUP, input),
        isInstalled: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_IS_INSTALLED, input),
        getVersion: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_GET_VERSION, input),
        restart: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_RESTART, input),
        getLogs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_GET_LOGS, input),
        getConfig: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_GET_CONFIG, input),
        updateEmail: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_UPDATE_EMAIL, input),
        removeGlobalRedirect: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_REMOVE_GLOBAL_REDIRECT, input),
        detectReverseProxy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_DETECT_REVERSE_PROXY, input),
        domain: {
            configure: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_CONFIGURE, input),
            update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_UPDATE, input),
            delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_DELETE, input),
            list: (serverId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_LIST, { serverId }),
            get: (domainId) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_DOMAIN_GET, domainId),
            getCertificateInfo: (serverId, domain) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TRAEFIK_CERTIFICATE_INFO, { serverId, domain }),
        },
    },
    crashReport: {
        submit: (userComment) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRASH_REPORT_SUBMIT, { userComment }),
        dismiss: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRASH_REPORT_DISMISS),
        hasPending: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRASH_REPORT_HAS_PENDING),
        getPending: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRASH_REPORT_GET_PENDING),
        addBreadcrumb: (message, category, data) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRASH_REPORT_ADD_BREADCRUMB, { message, category, data }),
        captureRendererError: (message, stack) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CRASH_REPORT_CAPTURE_RENDERER_ERROR, { message, stack }),
        onShowDialog: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.CRASH_REPORT_SHOW_DIALOG, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.CRASH_REPORT_SHOW_DIALOG, handler);
        },
    },
    onboarding: {
        onOpen: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('onboarding:open', handler);
            return () => electron_1.ipcRenderer.removeListener('onboarding:open', handler);
        },
    },
    // Security operations
    security: {
        // fail2ban
        getFail2BanStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_STATUS, input),
        installFail2Ban: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_INSTALL, input),
        configureFail2Ban: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_CONFIGURE, input),
        unbanIP: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_UNBAN, input),
        updateWhitelist: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_FAIL2BAN_WHITELIST, input),
        // UFW Firewall
        getUFWStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_STATUS, input),
        installUFW: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_INSTALL, input),
        enableUFW: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_ENABLE, input),
        disableUFW: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_DISABLE, input),
        addUFWRule: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_ADD_RULE, input),
        deleteUFWRule: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_DELETE_RULE, input),
        setUFWDefault: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UFW_SET_DEFAULT, input),
        // SSH Hardening
        getSSHStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_SSH_STATUS, input),
        configureSSH: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_SSH_CONFIGURE, input),
        changeSSHPort: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_SSH_CHANGE_PORT, input),
        // Auto Updates
        getAutoUpdatesStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UPDATES_STATUS, input),
        installAutoUpdates: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UPDATES_INSTALL, input),
        configureAutoUpdates: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UPDATES_CONFIGURE, input),
        checkForUpdates: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UPDATES_CHECK, input),
        applyUpdates: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_UPDATES_APPLY, input),
        // Security Audit
        runAudit: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_AUDIT, input),
        quickHarden: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_QUICK_HARDEN, input),
        testUsername: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_TEST_USERNAME, input),
        // User Management
        listUsers: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_USERS_LIST, input),
        createUser: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_USERS_CREATE, input),
        deleteUser: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_USERS_DELETE, input),
        addUserSSHKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_USERS_ADD_KEY, input),
        listUserSSHKeys: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_USERS_LIST_KEYS, input),
        removeUserSSHKey: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECURITY_USERS_REMOVE_KEY, input),
    },
    // Backup operations
    backup: {
        // Local file backup (existing)
        export: (input) => electron_1.ipcRenderer.invoke('backup:export', input),
        preview: (input) => electron_1.ipcRenderer.invoke('backup:preview', input),
        import: (input) => electron_1.ipcRenderer.invoke('backup:import', input),
        selectFile: () => electron_1.ipcRenderer.invoke('backup:selectFile'),
        // S3 Storage configuration
        storage: {
            list: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_STORAGE_LIST),
            create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_STORAGE_CREATE, input),
            update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_STORAGE_UPDATE, input),
            delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_STORAGE_DELETE, input),
            test: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_STORAGE_TEST, input),
            setDefault: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_STORAGE_SET_DEFAULT, input),
        },
        // Backup passphrase (stored in system keychain, per-storage config)
        passphrase: {
            has: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_HAS, input),
            set: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_SET, input),
            clear: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_CLEAR, input),
            verify: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_PASSPHRASE_VERIFY, input),
        },
        // App config backup schedule
        appSchedule: {
            get: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_GET_SCHEDULE),
            update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_UPDATE_SCHEDULE, input),
            runNow: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_RUN_NOW, input),
            listJobs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_LIST_JOBS, input),
            listFromS3: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_LIST_FROM_S3, input),
            previewFromS3: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_PREVIEW_FROM_S3, input),
            importFromS3: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_IMPORT_FROM_S3, input),
            downloadFromS3: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_DOWNLOAD_FROM_S3, input),
            deleteFromS3: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_APP_DELETE_FROM_S3, input),
        },
        // Server data backup
        server: {
            getConfig: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_GET_CONFIG, input),
            updateConfig: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_UPDATE_CONFIG, input),
            runNow: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_RUN_NOW, input),
            cancel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_CANCEL, input),
            listJobs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_LIST_JOBS, input),
            listFromS3: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_LIST_FROM_S3, input),
            getManifest: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_GET_MANIFEST, input),
            restore: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.BACKUP_SERVER_RESTORE, input),
        },
        // Progress events
        onProgress: (callback) => {
            const handler = (_event, data) => callback(data);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.BACKUP_PROGRESS, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.BACKUP_PROGRESS, handler);
        },
    },
    // Monitoring operations
    monitoring: {
        // Agent configuration
        getConfig: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_CONFIG, input),
        updateConfig: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_UPDATE_CONFIG, input),
        // Agent status and installation
        getAgentStatus: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_AGENT_STATUS, input),
        installAgent: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_INSTALL_AGENT, input),
        uninstallAgent: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_UNINSTALL_AGENT, input),
        pushConfig: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_PUSH_CONFIG, input),
        getAgentLogs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_AGENT_LOGS, input),
        triggerRun: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_TRIGGER_RUN, input),
        testNotification: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_TEST_NOTIFICATION, input),
        testNotificationChannel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_TEST_NOTIFICATION_CHANNEL, input),
        sendNotification: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_SEND_NOTIFICATION, input),
        getAgentSource: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_AGENT_SOURCE),
        checkDependencies: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_CHECK_DEPENDENCIES, input),
        // Alert rules
        getAlertRules: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_ALERT_RULES, input),
        createAlertRule: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_CREATE_ALERT_RULE, input),
        updateAlertRule: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_UPDATE_ALERT_RULE, input),
        deleteAlertRule: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_DELETE_ALERT_RULE, input),
        initDefaultRules: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_INIT_DEFAULT_RULES, input),
        // Notification channels
        getNotificationChannels: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_NOTIFICATION_CHANNELS, input),
        createNotificationChannel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_CREATE_NOTIFICATION_CHANNEL, input),
        updateNotificationChannel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_UPDATE_NOTIFICATION_CHANNEL, input),
        deleteNotificationChannel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_DELETE_NOTIFICATION_CHANNEL, input),
        // Alerts history
        getAlerts: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_ALERTS, input),
        getActiveAlertCount: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_GET_ACTIVE_ALERT_COUNT, input),
        syncAlerts: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MONITORING_SYNC_ALERTS, input),
    },
    // Local Docker Build operations
    localDocker: {
        // Check if Docker is available locally
        check: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_CHECK),
        // Validate build context
        validateContext: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_VALIDATE_CONTEXT, input),
        // Test git repository access (lightweight check)
        testGitAccess: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_TEST_GIT_ACCESS, input),
        // Clone repository locally for building
        clone: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_CLONE, input),
        // Cleanup cloned repository
        cleanupClone: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_CLEANUP_CLONE, input),
        // Build Docker image locally
        build: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD, input),
        // Stream image to server
        stream: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_STREAM, input),
        // Full deployment with local build
        deploy: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_DEPLOY, input),
        // Cancel build or stream
        cancel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_CANCEL, input),
        // Cleanup local image
        cleanup: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_CLEANUP, input),
        // Get build history
        getBuilds: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOCAL_DOCKER_GET_BUILDS, input || {}),
        // Event listeners for build progress
        onBuildProgress: (callback) => {
            const handler = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_PROGRESS, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_PROGRESS, handler);
        },
        // Event listeners for build logs
        onBuildLog: (callback) => {
            const handler = (_event, log) => callback(log);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_LOG, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.LOCAL_DOCKER_BUILD_LOG, handler);
        },
        // Event listeners for upload progress
        onUploadProgress: (callback) => {
            const handler = (_event, progress) => callback(progress);
            electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.LOCAL_DOCKER_UPLOAD_PROGRESS, handler);
            return () => electron_1.ipcRenderer.removeListener(types_1.IPC_CHANNELS.LOCAL_DOCKER_UPLOAD_PROGRESS, handler);
        },
    },
    // Secret Vault operations
    secrets: {
        getAll: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_GET_ALL),
        getById: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_GET_BY_ID, input),
        getSecrets: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_GET_SECRETS, input),
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_CREATE, input),
        update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_UPDATE, input),
        delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_DELETE, input),
        importEnv: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_IMPORT_ENV, input),
        selectEnvFiles: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_SELECT_ENV_FILES),
        exportEnv: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SECRETS_EXPORT_ENV, input),
    },
    // Tunnel operations
    tunnel: {
        open: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TUNNEL_OPEN, input),
        close: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TUNNEL_CLOSE, input),
        status: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TUNNEL_STATUS, input),
        list: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.TUNNEL_LIST),
    },
    // One-Click Install operations
    oneClick: {
        getTemplates: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_GET_TEMPLATES),
        getTemplate: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_GET_TEMPLATE, input),
        checkPrerequisites: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_CHECK_PREREQUISITES, input),
        install: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_INSTALL, input),
        sendInput: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_SEND_INPUT, input),
        getInstallations: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_GET_INSTALLATIONS, input),
        getInstallation: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_GET_INSTALLATION, input),
        start: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_START, input),
        stop: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_STOP, input),
        restart: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_RESTART, input),
        status: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_STATUS, input),
        logs: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_LOGS, input),
        uninstall: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_UNINSTALL, input),
        update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_UPDATE, input),
        getActions: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_GET_ACTIONS, input),
        executeAction: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_EXECUTE_ACTION, input),
        getActionOptions: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.ONE_CLICK_GET_ACTION_OPTIONS, input),
        // Event listeners
        onLog: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('oneClick:log', handler);
            return () => electron_1.ipcRenderer.removeListener('oneClick:log', handler);
        },
        onPrompt: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('oneClick:prompt', handler);
            return () => electron_1.ipcRenderer.removeListener('oneClick:prompt', handler);
        },
        onProgress: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('oneClick:progress', handler);
            return () => electron_1.ipcRenderer.removeListener('oneClick:progress', handler);
        },
    },
    // Favorite Paths operations
    favoritePaths: {
        list: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FAVORITE_PATHS_LIST, input),
        create: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FAVORITE_PATHS_CREATE, input),
        update: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FAVORITE_PATHS_UPDATE, input),
        delete: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.FAVORITE_PATHS_DELETE, input),
    },
    // Migration operations
    migration: {
        start: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_START, input),
        getSession: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_GET_SESSION, input),
        getItems: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_GET_ITEMS, input),
        selectItems: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_SELECT_ITEMS, input),
        execute: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_EXECUTE, input),
        verify: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_VERIFY, input),
        rollback: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_ROLLBACK, input),
        getDecommissionPlan: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_GET_DECOMMISSION_PLAN, input),
        executeDecommissionStep: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_EXECUTE_DECOMMISSION_STEP, input),
        getCutoverPlan: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_GET_CUTOVER_PLAN, input),
        executeCutover: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_EXECUTE_CUTOVER, input),
        cancel: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_CANCEL, input),
        getHistory: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_GET_HISTORY, input),
        retryItem: (input) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.MIGRATION_RETRY_ITEM, input),
        // Event subscriptions
        onScanProgress: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('migration:scanProgress', handler);
            return () => electron_1.ipcRenderer.removeListener('migration:scanProgress', handler);
        },
        onImportProgress: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('migration:importProgress', handler);
            return () => electron_1.ipcRenderer.removeListener('migration:importProgress', handler);
        },
        onTransferProgress: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('migration:transferProgress', handler);
            return () => electron_1.ipcRenderer.removeListener('migration:transferProgress', handler);
        },
        onVerifyProgress: (cb) => {
            const handler = (_e, data) => cb(data);
            electron_1.ipcRenderer.on('migration:verifyProgress', handler);
            return () => electron_1.ipcRenderer.removeListener('migration:verifyProgress', handler);
        },
    },
});
//# sourceMappingURL=preload.js.map