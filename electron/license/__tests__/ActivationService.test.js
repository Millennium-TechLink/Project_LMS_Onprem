/**
 * ActivationService.test.js
 * Phase 3 — Verify ECDSA-based activation for both file import and key string paths.
 * Run with: node onprem/electron/license/__tests__/ActivationService.test.js
 */

'use strict';

const crypto = require('crypto');

// A fresh keypair per run, patched into LicenseConstants' cached exports
// BEFORE requiring ActivationService - it (via CryptoService) destructures
// VENDOR_PUBLIC_KEY_PEM once at require time, so this must happen first.
// Avoids a hardcoded test key silently going stale after a real key rotation
// (which is exactly what happened to the key this file used to hardcode).
const constants = require('../LicenseConstants');
const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
constants.VENDOR_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY_PEM;

const { ActivationService } = require('../ActivationService');

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

const svc       = new ActivationService();
const MACHINE_ID = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

function makeLicenseBlock(overrides = {}) {
    return {
        schemaVersion:   2,
        licenseId:       crypto.randomUUID(),
        licenseType:     'PERMANENT',
        expiryDate:      'NEVER',
        issuedAt:        new Date().toISOString(),
        machineId:       MACHINE_ID,
        installDate:     new Date().toISOString(),
        status:          'ACTIVE',
        createdAt:       new Date().toISOString(),
        gracePeriodDays: 0,
        ...overrides,
    };
}

function buildEnvelope(blockOverrides = {}) {
    const block     = makeLicenseBlock(blockOverrides);
    const canonical = JSON.stringify(block, Object.keys(block).sort());
    const sigBuf    = crypto.sign('SHA256', Buffer.from(canonical, 'utf8'), {
        key: TEST_PRIVATE_KEY_PEM, dsaEncoding: 'der',
    });
    return {
        formatVersion:   1,
        licenseBlock:    block,
        vendorSignature: sigBuf.toString('base64'),
    };
}

function envelopeToFile(env)    { return JSON.stringify(env, null, 2); }
function envelopeToKey(env)     { return Buffer.from(JSON.stringify(env)).toString('base64'); }

console.log('\n── ActivationService Tests ─────────────────────────────────────\n');

// ═══ activateFromFile ════════════════════════════════════════════════════════
console.log('activateFromFile:');

const validEnv  = buildEnvelope();
const validFile = envelopeToFile(validEnv);

const r1 = svc.activateFromFile(validFile, MACHINE_ID);
assert('T3.A1  Valid .lic file succeeds', r1.success === true);
assert('T3.A1b licenseData is returned', r1.licenseData !== null);
assert('T3.A1c licenseType is PERMANENT', r1.licenseData.licenseType === 'PERMANENT');
assert('T3.A1d machineId bound to current machine', r1.licenseData.machineId === MACHINE_ID);
assert('T3.A1e verifiedEnvelope is present', r1.licenseData.verifiedEnvelope !== null);
assert('T3.A1f message is "Activation successful."', r1.message === 'Activation successful.');

// Empty / null input
const r2 = svc.activateFromFile('', MACHINE_ID);
assert('T3.A2  Empty file content fails', r2.success === false);

const r3 = svc.activateFromFile(null, MACHINE_ID);
assert('T3.A3  Null input fails', r3.success === false);

// Malformed JSON
const r4 = svc.activateFromFile('{ not valid json', MACHINE_ID);
assert('T3.A4  Malformed JSON fails', r4.success === false);
assert('T3.A4b Message mentions JSON', r4.message.toLowerCase().includes('json'));

// Missing licenseBlock
const r5 = svc.activateFromFile(JSON.stringify({ formatVersion: 1 }), MACHINE_ID);
assert('T3.A5  Missing licenseBlock fails', r5.success === false);

// Missing vendorSignature
const noSigEnv = { formatVersion: 1, licenseBlock: buildEnvelope().licenseBlock };
const r6 = svc.activateFromFile(JSON.stringify(noSigEnv), MACHINE_ID);
assert('T3.A6  Missing vendorSignature fails', r6.success === false);

// Tampered licenseBlock
const tamperedEnv = { ...buildEnvelope(), licenseBlock: { ...validEnv.licenseBlock, licenseType: 'ENTERPRISE' } };
const r7 = svc.activateFromFile(envelopeToFile(tamperedEnv), MACHINE_ID);
assert('T3.A7  Tampered licenseBlock fails ECDSA', r7.success === false);
assert('T3.A7b Message mentions signature', r7.message.toLowerCase().includes('signature'));

// Wrong machine
const wrongMachineEnv = buildEnvelope({ machineId: 'different-machine' });
const r8 = svc.activateFromFile(envelopeToFile(wrongMachineEnv), MACHINE_ID);
assert('T3.A8  Wrong machineId fails', r8.success === false);
assert('T3.A8b Message mentions machine', r8.message.toLowerCase().includes('machine'));

// Wildcard machineId
const wildcardEnv = buildEnvelope({ machineId: '*' });
const r9 = svc.activateFromFile(envelopeToFile(wildcardEnv), MACHINE_ID);
assert('T3.A9  Wildcard machineId succeeds', r9.success === true);
assert('T3.A9b machineId bound to actual machine', r9.licenseData.machineId === MACHINE_ID);

// Expired key
const expiredEnv = buildEnvelope({ expiryDate: '2020-01-01T00:00:00.000Z' });
const r10 = svc.activateFromFile(envelopeToFile(expiredEnv), MACHINE_ID);
assert('T3.A10 Expired activation key fails', r10.success === false);
assert('T3.A10b Message mentions expired', r10.message.toLowerCase().includes('expired'));

// Future expiry succeeds
const futureEnv = buildEnvelope({ expiryDate: new Date(Date.now() + 365 * 86400000).toISOString() });
const r11 = svc.activateFromFile(envelopeToFile(futureEnv), MACHINE_ID);
assert('T3.A11 Future expiry succeeds', r11.success === true);

// Unknown license type
const unknownTypeEnv = buildEnvelope({ licenseType: 'UNKNOWN_TYPE' });
const r12 = svc.activateFromFile(envelopeToFile(unknownTypeEnv), MACHINE_ID);
assert('T3.A12 Unknown licenseType fails', r12.success === false);

// ═══ activateOffline (key string) ════════════════════════════════════════════
console.log('\nactivateOffline (key string):');

const validKey = envelopeToKey(buildEnvelope());
const r13 = svc.activateOffline(validKey, MACHINE_ID);
assert('T3.B1  Valid key string succeeds', r13.success === true);
assert('T3.B1b licenseData present', r13.licenseData !== null);

// Empty key
const r14 = svc.activateOffline('', MACHINE_ID);
assert('T3.B2  Empty key fails', r14.success === false);

// Not Base64
const r15 = svc.activateOffline('not base64 !@#$', MACHINE_ID);
assert('T3.B3  Invalid Base64 fails', r15.success === false);

// Valid Base64 but not JSON inside
const r16 = svc.activateOffline(Buffer.from('not json').toString('base64'), MACHINE_ID);
assert('T3.B4  Base64 of non-JSON fails', r16.success === false);

// Key with whitespace/newlines (copy-paste artifact)
const keyWithSpaces = validKey.replace(/(.{40})/g, '$1\n');
const r17 = svc.activateOffline(keyWithSpaces, MACHINE_ID);
assert('T3.B5  Key with embedded newlines succeeds (whitespace stripped)', r17.success === true);

// ═══ generateActivationKey no longer exported from ActivationService ══════
console.log('\nSecurity: generateActivationKey removed from production class:');
const moduleExports = require('../ActivationService');
assert('T3.C1  generateActivationKey NOT exported from ActivationService',
    typeof moduleExports.generateActivationKey === 'undefined');
assert('T3.C2  Only ActivationService class is exported',
    typeof moduleExports.ActivationService === 'function');

// ═══ activateOnline placeholder ══════════════════════════════════════════════
console.log('\nactivateOnline placeholder:');
svc.activateOnline('key', MACHINE_ID).then(r => {
    assert('T3.D1 activateOnline returns failure (not yet implemented)', r.success === false);

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log('\n────────────────────────────────────────────────────────────────');
    console.log(`Result: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error('PHASE 3 ACTIVATION TEST FAILED');
        process.exit(1);
    } else {
        console.log('PHASE 3 ACTIVATION TEST PASSED');
        process.exit(0);
    }
});
