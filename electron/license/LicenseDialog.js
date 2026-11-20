/**
 * LicenseDialog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates and manages all license-related UI windows.
 *
 * Phase 5 improvements over original:
 *   1. Window ID embedded in data: URL hash (#wid=N) — eliminates the
 *      executeJavaScript race condition in the previous implementation.
 *   2. Every dialog function returns { promise, win } so callers get the
 *      BrowserWindow reference directly — no fragile browser-window-created
 *      event interception needed in main.js.
 *   3. Removed unused 'shell' and 'app' imports.
 *   4. Import .lic File button added to Expired and Invalid dialogs.
 *   5. Splash window fixed: nodeIntegration: false, contextIsolation: true.
 *
 * Dialogs provided:
 *   showExpiredDialog(info)          → { promise, win }  Trial Expired
 *   showIntegrityFailedDialog(info)  → { promise, win }  License Invalid
 *   showActivationRequiredDialog(info) → { promise, win } Not Yet Activated
 *   showClockTamperDialog(info,msg)  → { promise, win }  Clock Rollback
 *   showActivationSuccessDialog()    → win               Success (auto-close)
 *   injectTrialBanner(win, info)     → void              Banner in main window
 *
 * Return shape for blocking dialogs:
 *   promise resolves to:
 *     { action: 'exit' }
 *     { action: 'activate', key: string }    ← key string
 *     { action: 'activate-file' }            ← .lic file — main opens picker
 *
 * Security:
 *   - contextIsolation: true on every window.
 *   - nodeIntegration: false on every window.
 *   - All IPC uses window-specific channel names (dialog:*:<windowId>).
 *   - windowId is embedded in the URL hash — read synchronously by dialogPreload.
 */

'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SUPPORT_CONTACT, TRIAL_WARNING_THRESHOLD_DAYS } = require('./LicenseConstants');

// ── Shared CSS ────────────────────────────────────────────────────────────────
// No remote @import: this app must render offline, and @import blocks paint
// until it resolves - on a machine with no internet that's a stuck white
// window. System fonts below look fine without it.
const SHARED_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #0d1117;
    color: #e6edf3;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

/* ── Scrollable card shell ───────────────────────────────────────────── */
.shell {
    width: 100%;
    max-height: 100vh;
    overflow-y: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 24px 16px;
}
.shell::-webkit-scrollbar { width: 6px; }
.shell::-webkit-scrollbar-track { background: transparent; }
.shell::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }

/* ── Card ───────────────────────────────────────────────────────────── */
.card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 16px;
    width: 520px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.6);
    overflow: hidden;
}

/* ── Card header ────────────────────────────────────────────────────── */
.card-header {
    padding: 28px 32px 24px;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: flex-start;
    gap: 16px;
}
.header-icon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    flex-shrink: 0;
}
.header-icon.warn  { background: rgba(217, 119, 6, 0.15);  border: 1px solid rgba(217,119,6,0.3); }
.header-icon.error { background: rgba(220, 38, 38, 0.12);  border: 1px solid rgba(220,38,38,0.25); }
.header-icon.info  { background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59,130,246,0.25); }
.header-icon.ok    { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16,185,129,0.25); }
.header-text h1 {
    font-size: 18px;
    font-weight: 700;
    color: #e6edf3;
    margin-bottom: 4px;
    line-height: 1.3;
}
.header-text p {
    font-size: 13px;
    color: #8b949e;
    line-height: 1.55;
}

/* ── Card body ──────────────────────────────────────────────────────── */
.card-body { padding: 24px 32px; }

/* ── Info grid ──────────────────────────────────────────────────────── */
.info-grid {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 24px;
}
.info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid #21262d;
    gap: 12px;
}
.info-row:last-child { border-bottom: none; }
.info-label {
    color: #8b949e;
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    white-space: nowrap;
}
.info-value {
    color: #e6edf3;
    font-size: 13px;
    font-weight: 600;
    font-family: 'Consolas', 'SF Mono', monospace;
    text-align: right;
    word-break: break-all;
}

/* ── Section label ──────────────────────────────────────────────────── */
.section-label {
    font-size: 11px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 10px;
}

/* ── Method tabs ────────────────────────────────────────────────────── */
.method-tabs {
    display: flex;
    border: 1px solid #30363d;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 16px;
}
.tab-btn {
    flex: 1;
    padding: 9px 12px;
    background: transparent;
    border: none;
    color: #8b949e;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
    border-right: 1px solid #30363d;
}
.tab-btn:last-child { border-right: none; }
.tab-btn.active {
    background: #1f6feb;
    color: #ffffff;
    font-weight: 600;
}
.tab-btn:not(.active):hover { background: #21262d; color: #e6edf3; }

/* ── Tab panels ─────────────────────────────────────────────────────── */
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* ── File upload zone ───────────────────────────────────────────────── */
.upload-zone {
    border: 2px dashed #30363d;
    border-radius: 10px;
    padding: 28px 20px;
    text-align: center;
    cursor: pointer;
    transition: all 0.18s ease;
    background: #0d1117;
    position: relative;
    user-select: none;
}
.upload-zone:hover, .upload-zone:focus {
    border-color: #1f6feb;
    background: rgba(31, 111, 235, 0.06);
    outline: none;
}
.upload-zone:active { transform: scale(0.99); }
.upload-zone.drag-over {
    border-color: #1f6feb;
    background: rgba(31, 111, 235, 0.1);
}
.upload-zone-icon {
    width: 44px;
    height: 44px;
    margin: 0 auto 12px;
    background: rgba(31, 111, 235, 0.15);
    border: 1px solid rgba(31, 111, 235, 0.3);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
}
.upload-zone-title {
    font-size: 14px;
    font-weight: 600;
    color: #e6edf3;
    margin-bottom: 4px;
}
.upload-zone-sub {
    font-size: 12px;
    color: #8b949e;
}
.upload-zone-sub strong {
    color: #1f6feb;
    font-weight: 600;
}

/* ── Input field ────────────────────────────────────────────────────── */
.field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 8px;
}
.key-input {
    width: 100%;
    padding: 11px 14px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    color: #e6edf3;
    font-size: 13px;
    font-family: 'Consolas', 'SF Mono', monospace;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    line-height: 1.5;
}
.key-input::placeholder { color: #484f58; }
.key-input:focus {
    border-color: #1f6feb;
    box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.2);
}
.key-hint {
    font-size: 11px;
    color: #6e7681;
    margin-top: 6px;
    line-height: 1.5;
}

/* ── Message area ───────────────────────────────────────────────────── */
.msg-area {
    min-height: 36px;
    margin: 14px 0 4px;
    border-radius: 8px;
    padding: 0;
    overflow: hidden;
    transition: all 0.2s ease;
}
.msg-inner {
    display: none;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.5;
}
.msg-inner.visible { display: flex; }
.msg-inner.error {
    background: rgba(220, 38, 38, 0.1);
    border: 1px solid rgba(220, 38, 38, 0.25);
    color: #fca5a5;
}
.msg-inner.success {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.25);
    color: #6ee7b7;
}
.msg-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }

/* ── Contact box ────────────────────────────────────────────────────── */
.contact-box {
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 12px;
}
.contact-icon {
    width: 36px; height: 36px;
    background: rgba(59, 130, 246, 0.12);
    border: 1px solid rgba(59,130,246,0.2);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; flex-shrink: 0;
}
.contact-text p { font-size: 12px; color: #8b949e; margin-bottom: 2px; }
.contact-text strong { font-size: 13px; color: #58a6ff; font-weight: 600; }

/* ── Card footer / action row ───────────────────────────────────────── */
.card-footer {
    padding: 0 32px 28px;
    display: flex;
    gap: 10px;
}
.btn {
    flex: 1;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    font-family: inherit;
    line-height: 1;
}
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

.btn-primary {
    background: #1f6feb;
    color: #ffffff;
    border-color: #1f6feb;
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}
.btn-primary:hover:not(:disabled) { background: #388bfd; border-color: #388bfd; }

.btn-ghost {
    background: transparent;
    color: #8b949e;
    border-color: #30363d;
}
.btn-ghost:hover:not(:disabled) { background: #21262d; color: #e6edf3; border-color: #484f58; }

.btn-full { flex: unset; width: 100%; }

/* ── Spinner ────────────────────────────────────────────────────────── */
.spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    display: none;
}
@keyframes spin { to { transform: rotate(360deg); } }
.btn.loading .spinner { display: block; }
.btn.loading .btn-text { display: none; }

/* ── Badges ─────────────────────────────────────────────────────────── */
.badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.3px;
}
.badge-expired { background: rgba(220,38,38,0.12); color: #f87171; border: 1px solid rgba(220,38,38,0.25); }
.badge-invalid { background: rgba(220,38,38,0.12); color: #f87171; border: 1px solid rgba(220,38,38,0.25); }
.badge-warn    { background: rgba(217,119,6,0.12);  color: #fbbf24; border: 1px solid rgba(217,119,6,0.3); }
.badge-info    { background: rgba(59,130,246,0.12); color: #60a5fa; border: 1px solid rgba(59,130,246,0.25); }
.badge-ok      { background: rgba(16,185,129,0.12); color: #34d399; border: 1px solid rgba(16,185,129,0.25); }

/* ── Progress bar (success dialog) ─────────────────────────────────── */
.progress-track {
    height: 4px;
    background: #21262d;
    border-radius: 4px;
    overflow: hidden;
    margin-top: 28px;
}
.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #1f6feb, #34d399);
    border-radius: 4px;
    animation: shrink 4s linear forwards;
}
@keyframes shrink { from { width: 100%; } to { width: 0%; } }

/* ── Step indicator ─────────────────────────────────────────────────── */
.steps {
    display: flex;
    align-items: center;
    gap: 0;
    margin-bottom: 22px;
    counter-reset: step;
}
.step {
    display: flex;
    align-items: center;
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    color: #6e7681;
    gap: 8px;
}
.step.active { color: #e6edf3; }
.step-num {
    width: 24px; height: 24px;
    border-radius: 50%;
    border: 2px solid #30363d;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; flex-shrink: 0;
    color: #6e7681;
}
.step.active .step-num { border-color: #1f6feb; color: #1f6feb; background: rgba(31,111,235,0.1); }
.step-line { flex: 1; height: 1px; background: #21262d; margin: 0 4px; min-width: 16px; }
`;

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Create a dialog BrowserWindow with the windowId embedded in the URL hash.
 * The hash (#wid=N) is read synchronously by dialogPreload.js, eliminating
 * any race condition between page load and windowId injection.
 *
 * @param {object} opts
 * @returns {{ win: BrowserWindow, loadHtml: function(string): void }}
 */
function _createDialog({ width = 600, height = 750, title = 'Lab Management System' } = {}) {
    const win = new BrowserWindow({
        width,
        height,
        resizable:       false,
        center:          true,
        title,
        frame:           true,
        autoHideMenuBar: true,
        // No alwaysOnTop: the user may leave this open a while (finding a
        // .lic file, checking email) - pinning it above every other app on
        // the desktop instead of just showing/focusing once is bad behavior.
        skipTaskbar:     false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration:  false,
            preload:          path.join(__dirname, 'dialogPreload.js'),
        },
    });

    /**
     * Load HTML content. Appends #wid=<windowId> to the data: URI so
     * dialogPreload can resolve the window ID synchronously.
     * @param {string} html
     */
    function loadHtml(html) {
        // Encode HTML body, then append the hash separately so it is NOT
        // encoded (the hash is read from location.hash, not from the body).
        const encoded = encodeURIComponent(html);
        win.loadURL(`data:text/html;charset=utf-8,${encoded}#wid=${win.id}`);
    }

    return { win, loadHtml };
}

/**
 * Register IPC listeners for a dialog window and return a Promise that
 * resolves when the user takes a single action.
 *
 * Key design: uses ipcMain.once internally so each call resolves exactly once.
 * The window stays open after resolution — caller decides what to do next.
 * Callers that want to keep listening on the same open window simply call
 * this function again with the same `win`.
 *
 * Handles three possible actions:
 *   activate      → user submitted a key string
 *   activate-file → user wants to import a .lic file
 *   exit          → user clicked Exit or closed the window
 *
 * Cleans up all listeners after the first action fires so there are no leaks.
 *
 * @param {BrowserWindow} win
 * @param {boolean} allowActivate - whether to register the activate channels
 * @returns {Promise<{ action: string, key?: string }>}
 */
function _waitForDialogAction(win, allowActivate = true) {
    return new Promise((resolve) => {
        const id    = win.id;
        let settled = false;

        function settle(result) {
            if (settled) return;
            settled = true;
            // Always clean up all three channels before resolving
            ipcMain.removeAllListeners(`dialog:activate:${id}`);
            ipcMain.removeAllListeners(`dialog:activate-file:${id}`);
            ipcMain.removeAllListeners(`dialog:exit:${id}`);
            win.removeListener('closed', onClosed);
            resolve(result);
        }

        function onClosed() { settle({ action: 'exit' }); }

        if (allowActivate) {
            ipcMain.once(`dialog:activate:${id}`,      (_e, key) => settle({ action: 'activate', key }));
            ipcMain.once(`dialog:activate-file:${id}`, ()        => settle({ action: 'activate-file' }));
        }

        ipcMain.once(`dialog:exit:${id}`, () => settle({ action: 'exit' }));
        win.once('closed', onClosed);
    });
}

// ── Activation section HTML ───────────────────────────────────────────────────
// Shared by the Expired and Invalid dialogs.
// Uses a tab-based layout so users clearly see both options.

function _activationSection() {
    return `
    <!-- Step indicator -->
    <div class="steps">
        <div class="step active">
            <div class="step-num">1</div>
            <span>Choose method</span>
        </div>
        <div class="step-line"></div>
        <div class="step active">
            <div class="step-num">2</div>
            <span>Submit &amp; activate</span>
        </div>
    </div>

    <!-- Method selector tabs -->
    <div class="section-label">Activation method</div>
    <div class="method-tabs" role="tablist" aria-label="Activation method">
        <button class="tab-btn active" role="tab" aria-selected="true"
                aria-controls="panel-file" id="tab-file"
                onclick="switchTab('file')">
            📄&nbsp; Import .lic File
        </button>
        <button class="tab-btn" role="tab" aria-selected="false"
                aria-controls="panel-key" id="tab-key"
                onclick="switchTab('key')">
            🔑&nbsp; Enter Activation Key
        </button>
    </div>

    <!-- Panel: Import .lic file -->
    <div class="tab-panel active" id="panel-file" role="tabpanel" aria-labelledby="tab-file">
        <div class="upload-zone" tabindex="0" role="button"
             aria-label="Click to browse for a .lic license file"
             onclick="doImportFile()"
             onkeydown="if(event.key==='Enter'||event.key===' '){doImportFile();}"
             ondragover="event.preventDefault();this.classList.add('drag-over')"
             ondragleave="this.classList.remove('drag-over')">
            <div class="upload-zone-icon">📂</div>
            <div class="upload-zone-title">Click to browse for your license file</div>
            <div class="upload-zone-sub">Accepts <strong>.lic</strong> files provided by Millennium TechLink</div>
        </div>
        <p class="key-hint">Your vendor will email you a <strong>.lic</strong> file. Save it anywhere, then click above to locate it.</p>
    </div>

    <!-- Panel: Enter key string -->
    <div class="tab-panel" id="panel-key" role="tabpanel" aria-labelledby="tab-key">
        <label class="field-label" for="keyInput">Activation key</label>
        <textarea id="keyInput"
                  class="key-input"
                  rows="4"
                  placeholder="Paste your Base64 activation key here…"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="Activation key input"
                  style="resize:vertical;"></textarea>
        <p class="key-hint">Copy the full key string from the email sent by Millennium TechLink and paste it above.</p>
    </div>

    <!-- Feedback area -->
    <div class="msg-area" id="msgArea" role="alert" aria-live="polite">
        <div class="msg-inner" id="errorMsg">
            <span class="msg-icon">⚠</span>
            <span id="errorText"></span>
        </div>
        <div class="msg-inner" id="successMsg">
            <span class="msg-icon">✓</span>
            <span id="successText"></span>
        </div>
    </div>`;
}

function _activationScript() {
    return `
    <script>
        var activeTab = 'file';

        function switchTab(tab) {
            activeTab = tab;
            document.querySelectorAll('.tab-btn').forEach(function(b) {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            document.querySelectorAll('.tab-panel').forEach(function(p) {
                p.classList.remove('active');
            });
            document.getElementById('tab-' + tab).classList.add('active');
            document.getElementById('tab-' + tab).setAttribute('aria-selected', 'true');
            document.getElementById('panel-' + tab).classList.add('active');
            clearMessages();
        }

        function doActivate() {
            if (activeTab === 'file') {
                doImportFile();
                return;
            }
            var key = document.getElementById('keyInput').value.trim();
            if (!key) {
                showError('Please paste your activation key in the field above, or switch to the file import tab.');
                return;
            }
            clearMessages();
            var btn = document.getElementById('submitBtn');
            setLoading(btn, true);
            window.electronDialog.activate(key);
        }

        function doImportFile() {
            clearMessages();
            window.electronDialog.importFile();
        }

        function doExit() {
            window.electronDialog.exit();
        }

        function setLoading(btn, loading) {
            if (!btn) return;
            btn.disabled = loading;
            btn.classList.toggle('loading', loading);
        }

        function showError(msg) {
            document.getElementById('errorText').textContent = msg;
            document.getElementById('errorMsg').classList.add('visible');
            document.getElementById('successMsg').classList.remove('visible');
            var btn = document.getElementById('submitBtn');
            setLoading(btn, false);
        }

        function showSuccess(msg) {
            document.getElementById('successText').textContent = msg;
            document.getElementById('successMsg').classList.add('visible');
            document.getElementById('errorMsg').classList.remove('visible');
        }

        function clearMessages() {
            document.getElementById('errorMsg').classList.remove('visible');
            document.getElementById('successMsg').classList.remove('visible');
        }

        window.electronDialog.onActivationResult(function(result) {
            if (result.success) {
                showSuccess(result.message + ' The application will restart shortly…');
            } else {
                showError(result.message);
            }
        });
    </script>`;
}

// ── Public dialog functions ───────────────────────────────────────────────────

/**
 * Show the Trial Expired dialog.
 * User must activate a license or exit — application startup is blocked.
 *
 * @param {object} info  - from LicenseManager.getLicenseInfo()
 * @returns {{ promise: Promise<{action,key?}>, win: BrowserWindow }}
 */
function showExpiredDialog(info) {
    const { win, loadHtml } = _createDialog({
        width: 580, height: 780,
        title: 'Trial Expired - Lab Management System',
    });

    const installStr = info.installDate
        ? new Date(info.installDate).toLocaleDateString()
        : 'Unknown';
    const expiryStr = info.expiryDate && info.expiryDate !== 'NEVER'
        ? new Date(info.expiryDate).toLocaleDateString()
        : 'N/A';

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trial Expired</title>
<style>${SHARED_CSS}</style></head><body>
<div class="shell">
<div class="card">
    <!-- Header -->
    <div class="card-header">
        <div class="header-icon warn">⏰</div>
        <div class="header-text">
            <h1>Trial Period Expired</h1>
            <p>Your 30-day trial has ended. Activate a license to continue using Lab Management System.</p>
        </div>
    </div>

    <!-- Body -->
    <div class="card-body">
        <!-- License info -->
        <div class="section-label">License Information</div>
        <div class="info-grid">
            <div class="info-row">
                <span class="info-label">Machine ID</span>
                <span class="info-value">${info.machineId || 'Unknown'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Install Date</span>
                <span class="info-value">${installStr}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Expiry Date</span>
                <span class="info-value">${expiryStr}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value"><span class="badge badge-expired">EXPIRED</span></span>
            </div>
        </div>

        <!-- Activation section -->
        ${_activationSection()}

        <!-- Contact box -->
        <div class="contact-box">
            <div class="contact-icon">📧</div>
            <div class="contact-text">
                <p>To purchase a license, contact:</p>
                <strong>${SUPPORT_CONTACT.email}</strong>
            </div>
        </div>
    </div>

    <!-- Footer / Actions -->
    <div class="card-footer">
        <button class="btn btn-ghost" onclick="doExit()">Exit Application</button>
        <button class="btn btn-primary" id="submitBtn" onclick="doActivate()">
            <span class="spinner"></span>
            <span class="btn-text">Activate License ➔</span>
        </button>
    </div>
</div>
</div>
${_activationScript()}
</body></html>`;

    loadHtml(html);
    const promise = _waitForDialogAction(win, true);
    return { promise, win };
}

/**
 * Show the License Invalid / Integrity Failed dialog.
 *
 * @param {object} info
 * @returns {{ promise: Promise<{action,key?}>, win: BrowserWindow }}
 */
function showIntegrityFailedDialog(info) {
    const { win, loadHtml } = _createDialog({
        width: 580, height: 760,
        title: 'License Invalid - Lab Management System',
    });

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>License Invalid</title>
<style>${SHARED_CSS}</style></head><body>
<div class="shell">
<div class="card">
    <!-- Header -->
    <div class="card-header">
        <div class="header-icon error">🔒</div>
        <div class="header-text">
            <h1>License Invalid</h1>
            <p>The license file is corrupted, tampered with, or issued for a different machine. Please activate a valid license.</p>
        </div>
    </div>

    <!-- Body -->
    <div class="card-body">
        <!-- License info -->
        <div class="section-label">Current Status</div>
        <div class="info-grid">
            <div class="info-row">
                <span class="info-label">Machine ID</span>
                <span class="info-value">${info.machineId || 'Unknown'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value"><span class="badge badge-invalid">INVALID</span></span>
            </div>
        </div>

        <!-- Activation section -->
        ${_activationSection()}

        <!-- Contact box -->
        <div class="contact-box">
            <div class="contact-icon">💬</div>
            <div class="contact-text">
                <p>Need a replacement license?</p>
                <strong>${SUPPORT_CONTACT.email}</strong>
            </div>
        </div>
    </div>

    <!-- Footer / Actions -->
    <div class="card-footer">
        <button class="btn btn-ghost" onclick="doExit()">Exit Application</button>
        <button class="btn btn-primary" id="submitBtn" onclick="doActivate()">
            <span class="spinner"></span>
            <span class="btn-text">Activate License ➔</span>
        </button>
    </div>
</div>
</div>
${_activationScript()}
</body></html>`;

    loadHtml(html);
    const promise = _waitForDialogAction(win, true);
    return { promise, win };
}

/**
 * Show the "Activate Your License" dialog - a fresh install with no
 * license.dat yet. Worded as a normal first step, not a warning.
 * @param {object} info
 * @returns {{ promise: Promise<{action,key?}>, win: BrowserWindow }}
 */
function showActivationRequiredDialog(info) {
    const { win, loadHtml } = _createDialog({
        width: 580, height: 760,
        title: 'Activate License - Lab Management System',
    });

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activate License</title>
<style>${SHARED_CSS}</style></head><body>
<div class="shell">
<div class="card">
    <!-- Header -->
    <div class="card-header">
        <div class="header-icon info">🔑</div>
        <div class="header-text">
            <h1>Activate Your License</h1>
            <p>Enter the activation key or import the .lic file you received to start using Lab Management System.</p>
        </div>
    </div>

    <!-- Body -->
    <div class="card-body">
        <!-- License info -->
        <div class="section-label">This Machine</div>
        <div class="info-grid">
            <div class="info-row">
                <span class="info-label">Machine ID</span>
                <span class="info-value">${info.machineId || 'Unknown'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value"><span class="badge badge-info">NOT ACTIVATED</span></span>
            </div>
        </div>

        <!-- Activation section -->
        ${_activationSection()}

        <!-- Contact box -->
        <div class="contact-box">
            <div class="contact-icon">📧</div>
            <div class="contact-text">
                <p>Don't have a license yet? Share the Machine ID above with:</p>
                <strong>${SUPPORT_CONTACT.email}</strong>
            </div>
        </div>
    </div>

    <!-- Footer / Actions -->
    <div class="card-footer">
        <button class="btn btn-ghost" onclick="doExit()">Exit Application</button>
        <button class="btn btn-primary" id="submitBtn" onclick="doActivate()">
            <span class="spinner"></span>
            <span class="btn-text">Activate License ➔</span>
        </button>
    </div>
</div>
</div>
${_activationScript()}
</body></html>`;

    loadHtml(html);
    const promise = _waitForDialogAction(win, true);
    return { promise, win };
}

/**
 * Show the Activation Window Expired dialog.
 * Shown when user tries to activate a license after the activation deadline.
 * No activation is allowed — user must contact support for a new license.
 *
 * @param {object} info         - from LicenseManager.getLicenseInfo()
 * @param {object} deadlineInfo - activation window details from ActivationService
 * @returns {{ promise: Promise<{action}>, win: BrowserWindow }}
 */
function showActivationWindowExpiredDialog(info, deadlineInfo) {
    const { win, loadHtml } = _createDialog({
        width: 580, height: 700,
        title: 'Activation Window Expired - Lab Management System',
    });

    const issueStr = deadlineInfo.issueTimestampUtc
        ? new Date(deadlineInfo.issueTimestampUtc).toUTCString()
        : 'Unknown';
    const deadlineStr = deadlineInfo.activationDeadlineUtc
        ? new Date(deadlineInfo.activationDeadlineUtc).toUTCString()
        : 'Unknown';
    const currentStr = deadlineInfo.currentUtc
        ? new Date(deadlineInfo.currentUtc).toUTCString()
        : new Date().toUTCString();
    const windowDays = deadlineInfo.activationWindowDays || '?';

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activation Window Expired</title>
<style>${SHARED_CSS}</style></head><body>
<div class="shell">
<div class="card">
    <!-- Header -->
    <div class="card-header">
        <div class="header-icon warn">⏰</div>
        <div class="header-text">
            <h1>Activation Window Expired</h1>
            <p>This license had a ${windowDays}-day activation window that has expired. Contact support to generate a new activation license.</p>
        </div>
    </div>

    <!-- Body -->
    <div class="card-body">
        <!-- Timing details -->
        <div class="section-label">Activation Window Details</div>
        <div class="info-grid">
            <div class="info-row">
                <span class="info-label">Machine ID</span>
                <span class="info-value">${info.machineId || 'Unknown'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">License Issued (UTC)</span>
                <span class="info-value" style="font-size:11px;">${issueStr}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Activation Window</span>
                <span class="info-value">${windowDays} days</span>
            </div>
            <div class="info-row">
                <span class="info-label">Deadline (UTC)</span>
                <span class="info-value" style="font-size:11px;">${deadlineStr}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Current Time (UTC)</span>
                <span class="info-value" style="font-size:11px;">${currentStr}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value"><span class="badge badge-expired">WINDOW EXPIRED</span></span>
            </div>
        </div>

        <!-- Contact box -->
        <div class="contact-box">
            <div class="contact-icon">📧</div>
            <div class="contact-text">
                <p>Request a new activation license:</p>
                <strong>${SUPPORT_CONTACT.email}</strong>
            </div>
        </div>
    </div>

    <!-- Footer / Actions -->
    <div class="card-footer">
        <button class="btn btn-ghost btn-full" onclick="window.electronDialog.exit()">Exit Application</button>
    </div>
</div>
</div>
</body></html>`;

    loadHtml(html);
    const promise = _waitForDialogAction(win, false);
    return { promise, win };
}

/**
 * Show the Clock Rollback / Tamper dialog.
 * No activation path — user must fix the clock and restart.
 *
 * @param {object} info
 * @param {string} detail  - human-readable rollback detail from LicenseValidator
 * @returns {{ promise: Promise<{action}>, win: BrowserWindow }}
 */
function showClockTamperDialog(info, detail) {
    const { win, loadHtml } = _createDialog({
        width: 540, height: 480,
        title: 'Security Warning - Lab Management System',
    });

    // Sanitise detail for safe HTML embedding (no XSS from stored timestamps)
    const safeDetail = String(detail || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .slice(0, 300);

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clock Rollback Warning</title>
<style>${SHARED_CSS}</style></head><body>
<div class="shell">
<div class="card">
    <!-- Header -->
    <div class="card-header">
        <div class="header-icon warn">⚠️</div>
        <div class="header-text">
            <h1>Clock Rollback Detected</h1>
            <p>The system clock has been set back. Restore the correct time and restart the application.</p>
        </div>
    </div>

    <!-- Body -->
    <div class="card-body">
        <div class="section-label">Details</div>
        <div class="info-grid">
            <div class="info-row">
                <span class="info-label">Machine ID</span>
                <span class="info-value">${info.machineId || 'Unknown'}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Issue</span>
                <span class="info-value" style="font-size:11px;">${safeDetail}</span>
            </div>
        </div>

        <div class="contact-box">
            <div class="contact-icon">💬</div>
            <div class="contact-text">
                <p>If you believe this is an error:</p>
                <strong>${SUPPORT_CONTACT.email}</strong>
            </div>
        </div>
    </div>

    <!-- Footer / Actions -->
    <div class="card-footer">
        <button class="btn btn-ghost btn-full" onclick="window.electronDialog.exit()">Exit Application</button>
    </div>
</div>
</div>
</body></html>`;

    loadHtml(html);
    const promise = _waitForDialogAction(win, false);
    return { promise, win };
}

/**
 * Show the Activation Successful dialog.
 * Non-blocking — auto-closes after 4 seconds.
 * Returns the BrowserWindow directly (no promise needed).
 *
 * @returns {BrowserWindow}
 */
function showActivationSuccessDialog() {
    const { win, loadHtml } = _createDialog({
        width: 480, height: 320,
        title: 'License Activated',
    });

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Activated</title>
<style>
${SHARED_CSS}
.success-content { text-align: center; padding: 40px 32px 32px; }
.success-icon {
    width: 64px; height: 64px; margin: 0 auto 18px;
    background: rgba(16, 185, 129, 0.15);
    border: 2px solid rgba(16, 185, 129, 0.3);
    border-radius: 50%; display: flex;
    align-items: center; justify-content: center;
    font-size: 32px;
}
.success-title {
    font-size: 20px; font-weight: 700; color: #34d399;
    margin-bottom: 8px;
}
.success-text { font-size: 14px; color: #8b949e; }
</style></head><body>
<div class="shell">
<div class="card">
    <div class="success-content">
        <div class="success-icon">✓</div>
        <h1 class="success-title">License Activated Successfully</h1>
        <p class="success-text">The application will restart automatically.</p>
        <div class="progress-track"><div class="progress-fill"></div></div>
    </div>
</div>
</div>
<script>
    setTimeout(function() {
        if (window.electronDialog) window.electronDialog.exit();
    }, 4000);
</script>
</body></html>`;

    loadHtml(html);

    // Auto-close handler
    ipcMain.once(`dialog:exit:${win.id}`, () => {
        if (!win.isDestroyed()) win.close();
    });

    return win;
}

/**
 * Inject a dismissible trial warning banner into the main application window.
 * Only shown when trial is active and daysRemaining ≤ TRIAL_WARNING_THRESHOLD_DAYS.
 *
 * @param {BrowserWindow} mainWindow
 * @param {object}        info  - from LicenseManager.getLicenseInfo()
 */
function injectTrialBanner(mainWindow, info) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (info.daysRemaining > TRIAL_WARNING_THRESHOLD_DAYS) return;

    const days        = info.daysRemaining;
    const expiryStr   = info.expiryDate && info.expiryDate !== 'NEVER'
        ? new Date(info.expiryDate).toLocaleDateString()
        : '';
    const bgColor     = days <= 3 ? '#991b1b' : '#92400e';
    const textColor   = days <= 3 ? '#fca5a5' : '#fbbf24';
    const daysLabel   = days === 1 ? '1 day' : `${days} days`;

    // This script is injected into the renderer (already running React app).
    // It adds a fixed-position banner that the user can dismiss.
    // Guard prevents double-injection across hot reloads.
    const script = `
(function() {
    if (document.getElementById('__lms_trial_banner__')) return;
    var b = document.createElement('div');
    b.id = '__lms_trial_banner__';
    b.setAttribute('role', 'alert');
    b.style.cssText = 
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:${bgColor};color:${textColor};' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'font-size:13px;padding:10px 16px;display:flex;align-items:center;' +
        'justify-content:space-between;box-shadow:0 2px 12px rgba(0,0,0,0.5);' +
        'border-bottom:1px solid rgba(255,255,255,0.1);';
    b.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;">' +
        '<span style="font-size:18px;">⚠️</span>' +
        '<span><strong style="font-weight:700;">Trial License</strong> - ' +
        '${daysLabel} remaining${expiryStr ? ' (expires ' + expiryStr + ')' : ''}. ' +
        'Activate a license to continue access.</span></div>' +
        '<button aria-label="Dismiss" onclick="this.parentElement.remove()" ' +
        'style="background:transparent;border:1px solid rgba(255,255,255,0.2);' +
        'color:${textColor};cursor:pointer;font-size:11px;font-weight:600;' +
        'padding:4px 10px;border-radius:4px;transition:all 0.15s;' +
        'font-family:inherit;">Dismiss</button>';
    document.body ? document.body.prepend(b) : document.documentElement.prepend(b);
})();
`;
    mainWindow.webContents.executeJavaScript(script).catch(() => {});
}

module.exports = {
    showExpiredDialog,
    showIntegrityFailedDialog,
    showActivationRequiredDialog,
    showActivationWindowExpiredDialog,
    showClockTamperDialog,
    showActivationSuccessDialog,
    injectTrialBanner,
    // Exported so main.js can re-subscribe on an already-open dialog window
    // after a failed activation attempt without recreating the window.
    waitForDialogAction: _waitForDialogAction,
};
