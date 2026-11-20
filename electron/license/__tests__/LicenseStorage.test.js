/**
 * LicenseStorage.test.js
 * Phase 2 — Verify all storage operations: license.dat, machine.dat,
 * activation.log, atomic writes, backups, pruning, and shims.
 *
 * Run with: node onprem/electron/license/__tests__/LicenseStorage.test.js
 */

'use strict';

const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const PathResolver = require('../PathResolver');
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

function assertThrows(description, fn) {
    try {
        fn();
        console.error(`  ✗  FAIL: ${description} — expected an error but none was thrown`);
        failed++;
    } catch {
        console.log(`  ✓  ${description}`);
        passed++;
    }
}

// ── Fixture ───────────────────────────────────────────────────────────────────
const BASE  = path.join(os.tmpdir(), 'lms-storage-test-' + Date.now());
const ROAM  = path.join(BASE, 'Roaming', 'Lab Management System');
const LOCAL = path.join(BASE, 'Local');

const pr = new PathResolver({ userData: ROAM, localAppData: LOCAL, appName: 'Lab Management System' });
pr.ensureAllDirs();

const storage = new LicenseStorage(pr);

// ── Minimal valid envelope ────────────────────────────────────────────────────
function makeEnvelope(overrides = {}) {
    return {
        formatVersion:   1,
        licenseBlock:    { machineId: 'abc123', licenseType: 'TRIAL', expiryDate: '2099-01-01', ...overrides.licenseBlock },
        vendorSignature: 'testsig-abc',
        runtimeBlock:    { lastLaunch: null, lastVersion: '1.0.0', updatedAt: new Date().toISOString() },
        runtimeHmac:     'runtimehmac-abc',
        ...overrides,
    };
}

// ── Minimal valid machine data ────────────────────────────────────────────────
function makeMachine(overrides = {}) {
    return {
        version:              1,
        machineId:            'abc123',
        installDate:          new Date().toISOString(),
        firstInstallDetected: true,
        activationCount:      0,
        lastLaunch:           null,
        lastVersion:          '1.0.0',
        updatedAt:            new Date().toISOString(),
        hmac:                 'testhmacsig',
        ...overrides,
    };
}

console.log('\n── LicenseStorage Tests ────────────────────────────────────────\n');

// ── Constructor ───────────────────────────────────────────────────────────────
console.log('Constructor:');
assertThrows('T2.1  Throws if no pathResolver passed',
    () => new LicenseStorage(null));
assertThrows('T2.1b Throws if plain string passed',
    () => new LicenseStorage('/some/path'));
assert('T2.1c Constructs cleanly with valid PathResolver',
    storage instanceof LicenseStorage);

// ── licenseExists / machineExists ─────────────────────────────────────────────
console.log('\nlicenseExists / machineExists:');
assert('T2.2  licenseExists() false before write',   !storage.licenseExists());
assert('T2.2b machineExists() false before write',   !storage.machineExists());

// ── writeLicense / readLicense ────────────────────────────────────────────────
console.log('\nwriteLicense / readLicense:');
const env = makeEnvelope();
storage.writeLicense(env);

assert('T2.4  licenseExists() true after write',     storage.licenseExists());

const readBack = storage.readLicense();
assert('T2.4b readLicense returns non-null',         readBack !== null);
assert('T2.4c formatVersion preserved',              readBack.formatVersion === 1);
assert('T2.4d licenseBlock.machineId preserved',     readBack.licenseBlock.machineId === 'abc123');
assert('T2.4e vendorSignature preserved',            readBack.vendorSignature === 'testsig-abc');
assert('T2.4f runtimeBlock preserved',               readBack.runtimeBlock !== null);
assert('T2.4g runtimeHmac preserved',               readBack.runtimeHmac === 'runtimehmac-abc');

// ── readLicense returns null on missing file ──────────────────────────────────
console.log('\nreadLicense edge cases:');
storage.deleteLicense();
assert('T2.6  readLicense null on missing file',     storage.readLicense() === null);

// Write invalid JSON
fs.writeFileSync(pr.licenseFile, 'NOT VALID JSON', 'utf8');
assert('T2.7  readLicense null on malformed JSON',   storage.readLicense() === null);
fs.unlinkSync(pr.licenseFile);

// Write JSON missing required fields
fs.writeFileSync(pr.licenseFile, JSON.stringify({ formatVersion: 1 }), 'utf8');
assert('T2.8  readLicense null when licenseBlock missing', storage.readLicense() === null);
fs.unlinkSync(pr.licenseFile);

// ── writeLicense validates input ──────────────────────────────────────────────
console.log('\nwriteLicense validation:');
assertThrows('T2.8b writeLicense throws on null',
    () => storage.writeLicense(null));
assertThrows('T2.8c writeLicense throws on missing licenseBlock',
    () => storage.writeLicense({ formatVersion: 1 }));

// ── writeMachine / readMachine ────────────────────────────────────────────────
console.log('\nwriteMachine / readMachine:');
const mdata = makeMachine();
storage.writeMachine(mdata);

assert('T2.9  machineExists() true after write',     storage.machineExists());
const mRead = storage.readMachine();
assert('T2.9b readMachine returns non-null',         mRead !== null);
assert('T2.9c machineId preserved',                  mRead.machineId === 'abc123');
assert('T2.9d firstInstallDetected preserved',       mRead.firstInstallDetected === true);
assert('T2.9e hmac preserved',                       mRead.hmac === 'testhmacsig');

// ── readMachine returns null on missing / bad file ────────────────────────────
console.log('\nreadMachine edge cases:');
storage.deleteMachine();
assert('T2.10 readMachine null on missing file',     storage.readMachine() === null);

fs.writeFileSync(pr.machineFile, '{bad json}', 'utf8');
assert('T2.10b readMachine null on malformed JSON',  storage.readMachine() === null);
fs.unlinkSync(pr.machineFile);

// ── writeMachine validates input ──────────────────────────────────────────────
console.log('\nwriteMachine validation:');
assertThrows('T2.10c writeMachine throws on null',
    () => storage.writeMachine(null));
assertThrows('T2.10d writeMachine throws on missing machineId',
    () => storage.writeMachine({ installDate: new Date().toISOString() }));

// ── Atomic write (temp file cleanup) ─────────────────────────────────────────
console.log('\nAtomic write:');
storage.writeLicense(makeEnvelope());
const tmpPath = pr.licenseFile + '.tmp';
assert('T2.5  No .tmp file left after successful write', !fs.existsSync(tmpPath));

// ── appendActivationLog ───────────────────────────────────────────────────────
console.log('\nappendActivationLog:');
storage.appendActivationLog('FIRST_INSTALL', { machineId: 'A3F9', version: '1.0.0' });
storage.appendActivationLog('TRIAL_CREATED', { expiry: '2026-09-04', daysGranted: 30 });

assert('T2.11 activation.log exists', fs.existsSync(pr.activationLog));

const logContent = fs.readFileSync(pr.activationLog, 'utf8');
const logLines = logContent.trim().split('\n');

assert('T2.12 Two log lines written',                logLines.length === 2);
assert('T2.11 Line 1 contains FIRST_INSTALL',        logLines[0].includes('FIRST_INSTALL'));
assert('T2.11 Line 1 contains machineId=A3F9',       logLines[0].includes('machineId=A3F9'));
assert('T2.11 Line 1 has ISO timestamp',             logLines[0].match(/\d{4}-\d{2}-\d{2}T/));
assert('T2.11 Line 2 contains TRIAL_CREATED',        logLines[1].includes('TRIAL_CREATED'));
assert('T2.11 Line 2 contains daysGranted=30',       logLines[1].includes('daysGranted=30'));

// ── appendActivationLog with no fields ────────────────────────────────────────
storage.appendActivationLog('LAUNCH');
const logAfter = fs.readFileSync(pr.activationLog, 'utf8').trim().split('\n');
assert('T2.11b LAUNCH line appended (3 total)',      logAfter.length === 3);
assert('T2.11c LAUNCH line format correct',          logAfter[2].includes('| LAUNCH'));

// ── appendActivationLog is silent on error ────────────────────────────────────
// Simulate failure by using a path that cannot be written to (directory instead of file)
fs.mkdirSync(pr.activationLog + '_dir', { recursive: true });
const badStorage = new LicenseStorage(
    new PathResolver({ userData: ROAM, localAppData: LOCAL + '_x', appName: 'Bad' })
);
// Just ensure no throw
let logError = null;
try { badStorage.appendActivationLog('TEST'); } catch (e) { logError = e; }
assert('T2.13 appendActivationLog failure is silent', logError === null);
try { fs.rmSync(pr.activationLog + '_dir', { recursive: true }); } catch {}

// ── deleteLicense ─────────────────────────────────────────────────────────────
console.log('\ndeleteLicense:');
storage.writeLicense(makeEnvelope());
assert('      license exists before delete', storage.licenseExists());
storage.deleteLicense();
assert('T2.14 licenseExists false after deleteLicense', !storage.licenseExists());

// deleteLicense on non-existent file (no throw)
let deleteError = null;
try { storage.deleteLicense(); } catch (e) { deleteError = e; }
assert('T2.15 deleteLicense silent on missing file', deleteError === null);

// ── Backup written on writeLicense ───────────────────────────────────────────
console.log('\nBackup:');
storage.writeLicense(makeEnvelope());
const backupFiles = fs.readdirSync(pr.licenseBackupDir).filter(f => f.startsWith('license_'));
assert('T2.16 Backup file created on writeLicense', backupFiles.length >= 1);

// ── Backup pruning ────────────────────────────────────────────────────────────
// Write 7 more times — total should be capped at 5
for (let i = 0; i < 7; i++) {
    // Small delay to ensure distinct timestamps
    const spin = Date.now() + 2; while (Date.now() < spin) {}
    storage.writeLicense(makeEnvelope());
}
const backupFilesAfter = fs.readdirSync(pr.licenseBackupDir).filter(f => f.startsWith('license_'));
assert('T2.17 Backup count capped at 5', backupFilesAfter.length === 5);

// ═══ Phase 4: backward-compat shims removed from LicenseStorage ══════════════
console.log('\nPhase 4: backward-compat shims removed from LicenseStorage:');

assert('T2.18 read() shim removed — not a function',   typeof storage.read   !== 'function');
assert('T2.19 write() shim removed — not a function',  typeof storage.write  !== 'function');
assert('T2.19b exists() shim removed — not a function', typeof storage.exists !== 'function');
assert('T2.19c delete() shim removed — not a function', typeof storage.delete !== 'function');
assert('T2.19d readLicense() still present',   typeof storage.readLicense   === 'function');
assert('T2.19e writeLicense() still present',  typeof storage.writeLicense  === 'function');
assert('T2.19f licenseExists() still present', typeof storage.licenseExists === 'function');
assert('T2.19g deleteLicense() still present', typeof storage.deleteLicense === 'function');

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('PHASE 4 STORAGE TEST FAILED');
    process.exit(1);
} else {
    console.log('PHASE 4 STORAGE TEST PASSED');
    process.exit(0);
}
