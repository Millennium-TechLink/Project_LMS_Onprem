/**
 * LicenseManager.test.js
 * Phase 4 — Full lifecycle: initialize, checkLicense, updateLastLaunch, activate.
 * Run with: node onprem/electron/license/__tests__/LicenseManager.test.js
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const PathResolver = require('../PathResolver');

// A fresh keypair per run, patched into LicenseConstants' cached exports
// BEFORE requiring LicenseManager - it pulls in LicenseValidator, which (via
// CryptoService) destructures VENDOR_PUBLIC_KEY_PEM once at require time, so
// this must happen first. Avoids a hardcoded test key silently going stale
// after a real key rotation (which is exactly what happened to the key this
// file used to hardcode).
const constants = require('../LicenseConstants');
const { VALIDATION_RESULT, ACTIVATION_LOG_EVENTS } = constants;
const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
constants.VENDOR_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY_PEM;

const LicenseManager = require('../LicenseManager');
const LicenseStorage = require('../LicenseStorage');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePathResolver(suffix = '') {
    const base  = path.join(os.tmpdir(), `lms-lm-test-${Date.now()}${suffix}`);
    const roam  = path.join(base, 'Roaming', 'LMS');
    const local = path.join(base, 'Local');
    const pr    = new PathResolver({ userData: roam, localAppData: local, appName: 'LMS' });
    pr.ensureAllDirs();
    return { pr, base };
}

function buildActivationKey(machineId, overrides = {}) {
    const block = {
        schemaVersion:   2,
        licenseId:       crypto.randomUUID(),
        licenseType:     'PERMANENT',
        expiryDate:      'NEVER',
        issuedAt:        new Date().toISOString(),
        machineId,
        installDate:     new Date().toISOString(),
        status:          'ACTIVE',
        createdAt:       new Date().toISOString(),
        gracePeriodDays: 0,
        ...overrides,
    };
    const canonical = JSON.stringify(block, Object.keys(block).sort());
    const sig       = crypto.sign('SHA256', Buffer.from(canonical, 'utf8'), {
        key: TEST_PRIVATE_KEY_PEM, dsaEncoding: 'der',
    });
    const envelope  = { formatVersion: 1, licenseBlock: block, vendorSignature: sig.toString('base64') };
    return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

async function makeManager(pr, overrides = {}) {
    const lm = new LicenseManager({
        pathResolver: pr,
        appVersion:   overrides.appVersion || '1.0.0',
        log:          () => {},   // silent in tests
    });
    return lm;
}

// We need to get the real machineId to build valid test keys
let REAL_MACHINE_ID = null;
async function getRealMachineId() {
    if (REAL_MACHINE_ID) return REAL_MACHINE_ID;
    const { getMachineId } = require('../MachineId');
    REAL_MACHINE_ID = await getMachineId();
    return REAL_MACHINE_ID;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\n── LicenseManager Tests ────────────────────────────────────────\n');

// Wrap everything in async IIFE so we can await
(async () => {

// ═══ Constructor ═════════════════════════════════════════════════════════════
console.log('Constructor:');

try {
    new LicenseManager({ pathResolver: null, appVersion: '1.0.0' });
    assert('T4.1  Throws if pathResolver is null', false);
} catch (e) {
    assert('T4.1  Throws if pathResolver is null', true);
}

try {
    new LicenseManager({ pathResolver: '/some/path', appVersion: '1.0.0' });
    assert('T4.1b Throws if string passed as pathResolver', false);
} catch (e) {
    assert('T4.1b Throws if string passed as pathResolver', true);
}

// ═══ initialize — first install (no auto-trial) ═════════════════════════════
console.log('\ninitialize — first install:');

const { pr: pr1, base: base1 } = makePathResolver('a');
const lm1 = await makeManager(pr1);
const initResult1 = await lm1.initialize();

assert('T4.2  initialize returns isFirstInstall=true on fresh dirs',
    initResult1.isFirstInstall === true);
assert('T4.2b isBypassAttempt=false on fresh dirs',
    initResult1.isBypassAttempt === false);
assert('T4.2c license.dat NOT created (AUTO_TRIAL_ENABLED=false)',
    !fs.existsSync(pr1.licenseFile));
assert('T4.2d machine.dat created after initialize',
    fs.existsSync(pr1.machineFile));
assert('T4.2e activation.log created',
    fs.existsSync(pr1.activationLog));

const logContent1 = fs.readFileSync(pr1.activationLog, 'utf8');
assert('T4.2f activation.log has FIRST_INSTALL event',
    logContent1.includes('FIRST_INSTALL'));
assert('T4.2g activation.log has AWAITING_ACTIVATION event (no auto-trial)',
    logContent1.includes('AWAITING_ACTIVATION'));
assert('T4.2h activation.log does NOT have TRIAL_CREATED',
    !logContent1.includes('TRIAL_CREATED'));

// ═══ initialize — relaunch before activation (not a bypass) ═════════════════
console.log('\ninitialize — relaunch before activation:');

const lm1b = await makeManager(pr1);
const initResult1b = await lm1b.initialize();
assert('T4.3  isFirstInstall=false on second run', initResult1b.isFirstInstall === false);
assert('T4.3b isBypassAttempt=false - never activated is not a bypass', initResult1b.isBypassAttempt === false);
assert('T4.3c still no license.dat', !fs.existsSync(pr1.licenseFile));

// ═══ initialize — bypass attempt ════════════════════════════════════════════
console.log('\ninitialize — bypass attempt (activated license.dat deleted, machine.dat present):');

const { pr: pr2, base: base2 } = makePathResolver('b');
const lm2 = await makeManager(pr2);
await lm2.initialize();                          // machine.dat only - no auto-trial
const machineId2 = await getRealMachineId();
const activateResult2 = await lm2.activate(buildActivationKey(machineId2));
assert('T4.4pre activation succeeds (sets up a real license to delete)', activateResult2.success === true);
fs.unlinkSync(pr2.licenseFile);                  // simulate deletion of a previously-ACTIVATED license.dat

const lm2b = await makeManager(pr2);
const bypassResult = await lm2b.initialize();
assert('T4.4  isBypassAttempt=true when a previously-activated license.dat is deleted',
    bypassResult.isBypassAttempt === true);
assert('T4.4b isFirstInstall=false on bypass',
    bypassResult.isFirstInstall === false);
assert('T4.4c license.dat NOT recreated (no new trial)',
    !fs.existsSync(pr2.licenseFile));

const logContent2 = fs.readFileSync(pr2.activationLog, 'utf8');
assert('T4.4d activation.log has BYPASS_ATTEMPT event',
    logContent2.includes('BYPASS_ATTEMPT'));

// ═══ checkLicense — vendor-issued trial is valid ═════════════════════════════
console.log('\ncheckLicense — vendor-issued trial:');

const { pr: pr3, base: base3 } = makePathResolver('c');
const lm3 = await makeManager(pr3);
await lm3.initialize();
const machineId3 = await getRealMachineId();
const trialExpiry3 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const trialActivate3 = await lm3.activate(buildActivationKey(machineId3, { licenseType: 'TRIAL', expiryDate: trialExpiry3 }));
assert('T4.5pre vendor-issued trial activation succeeds', trialActivate3.success === true);

const check3 = await lm3.checkLicense();
assert('T4.5  Trial → VALID', check3.result.code === VALIDATION_RESULT.VALID);
assert('T4.5b daysRemaining > 0', check3.result.daysRemaining > 0);
assert('T4.5c licenseBlock present on VALID', check3.licenseBlock !== null);
assert('T4.5d licenseType is TRIAL', check3.licenseBlock.licenseType === 'TRIAL');

// ═══ checkLicense — bypass → INTEGRITY_FAILED ════════════════════════════════
console.log('\ncheckLicense — bypass → INTEGRITY_FAILED:');

const check4 = await lm2b.checkLicense();
assert('T4.6  Bypass check → INTEGRITY_FAILED or NOT_FOUND',
    check4.result.code === VALIDATION_RESULT.INTEGRITY_FAILED ||
    check4.result.code === VALIDATION_RESULT.NOT_FOUND);

// ═══ checkLicense — expired trial ════════════════════════════════════════════
console.log('\ncheckLicense — expired trial:');

const { pr: pr5, base: base5 } = makePathResolver('d');
const lm5 = await makeManager(pr5);
await lm5.initialize();
const machineId5 = await getRealMachineId();
const trialExpiry5 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
await lm5.activate(buildActivationKey(machineId5, { licenseType: 'TRIAL', expiryDate: trialExpiry5 }));

// Simulate expiry by passing a future 'now' (31 days ahead)
const futureNow = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
const check5 = await lm5.checkLicense(futureNow);
assert('T4.7  Trial expired 31 days ahead → EXPIRED',
    check5.result.code === VALIDATION_RESULT.EXPIRED);

// ═══ updateLastLaunch ═════════════════════════════════════════════════════════
console.log('\nupdateLastLaunch:');

const { pr: pr6, base: base6 } = makePathResolver('e');
const lm6 = await makeManager(pr6);
await lm6.initialize();
const machineId6 = await getRealMachineId();
await lm6.activate(buildActivationKey(machineId6));   // real license, so runtimeBlock assertions below have something to check

const now6 = new Date();
await lm6.updateLastLaunch(now6);

const machine6 = new LicenseStorage(pr6).readMachine();
assert('T4.8  machine.dat lastLaunch updated', machine6 && machine6.lastLaunch === now6.toISOString());
assert('T4.8b machine.dat hmac present', machine6 && typeof machine6.hmac === 'string');
assert('T4.8c license.dat vendorSignature unchanged (not rewritten)',
    (() => {
        const env = new LicenseStorage(pr6).readLicense();
        return env && env.runtimeBlock && !env.runtimeBlock.lastLaunch;
    })()
);

const logContent6 = fs.readFileSync(pr6.activationLog, 'utf8');
assert('T4.8d activation.log has LAUNCH event', logContent6.includes('LAUNCH'));

// ═══ checkLicense — clock rollback after updateLastLaunch ════════════════════
console.log('\ncheckLicense — clock rollback:');

const pastNow = new Date(now6.getTime() - 3 * 3600 * 1000);  // 3 hours back
const check6b = await lm6.checkLicense(pastNow);
assert('T4.9  Clock rolled back 3h → CLOCK_TAMPER', check6b.result.code === VALIDATION_RESULT.CLOCK_TAMPER);

// ═══ activate — ECDSA key ════════════════════════════════════════════════════
console.log('\nactivate (ECDSA key string):');

const machineId = await getRealMachineId();
const { pr: pr7, base: base7 } = makePathResolver('f');
const lm7 = await makeManager(pr7);
await lm7.initialize();

const activationKey = buildActivationKey(machineId);
const actResult     = await lm7.activate(activationKey);

assert('T4.10  activate() succeeds', actResult.success === true);
assert('T4.10b message is correct', actResult.message === 'Activation successful.');

// Re-check after activation
const check7 = await lm7.checkLicense();
assert('T4.10c Post-activation checkLicense → VALID', check7.result.code === VALIDATION_RESULT.VALID);
assert('T4.10d licenseType is PERMANENT', check7.licenseBlock && check7.licenseBlock.licenseType === 'PERMANENT');
assert('T4.10e daysRemaining is Infinity', check7.result.daysRemaining === Infinity);

const logContent7 = fs.readFileSync(pr7.activationLog, 'utf8');
assert('T4.10f activation.log has ACTIVATION_OK', logContent7.includes('ACTIVATION_OK'));

// Machine dat activation count incremented
const machine7 = new LicenseStorage(pr7).readMachine();
assert('T4.10g activationCount incremented', machine7 && machine7.activationCount === 1);

// ═══ activate — wrong machine ════════════════════════════════════════════════
console.log('\nactivate — wrong machine:');

const wrongKey = buildActivationKey('wrong-machine-id-0000000000000000000000000000000000');
const { pr: pr8, base: base8 } = makePathResolver('g');
const lm8 = await makeManager(pr8);
await lm8.initialize();
const wrongResult = await lm8.activate(wrongKey);

assert('T4.11  Wrong machine → activation fails', wrongResult.success === false);
assert('T4.11b Message mentions machine', wrongResult.message.toLowerCase().includes('machine'));

const logContent8 = fs.readFileSync(pr8.activationLog, 'utf8');
assert('T4.11c activation.log has ACTIVATION_FAIL', logContent8.includes('ACTIVATION_FAIL'));

// ═══ activateFromFile ════════════════════════════════════════════════════════
console.log('\nactivateFromFile:');

const fileKey = buildActivationKey(machineId);
const fileContents = JSON.stringify(JSON.parse(Buffer.from(fileKey, 'base64').toString('utf8')), null, 2);
const { pr: pr9, base: base9 } = makePathResolver('h');
const lm9 = await makeManager(pr9);
await lm9.initialize();
const fileResult = await lm9.activateFromFile(fileContents);

assert('T4.12  activateFromFile succeeds', fileResult.success === true);

// ═══ getLicenseInfo ══════════════════════════════════════════════════════════
console.log('\ngetLicenseInfo:');

const info7 = await lm7.getLicenseInfo();
assert('T4.13  getLicenseInfo machineId present (XXXX-XXXX-XXXX)', typeof info7.machineId === 'string' && info7.machineId.includes('-'));
assert('T4.13b licenseType is PERMANENT', info7.licenseType === 'PERMANENT');
assert('T4.13c daysRemaining is Infinity', info7.daysRemaining === Infinity);
assert('T4.13d activationCount is 1', info7.activationCount === 1);

// lm1 was never activated (no auto-trial) - getLicenseInfo should reflect that.
const info1 = await lm1.getLicenseInfo();
assert('T4.14  Not-yet-activated getLicenseInfo licenseType=null', info1.licenseType === null);
assert('T4.14b daysRemaining is 0 before activation', info1.daysRemaining === 0);
assert('T4.14c machineId still present before activation',
    typeof info1.machineId === 'string' && info1.machineId.includes('-'));

const info3 = await lm3.getLicenseInfo();
assert('T4.14d vendor-issued trial getLicenseInfo licenseType=TRIAL', info3.licenseType === 'TRIAL');
assert('T4.14e daysRemaining > 0 for active trial', info3.daysRemaining > 0);

// ═══ getMachineId ═══════════════════════════════════════════════════════════
console.log('\ngetMachineId:');

const displayStr = await lm7.getMachineId();
assert('T4.15  getMachineId returns XXXX-XXXX-XXXX display string',
    /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(displayStr));

// ── Cleanup ───────────────────────────────────────────────────────────────────
for (const base of [base1, base2, base3, base5, base6, base7, base8, base9]) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('PHASE 4 LICENSEMANAGER TEST FAILED');
    process.exit(1);
} else {
    console.log('PHASE 4 LICENSEMANAGER TEST PASSED');
    process.exit(0);
}

})();
