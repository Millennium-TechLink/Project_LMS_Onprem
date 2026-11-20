/**
 * BackendManager.test.js
 * Unit tests for the crash-recovery decision logic (attempt counting, the
 * sustained-uptime reset rule, and the max-attempts cutoff) in isolation -
 * start()/waitUntilReady() are stubbed so no real process is spawned.
 * Run with: node onprem/electron/license/__tests__/BackendManager.test.js
 */

'use strict';

const os = require('os');
const BackendManager = require('../../BackendManager');

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

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** Builds a BackendManager with start()/waitUntilReady() stubbed so no real process is spawned. */
function makeManager({ startSucceeds = true } = {}) {
    const bm = new BackendManager({ paths: { backendConfigDir: os.tmpdir() }, logFn: () => {}, logErrFn: () => {} });
    bm._lastCommand = 'noop';
    bm._lastArgs = [];
    bm._lastOptions = {};
    bm.start = async () => { if (!startSucceeds) throw new Error('stub start failure'); };
    bm.waitUntilReady = async () => { if (!startSucceeds) throw new Error('stub waitUntilReady failure'); return true; };
    bm.isRunning = () => false; // health poll no-ops without a real process
    return bm;
}

async function testSuccessfulRestartNotifiesAndResetsAfterSustainedUptime() {
    const bm = makeManager({ startSucceeds: true });
    const statuses = [];
    bm.enableCrashRecovery({
        onStatusChange: (s) => statuses.push(s),
        maxAttempts: 5,
        backoffScheduleMs: [10],
        healthPollIntervalMs: 100000, // don't let the poll interfere with this test
        sustainedUptimeMs: 30,
    });

    await bm._handleUnexpectedExit(1, null);

    assert('notifies "restarting" then "restored"',
        statuses.length === 2 && statuses[0].state === 'restarting' && statuses[1].state === 'restored');
    assert('attempt count is 1 right after a successful restart', bm._crashAttempts === 1);

    await sleep(50); // longer than sustainedUptimeMs
    assert('attempt count resets to 0 after sustained uptime', bm._crashAttempts === 0);

    bm._clearSupervisionTimers();
}

async function testGivesUpAfterMaxAttempts() {
    const bm = makeManager({ startSucceeds: false });
    const statuses = [];
    bm.enableCrashRecovery({
        onStatusChange: (s) => statuses.push(s),
        maxAttempts: 3,
        backoffScheduleMs: [5, 5, 5],
        healthPollIntervalMs: 100000,
        sustainedUptimeMs: 100000,
    });

    await bm._handleUnexpectedExit(1, null);

    const last = statuses[statuses.length - 1];
    assert('final status is "failed"', last.state === 'failed');
    assert('reports the configured max attempts', last.attempts === 3);
    assert('does not exceed maxAttempts restarting notifications',
        statuses.filter(s => s.state === 'restarting').length === 3);

    bm._clearSupervisionTimers();
}

async function testIntentionalStopSkipsRecovery() {
    const bm = makeManager({ startSucceeds: true });
    const statuses = [];
    bm.enableCrashRecovery({ onStatusChange: (s) => statuses.push(s), backoffScheduleMs: [5] });

    bm._intentionalStop = true;
    await bm._handleUnexpectedExit(0, null);

    assert('no status change fired for a deliberate stop', statuses.length === 0);
    assert('_intentionalStop flag is cleared after being consumed', bm._intentionalStop === false);

    bm._clearSupervisionTimers();
}

async function testWaitUntilReadyFailsFastWhenBackendExits() {
    console.log('waitUntilReady: process exits while starting');
    const bm = new BackendManager({ paths: { backendConfigDir: os.tmpdir() }, logFn: () => {}, logErrFn: () => {} });
    bm.healthCheck = async () => false;
    bm._exitInfo = { code: 1, signal: null };
    const t0 = Date.now();
    let err = null;
    try { await bm.waitUntilReady(30000); } catch (e) { err = e; }
    assert('throws right away instead of waiting for the timeout', err !== null && Date.now() - t0 < 2000);
    assert('error says the backend exited and carries the exit code', err && err.backendExited === true && err.exitCode === 1);
}

async function testWaitUntilReadyReportsProgressAndSucceeds() {
    console.log('waitUntilReady: slow start, then healthy');
    const bm = new BackendManager({ paths: { backendConfigDir: os.tmpdir() }, logFn: () => {}, logErrFn: () => {} });
    let calls = 0;
    bm.healthCheck = async () => ++calls > 6;
    const ticks = [];
    const ok = await bm.waitUntilReady(30000, (sec) => ticks.push(sec));
    assert('resolves true once the health check passes', ok === true);
    assert('reports progress while waiting', ticks.length >= 1);
}

(async () => {
    console.log('\n── BackendManager crash-recovery tests ─────────────────────────\n');
    await testSuccessfulRestartNotifiesAndResetsAfterSustainedUptime();
    await testGivesUpAfterMaxAttempts();
    await testIntentionalStopSkipsRecovery();
    await testWaitUntilReadyFailsFastWhenBackendExits();
    await testWaitUntilReadyReportsProgressAndSucceeds();

    console.log('\n────────────────────────────────────────────────────────────────');
    console.log(`Result: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error('BACKENDMANAGER TEST FAILED');
        process.exit(1);
    } else {
        console.log('BACKENDMANAGER TEST PASSED');
        process.exit(0);
    }
})();
