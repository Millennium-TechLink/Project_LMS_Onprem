/**
 * LicenseValidator.test.js
 * Phase 3 — Verify ECDSA verification, runtime HMAC, and full validate() flow.
 * Run with: node onprem/electron/license/__tests__/LicenseValidator.test.js
 */

'use strict';

const crypto = require('crypto');

// A fresh keypair per run, patched into LicenseConstants' cached exports
// BEFORE requiring LicenseValidator - it (via CryptoService) destructures
// VENDOR_PUBLIC_KEY_PEM once at require time, so this must happen first.
// Avoids a hardcoded test key silently going stale after a real key rotation
// (which is exactly what happened to the key this file used to hardcode).
const constants = require('../LicenseConstants');
const { VALIDATION_RESULT } = constants;
const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
constants.VENDOR_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY_PEM;

const LicenseValidator = require('../LicenseValidator');

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
const v = new LicenseValidator();
const MACHINE_ID = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

/**
 * Sign a licenseBlock with the test private key — mirrors what LicenseIssuer.js does.
 */
function signBlock(block) {
    const canonical = JSON.stringify(block, Object.keys(block).sort());
    const sigBuf = crypto.sign('SHA256', Buffer.from(canonical, 'utf8'), {
        key:         TEST_PRIVATE_KEY_PEM,
        dsaEncoding: 'der',
    });
    return sigBuf.toString('base64');
}

function makeLicenseBlock(overrides = {}) {
    return {
        schemaVersion: 2,
        licenseId:     'test-license-001',
        licenseType:   'PERMANENT',
        expiryDate:    'NEVER',
        issuedAt:      new Date().toISOString(),
        machineId:     MACHINE_ID,
        installDate:   new Date().toISOString(),
        status:        'ACTIVE',
        createdAt:     new Date().toISOString(),
        gracePeriodDays: 0,
        ...overrides,
    };
}

function makeValidEnvelope(blockOverrides = {}) {
    const block = makeLicenseBlock(blockOverrides);
    return {
        formatVersion:   1,
        licenseBlock:    block,
        vendorSignature: signBlock(block),
        runtimeBlock:    { lastLaunch: null, lastVersion: '1.0.0', updatedAt: new Date().toISOString() },
        runtimeHmac:     '',
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
console.log('\n── LicenseValidator Tests ──────────────────────────────────────\n');

// ═══ verifyVendorSignature ═══════════════════════════════════════════════════
console.log('verifyVendorSignature (ECDSA):');

const validBlock = makeLicenseBlock();
const validSig   = signBlock(validBlock);

assert('T3.1  Valid ECDSA signature passes',
    v.verifyVendorSignature(validBlock, validSig) === true);

// Tampered block
const tamperedBlock = { ...validBlock, licenseType: 'ENTERPRISE' };
assert('T3.2  Tampered licenseBlock fails',
    v.verifyVendorSignature(tamperedBlock, validSig) === false);

// Wrong signature
assert('T3.3  Random base64 signature fails',
    v.verifyVendorSignature(validBlock, Buffer.alloc(64).toString('base64')) === false);

assert('T3.4  null licenseBlock returns false',
    v.verifyVendorSignature(null, validSig) === false);

assert('T3.5  null signature returns false',
    v.verifyVendorSignature(validBlock, null) === false);

assert('T3.6  Empty string signature returns false',
    v.verifyVendorSignature(validBlock, '') === false);

// ═══ signRuntime / verifyRuntimeHmac ════════════════════════════════════════
console.log('\nsignRuntime / verifyRuntimeHmac (HMAC):');

const runtimeData = { lastLaunch: '2026-08-05T09:00:00.000Z', lastVersion: '1.0.0' };
const hmac = v.signRuntime(runtimeData, MACHINE_ID);

assert('T3.7  signRuntime returns non-empty hex string',
    typeof hmac === 'string' && hmac.length === 64);
assert('T3.8  verifyRuntimeHmac passes with correct data',
    v.verifyRuntimeHmac(runtimeData, hmac, MACHINE_ID) === true);

// Tampered data
assert('T3.9  verifyRuntimeHmac fails with tampered data',
    v.verifyRuntimeHmac({ ...runtimeData, lastVersion: '9.9.9' }, hmac, MACHINE_ID) === false);

// Different machine
assert('T3.10 verifyRuntimeHmac fails with different machineId',
    v.verifyRuntimeHmac(runtimeData, hmac, 'different-machine-id') === false);

assert('T3.11 signRuntime is deterministic (same input → same output)',
    v.signRuntime(runtimeData, MACHINE_ID) === hmac);

// ═══ Backward-compat shims removed in Phase 4 ═══════════════════════════════
console.log('\nPhase 4: backward-compat shims removed from LicenseValidator:');

assert('T3.12 sign() shim removed — not a function',
    typeof v.sign !== 'function');
assert('T3.13 verifyIntegrity() shim removed — not a function',
    typeof v.verifyIntegrity !== 'function');
assert('T3.12b signRuntime() exists (real method)',
    typeof v.signRuntime === 'function');
assert('T3.13b verifyRuntimeHmac() exists (real method)',
    typeof v.verifyRuntimeHmac === 'function');

// ═══ validate() — new ECDSA envelope format ══════════════════════════════════
console.log('\nvalidate() — new ECDSA envelope format:');

// T3.14 Valid envelope passes
const validEnv = makeValidEnvelope();
const r1 = v.validate(validEnv, MACHINE_ID);
assert('T3.14 Valid envelope → VALID',
    r1.code === VALIDATION_RESULT.VALID && r1.valid === true);
assert('T3.14b daysRemaining is Infinity for NEVER expiry',
    r1.daysRemaining === Infinity);
assert('T3.14c licenseType is PERMANENT',
    r1.licenseType === 'PERMANENT');

// T3.15 null envelope → NOT_FOUND
const r2 = v.validate(null, MACHINE_ID);
assert('T3.15 null → NOT_FOUND', r2.code === VALIDATION_RESULT.NOT_FOUND);

// T3.16 Missing licenseBlock → MALFORMED
const r3 = v.validate({ formatVersion: 1 }, MACHINE_ID);
assert('T3.16 Missing licenseBlock → MALFORMED', r3.code === VALIDATION_RESULT.MALFORMED);

// T3.17 Tampered licenseBlock → INTEGRITY_FAILED
const tamperedEnv = {
    ...makeValidEnvelope(),
    licenseBlock: { ...validBlock, licenseType: 'ENTERPRISE' },
};
const r4 = v.validate(tamperedEnv, MACHINE_ID);
assert('T3.17 Tampered block → INTEGRITY_FAILED', r4.code === VALIDATION_RESULT.INTEGRITY_FAILED);

// T3.18 Wrong machine → MACHINE_MISMATCH
const wrongMachineEnv = makeValidEnvelope({ machineId: 'different-machine-id' });
const r5 = v.validate(wrongMachineEnv, MACHINE_ID);
assert('T3.18 Wrong machineId → MACHINE_MISMATCH', r5.code === VALIDATION_RESULT.MACHINE_MISMATCH);

// T3.19 Expired license → EXPIRED
const expiredEnv = makeValidEnvelope({ expiryDate: '2020-01-01T00:00:00.000Z' });
const r6 = v.validate(expiredEnv, MACHINE_ID);
assert('T3.19 Expired license → EXPIRED', r6.code === VALIDATION_RESULT.EXPIRED);
assert('T3.19b daysRemaining is 0 on expired', r6.daysRemaining === 0);

// T3.20 Future expiry → VALID with daysRemaining > 0
const futureEnv = makeValidEnvelope({ expiryDate: new Date(Date.now() + 10 * 86400000).toISOString() });
const r7 = v.validate(futureEnv, MACHINE_ID);
assert('T3.20 Future expiry → VALID', r7.code === VALIDATION_RESULT.VALID);
assert('T3.20b daysRemaining > 0', r7.daysRemaining > 0 && r7.daysRemaining <= 10);

// T3.21 Clock rollback → CLOCK_TAMPER
const futureLastLaunch = new Date(Date.now() + 3 * 3600 * 1000).toISOString(); // 3h in future
const rollbackEnv = {
    ...makeValidEnvelope(),
    runtimeBlock: { lastLaunch: futureLastLaunch, lastVersion: '1.0.0', updatedAt: futureLastLaunch },
};
const r8 = v.validate(rollbackEnv, MACHINE_ID, new Date());
assert('T3.21 Clock rollback (3h) → CLOCK_TAMPER', r8.code === VALIDATION_RESULT.CLOCK_TAMPER);

// T3.22 Small clock difference (< 90 min) → still VALID
const smallDiffLaunch = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30min in future
const smallDiffEnv = {
    ...makeValidEnvelope(),
    runtimeBlock: { lastLaunch: smallDiffLaunch, lastVersion: '1.0.0', updatedAt: smallDiffLaunch },
};
const r9 = v.validate(smallDiffEnv, MACHINE_ID, new Date());
assert('T3.22 Small clock diff (30min) → VALID (within tolerance)', r9.code === VALIDATION_RESULT.VALID);

// T3.23 Missing required field → MALFORMED
const missingFieldEnv = makeValidEnvelope({ machineId: undefined });
// Re-sign with the field missing
const missingBlock = { ...makeLicenseBlock() };
delete missingBlock.machineId;
const missingEnv = { formatVersion: 1, licenseBlock: missingBlock, vendorSignature: signBlock(missingBlock) };
const r10 = v.validate(missingEnv, MACHINE_ID);
assert('T3.23 Missing machineId → MALFORMED', r10.code === VALIDATION_RESULT.MALFORMED);

// ═══ validate() — trial/HMAC envelope format ════════════════════════════════
console.log('\nvalidate() — trial HMAC-signed format { payload, signature }:');

// This is NOT a legacy shim. Trials are HMAC-protected (no vendor ECDSA).
// The validator handles this via the runtimeHmac path when vendorSignature is null.
// Building a trial-like envelope: licenseBlock + runtimeHmac (no vendorSignature)
const trialPayload = {
    schemaVersion: 2,
    machineId:     MACHINE_ID,
    licenseType:   'TRIAL',
    expiryDate:    new Date(Date.now() + 20 * 86400000).toISOString(),
    status:        'ACTIVE',
    installDate:   new Date().toISOString(),
    createdAt:     new Date().toISOString(),
};
const trialHmac = v.signRuntime(trialPayload, MACHINE_ID);

// New trial envelope format (licenseBlock + runtimeHmac, no vendorSignature)
const trialEnv = {
    formatVersion:   1,
    licenseBlock:    trialPayload,
    vendorSignature: null,
    runtimeBlock:    { lastLaunch: null },
    runtimeHmac:     trialHmac,
};
const r11 = v.validate(trialEnv, MACHINE_ID);
assert('T3.24 Trial envelope with valid HMAC → VALID', r11.code === VALIDATION_RESULT.VALID);

// Tampered trial block
const tamperedTrial = { ...trialPayload, licenseType: 'ENTERPRISE' };
const r12 = v.validate({ ...trialEnv, licenseBlock: tamperedTrial }, MACHINE_ID);
assert('T3.25 Trial envelope tampered → INTEGRITY_FAILED', r12.code === VALIDATION_RESULT.INTEGRITY_FAILED);

// Legacy { payload, signature } shape still supported by validate()
const legacySig = v.signRuntime(trialPayload, MACHINE_ID);
const legacyEnv = { payload: trialPayload, signature: legacySig };
const r13 = v.validate(legacyEnv, MACHINE_ID);
assert('T3.26 Legacy { payload, signature } format → VALID', r13.code === VALIDATION_RESULT.VALID);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────');
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('PHASE 4 VALIDATOR TEST FAILED');
    process.exit(1);
} else {
    console.log('PHASE 4 VALIDATOR TEST PASSED');
    process.exit(0);
}
