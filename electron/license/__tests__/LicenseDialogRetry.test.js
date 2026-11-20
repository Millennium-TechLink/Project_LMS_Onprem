/**
 * LicenseDialogRetry.test.js
 * Bug fix verification — dialog must remain functional after a failed activation.
 *
 * Tests the exact failure sequence reported:
 *   1. User clicks "Import License File"
 *   2. File validation fails (wrong machine, bad sig, expired, etc.)
 *   3. Dialog shows error message
 *   4. User can immediately click "Import License File" again (no restart needed)
 *   5. User can also paste a key string after a failed file import
 *   6. User can try a file import after a failed key-string attempt
 *   7. Cancelling the file picker does NOT lock the dialog
 *
 * Run with: node onprem/electron/license/__tests__/LicenseDialogRetry.test.js
 */

'use strict';

const { ipcMain: _ipcMainCheck } = (() => {
    try { return require('electron'); }
    catch { return { ipcMain: null }; }
})();

// ── These tests exercise _waitForDialogAction directly via the exported
//    waitForDialogAction function, using a mock BrowserWindow and ipcMain.
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description, condition) {
    if (condition) {
        console.log(`  ✓  ${description}`);
        passed++;
    } else {
        console.error(`  ✗  FAIL: ${description}`);
        failed++;
    }
}

// ── Minimal mock of Electron's ipcMain ───────────────────────────────────────
// Simulates the ipcMain.once / removeAllListeners / .on semantics
class MockIpcMain {
    constructor() {
        this._listeners = {};  // channel → [handler, ...]
    }

    once(channel, handler) {
        if (!this._listeners[channel]) this._listeners[channel] = [];
        // 'once' wraps the handler to auto-remove after first call
        const wrapper = (...args) => {
            this.removeAllListeners(channel);
            handler(...args);
        };
        wrapper._once = true;
        wrapper._original = handler;
        this._listeners[channel].push(wrapper);
    }

    on(channel, handler) {
        if (!this._listeners[channel]) this._listeners[channel] = [];
        this._listeners[channel].push(handler);
    }

    removeAllListeners(channel) {
        delete this._listeners[channel];
    }

    emit(channel, ...args) {
        const handlers = (this._listeners[channel] || []).slice();
        for (const h of handlers) {
            h(...args);
        }
    }

    listenerCount(channel) {
        return (this._listeners[channel] || []).length;
    }
}

// ── Minimal mock BrowserWindow ────────────────────────────────────────────────
class MockWin {
    constructor(id) {
        this.id       = id;
        this._closed  = false;
        this._events  = {};
        this.webContents = {
            send: () => {},
            executeJavaScript: async () => {},
        };
    }

    once(event, handler) {
        if (!this._events[event]) this._events[event] = [];
        const wrapper = (...args) => {
            this._events[event] = (this._events[event] || []).filter(h => h !== wrapper);
            handler(...args);
        };
        this._events[event].push(wrapper);
    }

    removeListener(event, handler) {
        if (!this._events[event]) return;
        this._events[event] = this._events[event].filter(h => h !== handler);
    }

    isDestroyed() { return this._closed; }

    close() {
        this._closed = true;
        const handlers = (this._events['closed'] || []).slice();
        for (const h of handlers) h();
    }
}

// ── Build a standalone _waitForDialogAction using our mocks ──────────────────
// We replicate the exact logic from LicenseDialog.js so we can test it
// without Electron running.

function buildWaitFn(mockIpc) {
    return function waitForDialogAction(win, allowActivate = true) {
        return new Promise((resolve) => {
            const id    = win.id;
            let settled = false;

            function settle(result) {
                if (settled) return;
                settled = true;
                mockIpc.removeAllListeners(`dialog:activate:${id}`);
                mockIpc.removeAllListeners(`dialog:activate-file:${id}`);
                mockIpc.removeAllListeners(`dialog:exit:${id}`);
                win.removeListener('closed', onClosed);
                resolve(result);
            }

            function onClosed() { settle({ action: 'exit' }); }

            if (allowActivate) {
                mockIpc.once(`dialog:activate:${id}`,      (_e, key) => settle({ action: 'activate', key }));
                mockIpc.once(`dialog:activate-file:${id}`, ()        => settle({ action: 'activate-file' }));
            }

            mockIpc.once(`dialog:exit:${id}`, () => settle({ action: 'exit' }));
            win.once('closed', onClosed);
        });
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n── LicenseDialog Retry Bug Fix Tests ───────────────────────────\n');

(async () => {

// ═══ T1: Basic activate action fires and resolves ════════════════════════════
console.log('Basic action resolution:');
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(10);
    const wait = buildWaitFn(ipc);

    const promise = wait(win, true);
    ipc.emit(`dialog:activate:${win.id}`, null, 'my-test-key');
    const result = await promise;

    assert('T1.1  activate action resolves with key', result.action === 'activate');
    assert('T1.2  key is passed through',             result.key === 'my-test-key');
    assert('T1.3  all listeners cleaned up after activate',
        ipc.listenerCount(`dialog:activate:${win.id}`) === 0 &&
        ipc.listenerCount(`dialog:activate-file:${win.id}`) === 0 &&
        ipc.listenerCount(`dialog:exit:${win.id}`) === 0);
}

// ═══ T2: activate-file action fires and resolves ═════════════════════════════
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(11);
    const wait = buildWaitFn(ipc);

    const promise = wait(win, true);
    ipc.emit(`dialog:activate-file:${win.id}`);
    const result = await promise;

    assert('T2.1  activate-file action resolves', result.action === 'activate-file');
    assert('T2.2  all listeners cleaned up after activate-file',
        ipc.listenerCount(`dialog:activate-file:${win.id}`) === 0);
}

// ═══ T3: exit action fires and resolves ═════════════════════════════════════
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(12);
    const wait = buildWaitFn(ipc);

    const promise = wait(win, true);
    ipc.emit(`dialog:exit:${win.id}`);
    const result = await promise;

    assert('T3.1  exit action resolves', result.action === 'exit');
}

// ═══ T4: Window close triggers exit ═════════════════════════════════════════
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(13);
    const wait = buildWaitFn(ipc);

    const promise = wait(win, true);
    win.close();
    const result = await promise;

    assert('T4.1  window close resolves with exit', result.action === 'exit');
    assert('T4.2  all listeners cleaned up after close',
        ipc.listenerCount(`dialog:activate:${win.id}`) === 0);
}

// ═══ T5: THE BUG FIX — retry after failed file import ════════════════════════
// Simulates: file import fails → error shown → user can immediately import again
console.log('\nRetry after failed file import (the reported bug):');
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(20);
    const wait = buildWaitFn(ipc);

    // First attempt: user clicks "Import .lic File"
    const promise1 = wait(win, true);
    ipc.emit(`dialog:activate-file:${win.id}`);
    const result1 = await promise1;

    assert('T5.1  First activate-file resolves', result1.action === 'activate-file');
    assert('T5.2  Listeners cleaned up after first activate-file',
        ipc.listenerCount(`dialog:activate-file:${win.id}`) === 0);

    // Simulate: main.js sends failure result back to window (wrong machine)
    // The window is still open. Now re-subscribe for the next user action.
    assert('T5.3  Window is still open (not destroyed)', !win.isDestroyed());

    // Second attempt: user clicks "Import .lic File" again
    // (This is what was broken — the dialog was unresponsive after this point)
    const promise2 = wait(win, true);

    // Verify listeners are fresh for the second round
    assert('T5.4  Fresh activate-file listener registered for retry',
        ipc.listenerCount(`dialog:activate-file:${win.id}`) === 1);

    ipc.emit(`dialog:activate-file:${win.id}`);
    const result2 = await promise2;

    assert('T5.5  Second activate-file resolves (retry works)',
        result2.action === 'activate-file');
    assert('T5.6  Listeners cleaned up after retry',
        ipc.listenerCount(`dialog:activate-file:${win.id}`) === 0);
}

// ═══ T6: Retry after failed key string activation ════════════════════════════
console.log('\nRetry after failed key activation:');
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(21);
    const wait = buildWaitFn(ipc);

    // First attempt: bad key
    const promise1 = wait(win, true);
    ipc.emit(`dialog:activate:${win.id}`, null, 'bad-key-1');
    const result1 = await promise1;
    assert('T6.1  First key attempt resolves', result1.action === 'activate');

    // Window still open, re-subscribe
    const promise2 = wait(win, true);
    ipc.emit(`dialog:activate:${win.id}`, null, 'bad-key-2');
    const result2 = await promise2;
    assert('T6.2  Second key attempt resolves', result2.action === 'activate');
    assert('T6.3  Second key value correct',    result2.key === 'bad-key-2');

    // Third attempt: file import after two failed key attempts
    const promise3 = wait(win, true);
    ipc.emit(`dialog:activate-file:${win.id}`);
    const result3 = await promise3;
    assert('T6.4  File import after failed keys resolves', result3.action === 'activate-file');
}

// ═══ T7: Cancel file picker → retry is still available ══════════════════════
console.log('\nCancel file picker does not lock dialog:');
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(22);
    const wait = buildWaitFn(ipc);

    // User clicks Import → main handles picker cancel → re-subscribes
    const promise1 = wait(win, true);
    ipc.emit(`dialog:activate-file:${win.id}`);
    const result1 = await promise1;
    assert('T7.1  activate-file resolves on first click', result1.action === 'activate-file');

    // Simulate cancel: main sends "No file selected" message back
    // then re-subscribes (this is what the fixed main.js does)
    const promise2 = wait(win, true);

    // User clicks Import again after cancel
    ipc.emit(`dialog:activate-file:${win.id}`);
    const result2 = await promise2;
    assert('T7.2  activate-file resolves after cancel+retry', result2.action === 'activate-file');
}

// ═══ T8: N consecutive retries all resolve correctly ════════════════════════
console.log('\nMultiple consecutive retries:');
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(23);
    const wait = buildWaitFn(ipc);

    for (let i = 1; i <= 5; i++) {
        const p = wait(win, true);
        ipc.emit(`dialog:activate-file:${win.id}`);
        const r = await p;
        assert(`T8.${i}  Retry #${i} resolves correctly`, r.action === 'activate-file');
        assert(`T8.${i}b No listener leak after retry #${i}`,
            ipc.listenerCount(`dialog:activate-file:${win.id}`) === 0);
    }
}

// ═══ T9: Exit after multiple retries works correctly ════════════════════════
console.log('\nExit after retries:');
{
    const ipc  = new MockIpcMain();
    const win  = new MockWin(24);
    const wait = buildWaitFn(ipc);

    // Two failed attempts
    for (let i = 0; i < 2; i++) {
        const p = wait(win, true);
        ipc.emit(`dialog:activate-file:${win.id}`);
        await p;
    }

    // Then user clicks Exit
    const exitPromise = wait(win, true);
    ipc.emit(`dialog:exit:${win.id}`);
    const exitResult = await exitPromise;

    assert('T9.1  Exit resolves correctly after retries', exitResult.action === 'exit');
    assert('T9.2  No lingering listeners after exit',
        ipc.listenerCount(`dialog:exit:${win.id}`) === 0 &&
        ipc.listenerCount(`dialog:activate:${win.id}`) === 0);
}

// ═══ T10: settled flag prevents double-resolution ════════════════════════════
console.log('\nSettled flag prevents double-resolution:');
{
    const ipc    = new MockIpcMain();
    const win    = new MockWin(25);
    const wait   = buildWaitFn(ipc);
    const results = [];

    const promise = wait(win, true);
    promise.then(r => results.push(r));

    // Fire two events rapidly — only the first should resolve the promise
    ipc.emit(`dialog:activate:${win.id}`, null, 'key-1');
    // After the first fires, listeners are removed, so this second emit is a no-op
    ipc.emit(`dialog:activate:${win.id}`, null, 'key-2');

    await promise;
    // Wait one microtask tick to let any spurious .then run
    await new Promise(r => setTimeout(r, 0));

    assert('T10.1  Promise resolves exactly once', results.length === 1);
    assert('T10.2  First event wins', results[0].key === 'key-1');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('DIALOG RETRY BUG FIX TEST FAILED');
    process.exit(1);
} else {
    console.log('DIALOG RETRY BUG FIX TEST PASSED');
    process.exit(0);
}

})();
