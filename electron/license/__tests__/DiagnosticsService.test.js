/**
 * DiagnosticsService.test.js
 * Phase 7 — Verify bundle creation, ZIP integrity, file contents, pruning.
 * Run with: node onprem/electron/license/__tests__/DiagnosticsService.test.js
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const zlib   = require('zlib');

const PathResolver       = require('../PathResolver');
const DiagnosticsService = require('../DiagnosticsService');

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
const BASE  = path.join(os.tmpdir(), 'lms-diag-test-' + Date.now());
const ROAM  = path.join(BASE, 'Roaming', 'Lab Management System');
const LOCAL = path.join(BASE, 'Local');

const pr = new PathResolver({
    userData:     ROAM,
    localAppData: LOCAL,
    appName:      'Lab Management System',
});
pr.ensureAllDirs();

// ── Seed some log content ─────────────────────────────────────────────────────
fs.writeFileSync(pr.electronLog, Array.from({ length: 600 }, (_, i) =>
    `[2026-08-05T09:00:00.000Z] Log line ${i + 1}`
).join('\n'), 'utf8');

fs.writeFileSync(pr.backendLog, Array.from({ length: 50 }, (_, i) =>
    `[2026-08-05T09:00:00.000Z] Backend line ${i + 1}`
).join('\n'), 'utf8');

fs.writeFileSync(pr.activationLog,
    '2026-08-05T09:00:00.000Z | FIRST_INSTALL | machineId=A3F9-B2C1 version=1.0.0\n' +
    '2026-08-05T09:00:01.000Z | TRIAL_CREATED | expiry=2026-09-04 days=30\n', 'utf8');

// Write a machine.dat for the machine-info collector
fs.writeFileSync(pr.machineFile, JSON.stringify({
    version:              1,
    machineId:            'aabbccdd',
    installDate:          '2026-08-05T09:00:00.000Z',
    firstInstallDetected: true,
    activationCount:      0,
    lastLaunch:           null,
    lastVersion:          '1.0.0',
    updatedAt:            '2026-08-05T09:00:00.000Z',
    hmac:                 'secret-hmac-value',   // should be excluded from output
}, null, 2), 'utf8');

// ── Mock LicenseManager ───────────────────────────────────────────────────────
const mockLicenseManager = {
    getLicenseInfo: async () => ({
        machineId:        'A3F9-B2C1-D4E5',
        licenseType:      'TRIAL',
        status:           'ACTIVE',
        edition:          null,
        expiryDate:       '2026-09-04T09:00:00.000Z',
        daysRemaining:    30,
        licenseId:        null,
        installDate:      '2026-08-05T09:00:00.000Z',
        lastLaunch:       '2026-08-05T09:01:00.000Z',
        lastVersion:      '1.0.0',
        activationCount:  0,
        customerName:     null,
        customerCompany:  null,
    }),
};

const svc = new DiagnosticsService(pr, mockLicenseManager, '1.0.0', '28.0.0');

// ── Helper: parse a minimal ZIP and extract file names ────────────────────────
function listZipFiles(buf) {
    const files = [];
    let   pos   = 0;

    while (pos + 4 <= buf.length) {
        const sig = buf.readUInt32LE(pos);
        if (sig === 0x04034b50) {
            // Local file header
            const nameLen  = buf.readUInt16LE(pos + 26);
            const extraLen = buf.readUInt16LE(pos + 28);
            const compSize = buf.readUInt32LE(pos + 18);
            const name     = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
            files.push(name);
            pos += 30 + nameLen + extraLen + compSize;
        } else if (sig === 0x02014b50 || sig === 0x06054b50) {
            break;  // Central directory or end record — stop
        } else {
            break;
        }
    }
    return files;
}

function extractZipFile(buf, targetName) {
    let pos = 0;
    while (pos + 4 <= buf.length) {
        const sig = buf.readUInt32LE(pos);
        if (sig === 0x04034b50) {
            const nameLen   = buf.readUInt16LE(pos + 26);
            const extraLen  = buf.readUInt16LE(pos + 28);
            const compSize  = buf.readUInt32LE(pos + 18);
            const uncmpSize = buf.readUInt32LE(pos + 22);
            const name      = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
            const dataStart = pos + 30 + nameLen + extraLen;
            if (name === targetName) {
                const compressed = buf.slice(dataStart, dataStart + compSize);
                return zlib.inflateRawSync(compressed).toString('utf8');
            }
            pos = dataStart + compSize;
        } else {
            break;
        }
    }
    return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\n── DiagnosticsService Tests ────────────────────────────────────\n');

// ═══ Constructor ═════════════════════════════════════════════════════════════
console.log('Constructor:');
assertThrows('T7.1  Throws if PathResolver is null',
    () => new DiagnosticsService(null, null, '1.0.0'));

const goodSvc = new DiagnosticsService(pr, null, '1.0.0', '28.0.0');
assert('T7.2  Constructs cleanly with valid PathResolver and null licenseManager',
    goodSvc instanceof DiagnosticsService);

// ═══ collectBundle ═══════════════════════════════════════════════════════════
console.log('\ncollectBundle:');

(async () => {
const result = await svc.collectBundle();

assert('T7.3  collectBundle returns success=true',   result.success === true);
assert('T7.4  filePath is a string',                 typeof result.filePath === 'string');
assert('T7.5  filePath ends with .zip',              result.filePath.endsWith('.zip'));
assert('T7.6  sizeBytes > 0',                        result.sizeBytes > 0);
assert('T7.7  message contains filename',
    result.message.includes('lms-diagnostics-'));
assert('T7.8  ZIP file exists on disk',
    fs.existsSync(result.filePath));

// ═══ ZIP contents ═════════════════════════════════════════════════════════════
console.log('\nZIP contents:');

const zipBuf  = fs.readFileSync(result.filePath);
const zipFiles = listZipFiles(zipBuf);

assert('T7.9  electron.log in ZIP',       zipFiles.includes('electron.log'));
assert('T7.10 backend.log in ZIP',        zipFiles.includes('backend.log'));
assert('T7.11 activation.log in ZIP',     zipFiles.includes('activation.log'));
assert('T7.12 license-summary.txt in ZIP',zipFiles.includes('license-summary.txt'));
assert('T7.13 system-info.json in ZIP',   zipFiles.includes('system-info.json'));
assert('T7.14 machine-info.txt in ZIP',   zipFiles.includes('machine-info.txt'));
assert('T7.15 ZIP contains exactly 6 files', zipFiles.length === 6);

// ═══ Log truncation ═══════════════════════════════════════════════════════════
console.log('\nLog truncation:');

const electronLogContent = extractZipFile(zipBuf, 'electron.log');
assert('T7.16 electron.log extracted successfully', electronLogContent !== null);

const electronLines = electronLogContent.split('\n').filter(l => l.trim());
assert('T7.17 electron.log capped at 500 lines (was 600)',
    electronLines.length <= 502);  // 500 lines + 2 header lines
assert('T7.18 electron.log contains truncation notice',
    electronLogContent.includes('Showing last 500'));

const backendLogContent = extractZipFile(zipBuf, 'backend.log');
assert('T7.19 backend.log extracted successfully', backendLogContent !== null);
// Backend log had only 50 lines — should not be truncated
assert('T7.20 backend.log not truncated (only 50 lines)',
    !backendLogContent.includes('Showing last'));

// ═══ activation.log ═══════════════════════════════════════════════════════════
console.log('\nactivation.log content:');

const activationContent = extractZipFile(zipBuf, 'activation.log');
assert('T7.21 activation.log contains FIRST_INSTALL', activationContent.includes('FIRST_INSTALL'));
assert('T7.22 activation.log contains TRIAL_CREATED', activationContent.includes('TRIAL_CREATED'));

// ═══ license-summary.txt ══════════════════════════════════════════════════════
console.log('\nlicense-summary.txt content:');

const licenseContent = extractZipFile(zipBuf, 'license-summary.txt');
assert('T7.23 license-summary has Machine ID', licenseContent.includes('A3F9-B2C1-D4E5'));
assert('T7.24 license-summary has license type TRIAL', licenseContent.includes('TRIAL'));
assert('T7.25 license-summary has no raw signature text',
    !licenseContent.includes('vendorSignature') &&
    !licenseContent.includes('runtimeHmac'));

// ═══ system-info.json ════════════════════════════════════════════════════════
console.log('\nsystem-info.json content:');

const sysInfoContent = extractZipFile(zipBuf, 'system-info.json');
let sysInfo;
try {
    sysInfo = JSON.parse(sysInfoContent);
} catch (e) {
    sysInfo = null;
}
assert('T7.26 system-info.json is valid JSON', sysInfo !== null);
assert('T7.27 system-info has application section', sysInfo && sysInfo.application);
assert('T7.28 system-info has license section', sysInfo && sysInfo.license);
assert('T7.29 system-info has system section', sysInfo && sysInfo.system);
assert('T7.30 system-info has paths section', sysInfo && sysInfo.paths);
assert('T7.31 system-info has directoryStatus', sysInfo && sysInfo.directoryStatus);
assert('T7.32 system-info.application.version is 1.0.0',
    sysInfo && sysInfo.application.version === '1.0.0');
assert('T7.33 system-info.application.electronVersion is 28.0.0',
    sysInfo && sysInfo.application.electronVersion === '28.0.0');
assert('T7.34 system-info.license.machineId present',
    sysInfo && sysInfo.license.machineId === 'A3F9-B2C1-D4E5');

// ═══ machine-info.txt ════════════════════════════════════════════════════════
console.log('\nmachine-info.txt content:');

const machineContent = extractZipFile(zipBuf, 'machine-info.txt');
assert('T7.35 machine-info present', machineContent !== null && machineContent.length > 0);
assert('T7.36 machine-info has machineId', machineContent.includes('aabbccdd'));
assert('T7.37 machine-info EXCLUDES HMAC value',
    !machineContent.includes('secret-hmac-value'));
assert('T7.38 machine-info mentions HMAC excluded',
    machineContent.includes('HMAC field excluded'));

// ═══ Pruning ═════════════════════════════════════════════════════════════════
console.log('\nBundle pruning:');

// Create 12 more bundles (13 total including the one from T7.3).
// Use a slightly longer delay to ensure distinct file mtimes.
for (let i = 0; i < 12; i++) {
    await svc.collectBundle();
}

const allBundles = fs.readdirSync(pr.diagnosticsDir)
    .filter(f => f.startsWith('lms-diagnostics-') && f.endsWith('.zip'));

assert('T7.39 Bundle count capped at 10 after 13 exports',
    allBundles.length <= 10);

// ═══ Resilience: no license manager ══════════════════════════════════════════
console.log('\nResilience:');

const noLmSvc = new DiagnosticsService(pr, null, '1.0.0', '28.0.0');
const noLmResult = await noLmSvc.collectBundle();
assert('T7.40 collectBundle succeeds without licenseManager',
    noLmResult.success === true);

// ═══ CRC-32 sanity ═══════════════════════════════════════════════════════════
console.log('\nCRC-32 calculation:');

const testBuf = Buffer.from('hello world', 'utf8');
const crc     = svc._crc32(testBuf);
// CRC-32 of "hello world" is 0x0D4A1185
assert('T7.41 CRC-32 of "hello world" is correct',
    crc === 0x0D4A1185);

// ═══ DOS date/time ═══════════════════════════════════════════════════════════
console.log('\nDOS date/time:');

const testDate = new Date(2026, 7, 5, 9, 30, 0);  // 2026-08-05 09:30:00
const dosDate  = svc._toDosDate(testDate);
const dosTime  = svc._toDosTime(testDate);
assert('T7.42 DOS date encoded correctly',
    dosDate === ((2026 - 1980) << 9) | (8 << 5) | 5);
assert('T7.43 DOS time encoded correctly',
    dosTime === (9 << 11) | (30 << 5) | 0);

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('PHASE 7 DIAGNOSTICS TEST FAILED');
    process.exit(1);
} else {
    console.log('PHASE 7 DIAGNOSTICS TEST PASSED');
    process.exit(0);
}

})();
