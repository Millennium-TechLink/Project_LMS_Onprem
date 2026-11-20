/**
 * LicenseNegativeCases.test.js
 * Activation rejects every bad key and accepts a good one (stand-in key pair patched in before the services load).
 * Run with: node onprem/electron/license/__tests__/LicenseNegativeCases.test.js
 */

'use strict';

const crypto = require('crypto');
const constants = require('../LicenseConstants');

function newPair() {
    return crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}
const GOOD = newPair(), OTHER = newPair();
// CryptoService reads the key once at require time, so patch before loading it
constants.VENDOR_PUBLIC_KEY_PEM = GOOD.publicKey;

const { issueLicense } = require('../../tools/LicenseIssuer');
const { ActivationService } = require('../ActivationService');

const MID = 'A89B-1886-1FF1';
let passed = 0, failed = 0;
function check(label, cond) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
    cond ? passed++ : failed++;
}
function issue(privateKeyPem, machineId = MID) {
    return issueLicense({ privateKeyPem, machineId, licenseType: 'PERMANENT', expiryDate: 'NEVER', customer: { name: 'T', company: 'T', email: 't@example.com' } });
}

const svc = new ActivationService();
const good = issue(GOOD.privateKey);

console.log('\nAccepted');
check('activation key for this machine', svc.activateOffline(good.activationKey, MID).success === true);
check('.lic file for this machine', svc.activateFromFile(good.licFile, MID).success === true);
check('same key twice is harmless', svc.activateOffline(good.activationKey, MID).success === true);

console.log('\nRejected');
check('different machine', svc.activateOffline(good.activationKey, 'AAAA-BBBB-CCCC').success === false);
check('signed by another key', svc.activateOffline(issue(OTHER.privateKey).activationKey, MID).success === false);
check('signed by another key (.lic)', svc.activateFromFile(issue(OTHER.privateKey).licFile, MID).success === false);
const tampered = JSON.parse(good.licFile); tampered.licenseBlock.licenseType = 'ENTERPRISE';
check('tampered .lic', svc.activateFromFile(JSON.stringify(tampered), MID).success === false);
const swapped = JSON.parse(good.licFile); swapped.vendorSignature = JSON.parse(issue(OTHER.privateKey).licFile).vendorSignature;
check('signature from another license', svc.activateFromFile(JSON.stringify(swapped), MID).success === false);
check('empty key', svc.activateOffline('', MID).success === false);
check('whitespace key', svc.activateOffline('   ', MID).success === false);
check('garbage key', svc.activateOffline('not-a-license-key', MID).success === false);
check('truncated key', svc.activateOffline(good.activationKey.slice(0, -40), MID).success === false);
const k = good.activationKey;
check('corrupted key', svc.activateOffline(k.slice(0, -5) + (k.slice(-5) === 'AAAAA' ? 'BBBBB' : 'AAAAA'), MID).success === false);
check('empty .lic', svc.activateFromFile('', MID).success === false);
check('non-JSON .lic', svc.activateFromFile('{not json', MID).success === false);
check('mismatched machine id format', svc.activateOffline(good.activationKey, 'not-a-machine-id').success === false);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
console.log(failed ? 'LICENSE NEGATIVE CASES TEST FAILED' : 'LICENSE NEGATIVE CASES TEST PASSED');
process.exit(failed ? 1 : 0);
