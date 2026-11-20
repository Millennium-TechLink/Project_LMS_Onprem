/**
 * main.js  —  Electron Main Process
 * ─────────────────────────────────────────────────────────────────────────────
 * Startup sequence:
 *
 *   1.  PathResolver.resolve() — establish all filesystem paths
 *   2.  Logging — open electron.log + backend.log in correct roaming location
 *   3.  LicenseManager.initialize() — first-install detection / bypass check
 *   4.  LicenseManager.checkLicense() — validate trial or vendor license
 *   5a. BLOCKED → show appropriate dialog → activate or quit
 *   5b. VALID   → proceed
 *   6.  Register IPC handlers
 *   7.  createSplash()
 *   8.  VenvManager.setupVenv() + BackendManager.start() — injects UPLOAD_DIR
 *   9.  BackendManager.waitUntilReady()
 *   10. updateLastLaunch()   ← AFTER backend confirmed (not before)
 *   11. createWindow()
 *   12. injectTrialBanner() if needed
 *
 * Phase 5 / 6 improvements:
 *   - PathResolver owns ALL filesystem paths (logs now go to roaming profile)
 *   - LicenseManager receives PathResolver directly (no legacy string shim)
 *   - Dialog functions return { promise, win } — no fragile event interception
 *   - Splash window: nodeIntegration: false, contextIsolation: true
 *   - Dead variables removed (origHandle, unused event params)
 *   - UPLOAD_DIR injected into backend process environment
 *   - IPC handlers wired for all channels defined in Phase 1:
 *       license:status, license:activate, license:import-file,
 *       system:info, app:quit, app:open-logs, app:open-folder,
 *       app:export-diagnostics
 */

'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, powerMonitor } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const { restrictToCurrentUser, restrictToCurrentUserAsync } = require('./license/FilePermissions');

// ── Fix Electron's userData path BEFORE anything else can touch it ─────────
// package.json's top-level "name" is "lab-management-system" (npm-safe,
// lowercase) - electron-builder's "productName": "Lab Management System"
// lives inside the "build" config, which electron-builder reads for the
// installer/shortcuts, but Electron itself never reads at runtime. Left
// alone, app.getPath('userData') silently resolves to
// %APPDATA%\lab-management-system\ instead of ...\Lab Management System\ -
// splitting license.dat/machine.dat/logs across two different folders from
// everything PathResolver.js computes (all userData-based), while
// MachineId.js and installer.nsh (both hardcode the literal folder name)
// keep writing to the correct one. app.setName() alone does not fix this:
// it runs too late if anything - including requestSingleInstanceLock()
// below - touches the default userData path first. Must run before that.
const desiredUserData = path.join(app.getPath('appData'), 'Lab Management System');
fs.mkdirSync(desiredUserData, { recursive: true });
app.setPath('userData', desiredUserData);
app.setName('Lab Management System');

// ── Single instance lock ────────────────────────────────────────────────────
// Without this, a second launch (double-click twice, a stuck previous window,
// etc.) becomes a second full process: its own backend trying to bind the
// same port as the first (one of them loses), and its own independent log
// file streams appending to the same electron.log/backend.log as the first,
// uncoordinated - the exact way log writes end up interleaved or dropped.
// Must be the very first thing that runs, before any path/logging/backend
// setup below, so a duplicate launch exits before doing any of that.
// A launch right after a close waits for the old process (marker file) instead of quitting.
const CLOSING_MARKER = path.join(desiredUserData, 'closing.json');

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function previousInstanceIsClosing() {
    try {
        const { pid, ts } = JSON.parse(fs.readFileSync(CLOSING_MARKER, 'utf8'));
        if (pid === process.pid) return false;
        if (Date.now() - ts > 30000) return false;      // stale marker
        try {
            process.kill(pid, 0);                       // throws if that process is gone
        } catch (e) {
            if (e.code !== 'EPERM') return false;
        }
        return true;
    } catch {
        return false;
    }
}

function writeClosingMarker() {
    try { fs.writeFileSync(CLOSING_MARKER, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* best effort */ }
}

function clearClosingMarker() {
    try {
        const m = JSON.parse(fs.readFileSync(CLOSING_MARKER, 'utf8'));
        if (m.pid === process.pid) fs.unlinkSync(CLOSING_MARKER);
    } catch { /* nothing to clear */ }
}

// Cleared on exit, when the lock is released too.
process.on('exit', clearClosingMarker);

function acquireInstanceLock() {
    if (!previousInstanceIsClosing()) {
        return { ok: app.requestSingleInstanceLock(), waited: false };
    }
    const deadline = Date.now() + 20000;
    while (previousInstanceIsClosing() && Date.now() < deadline) sleepSync(200);
    // The lock can free a moment after the marker is gone.
    for (let i = 0; i < 15; i++) {
        if (app.requestSingleInstanceLock()) return { ok: true, waited: true };
        sleepSync(200);
    }
    return { ok: false, waited: true };
}

const instanceLock = acquireInstanceLock();
if (!instanceLock.ok) {
    if (instanceLock.waited) {
        dialog.showErrorBox('Lab Management System', 'The previous session is still closing. Please try again in a few seconds.');
    }
    app.quit();
    process.exit(0);
}

// Backend port: single source of truth, overridable via the PORT env var so
// it never has to be hardcoded separately in main.js, run_backend.ps1, and
// the backend's own Settings.PORT. Defaults to 8001 everywhere it's unset.
const BACKEND_PORT = parseInt(process.env.LMS_BACKEND_PORT, 10) || parseInt(process.env.PORT, 10) || 8001;

// ── License subsystem ─────────────────────────────────────────────────────────
const PathResolver       = require('./license/PathResolver');
const LicenseManager     = require('./license/LicenseManager');
const LicenseDialog      = require('./license/LicenseDialog');
const DiagnosticsService = require('./license/DiagnosticsService');
const BackupService      = require('./license/BackupService');
const BackendManager     = require('./BackendManager');
const { setMachineIdLogger } = require('./license/MachineId');
const {
    VALIDATION_RESULT,
    IPC_CHANNELS,
    TRIAL_WARNING_THRESHOLD_DAYS,
    LICENSE_TYPES,
} = require('./license/LicenseConstants');

// ── Step 1: Path resolution ───────────────────────────────────────────────────
// PathResolver is the ONLY place that calls app.getPath() or reads env vars.
// Every other module receives paths through injection.
// (app.setName() + the userData override already ran at the very top of this
// file, before the single-instance lock - see the comment there for why.)
const paths = PathResolver.resolve({ app, os });
paths.ensureAllDirs();
paths.purgeTempDir();

// ── Step 2: Logging ───────────────────────────────────────────────────────────
// Logs go to roaming profile so support staff can access them remotely.
// %APPDATA%\Lab Management System\logs\

const BACKEND_LOG_FILE  = paths.backendLog;
const ELECTRON_LOG_FILE = paths.electronLog;
const LOG_DIR           = paths.logsDir;

// Raw capture with no size cap of its own - rotate past 10MB (the backend's own Python log already does).
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
function rotateLogIfLarge(filePath) {
    try {
        if (fs.statSync(filePath).size > LOG_ROTATE_MAX_BYTES) {
            fs.renameSync(filePath, `${filePath}.old`);
        }
    } catch (_) { /* file doesn't exist yet - nothing to rotate */ }
}
rotateLogIfLarge(BACKEND_LOG_FILE);
rotateLogIfLarge(ELECTRON_LOG_FILE);

const backendLogStream  = fs.createWriteStream(BACKEND_LOG_FILE,  { flags: 'a' });
const electronLogStream = fs.createWriteStream(ELECTRON_LOG_FILE, { flags: 'a' });

function logElectron(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[Electron] ${msg}`);
    // Guard: stream may already be closed during app shutdown (before-quit ends the stream;
    // async events like backendProcess 'exit' can still fire after, causing ERR_STREAM_WRITE_AFTER_END)
    if (!electronLogStream.writableEnded) {
        electronLogStream.write(line + '\n');
    }
}

function logBackend(msg) {
    const clean = String(msg).trimEnd();
    const line = `[${new Date().toISOString()}] ${clean}`;
    console.log(`[Backend] ${clean}`);
    if (!backendLogStream.writableEnded) {
        backendLogStream.write(line + '\n');
    }
}

function logBackendErr(msg) {
    const clean = String(msg).trimEnd();
    const line = `[${new Date().toISOString()}] [STDERR] ${clean}`;
    console.error(`[Backend Err] ${clean}`);
    if (!backendLogStream.writableEnded) {
        backendLogStream.write(line + '\n');
    }
}

const SEP = '='.repeat(72);
electronLogStream.write(`\n${SEP}\nSession start: ${new Date().toISOString()}\n${SEP}\n`);
backendLogStream.write(`\n${SEP}\nSession start: ${new Date().toISOString()}\n${SEP}\n`);

logElectron(`Roaming data : ${paths.roamingRoot}`);
logElectron(`Local data   : ${paths.localRoot}`);

// Inject logger into MachineId so all ID generation events go to electron.log
setMachineIdLogger(logElectron);

// ── Application state ─────────────────────────────────────────────────────────
let splashWindow      = null;
let mainWindow        = null;
let backendManager    = null;

// A second launch attempt quit itself immediately above (before this code
// even runs), but Electron still fires this on the running (first) instance
// so it can bring itself to front instead of the user's second click just
// silently doing nothing.
app.on('second-instance', () => {
    logElectron('Second launch attempt detected — focusing existing window.');
    const win = mainWindow || splashWindow;
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
    }
});

const RING_SIZE    = 100;
const backendLines = [];
function pushBackendLine(line) {
    backendLines.push(line);
    if (backendLines.length > RING_SIZE) backendLines.shift();
}

// ── Runtime .env bootstrap ────────────────────────────────────────────────────
/**
 * Ensure the runtime .env exists at the canonical location:
 *   %LOCALAPPDATA%\Lab Management System\backend\.env
 *
 * On a fresh install the directory is guaranteed to exist (PathResolver.ensureAllDirs
 * created it), but the .env file itself must have been placed there by the installer
 * or a previous setup step.
 *
 * If the file is completely absent we copy the bundled .env.customer.example
 * (shipped in resources/backend/) as a starting template. This gives the
 * customer a well-formed file they can edit, and prevents the cryptic Pydantic
 * ValidationError ("DATABASE_URL field required") that causes the app to close
 * silently after "Starting backend service…".
 *
 * The copy is intentionally minimal – it does NOT set a live DATABASE_URL.
 * The backend will still exit with a clear "[Config] CRITICAL ERROR" message
 * that lands in backend.log, but the electron.log will also carry a pre-flight
 * warning so the support team immediately knows the cause.
 *
 * Returns true if the .env exists (or was successfully bootstrapped).
 * Returns false if the .env is absent AND the template copy failed.
 */

// /health is a pure liveness probe (returns 200 even with a dead DB, by
// design - see app.main's docstring). /api/health-check actually attempts a
// DB connection. Locking on the former would lock in a broken DATABASE_URL.
async function isDatabaseHealthy(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health-check`);
        if (!res.ok) return false;
        const body = await res.json();
        return body.database === true;
    } catch {
        return false;
    }
}

// Fingerprints a baked .env's plaintext content, so a rebuild with a
// different DATABASE_URL/secrets can be told apart from an unrelated app
// update reinstalling the same config.
function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Cheap local check matching env_crypto.py's own MAGIC prefix - no DPAPI
// call needed, just a peek at the first bytes.
function isEnvEncrypted(envPath) {
    try {
        const fd = fs.openSync(envPath, 'r');
        const buf = Buffer.alloc(7);
        fs.readSync(fd, buf, 0, 7, 0);
        fs.closeSync(fd);
        return buf.toString('latin1') === 'DPAPI1:';
    } catch {
        return false;
    }
}

// DPAPI-encrypts a baked .env in place via app/core/env_crypto.py, so its
// plaintext secrets don't sit readable on disk. Best-effort: a failure here
// just leaves the file as plaintext, never blocks startup.
function encryptEnvFile(envPath, logFn) {
    const log = logFn || (() => {});
    try {
        const pythonExe = path.join(process.resourcesPath, 'backend', 'python', 'python.exe');
        // .pyc, not .py - afterPack.js strips .py source from resources/backend/app.
        const script = path.join(process.resourcesPath, 'backend', 'app', 'core', 'env_crypto.pyc');
        if (!fs.existsSync(pythonExe) || !fs.existsSync(script)) return false;
        const result = spawnSync(pythonExe, [script, 'encrypt', envPath], { stdio: 'ignore' });
        if (result.status !== 0) {
            log(`[Preflight] env_crypto encrypt failed (exit ${result.status}).`);
            return false;
        }
        log(`[Preflight] Encrypted ${envPath}.`);
        return true;
    } catch (err) {
        log(`[Preflight] Could not encrypt ${envPath}: ${err.message}`);
        return false;
    }
}

// Keeps a plaintext copy of .env from just before its encryption - once
// DPAPI-locked it's only decryptable on this same Windows profile. Called
// from all three places a plaintext .env gets encrypted for the first time
// (baked-bootstrap, baked-refresh-on-change, and the health-check-gated
// path below) - each call site only reaches this while envTarget is still
// plaintext, so it fires once per genuinely new .env, not on every launch.
//
// Writes two copies: envPreEncryptBackupFile (fixed name, always overwritten
// - "what's the current one") and a dated copy under envPreEncryptHistoryDir
// that's never overwritten - so an earlier delete-and-recreate cycle's .env
// is still recoverable even after a later one replaces the "latest" copy.
function backupEnvBeforeEncrypt(envPath, logFn) {
    const log = logFn || (() => {});
    try {
        const backupPath = paths.envPreEncryptBackupFile;
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(envPath, backupPath);
        restrictToCurrentUser(backupPath, log);
        log(`[Preflight] Backed up plaintext .env to ${backupPath} before encryption.`);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const historyPath = path.join(paths.envPreEncryptHistoryDir, `${timestamp}.env.bak`);
        fs.mkdirSync(paths.envPreEncryptHistoryDir, { recursive: true });
        fs.copyFileSync(envPath, historyPath);
        restrictToCurrentUser(historyPath, log);
        log(`[Preflight] Also kept a dated copy at ${historyPath}.`);

        return true;
    } catch (err) {
        log(`[Preflight] Could not back up .env before encryption: ${err.message}`);
        return false;
    }
}

function ensureRuntimeEnv() {
    const envTarget = path.join(paths.backendConfigDir, '.env');
    const envExists = fs.existsSync(envTarget);

    // Does this build ship a real customer .env (build_desktop.ps1's
    // -BakeCustomerEnv)? Checked every launch, not just the first, so the
    // read-only lock below doesn't get undone on relaunch.
    const bakedEnvCandidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'backend', '.env'),
            path.join(process.resourcesPath, 'backend', '_internal', '.env'),
          ]
        : [];
    const isBakedBuild = bakedEnvCandidates.some(c => fs.existsSync(c));
    const bakeHashMarker = path.join(paths.backendConfigDir, '.env.bake-hash');

    if (envExists) {
        logElectron(`[Preflight] Runtime .env found: ${envTarget}`);

        // This build ships a real baked .env (build_desktop.ps1's bake-on-by-
        // default step) - compare its fingerprint against the one recorded the
        // last time it was applied. A mismatch means the developer changed
        // DATABASE_URL/secrets and rebuilt, so the new config should replace
        // the stale runtime copy. An unrelated app update that ships the same
        // baked config (unchanged hash) leaves the runtime .env untouched, so
        // a customer's own edits to a non-baked .env are never clobbered.
        if (isBakedBuild) {
            const bakedEnvSrc = bakedEnvCandidates.find(c => fs.existsSync(c));
            try {
                const bakedHash = sha256File(bakedEnvSrc);
                const appliedHash = fs.existsSync(bakeHashMarker) ? fs.readFileSync(bakeHashMarker, 'utf8').trim() : null;
                if (bakedHash !== appliedHash) {
                    logElectron(`[Preflight] Baked .env changed since last run - refreshing runtime .env from ${bakedEnvSrc}.`);
                    // The previous copy may be ACL-locked read-only (see below) -
                    // reopen it for writing before overwriting, then re-lock.
                    restrictToCurrentUser(envTarget, logElectron, { readOnly: false });
                    fs.copyFileSync(bakedEnvSrc, envTarget);
                    backupEnvBeforeEncrypt(envTarget, logElectron);
                    encryptEnvFile(envTarget, logElectron);
                    restrictToCurrentUser(envTarget, logElectron, { readOnly: true });
                    fs.writeFileSync(bakeHashMarker, bakedHash, 'utf8');
                }
            } catch (refreshErr) {
                logElectron(`[Preflight] Could not refresh runtime .env from baked config: ${refreshErr.message}`);
            }
        }

        // Quick sanity: verify DATABASE_URL is present and non-empty. Skipped
        // once encrypted - it's ciphertext, not text, so this would just print
        // a false "not found" warning every launch.
        try {
            if (isEnvEncrypted(envTarget)) {
                logElectron(`[Preflight] .env is encrypted - skipping plaintext sanity check.`);
            } else {
                const content = fs.readFileSync(envTarget, 'utf8');
                const lines   = content.split(/\r?\n/);
                const dbLine  = lines.find(l => /^DATABASE_URL\s*=/.test(l));
                if (!dbLine) {
                    logElectron(`[Preflight] WARNING: DATABASE_URL not found in ${envTarget}`);
                    logElectron(`[Preflight] Backend will fail – add DATABASE_URL to the .env file.`);
                } else {
                    const dbValue = dbLine.split('=').slice(1).join('=').trim();
                    if (!dbValue) {
                        logElectron(`[Preflight] WARNING: DATABASE_URL is empty in ${envTarget}`);
                    } else {
                        // Log host/port only – never log credentials
                        try {
                            const urlObj = new URL(dbValue);
                            logElectron(`[Preflight] DATABASE_URL points to ${urlObj.hostname}:${urlObj.port || 5432}${urlObj.pathname}`);
                        } catch {
                            logElectron(`[Preflight] DATABASE_URL is set (could not parse for display).`);
                        }
                    }
                }
            }
        } catch (readErr) {
            logElectron(`[Preflight] Could not read .env for sanity check: ${readErr.message}`);
        }
        // Once locked (baked, or locked post-health-check below), stay locked on
        // every relaunch - isBakedBuild alone would miss the non-baked case.
        // Not awaited: icacls takes over a second and must not delay the backend start
        restrictToCurrentUserAsync(envTarget, logElectron, { readOnly: isBakedBuild || isEnvEncrypted(envTarget) });
        return true;
    }

    // .env is absent - try the baked customer .env first (already valid,
    // lock read-only). Falls through to the template below if absent.
    logElectron(`[Preflight] WARNING: Runtime .env NOT found at: ${envTarget}`);

    let bakedEnvSrc = null;
    for (const candidate of bakedEnvCandidates) {
        if (fs.existsSync(candidate)) { bakedEnvSrc = candidate; break; }
    }

    if (bakedEnvSrc) {
        try {
            fs.copyFileSync(bakedEnvSrc, envTarget);
            logElectron(`[Preflight] Bootstrapped .env from baked customer config: ${bakedEnvSrc}`);
            backupEnvBeforeEncrypt(envTarget, logElectron);
            encryptEnvFile(envTarget, logElectron);
            restrictToCurrentUser(envTarget, logElectron, { readOnly: true });
            try { fs.writeFileSync(bakeHashMarker, sha256File(bakedEnvSrc), 'utf8'); } catch { /* best-effort */ }
            return true;
        } catch (copyErr) {
            logElectron(`[Preflight] Could not copy baked .env: ${copyErr.message}`);
            // fall through to the placeholder-template path below
        }
    }

    // No baked .env - fall back to the placeholder template (CUSTOMER_SETUP_GUIDE.md), kept editable.
    const templateCandidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'backend', '.env.customer.example'),
            path.join(process.resourcesPath, 'backend', '_internal', '.env.customer.example'),
          ]
        : [
            path.join(__dirname, '..', 'config', '.env.customer.example'),
          ];

    let templateSrc = null;
    for (const candidate of templateCandidates) {
        if (fs.existsSync(candidate)) { templateSrc = candidate; break; }
    }

    if (templateSrc) {
        try {
            fs.copyFileSync(templateSrc, envTarget);
            logElectron(`[Preflight] Bootstrapped .env from template: ${templateSrc}`);
            logElectron(`[Preflight] IMPORTANT: Edit ${envTarget} and set DATABASE_URL before retrying.`);
            restrictToCurrentUser(envTarget, logElectron);
        } catch (copyErr) {
            logElectron(`[Preflight] Could not copy template: ${copyErr.message}`);
        }
    } else {
        logElectron(`[Preflight] No .env template found in resources – cannot bootstrap.`);
        logElectron(`[Preflight] Candidates checked: ${templateCandidates.join(', ')}`);
    }

    // Always return false here: even if we copied the template, DATABASE_URL won't be
    // set yet, so the backend will fail. Return false lets the caller decide whether
    // to show a setup-required dialog instead of waiting 90 s for health-check timeout.
    return false;
}

// dialog.showMessageBox() with no parent window renders as a plain unparented
// window - on Windows it can end up stacked BEHIND an alwaysOnTop window like
// the splash screen instead of above it. Passing a parent makes the dialog
// window-modal to it, which fixes the stacking. Falls back to unparented if
// the given window is already gone (e.g. splash already closed).
function showMessageBoxOn(win, options) {
    if (win && !win.isDestroyed()) {
        return dialog.showMessageBox(win, options);
    }
    return dialog.showMessageBox(options);
}

// shell.openPath alone silently failed on some machines: log it, fall back to explorer.exe, wait before quit.
async function openFolderSafely(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    let failure = '';
    try {
        failure = await shell.openPath(dir);
    } catch (e) {
        failure = e.message;
    }
    if (failure) {
        logElectron(`[OpenFolder] shell.openPath failed for ${dir}: ${failure} - trying explorer.exe`);
        try {
            spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) {
            logElectron(`[OpenFolder] explorer.exe failed too: ${e.message}`);
        }
    } else {
        logElectron(`[OpenFolder] Opened ${dir}`);
    }
    await new Promise(r => setTimeout(r, 600));
}

// Last error line from the backend output, plus a plain-language hint for known failures.
function describeBackendFailure(lines) {
    const clean = l => String(l).replace(/^(\[[^\]]+\]\s*)+/, '').trim();
    const recent = lines.slice(-200).map(clean).filter(Boolean);
    const errorLine = [...recent].reverse().find(l => /^[A-Za-z_.]*(Error|Exception)\b.*:/.test(l) || /error:/i.test(l)) || '';
    const text = recent.join('\n');
    let hint = '';
    if (/could not connect|connection refused|password authentication failed|database ".*" does not exist|OperationalError/i.test(text)) {
        hint = 'The database could not be reached. Check that PostgreSQL is running and that DATABASE_URL in the .env file is correct.';
    } else if (/only one usage of each socket|address already in use|WinError 10048/i.test(text)) {
        hint = 'The backend port is already in use. Close the other program using it and start the app again.';
    } else if (/CRM_ENCRYPTION_KEY/.test(text)) {
        hint = 'CRM_ENCRYPTION_KEY in the .env file is not a valid key. Remove the value or replace it with a valid key.';
    } else if (/DATABASE_URL|SECRET_KEY|JWT_SECRET_KEY|ValidationError/i.test(errorLine)) {
        hint = 'A required setting in the .env file is missing or invalid.';
    }
    return { errorLine, hint };
}

// ── Backend startup error dialog ─────────────────────────────────────────────
// (Defined BEFORE startBackend so it can be called from the pre-flight path)
async function showMissingEnvDialog() {
    const envTarget = path.join(paths.backendConfigDir, '.env');
    const detail = [
        'The application cannot start because the database configuration file',
        'is missing or incomplete.',
        '',
        'Required file:',
        `  ${envTarget}`,
        '',
        'This file must contain at minimum:',
        '  DATABASE_URL=postgresql://user:password@host:5432/database_name',
        '',
        'Steps to resolve:',
        '  1. Ensure PostgreSQL is installed and running.',
        '  2. Create the .env file at the path shown above.',
        '  3. Set DATABASE_URL to your PostgreSQL connection string.',
        '  4. Restart the application.',
        '',
        `Log file: ${paths.electronLog}`,
    ].join('\n');

    logElectron('[Preflight] Showing missing .env configuration dialog.');

    const { response } = await showMessageBoxOn(splashWindow, {
        type:      'error',
        title:     'Lab Management System - Configuration Required',
        message:   'Database configuration file not found.',
        detail,
        buttons:   ['Open Configuration Folder', 'Quit'],
        defaultId: 0,
        cancelId:  1,
    });
    if (response === 0) {
        // Must be awaited: the caller closes the splash window and calls
        // app.quit() right after this function returns. shell.openPath()
        // just asks the OS to launch a file-explorer window and does not
        // wait for it - without awaiting it here, app.quit() can tear the
        // process down before Explorer actually opens, so the button
        // silently does nothing.
        await openFolderSafely(paths.backendConfigDir);
    }
}


// Backend startup/port-cleanup is now handled entirely by BackendManager and
// VenvManager - removed the old direct-spawn helpers (findPortOwners,
// killPortIfBusy, startBackend, waitForBackend). They referenced variables
// no longer declared anywhere in this file and would have thrown if called.

// ── Backend startup error dialog ─────────────────────────────────────────────
async function showStartupErrorDialog(err) {
    const lastLines = backendLines.slice(-100).join('\n') || '(no output captured)';
    const { errorLine, hint } = describeBackendFailure(backendLines);
    const exited = !!(err && err.backendExited);
    const detail = [
        ...(errorLine ? [`Reason: ${errorLine}`, ''] : []),
        ...(hint ? [hint, ''] : []),
        '── Last backend output (up to 100 lines) ──',
        lastLines,
        '',
        '── Log files ──',
        `Backend : ${BACKEND_LOG_FILE}`,
        `Electron: ${ELECTRON_LOG_FILE}`,
    ].join('\n');

    logElectron(`Showing startup error dialog. Reason: ${errorLine || '(none found in the backend output)'}`);

    const { response } = await showMessageBoxOn(splashWindow, {
        type:      'error',
        title:     'Lab Management System - Backend Failed to Start',
        message:   exited
            ? 'The backend service stopped while starting.'
            : 'The backend service did not become available within 2.5 minutes.',
        detail,
        buttons:   ['Open Log Folder', 'Quit'],
        defaultId: 1,
        cancelId:  1,
    });
    // Awaited - see the comment on the same pattern in showMissingEnvDialog above.
    if (response === 0) await openFolderSafely(LOG_DIR);
}

// ── Port conflict dialog ─────────────────────────────────────────────────────
// Shown when BackendManager can't free the port itself (unknown owner).
async function showPortConflictDialog() {
    logElectron('Showing port conflict dialog.');
    const { response } = await showMessageBoxOn(splashWindow, {
        type:      'error',
        title:     'Lab Management System - Port In Use',
        message:   `Port ${BACKEND_PORT} is already in use by another program.`,
        detail:
            `The application tried to free port ${BACKEND_PORT} automatically but it is still in use.\n\n` +
            `This usually means another program (a previous backend process, a development server, ` +
            `or something else) is using this port. Close whatever is using it, or restart your computer, ` +
            `then try again.`,
        buttons:   ['Open Log Folder', 'Quit'],
        defaultId: 1,
        cancelId:  1,
    });
    // Awaited - see the comment on the same pattern in showMissingEnvDialog above.
    if (response === 0) await openFolderSafely(LOG_DIR);
}

// ── Backend crash-recovery exhausted dialog ──────────────────────────────────
// Shown when the backend died mid-session and BackendManager gave up trying
// to restart it (see backendManager.enableCrashRecovery() below).
async function showBackendCrashDialog(attempts) {
    const lastLines = backendLines.slice(-100).join('\n') || '(no output captured)';
    const detail = [
        `The backend stopped unexpectedly while the app was running and could ` +
        `not be restarted after ${attempts} attempt(s).`,
        '',
        '── Last backend output (up to 100 lines) ──',
        lastLines,
        '',
        '── Log files ──',
        `Backend : ${BACKEND_LOG_FILE}`,
        `Electron: ${ELECTRON_LOG_FILE}`,
    ].join('\n');

    logElectron('Showing backend-crash-recovery-exhausted dialog.');

    const { response } = await showMessageBoxOn(mainWindow, {
        type:      'error',
        title:     'Lab Management System - Backend Stopped Unexpectedly',
        message:   'The backend crashed and automatic recovery was unsuccessful.',
        detail,
        buttons:   ['Restart App', 'Open Log Folder', 'Quit'],
        defaultId: 0,
        cancelId:  2,
    });
    if (response === 0) {
        app.relaunch();
        app.quit();
    } else if (response === 1) {
        await openFolderSafely(LOG_DIR);
    }
}

// ── Splash screen ─────────────────────────────────────────────────────────────
function createSplash(statusText = 'Starting backend services...') {
    splashWindow = new BrowserWindow({
        width:        480,
        height:       320,
        frame:        false,
        transparent:  true,
        // Not topmost: a slow start must not cover other apps.
        resizable:    false,
        skipTaskbar:  false,
        // Fixed: nodeIntegration: false — splash is static HTML, needs no Node access
        webPreferences: {
            nodeIntegration:  false,
            contextIsolation: true,
        },
    });

    // Same stale-reference protection as mainWindow - covers an unexpected
    // close (e.g. Alt+F4) while splash is still the only window up.
    splashWindow.on('closed', () => { splashWindow = null; });

    splashWindow.loadURL(`data:text/html,${encodeURIComponent(`
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:480px; height:320px;
  background: linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%);
  border-radius:16px; display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  font-family:'Segoe UI',sans-serif; color:white; overflow:hidden;
  border:1px solid rgba(255,255,255,0.1);
}
.logo { font-size:48px; margin-bottom:12px; }
h1 { font-size:20px; font-weight:700; letter-spacing:0.5px; margin-bottom:4px; }
p  { font-size:13px; color:rgba(255,255,255,0.55); margin-bottom:32px; }
.bar-track { width:280px; height:4px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; }
.bar-fill  { height:100%; width:30%; background:linear-gradient(90deg,#3b82f6,#60a5fa);
             border-radius:4px; animation:slide 1.4s ease-in-out infinite; }
@keyframes slide { 0%{margin-left:-30%} 100%{margin-left:100%} }
.status { margin-top:16px; font-size:12px; color:rgba(255,255,255,0.4); }
</style></head><body>
  <div class="logo">🔬</div>
  <h1>Lab Management System</h1>
  <p>Millennium TechLink</p>
  <div class="bar-track"><div class="bar-fill"></div></div>
  <div class="status" id="status">${statusText}</div>
</body></html>
    `)}`);
}

function setSplashStatus(text) {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.webContents
        .executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(text)}`)
        .catch(() => { /* cosmetic only */ });
}

// ── Main window ───────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width:           1400,
        height:          900,
        show:            false,
        autoHideMenuBar: true,
        title:           'Lab Management System - TechLink',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
            sandbox:          false,
        },
    });

    mainWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
        mainWindow.show();
    });

    // Without this, mainWindow keeps pointing at a destroyed window after the
    // user closes it - the exact stale reference that crashed second-instance.
    mainWindow.on('closed', () => { mainWindow = null; });

    // Force logout on close: clear the session so the next launch requires a
    // fresh login, rather than the auth token in localStorage (valid for
    // hours) silently carrying over. Intercept 'close' (before the window is
    // destroyed, while webContents is still usable), clear, then let it close
    // for real - 'closed' above still fires normally afterward.
    let sessionCleared = false;
    mainWindow.on('close', (event) => {
        if (sessionCleared || !mainWindow) return;
        event.preventDefault();
        const keys = ['authToken', 'labManagementUser', 'cssp_token'];
        const script = keys.map(k => `localStorage.removeItem(${JSON.stringify(k)});`).join(' ');
        mainWindow.webContents.executeJavaScript(script)
            .catch((err) => logElectron(`[Logout-on-close] Could not clear session: ${err.message}`))
            .finally(() => {
                sessionCleared = true;
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
            });
    });

    mainWindow.loadURL(`http://127.0.0.1:${BACKEND_PORT}`);
    return mainWindow;
}

// ── IPC handler registration ──────────────────────────────────────────────────
/**
 * Register all IPC channels exposed via preload.js.
 * Called once, before createWindow().
 *
 * @param {LicenseManager}    licenseManager
 * @param {DiagnosticsService} diagnosticsService
 * @param {BackupService}     backupService
 */
function registerIpcHandlers(licenseManager, diagnosticsService, backupService) {

    // ── license:status  (renderer → main → getLicenseInfo) ───────────────────
    ipcMain.handle(IPC_CHANNELS.LICENSE_STATUS, async () =>
        licenseManager.getLicenseInfo()
    );

    // ── license:activate  (key string) ───────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.LICENSE_ACTIVATE, async (_e, key) => {
        const result = await licenseManager.activate(key);
        if (result.success) {
            setTimeout(() => { app.relaunch(); app.quit(); }, 3000);
        }
        return result;
    });

    // ── license:import-file  (native file picker → file contents → activate) ─
    ipcMain.handle(IPC_CHANNELS.LICENSE_IMPORT_FILE, async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title:       'Select License File',
            filters:     [{ name: 'License Files', extensions: ['lic'] }],
            properties:  ['openFile'],
        });
        if (canceled || !filePaths.length) {
            return { success: false, message: 'No file selected.' };
        }
        try {
            const contents = fs.readFileSync(filePaths[0], 'utf8');
            const result   = await licenseManager.activateFromFile(contents);
            if (result.success) {
                setTimeout(() => { app.relaunch(); app.quit(); }, 3000);
            }
            return result;
        } catch (err) {
            logElectron(`[IPC] importFile error: ${err.message}`);
            return { success: false, message: `Could not read file: ${err.message}` };
        }
    });

    // ── system:info ───────────────────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.SYSTEM_INFO, async () => {
        const licenseInfo = await licenseManager.getLicenseInfo();
        return {
            application: {
                name:            app.getName(),
                version:         app.getVersion(),
                electronVersion: process.versions.electron,
                nodeVersion:     process.versions.node,
                isPackaged:      app.isPackaged,
            },
            license: {
                type:           licenseInfo.licenseType,
                status:         licenseInfo.status,
                daysRemaining:  Number.isFinite(licenseInfo.daysRemaining)
                                    ? licenseInfo.daysRemaining
                                    : 'Unlimited',
                expiryDate:     licenseInfo.expiryDate,
                machineId:      licenseInfo.machineId,
                edition:        licenseInfo.edition,
                activationCount:licenseInfo.activationCount,
            },
            paths:   paths.toDisplayObject(),
            backups: backupService.getStatus(),
            system: {
                platform:   process.platform,
                arch:       process.arch,
                hostname:   os.hostname(),
                totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
                freeMemMB:  Math.round(os.freemem()  / 1024 / 1024),
            },
        };
    });

    // ── app:quit ─────────────────────────────────────────────────────────────
    ipcMain.on(IPC_CHANNELS.APP_QUIT, () => {
        logElectron('[IPC] Quit requested by renderer.');
        app.quit();
    });

    // ── app:open-logs ────────────────────────────────────────────────────────
    ipcMain.on(IPC_CHANNELS.APP_OPEN_LOGS, () => {
        logElectron('[IPC] Open logs folder requested.');
        shell.openPath(LOG_DIR);
    });

    // ── app:open-folder ──────────────────────────────────────────────────────
    ipcMain.on(IPC_CHANNELS.APP_OPEN_FOLDER, (_e, folderKey) => {
        const folderMap = {
            logs:        paths.logsDir,
            uploads:     paths.uploadsDir,
            backups:     paths.backupsDir,
            diagnostics: paths.diagnosticsDir,
            exports:     paths.exportsDir,
        };
        const target = folderMap[folderKey] || paths.logsDir;
        logElectron(`[IPC] Open folder: ${folderKey} → ${target}`);
        shell.openPath(target);
    });

    // ── backup:list ───────────────────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.BACKUP_LIST, async () => backupService.listBackups());

    // ── backup:restore-database ──────────────────────────────────────────────
    // Destructive - the only place includeDatabase:true is passed, always behind this confirmation.
    ipcMain.handle(IPC_CHANNELS.BACKUP_RESTORE_DATABASE, async (_e, backupPath) => {
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['Cancel', 'Restore Database'],
            defaultId: 0,
            cancelId: 0,
            title: 'Restore Database from Backup',
            message: 'This replaces the current database with the selected backup.',
            detail: 'Any data entered after that backup was taken will be lost. This cannot be undone. Are you sure you want to continue?',
        });
        if (response !== 1) {
            return { success: false, message: 'Cancelled by user.' };
        }
        logElectron(`[IPC] Database restore confirmed by user: ${backupPath}`);
        // backendStartConfig omitted deliberately: a full database swap is
        // exactly the case for a clean whole-app relaunch below, not an
        // in-place backend hot-restart.
        const result = await backupService.restoreBackup(backupPath, {
            backendManager,
            licenseManager,
            includeDatabase: true,
        });
        logElectron(`[IPC] Database restore result: ${result.message}`);
        if (result.success) {
            setTimeout(() => { app.relaunch(); app.quit(); }, 3000);
        }
        return result;
    });

    // ── app:export-diagnostics ───────────────────────────────────────────────
    ipcMain.handle(IPC_CHANNELS.APP_EXPORT_DIAGNOSTICS, async () => {
        logElectron('[IPC] Export diagnostics bundle requested.');
        const result = await diagnosticsService.collectBundle();
        logElectron(`[IPC] Diagnostics: ${result.message}`);
        if (result.success) {
            // Open the diagnostics folder so the user can find the file
            shell.openPath(paths.diagnosticsDir);
        }
        return result;
    });
}

// ── Activation loop helper ────────────────────────────────────────────────────
/**
 * Show a blocking license dialog and loop until the user provides a valid
 * activation key/file or explicitly exits.
 *
 * Bug fix (retry after failed import):
 *   After ANY failed activation attempt the dialog window stays open.
 *   We call LicenseDialog.waitForDialogAction(win) again on the SAME open
 *   window rather than waiting for it to close and re-opening it.
 *   This lets the user immediately retry — click "Import .lic File" again,
 *   select a different file, or paste a key string — without restarting.
 *
 * The key point: _waitForDialogAction always cleans up its listeners before
 * resolving, so calling it again registers a fresh set of listeners with
 * no risk of double-firing or memory leaks.
 *
 * @param {Function}       showFn         - () => { promise, win }
 * @param {LicenseManager} licenseManager
 */
async function runActivationLoop(showFn, licenseManager) {
    // Create the dialog window once.
    const { promise: firstPromise, win } = showFn();

    // currentPromise tracks the currently-active wait on this window.
    let currentPromise = firstPromise;

    while (true) {
        const dialogResult = await currentPromise;

        // ── User clicked Exit or closed the window ────────────────────────
        if (dialogResult.action === 'exit') {
            logElectron('[License] User chose to exit.');
            app.quit();
            return;
        }

        // ── Key string activation ─────────────────────────────────────────
        if (dialogResult.action === 'activate' && dialogResult.key) {
            logElectron('[License] Activation key submitted...');
            const result = await licenseManager.activate(dialogResult.key);

            // ── Check for activation window expiry ───────────────────────────
            // Branch on the structured flag — never on message string content.
            if (!result.success && result.activationWindowExpired) {
                logElectron('[License] Activation window expired. Showing dedicated dialog.');
                if (!win.isDestroyed()) win.close();

                const info = await licenseManager.getLicenseInfo();
                const deadlineInfo = result.deadlineInfo || {
                    issueTimestampUtc:     info.issueTimestampUtc,
                    activationWindowDays:  info.activationWindowDays,
                    activationDeadlineUtc: info.activationDeadlineUtc,
                    currentUtc:            new Date().toISOString(),
                };

                const { promise: expiredPromise } = LicenseDialog.showActivationWindowExpiredDialog(info, deadlineInfo);
                await expiredPromise;
                app.quit();
                return;
            }

            if (!win.isDestroyed()) {
                win.webContents.send('dialog:activation-result', result);
            }

            if (result.success) {
                logElectron('[License] Activation successful. Relaunching...');
                // Show the success dialog (auto-closes after 4s).
                // Keep a hidden placeholder window open so Electron does not
                // quit automatically (all-windows-closed) before the relaunch
                // timer fires.
                LicenseDialog.showActivationSuccessDialog();
                const _keepAlive = new (require('electron').BrowserWindow)({
                    show: false, skipTaskbar: true,
                    webPreferences: { contextIsolation: true, nodeIntegration: false },
                });
                setTimeout(() => {
                    if (!_keepAlive.isDestroyed()) _keepAlive.destroy();
                    app.relaunch();
                    app.quit();
                }, 4200);
                return;
            }

            // Failed — window is still open showing the error message.
            // Re-subscribe on the same window so the user can retry immediately.
            if (win.isDestroyed()) {
                // Window was closed while we were processing — loop will recreate.
                // Note: can't reassign const 'win'; this branch is a safety net
                // only (in practice the dialog stays open during activation).
                const { promise: p } = showFn();
                currentPromise = p;
            } else {
                currentPromise = LicenseDialog.waitForDialogAction(win, true);
            }
            continue;
        }

        // ── .lic file import ─────────────────────────────────────────────
        if (dialogResult.action === 'activate-file') {
            logElectron('[License] .lic file import requested...');

            const { canceled, filePaths } = await dialog.showOpenDialog({
                title:      'Select License File',
                filters:    [{ name: 'License Files', extensions: ['lic'] }],
                properties: ['openFile'],
            });

            if (canceled || !filePaths.length) {
                // User cancelled the picker — send a neutral message and
                // re-subscribe so they can try again immediately.
                if (!win.isDestroyed()) {
                    win.webContents.send('dialog:activation-result', {
                        success: false,
                        message: 'No file selected. You can try again.',
                    });
                    currentPromise = LicenseDialog.waitForDialogAction(win, true);
                } else {
                    const { promise: p } = showFn();
                    currentPromise = p;
                }
                continue;
            }

            let fileResult;
            try {
                const contents = fs.readFileSync(filePaths[0], 'utf8');
                fileResult     = await licenseManager.activateFromFile(contents);
            } catch (err) {
                fileResult = { success: false, message: `Could not read file: ${err.message}` };
            }

            // ── Check for activation window expiry ───────────────────────────
            // Branch on the structured flag — never on message string content.
            if (!fileResult.success && fileResult.activationWindowExpired) {
                logElectron('[License] Activation window expired. Showing dedicated dialog.');
                if (!win.isDestroyed()) win.close();

                const info = await licenseManager.getLicenseInfo();
                const deadlineInfo = fileResult.deadlineInfo || {
                    issueTimestampUtc:     info.issueTimestampUtc,
                    activationWindowDays:  info.activationWindowDays,
                    activationDeadlineUtc: info.activationDeadlineUtc,
                    currentUtc:            new Date().toISOString(),
                };

                const { promise: expiredPromise } = LicenseDialog.showActivationWindowExpiredDialog(info, deadlineInfo);
                await expiredPromise;
                app.quit();
                return;
            }

            if (!win.isDestroyed()) {
                win.webContents.send('dialog:activation-result', fileResult);
            }

            if (fileResult.success) {
                logElectron('[License] File activation successful. Relaunching...');
                // Keep-alive window prevents auto-quit before the relaunch timer fires.
                LicenseDialog.showActivationSuccessDialog();
                const _keepAlive = new (require('electron').BrowserWindow)({
                    show: false, skipTaskbar: true,
                    webPreferences: { contextIsolation: true, nodeIntegration: false },
                });
                setTimeout(() => {
                    if (!_keepAlive.isDestroyed()) _keepAlive.destroy();
                    app.relaunch();
                    app.quit();
                }, 4200);
                return;
            }

            // Failed — re-subscribe so the user can retry without restarting.
            if (!win.isDestroyed()) {
                currentPromise = LicenseDialog.waitForDialogAction(win, true);
            } else {
                const { promise: p } = showFn();
                currentPromise = p;
            }
            continue;
        }
    }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    logElectron(`App ready. Packaged=${app.isPackaged}  Version=${app.getVersion()}`);

    // ── Step 3: Initialize LicenseManager ────────────────────────────────────
    const licenseManager = new LicenseManager({
        pathResolver: paths,
        appVersion:   app.getVersion(),
        log:          logElectron,
    });

    let licenseInit = { isFirstInstall: false, isBypassAttempt: false };
    try {
        licenseInit = await licenseManager.initialize();
    } catch (err) {
        logElectron(`[License] CRITICAL: ${err.message}`);
        await dialog.showMessageBox({
            type:    'error',
            title:   'License System Error',
            message: 'Failed to initialize the license system.',
            detail:  err.message,
            buttons: ['Quit'],
        });
        app.quit();
        return;
    }

    // ── Step 4: Validate license ──────────────────────────────────────────────
    const { result: licenseResult } = await licenseManager.checkLicense();
    logElectron(`[License] Check result: ${licenseResult.code}`);

    // ── Step 5a: Blocked — show appropriate dialog ───────────────────────────
    const blockedCodes = [
        VALIDATION_RESULT.EXPIRED,
        VALIDATION_RESULT.INTEGRITY_FAILED,
        VALIDATION_RESULT.MACHINE_MISMATCH,
        VALIDATION_RESULT.MALFORMED,
        VALIDATION_RESULT.CLOCK_TAMPER,
        VALIDATION_RESULT.NOT_FOUND,
    ];

    if (blockedCodes.includes(licenseResult.code)) {
        logElectron(`[License] Startup blocked: ${licenseResult.code}`);
        const info = await licenseManager.getLicenseInfo();

        if (licenseResult.code === VALIDATION_RESULT.CLOCK_TAMPER) {
            const { promise } = LicenseDialog.showClockTamperDialog(info, licenseResult.message);
            await promise;
            app.quit();
            return;
        }

        // NOT_FOUND means "never activated" (friendly prompt) unless
        // isBypassAttempt says a real license.dat was deleted (alarming prompt).
        const showFn = licenseResult.code === VALIDATION_RESULT.EXPIRED
            ? () => LicenseDialog.showExpiredDialog(info)
            : (licenseResult.code === VALIDATION_RESULT.NOT_FOUND && !licenseInit.isBypassAttempt)
                ? () => LicenseDialog.showActivationRequiredDialog(info)
                : () => LicenseDialog.showIntegrityFailedDialog(info);

        await runActivationLoop(showFn, licenseManager);
        return;
    }

    // ── Step 5b: Valid — proceed ──────────────────────────────────────────────
    logElectron(`[License] Valid. Type=${licenseResult.licenseType}  Days=${licenseResult.daysRemaining}`);

    // ── Step 6: Register IPC handlers ────────────────────────────────────────
    const diagnosticsService = new DiagnosticsService(
        paths,
        licenseManager,
        app.getVersion(),
        process.versions.electron
    );
    const backupService = new BackupService({
        pathResolver: paths,
        log:          logElectron,
    });
    registerIpcHandlers(licenseManager, diagnosticsService, backupService);

    // ── Step 7: Splash ────────────────────────────────────────────────────────
    createSplash('Starting backend services...');

    // ── Step 7a: Post-update data verification (only after an in-app update) ──
    // Must run BEFORE ensureRuntimeEnv() below, or a missing .env would get the
    // blank template instead of a real restore. The marker file (written by
    // installer.nsh) is what actually fires this; --updated is for a future in-app updater.
    let updateManager = null;
    const pendingUpdateCheck = fs.existsSync(paths.pendingUpdateCheckFile);
    if (process.argv.includes('--updated') || pendingUpdateCheck) {
        const InstallLogger = require('./license/InstallLogger');
        const UpdateManager = require('./UpdateManager');
        updateManager = new UpdateManager({
            pathResolver: paths,
            backupService,
            installLogger: new InstallLogger(paths),
            licenseManager,
            currentVersion: app.getVersion()
        });
        const verifyResult = await updateManager.verifyPostUpdateData();
        if (!verifyResult.success) {
            logElectron(`[Update] Post-update verification failed: ${verifyResult.message}`);
        }
        if (pendingUpdateCheck) {
            try { fs.unlinkSync(paths.pendingUpdateCheckFile); } catch (err) {
                logElectron(`[Update] Could not remove pending-update marker: ${err.message}`);
            }
        }
    }

    // ── Step 7b: Pre-flight – verify runtime .env exists ─────────────────────
    // This runs BEFORE spawning the backend so the customer gets an immediate
    // clear error dialog instead of waiting 90 seconds for the health-check
    // timeout and then seeing "Backend did not become available".
    const envReady = ensureRuntimeEnv();
    if (!envReady) {
        logElectron('[Preflight] Runtime .env missing or DATABASE_URL absent — aborting backend start.');
        // Dialog before closing splash - same reason as the catch block below.
        await showMissingEnvDialog();
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        app.quit();
        return;
    }

    // ── Step 8: Backend ───────────────────────────────────────────────────────
    backendManager = new BackendManager({ paths, logFn: logElectron, logErrFn: logElectron, port: BACKEND_PORT });
    backendManager.onBackendLog = (line) => { logBackend(line); pushBackendLine(line); };
    backendManager.onBackendErr = (line) => { logBackendErr(line); pushBackendLine(line); };
    backendManager.onBackendError = (err) => pushBackendLine(`[SPAWN ERROR] ${err.message}`);

    // bugfix/backend-code-exposure-fixes spawns a PyInstaller-built LMS_Backend_Server.exe
    // directly instead of VenvManager, and reintroduces a killPortIfBusy(8001) call. Not
    // adopted here: this branch has no PyInstaller build step, and killPortIfBusy() isn't
    // defined on this branch (port cleanup already lives inside BackendManager.start()).
    const VenvManager = require('./VenvManager');
    const projectRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
    const venvManager = new VenvManager(projectRoot, logElectron, logElectron);
    const pythonExe = await venvManager.setupVenv();

    // Port 8001 orphan cleanup is handled inside BackendManager.start() itself.

    const backendEnv = {
        ...process.env,
        UPLOAD_DIR: paths.uploadsDir,
        LMS_BACKEND_CONFIG_DIR: paths.backendConfigDir,
        DEPLOYMENT_MODE: 'onprem',
        PORT: String(BACKEND_PORT),
    };

    try {
        await backendManager.start(
            pythonExe,
            ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT)],
            {
                cwd: path.join(projectRoot, 'backend'),
                shell: false,
                env: backendEnv,
            }
        );

        // ── Step 9: Wait for backend ──────────────────────────────────────────
        await backendManager.waitUntilReady(undefined, (sec) => {
            setSplashStatus(sec < 15 ? 'Starting backend services...' : `Still starting (${sec}s)... the first start after an install can take up to 30s`);
        });

        // Lock the .env only once the DATABASE_URL inside it is proven to
        // actually work - not just "the process is up" (waitUntilReady above
        // is a liveness check only; /health returns 200 even with a dead DB).
        // No-op if already encrypted; leaves it editable if the DB isn't reachable.
        if (app.isPackaged) {
            const envTarget = path.join(paths.backendConfigDir, '.env');
            if (!isEnvEncrypted(envTarget)) {
                if (await isDatabaseHealthy(BACKEND_PORT)) {
                    backupEnvBeforeEncrypt(envTarget, logElectron);
                    encryptEnvFile(envTarget, logElectron);
                    restrictToCurrentUser(envTarget, logElectron, { readOnly: true });
                } else {
                    logElectron('[Preflight] Database not reachable yet - leaving .env editable.');
                }
            }
        }

        if (updateManager) {
            updateManager.logBackendSuccess();
        }

        // ── Step 10: updateLastLaunch — AFTER backend confirmed ───────────────
        await licenseManager.updateLastLaunch();

        // ── Step 11: Main window ──────────────────────────────────────────────
        const win = createWindow();

        // ── Step 11b: Backend crash recovery — only once the app is actually
        // up and running; the try/catch above already handles a failure to
        // start in the first place. ─────────────────────────────────────────
        backendManager.enableCrashRecovery({
            onStatusChange: (status) => {
                mainWindow?.webContents.send(IPC_CHANNELS.BACKEND_STATUS, status);
                if (status.state === 'failed') showBackendCrashDialog(status.attempts);
            },
        });

        // ── Step 12: Trial banner ─────────────────────────────────────────────
        win.webContents.on('did-finish-load', async () => {
            const info = await licenseManager.getLicenseInfo();
            if (
                info.licenseType === LICENSE_TYPES.TRIAL &&
                info.daysRemaining <= TRIAL_WARNING_THRESHOLD_DAYS
            ) {
                LicenseDialog.injectTrialBanner(win, info);
            }
        });

    } catch (err) {
        logElectron(`Startup failed: ${err.message}`);
        // Show the dialog BEFORE closing splash, not after - closing splash while
        // it's the only open window fires 'window-all-closed' immediately, which
        // calls app.quit() on its own, tearing the app down while the dialog's
        // await is still pending. That's what made it flash and vanish.
        if (err.portConflict) {
            await showPortConflictDialog();
        } else {
            await showStartupErrorDialog(err);
        }
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        app.quit();
    }
});

// Without this, closing the window leaves the app running invisibly (backend,
// port, and single-instance lock all still held), breaking the next launch.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// A suspended machine can silently kill or orphan the spawned backend
// process across the sleep/wake cycle in ways the normal exit/health-poll
// paths only catch after the fact (next failed API call). Check proactively
// the moment the system wakes instead of waiting for that. Routes through
// the same _handleUnexpectedExit used by crash/hang recovery, so this is one
// more trigger for the existing recovery path, not a separate one.
powerMonitor.on('resume', async () => {
    logElectron('System resumed from sleep — verifying backend.');
    if (!backendManager) return;
    const alive = await backendManager.healthCheck();
    if (!alive) {
        logElectron('Backend unresponsive after resume — triggering recovery.');
        backendManager._handleUnexpectedExit(null, 'RESUME_CHECK_FAILED');
    }
});

let isQuitting = false;
app.on('before-quit', async (event) => {
    if (isQuitting) return;
    
    logElectron('App quitting — stopping backend.');
    if (backendManager) {
        event.preventDefault(); // Prevent immediate quit
        isQuitting = true;
        writeClosingMarker();

        await backendManager.stop();

        electronLogStream.end();
        backendLogStream.end();

        app.quit(); // Resume quit
    } else {
        electronLogStream.end();
        backendLogStream.end();
    }
});
