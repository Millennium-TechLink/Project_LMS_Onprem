/**
 * LicenseConstants.test.js
 * Phase 1 — Verify constants are correct values, types, and uniqueness.
 * Run with: node onprem/electron/license/__tests__/LicenseConstants.test.js
 */

'use strict';

const c = require('../LicenseConstants');

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

function assertEqual(description, actual, expected) {
    if (actual === expected) {
        console.log(`  ✓  ${description}`);
        passed++;
    } else {
        console.error(`  ✗  FAIL: ${description} — expected ${expected}, got ${actual}`);
        failed++;
    }
}

console.log('\n── LicenseConstants Tests ──────────────────────────────────────\n');

// T1.14 — All LICENSE_TYPES values are strings
console.log('LICENSE_TYPES:');
for (const [k, v] of Object.entries(c.LICENSE_TYPES)) {
    assert(`LICENSE_TYPES.${k} is a string`, typeof v === 'string');
}

// T1.15 — All VALIDATION_RESULT values are strings and unique
console.log('\nVALIDATION_RESULT:');
const vrValues = Object.values(c.VALIDATION_RESULT);
assert('All VALIDATION_RESULT values are strings', vrValues.every(v => typeof v === 'string'));
assert('All VALIDATION_RESULT values are unique', vrValues.length === new Set(vrValues).size);

// GRACE_PERIOD added
assert('VALIDATION_RESULT.GRACE_PERIOD exists', typeof c.VALIDATION_RESULT.GRACE_PERIOD === 'string');

// T1.16 — Clock tolerance is 90 minutes
console.log('\nClock tolerance:');
assertEqual('CLOCK_ROLLBACK_TOLERANCE_MS === 0 (zero tolerance)', c.CLOCK_ROLLBACK_TOLERANCE_MS, 0);

// T1.17 — Two separate salts, not equal
console.log('\nCrypto salts:');
assert('MACHINE_ID_SALT is a non-empty string', typeof c.MACHINE_ID_SALT === 'string' && c.MACHINE_ID_SALT.length > 10);
assert('RUNTIME_HMAC_SALT is a non-empty string', typeof c.RUNTIME_HMAC_SALT === 'string' && c.RUNTIME_HMAC_SALT.length > 10);
assert('MACHINE_ID_SALT !== RUNTIME_HMAC_SALT', c.MACHINE_ID_SALT !== c.RUNTIME_HMAC_SALT);

// T1.18 — Backward-compat aliases were removed in Phase 2
console.log('\nBackward-compat aliases (removed in Phase 2):');
assert('APP_SALT not exported after Phase 2', c.APP_SALT === undefined);
assert('LICENSE_SUBDIR not exported after Phase 2', c.LICENSE_SUBDIR === undefined);
assert('LICENSE_BACKUP_DIR not exported after Phase 2', c.LICENSE_BACKUP_DIR === undefined);

// T1.19 — All IPC_CHANNELS values are namespaced (contain ':')
console.log('\nIPC_CHANNELS:');
for (const [k, v] of Object.entries(c.IPC_CHANNELS)) {
    assert(`IPC_CHANNELS.${k} contains ':'`, v.includes(':'));
}

// T1.20 — Schema versions
console.log('\nSchema versions:');
assertEqual('LICENSE_SCHEMA_VERSION === 2', c.LICENSE_SCHEMA_VERSION, 2);
assertEqual('MACHINE_SCHEMA_VERSION === 1',  c.MACHINE_SCHEMA_VERSION,  1);
assertEqual('ENVELOPE_FORMAT_VERSION === 1', c.ENVELOPE_FORMAT_VERSION, 1);

// File names
console.log('\nFile names:');
assertEqual('LICENSE_FILENAME', c.LICENSE_FILENAME, 'license.dat');
assertEqual('MACHINE_FILENAME', c.MACHINE_FILENAME, 'machine.dat');
assertEqual('ACTIVATION_LOG_FILENAME', c.ACTIVATION_LOG_FILENAME, 'activation.log');

// Activation log events
console.log('\nActivation log events:');
const requiredEvents = [
    'FIRST_INSTALL', 'TRIAL_CREATED', 'LAUNCH', 'ACTIVATION_OK',
    'ACTIVATION_FAIL', 'LICENSE_EXPIRED', 'INTEGRITY_FAILED',
    'CLOCK_TAMPER', 'MACHINE_MISMATCH', 'BYPASS_ATTEMPT',
];
for (const ev of requiredEvents) {
    assert(`ACTIVATION_LOG_EVENTS.${ev} exists`, typeof c.ACTIVATION_LOG_EVENTS[ev] === 'string');
}

// LICENSE_STATUS includes GRACE_PERIOD
console.log('\nLICENSE_STATUS:');
assert('LICENSE_STATUS.GRACE_PERIOD exists', typeof c.LICENSE_STATUS.GRACE_PERIOD === 'string');

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('PHASE 1 CONSTANTS TEST FAILED');
    process.exit(1);
} else {
    console.log('PHASE 1 CONSTANTS TEST PASSED');
    process.exit(0);
}
