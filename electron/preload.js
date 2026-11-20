/**
 * preload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Electron contextBridge — sole controlled API surface between main process
 * and the renderer (React app).
 *
 * Security contract:
 *   - contextIsolation: true  (renderer cannot access Node.js directly)
 *   - nodeIntegration: false  (renderer cannot require() modules)
 *   - Only explicitly listed functions are exposed — no pass-through.
 *   - All IPC channel names come from LicenseConstants — never raw strings.
 *   - No sensitive data (signatures, paths, keys) is passed to the renderer.
 *
 * Exposed namespaces:
 *   window.electronAPI.license.*  — license status and activation
 *   window.electronAPI.system.*   — about / system information
 *   window.electronAPI.app.*      — application-level actions
 *   window.electronAPI.backup.*   — backup list / database restore
 *   window.electronAPI.backend.*  — backend health status push (main -> renderer)
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preloads cannot require local files; keep in sync with IPC_CHANNELS in license/LicenseConstants.js
const IPC_CHANNELS = Object.freeze({
    LICENSE_STATUS:          'license:status',
    LICENSE_ACTIVATE:        'license:activate',
    LICENSE_IMPORT_FILE:     'license:import-file',
    SYSTEM_INFO:             'system:info',
    BACKUP_LIST:             'backup:list',
    BACKUP_RESTORE_DATABASE: 'backup:restore-database',
    APP_QUIT:                'app:quit',
    APP_OPEN_LOGS:           'app:open-logs',
    APP_OPEN_FOLDER:         'app:open-folder',
    APP_EXPORT_DIAGNOSTICS:  'app:export-diagnostics',
    BACKEND_STATUS:          'backend:status',
});

contextBridge.exposeInMainWorld('electronAPI', {

    // ── License API ───────────────────────────────────────────────────────────
    license: {
        /**
         * Get the current license status for display in the UI.
         * Returns a safe summary — no signatures or crypto material.
         * @returns {Promise<LicenseInfo>}
         */
        getStatus: () =>
            ipcRenderer.invoke(IPC_CHANNELS.LICENSE_STATUS),

        /**
         * Activate using a Base64 key string (paste/email delivery).
         * @param {string} key
         * @returns {Promise<{ success: boolean, message: string }>}
         */
        activate: (key) =>
            ipcRenderer.invoke(IPC_CHANNELS.LICENSE_ACTIVATE, key),

        /**
         * Open the native file picker and activate from a .lic file.
         * Main process handles file selection and content reading.
         * @returns {Promise<{ success: boolean, message: string }>}
         */
        importFile: () =>
            ipcRenderer.invoke(IPC_CHANNELS.LICENSE_IMPORT_FILE),
    },

    // ── System / About API ────────────────────────────────────────────────────
    system: {
        /**
         * Get complete system information for the About dialog and diagnostics.
         * Includes app version, Electron version, license summary, paths.
         * @returns {Promise<SystemInfo>}
         */
        getInfo: () =>
            ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_INFO),
    },

    // ── Application actions ───────────────────────────────────────────────────
    app: {
        /**
         * Gracefully quit the application.
         */
        quit: () =>
            ipcRenderer.send(IPC_CHANNELS.APP_QUIT),

        /**
         * Open the logs folder in Windows Explorer.
         */
        openLogs: () =>
            ipcRenderer.send(IPC_CHANNELS.APP_OPEN_LOGS),

        /**
         * Open an arbitrary folder in Windows Explorer.
         * @param {string} folderKey  - one of: 'logs'|'uploads'|'backups'|'diagnostics'
         */
        openFolder: (folderKey) =>
            ipcRenderer.send(IPC_CHANNELS.APP_OPEN_FOLDER, folderKey),

        /**
         * Export a diagnostics bundle ZIP to the diagnostics directory.
         * @returns {Promise<{ success: boolean, filePath?: string, message: string }>}
         */
        exportDiagnostics: () =>
            ipcRenderer.invoke(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS),
    },

    // ── Backup / restore API ──────────────────────────────────────────────────
    backup: {
        /**
         * List available backups (newest first).
         * @returns {Promise<Array<{ name: string, path: string, createdAt: string|null }>>}
         */
        list: () =>
            ipcRenderer.invoke(IPC_CHANNELS.BACKUP_LIST),

        /**
         * Restore the database from a backup. Destructive - main process
         * shows a native confirmation dialog before doing anything.
         * @param {string} backupPath
         * @returns {Promise<{ success: boolean, message: string }>}
         */
        restoreDatabase: (backupPath) =>
            ipcRenderer.invoke(IPC_CHANNELS.BACKUP_RESTORE_DATABASE, backupPath),
    },

    // ── Backend health API ────────────────────────────────────────────────────
    backend: {
        /**
         * Subscribe to backend health status pushes from the main process
         * (restarting / restored / failed - see BackendManager.enableCrashRecovery).
         * @param {(status: { state: string, attempt?: number, maxAttempts?: number, attempts?: number }) => void} callback
         * @returns {() => void} unsubscribe function
         */
        onStatusChange: (callback) => {
            const handler = (_event, status) => callback(status);
            ipcRenderer.on(IPC_CHANNELS.BACKEND_STATUS, handler);
            return () => ipcRenderer.removeListener(IPC_CHANNELS.BACKEND_STATUS, handler);
        },
    },
});
