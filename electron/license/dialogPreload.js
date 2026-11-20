/**
 * dialogPreload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal contextBridge for license dialog BrowserWindows.
 *
 * Security design:
 *   - contextIsolation: true on all dialog windows.
 *   - Only the three operations a dialog ever needs are exposed.
 *   - No Node.js or Electron APIs are accessible from dialog HTML.
 *
 * Window ID resolution — race-condition-free approach:
 *   The window ID is embedded in the data: URL hash by LicenseDialog.js
 *   before the page loads:  data:text/html;charset=utf-8,...#wid=<id>
 *   This preload reads it synchronously from location.hash before any
 *   user interaction is possible, eliminating the previous
 *   executeJavaScript injection race condition.
 *
 * IPC channel naming:
 *   dialog:activate:<windowId>         → user submitted an activation key
 *   dialog:activate-file:<windowId>    → user clicked Import .lic File
 *   dialog:exit:<windowId>             → user clicked Exit
 *   dialog:activation-result           → main sends result back to this window
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Resolve window ID synchronously from URL hash ─────────────────────────
// Reads hash ONCE at script evaluation time — guaranteed before any IPC.
function _getWindowId() {
    try {
        const hash = window.location.hash;      // e.g.  #wid=5
        const match = hash.match(/wid=(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    } catch {
        return 0;
    }
}

const WINDOW_ID = _getWindowId();

// ── Exposed API ────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electronDialog', {

    /**
     * Send an activation key string to the main process.
     * @param {string} key - Base64-encoded activation key
     */
    activate(key) {
        ipcRenderer.send(`dialog:activate:${WINDOW_ID}`, key);
    },

    /**
     * Signal the main process that the user clicked "Import .lic File".
     * Main will open a native file picker and handle the result.
     */
    importFile() {
        ipcRenderer.send(`dialog:activate-file:${WINDOW_ID}`);
    },

    /**
     * Signal the main process that the user clicked Exit.
     */
    exit() {
        ipcRenderer.send(`dialog:exit:${WINDOW_ID}`);
    },

    /**
     * Register a one-time callback for activation results sent back from main.
     * @param {Function} callback - receives { success: boolean, message: string }
     */
    onActivationResult(callback) {
        ipcRenderer.on('dialog:activation-result', (_event, result) => {
            callback(result);
        });
    },
});
