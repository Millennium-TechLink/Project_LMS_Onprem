/**
 * PathResolver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for ALL filesystem paths used by the application.
 *
 * No other module may call:
 *   - app.getPath()
 *   - process.env.LOCALAPPDATA  (except to pass into PathResolver.resolve())
 *   - process.env.APPDATA       (except to pass into PathResolver.resolve())
 *   - path.join() for application storage paths
 *
 * Every service receives paths exclusively through a PathResolver instance
 * injected via constructor.
 *
 * ── Storage layout ────────────────────────────────────────────────────────────
 *
 * ROAMING (%APPDATA%\Lab Management System\)
 *   Roams with Windows user profiles. Small files. Config and license state.
 *
 *   license/
 *     license.dat          ← vendor-signed license (ECDSA-protected)
 *     machine.dat          ← runtime state (locally HMAC-protected)
 *     activation.log       ← append-only plaintext audit trail
 *     backups/             ← automatic license.dat backups (max 5)
 *   logs/
 *     electron.log         ← Electron main process log
 *     backend.log          ← Backend process stdout/stderr
 *
 * LOCAL (%LOCALAPPDATA%\Lab Management System\)
 *   Never roams. Machine-local. Large files. Never increases roaming profile.
 *
 *   uploads/
 *     logos/
 *     documents/
 *     rfqs/
 *     calibration_certificates/
 *   exports/               ← user-exported PDFs, Excel reports
 *   backups/
 *     database/            ← future: pg_dump output files
 *     uploads/             ← future: upload directory archives
 *   diagnostics/           ← support bundles (ZIP files)
 *   temp/                  ← working files; purged on every startup
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   // In main.js (the only place Electron APIs are allowed):
 *   const paths = PathResolver.resolve({ app, os });
 *   paths.ensureAllDirs();
 *
 *   // Inject into every service:
 *   const storage = new LicenseStorage(paths);
 *   const diag    = new DiagnosticsService(paths);
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

class PathResolver {
    /**
     * @param {object} opts
     * @param {string} opts.userData      - Resolved value of app.getPath('userData')
     *                                      e.g. C:\Users\Shruti\AppData\Roaming\Lab Management System
     * @param {string} opts.localAppData  - Resolved value of process.env.LOCALAPPDATA
     *                                      e.g. C:\Users\Shruti\AppData\Local
     * @param {string} opts.appName       - Application name used for the local subdirectory
     *                                      e.g. 'Lab Management System'
     */
    constructor({ userData, localAppData, appName }) {
        if (!userData)     throw new Error('PathResolver: userData is required');
        if (!localAppData) throw new Error('PathResolver: localAppData is required');
        if (!appName)      throw new Error('PathResolver: appName is required');

        this._roaming = userData;
        this._local   = path.join(localAppData, appName);
        this._appName = appName;
    }

    // ── Roaming root ──────────────────────────────────────────────────────────

    /** %APPDATA%\Lab Management System\ */
    get roamingRoot()  { return this._roaming; }

    // ── Roaming: license ──────────────────────────────────────────────────────

    /** %APPDATA%\Lab Management System\license\ */
    get licenseDir()      { return path.join(this._roaming, 'license'); }

    /** %APPDATA%\Lab Management System\license\license.dat */
    get licenseFile()     { return path.join(this._roaming, 'license', 'license.dat'); }

    /** %APPDATA%\Lab Management System\license\machine.dat */
    get machineFile()     { return path.join(this._roaming, 'license', 'machine.dat'); }

    /** %APPDATA%\Lab Management System\license\activation.log */
    get activationLog()   { return path.join(this._roaming, 'license', 'activation.log'); }

    /** %APPDATA%\Lab Management System\license\activation.dat */
    get activationFile()  { return path.join(this._roaming, 'license', 'activation.dat'); }

    /** %APPDATA%\Lab Management System\license\backups\ */
    get licenseBackupDir(){ return path.join(this._roaming, 'license', 'backups'); }

    // ── Roaming: logs ─────────────────────────────────────────────────────────

    /** %APPDATA%\Lab Management System\logs\ */
    get logsDir()         { return path.join(this._roaming, 'logs'); }

    /** %APPDATA%\Lab Management System\logs\electron.log */
    get electronLog()     { return path.join(this._roaming, 'logs', 'electron.log'); }

    /** %APPDATA%\Lab Management System\logs\backend.log */
    get backendLog()      { return path.join(this._roaming, 'logs', 'backend.log'); }

    // ── Local root ────────────────────────────────────────────────────────────

    /** %LOCALAPPDATA%\Lab Management System\ */
    get localRoot()       { return this._local; }

    /** %LOCALAPPDATA%\Lab Management System\installation.log */
    get installationLog() { return path.join(this._local, 'installation.log'); }

    // ── Local: uploads ────────────────────────────────────────────────────────

    /** %LOCALAPPDATA%\Lab Management System\uploads\ */
    get uploadsDir()               { return path.join(this._local, 'uploads'); }

    /** %LOCALAPPDATA%\Lab Management System\uploads\logos\ */
    get uploadsLogosDir()          { return path.join(this._local, 'uploads', 'logos'); }

    /** %LOCALAPPDATA%\Lab Management System\uploads\documents\ */
    get uploadsDocumentsDir()      { return path.join(this._local, 'uploads', 'documents'); }

    /** %LOCALAPPDATA%\Lab Management System\uploads\rfqs\ */
    get uploadsRfqsDir()           { return path.join(this._local, 'uploads', 'rfqs'); }

    /** %LOCALAPPDATA%\Lab Management System\uploads\calibration_certificates\ */
    get uploadsCalibrationDir()    { return path.join(this._local, 'uploads', 'calibration_certificates'); }

    // ── Local: other ─────────────────────────────────────────────────────────

    /** %LOCALAPPDATA%\Lab Management System\backend\ — runtime .env location */
    get backendConfigDir(){ return path.join(this._local, 'backend'); }

    /** %LOCALAPPDATA%\Lab Management System\exports\ */
    get exportsDir()      { return path.join(this._local, 'exports'); }

    /** %LOCALAPPDATA%\Lab Management System\backups\ */
    get backupsDir()      { return path.join(this._local, 'backups'); }

    /** %LOCALAPPDATA%\Lab Management System\backups\database\ */
    get dbBackupsDir()    { return path.join(this._local, 'backups', 'database'); }

    /** %LOCALAPPDATA%\Lab Management System\backups\uploads\ */
    get uploadsBackupDir(){ return path.join(this._local, 'backups', 'uploads'); }

    /** %LOCALAPPDATA%\Lab Management System\backups\config\ */
    get configBackupDir() { return path.join(this._local, 'backups', 'config'); }

    /** %LOCALAPPDATA%\Lab Management System\backups\config\.env.pre-encrypt.bak - latest plaintext snapshot, overwritten each time */
    get envPreEncryptBackupFile() { return path.join(this._local, 'backups', 'config', '.env.pre-encrypt.bak'); }

    /** %LOCALAPPDATA%\Lab Management System\backups\config\history\ - one dated snapshot per encryption event, never overwritten */
    get envPreEncryptHistoryDir() { return path.join(this._local, 'backups', 'config', 'history'); }

    /** %LOCALAPPDATA%\Lab Management System\diagnostics\ */
    get diagnosticsDir()  { return path.join(this._local, 'diagnostics'); }

    /** %LOCALAPPDATA%\Lab Management System\temp\ */
    get tempDir()         { return path.join(this._local, 'temp'); }

    /**
     * %LOCALAPPDATA%\Lab Management System\.pending-post-update-check
     * Written by build/installer.nsh's customInstall macro whenever it
     * detects an upgrade (existing .env found). main.js checks for this on
     * every startup and, if present, runs UpdateManager.verifyPostUpdateData()
     * then deletes it - a file marker instead of a launch arg, since nothing
     * currently controls what arguments the post-install app launch uses.
     */
    get pendingUpdateCheckFile() { return path.join(this._local, '.pending-post-update-check'); }

    // ── Operations ───────────────────────────────────────────────────────────

    /**
     * Create all application directories if they do not already exist.
     * Safe to call multiple times (idempotent).
     * Does NOT throw if a directory already exists.
     *
     * @returns {string[]} List of directory paths ensured
     */
    ensureAllDirs() {
        const dirs = [
            // Roaming
            this.roamingRoot,
            this.licenseDir,
            this.licenseBackupDir,
            this.logsDir,
            // Local
            this.localRoot,
            this.uploadsDir,
            this.uploadsLogosDir,
            this.uploadsDocumentsDir,
            this.uploadsRfqsDir,
            this.uploadsCalibrationDir,
            this.exportsDir,
            this.backupsDir,
            this.dbBackupsDir,
            this.uploadsBackupDir,
            this.configBackupDir,
            this.envPreEncryptHistoryDir,
            this.diagnosticsDir,
            this.tempDir,
            // Backend runtime config directory — where the customer .env lives
            this.backendConfigDir,
        ];

        for (const dir of dirs) {
            fs.mkdirSync(dir, { recursive: true });
        }

        return dirs;
    }

    /**
     * Delete all files inside the temp directory that are older than maxAgeMs.
     * Subdirectories within temp are not touched.
     * Silent no-op if temp directory is empty or does not exist.
     *
     * @param {number} maxAgeMs  - Maximum age in milliseconds (default: 24 hours)
     */
    purgeTempDir(maxAgeMs = 24 * 60 * 60 * 1000) {
        try {
            if (!fs.existsSync(this.tempDir)) return;

            const now   = Date.now();
            const entries = fs.readdirSync(this.tempDir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isFile()) continue;   // leave subdirectories untouched
                const filePath = path.join(this.tempDir, entry.name);
                try {
                    const stat = fs.statSync(filePath);
                    if (now - stat.mtimeMs > maxAgeMs) {
                        fs.unlinkSync(filePath);
                    }
                } catch {
                    // Individual file errors are non-fatal
                }
            }
        } catch {
            // Temp purge failure must never crash startup
        }
    }

    /**
     * Return a plain object of display-friendly path strings.
     * Used by SystemInfoService and diagnostics bundle.
     *
     * @returns {object}
     */
    toDisplayObject() {
        return {
            roaming:     this.roamingRoot,
            local:       this.localRoot,
            license:     this.licenseFile,
            logs:        this.logsDir,
            uploads:     this.uploadsDir,
            exports:     this.exportsDir,
            backups:     this.backupsDir,
            diagnostics: this.diagnosticsDir,
            temp:        this.tempDir,
            backendConfig: this.backendConfigDir,
        };
    }

    // ── Static factory ────────────────────────────────────────────────────────

    /**
     * Convenience factory for use in main.js.
     * This is the ONLY place where Electron APIs and process.env are read.
     * After construction, inject the PathResolver instance everywhere else.
     *
     * @param {object} opts
     * @param {object} opts.app  - Electron app object (provides getUserData path + name)
     * @param {object} [opts.os] - Node os module (provides homedir fallback)
     * @returns {PathResolver}
     *
     * @example
     *   const paths = PathResolver.resolve({ app });
     *   paths.ensureAllDirs();
     */
    static resolve({ app, os: osModule }) {
        const osRef       = osModule || os;
        const userData    = app.getPath('userData');
        const appName     = app.getName();

        // process.env.LOCALAPPDATA is always set on Windows.
        // Fallback handles CI, Docker, and non-standard Windows configurations.
        const localAppData = process.env.LOCALAPPDATA
            || path.join(osRef.homedir(), 'AppData', 'Local');

        return new PathResolver({ userData, localAppData, appName });
    }
}

module.exports = PathResolver;
