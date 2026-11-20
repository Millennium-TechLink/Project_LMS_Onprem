/**
 * test_activation_key.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Test script for the new activation key format.
 * 
 * Usage:
 *   node onprem/electron/tools/test_activation_key.js
 * 
 * This script demonstrates:
 *   1. Generating a test license with the new format
 *   2. Parsing and validating the activation key
 *   3. Checksum verification
 *   4. Format detection
 *   5. Error scenarios
 */

'use strict';

const crypto = require('crypto');
const { issueLicense } = require('./LicenseIssuer');

// A fresh keypair per run, patched into LicenseConstants' cached exports
// BEFORE requiring ActivationService - it (via CryptoService) destructures
// VENDOR_PUBLIC_KEY_PEM once at require time, so this must happen first.
// Avoids a hardcoded test key silently going stale after a real key rotation
// (which is exactly what happened to the key this file used to hardcode).
const constants = require('../license/LicenseConstants');
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
constants.VENDOR_PUBLIC_KEY_PEM = TEST_PUBLIC_KEY;

const { ActivationService } = require('../license/ActivationService');
const fs = require('fs');
const path = require('path');

let outcomes = {};

console.log('═══════════════════════════════════════════════════════════');
console.log('  Activation Key Format Test Suite');
console.log('═══════════════════════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Generate a test license
// ─────────────────────────────────────────────────────────────────────────────
console.log('Test 1: Generate License with New Format');
console.log('─────────────────────────────────────────────────────────────');

const testLicense = issueLicense({
    privateKeyPem: TEST_PRIVATE_KEY,
    machineId: 'A89B-1886-1FF1',
    licenseType: 'TRIAL',
    expiryDate: '2027-12-31',
    licenseId: 'TEST-' + Date.now(),
    customer: {
        name: 'Test User',
        company: 'Test Company',
        email: 'test@test.com',
    },
    activationWindowDays: 7,
    licenseDurationDays: 30,
});

console.log('✅ License generated successfully');
console.log(`License ID: ${testLicense.envelope.licenseBlock.licenseId}`);
console.log(`\nActivation Key Format:`);
console.log(testLicense.activationKey.substring(0, 80) + '...\n');

// Extract format components
const keyMatch = testLicense.activationKey.match(/^LMS-V(\d+)-([0-9A-F]{4})-(.+)$/);
if (keyMatch) {
    const [, version, checksum, payload] = keyMatch;
    console.log(`  Prefix:   LMS-`);
    console.log(`  Version:  V${version}`);
    console.log(`  Checksum: ${checksum}`);
    console.log(`  Payload:  ${payload.length} characters`);
} else {
    console.log('❌ Key does not match expected format!');
}
outcomes.formatGeneration = !!keyMatch;

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Validate the generated key
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\nTest 2: Validate Generated Key');
console.log('─────────────────────────────────────────────────────────────');

const activationService = new ActivationService();
const validResult = activationService.activateOffline(
    testLicense.activationKey,
    'A89B-1886-1FF1'
);

if (validResult.success) {
    console.log('✅ Activation key validated successfully');
    console.log(`   License Type: ${validResult.licenseData.licenseType}`);
    console.log(`   License ID:   ${validResult.licenseData.licenseId}`);
} else {
    console.log('❌ Validation failed:', validResult.message);
}
outcomes.validKeyValidation = validResult.success === true;

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Test invalid format
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\nTest 3: Invalid Format Detection');
console.log('─────────────────────────────────────────────────────────────');

const invalidFormats = [
    'INVALID-KEY',
    'LMS-V2-A7F2-payload',  // Wrong version
    'LMS-V1-XYZ-payload',   // Invalid checksum format
    'LMS-V1-',              // Incomplete
];

outcomes.invalidFormatDetection = invalidFormats.every((key, idx) => {
    const result = activationService.activateOffline(key, 'A89B-1886-1FF1');
    console.log(`\nTest 3.${idx + 1}: "${key.substring(0, 30)}..."`);
    if (result.success) {
        console.log('  ❌ Should have failed but succeeded!');
        return false;
    }
    console.log(`  ✅ Correctly rejected: ${result.message.substring(0, 60)}...`);
    return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Test checksum mismatch
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\nTest 4: Checksum Mismatch Detection');
console.log('─────────────────────────────────────────────────────────────');

// Modify the payload but keep the same checksum
const keyParts = testLicense.activationKey.split('-');
const modifiedPayload = keyParts[3].substring(0, keyParts[3].length - 10) + 'MODIFIED==';
const tamperedKey = `${keyParts[0]}-${keyParts[1]}-${keyParts[2]}-${modifiedPayload}`;

const checksumResult = activationService.activateOffline(tamperedKey, 'A89B-1886-1FF1');
if (checksumResult.success) {
    console.log('❌ Tampered key should have been rejected!');
} else {
    console.log('✅ Correctly detected tampering');
    console.log(`   Error: ${checksumResult.message.substring(0, 80)}...`);
}
outcomes.checksumTamperingDetection = checksumResult.success === false;

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Test machine ID mismatch
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\nTest 5: Machine ID Mismatch');
console.log('─────────────────────────────────────────────────────────────');

const wrongMachineResult = activationService.activateOffline(
    testLicense.activationKey,
    'WRONG-MACHINE-ID'
);

if (wrongMachineResult.success) {
    console.log('❌ Should have rejected wrong machine ID!');
} else {
    console.log('✅ Correctly rejected wrong machine');
    console.log(`   Error: ${wrongMachineResult.message.substring(0, 80)}...`);
}
outcomes.machineIdBinding = wrongMachineResult.success === false;

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Test legacy format (backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\nTest 6: Legacy Format Support');
console.log('─────────────────────────────────────────────────────────────');

// Generate a legacy-style key (plain Base64 without LMS- prefix)
const legacyKey = Buffer.from(testLicense.licFile, 'utf8').toString('base64');
console.log(`Legacy key format: ${legacyKey.substring(0, 60)}...`);

const legacyResult = activationService.activateOffline(legacyKey, 'A89B-1886-1FF1');
if (legacyResult.success) {
    console.log('✅ Legacy format still works (backward compatible)');
    console.log(`   License ID: ${legacyResult.licenseData.licenseId}`);
} else {
    console.log('❌ Legacy format failed:', legacyResult.message);
}
outcomes.legacyFormatSupport = legacyResult.success === true;

// ─────────────────────────────────────────────────────────────────────────────
// Summary - reflects actual outcomes recorded above, not a hardcoded PASS list.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\n═══════════════════════════════════════════════════════════');
console.log('  Test Summary');
console.log('═══════════════════════════════════════════════════════════');
const labels = {
    formatGeneration:           'New format generation',
    validKeyValidation:         'Valid key validation',
    invalidFormatDetection:     'Invalid format detection',
    checksumTamperingDetection: 'Checksum tampering detection',
    machineIdBinding:           'Machine ID binding',
    legacyFormatSupport:        'Legacy format support',
};
let allPassed = true;
for (const [key, label] of Object.entries(labels)) {
    const ok = outcomes[key] === true;
    if (!ok) allPassed = false;
    console.log(`${ok ? '✅' : '❌'} ${label}: ${ok ? 'PASS' : 'FAIL'}`);
}
console.log(allPassed ? '\n🎉 All tests passed!\n' : '\n❌ One or more tests FAILED.\n');
if (!allPassed) process.exitCode = 1;

console.log('═══════════════════════════════════════════════════════════\n');
console.log('Next steps:');
console.log('1. Generate a real license using LicenseIssuer.js');
console.log('2. Test activation in the Electron app');
console.log('3. Verify error messages in the UI');
console.log('4. Update vendor documentation\n');
