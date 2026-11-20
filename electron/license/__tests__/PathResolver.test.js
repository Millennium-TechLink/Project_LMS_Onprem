/**
 * PathResolver.test.js
 * Phase 1 — Verify path resolution, directory creation, temp purge.
 * Run with: node onprem/electron/license/__tests__/PathResolver.test.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const PathResolver = require('../PathResolver');

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

// ── Shared test fixture ───────────────────────────────────────────────────────
const BASE_TEMP = path.join(os.tmpdir(), 'lms-pathresolver-test-' + Date.now());
const ROAMING   = path.join(BASE_TEMP, 'Roaming', 'Lab Management System');
const LOCAL_APP = path.join(BASE_TEMP, 'Local');
const APP_NAME  = 'Lab Management System';

const pr = new PathResolver({
    userData:     ROAMING,
    localAppData: LOCAL_APP,
    appName:      APP_NAME,
});

console.log('\n── PathResolver Tests ──────────────────────────────────────────\n');

// ── T1.1  roamingRoot ─────────────────────────────────────────────────────────
console.log('Root paths:');
assert('T1.1  roamingRoot === userData input', pr.roamingRoot === ROAMING);
assert('T1.1b localRoot === localAppData/appName',
    pr.localRoot === path.join(LOCAL_APP, APP_NAME));

// ── T1.2  licenseFile ─────────────────────────────────────────────────────────
console.log('\nRoaming paths:');
assert('T1.2  licenseFile ends with license\\license.dat',
    pr.licenseFile.endsWith(path.join('license', 'license.dat')));
assert('T1.3  machineFile ends with license\\machine.dat',
    pr.machineFile.endsWith(path.join('license', 'machine.dat')));
assert('T1.4  activationLog ends with license\\activation.log',
    pr.activationLog.endsWith(path.join('license', 'activation.log')));
assert('      licenseBackupDir ends with license\\backups',
    pr.licenseBackupDir.endsWith(path.join('license', 'backups')));
assert('      logsDir ends with logs',
    pr.logsDir.endsWith('logs'));
assert('      electronLog ends with logs\\electron.log',
    pr.electronLog.endsWith(path.join('logs', 'electron.log')));
assert('      backendLog ends with logs\\backend.log',
    pr.backendLog.endsWith(path.join('logs', 'backend.log')));

// ── T1.5  uploads is under LOCAL, not ROAMING ─────────────────────────────────
console.log('\nLocal paths:');
assert('T1.5  uploadsDir is under localRoot',
    pr.uploadsDir.startsWith(pr.localRoot));
assert('T1.5b uploadsDir is NOT under roamingRoot',
    !pr.uploadsDir.startsWith(pr.roamingRoot));
assert('T1.6  backupsDir is under localRoot',
    pr.backupsDir.startsWith(pr.localRoot));
assert('      dbBackupsDir is under localRoot',
    pr.dbBackupsDir.startsWith(pr.localRoot));
assert('      diagnosticsDir is under localRoot',
    pr.diagnosticsDir.startsWith(pr.localRoot));
assert('      tempDir is under localRoot',
    pr.tempDir.startsWith(pr.localRoot));

// ── T1.7  ensureAllDirs creates directories ───────────────────────────────────
console.log('\nDirectory creation:');
const dirsCreated = pr.ensureAllDirs();
assert('T1.7  ensureAllDirs returns an array',
    Array.isArray(dirsCreated) && dirsCreated.length > 0);
assert('T1.7b licenseDir exists after ensureAllDirs',
    fs.existsSync(pr.licenseDir));
assert('T1.7c licenseBackupDir exists',
    fs.existsSync(pr.licenseBackupDir));
assert('T1.7d logsDir exists',
    fs.existsSync(pr.logsDir));
assert('T1.7e uploadsDir exists',
    fs.existsSync(pr.uploadsDir));
assert('T1.7f diagnosticsDir exists',
    fs.existsSync(pr.diagnosticsDir));
assert('T1.7g tempDir exists',
    fs.existsSync(pr.tempDir));
assert('T1.7h at least 15 directories ensured',
    dirsCreated.length >= 15);

// ── T1.8  ensureAllDirs is idempotent ─────────────────────────────────────────
console.log('\nIdempotency:');
let idempotentError = null;
try { pr.ensureAllDirs(); } catch (e) { idempotentError = e; }
assert('T1.8  ensureAllDirs called twice does not throw',
    idempotentError === null);

// ── T1.9  purgeTempDir removes old files ─────────────────────────────────────
console.log('\nTemp directory purge:');
// Create 3 files: 2 "old" (mtime set to 48 hours ago), 1 "new"
const oldFile1  = path.join(pr.tempDir, 'old1.tmp');
const oldFile2  = path.join(pr.tempDir, 'old2.tmp');
const newFile   = path.join(pr.tempDir, 'new.tmp');
const oldTime   = new Date(Date.now() - 48 * 60 * 60 * 1000);

fs.writeFileSync(oldFile1, 'old1');
fs.writeFileSync(oldFile2, 'old2');
fs.writeFileSync(newFile,  'new');

// Back-date the old files
fs.utimesSync(oldFile1, oldTime, oldTime);
fs.utimesSync(oldFile2, oldTime, oldTime);

pr.purgeTempDir(24 * 60 * 60 * 1000);  // purge files older than 24h

assert('T1.9  old file 1 removed', !fs.existsSync(oldFile1));
assert('T1.9b old file 2 removed', !fs.existsSync(oldFile2));
assert('T1.9c new file preserved', fs.existsSync(newFile));

// ── T1.10 purgeTempDir is silent on empty dir ─────────────────────────────────
fs.unlinkSync(newFile);  // clean up new file
let purgeError = null;
try { pr.purgeTempDir(); } catch (e) { purgeError = e; }
assert('T1.10 purgeTempDir on empty dir does not throw', purgeError === null);

// ── T1.11 toDisplayObject ─────────────────────────────────────────────────────
console.log('\nDisplay object:');
const display = pr.toDisplayObject();
const requiredKeys = ['roaming', 'local', 'license', 'logs', 'uploads', 'backups', 'diagnostics'];
for (const key of requiredKeys) {
    assert(`T1.11 toDisplayObject has key '${key}'`, typeof display[key] === 'string');
}

// ── T1.12 static resolve() ────────────────────────────────────────────────────
console.log('\nStatic factory:');
const mockApp = {
    getPath: (key) => key === 'userData' ? ROAMING : '',
    getName: ()    => APP_NAME,
};
const resolvedPr = PathResolver.resolve({ app: mockApp, os });
assert('T1.12 PathResolver.resolve() returns PathResolver instance',
    resolvedPr instanceof PathResolver);
assert('T1.12b resolved roamingRoot matches',
    resolvedPr.roamingRoot === ROAMING);

// ── T1.13 LOCALAPPDATA fallback ───────────────────────────────────────────────
console.log('\nFallback:');
const savedEnv = process.env.LOCALAPPDATA;
delete process.env.LOCALAPPDATA;
const fallbackPr = PathResolver.resolve({ app: mockApp, os });
assert('T1.13 fallback path includes AppData\\Local',
    fallbackPr.localRoot.includes(path.join('AppData', 'Local')));
process.env.LOCALAPPDATA = savedEnv;

// ── Constructor validation ────────────────────────────────────────────────────
console.log('\nConstructor validation:');
let constructorError = null;
try { new PathResolver({ userData: null, localAppData: 'x', appName: 'x' }); }
catch (e) { constructorError = e; }
assert('Constructor throws on null userData', constructorError !== null);

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(BASE_TEMP, { recursive: true, force: true }); } catch {}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('PHASE 1 PATHRESOLVER TEST FAILED');
    process.exit(1);
} else {
    console.log('PHASE 1 PATHRESOLVER TEST PASSED');
    process.exit(0);
}
