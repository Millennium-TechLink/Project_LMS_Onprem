/**
 * BatchIssue.test.js
 * Bulk license issuing from a CSV: validation, defaults, and real signed files with a stand-in key pair.
 * Run with: node onprem/electron/license/__tests__/BatchIssue.test.js
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const constants = require('../LicenseConstants');

const pair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// issue-license.js destructures the public key at require time, so patch before loading it
constants.VENDOR_PUBLIC_KEY_PEM = pair.publicKey;

const { parseBatchCsv, runBatch } = require('../../tools/issue-license');
const { ISSUED_LICENSES_DIR } = require('../../tools/LicenseIssuer');
const ledger = require('../../tools/LicenseLedger');

let passed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('BatchIssue');

check('only machineId and company are required; the rest default', () => {
    const { rows, errors } = parseBatchCsv('machineId,company\nA89B-1886-1FF1,Acme Labs\n');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(rows[0].licenseType, 'PERMANENT');
    assert.strictEqual(rows[0].expiryDate, 'NEVER');
    assert.strictEqual(rows[0].licenseDurationDays, null);
    assert.strictEqual(rows[0].customer.name, 'Acme Labs');
});

check('days turns into a duration and an outer expiry date', () => {
    const { rows, errors } = parseBatchCsv('machineId,company,licenseType,days\nA89B-1886-1FF1,Acme,TRIAL,30\n');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(rows[0].licenseDurationDays, 30);
    assert.match(rows[0].expiryDate, /^\d{4}-\d{2}-\d{2}$/);
});

check('every bad row is reported together', () => {
    const csv = [
        'machineId,company,licenseType,days',
        'NOT-AN-ID,Acme,TRIAL,30',
        'A89B-1886-1FF1,,TRIAL,30',
        'A89B-1886-1FF2,Acme,BOGUS,30',
        'A89B-1886-1FF3,Acme,PERMANENT,30',
        'A89B-1886-1FF3,Acme,TRIAL,0',
    ].join('\n');
    const { errors } = parseBatchCsv(csv);
    assert.ok(errors.length >= 6, errors.join(' | '));
});

check('duplicate machine IDs are refused, wildcard may repeat', () => {
    const dup = parseBatchCsv('machineId,company\nA89B-1886-1FF1,A\na89b-1886-1ff1,B\n');
    assert.ok(dup.errors.some(e => /twice/.test(e)));
    const star = parseBatchCsv('machineId,company\n*,A\n*,B\n');
    assert.deepStrictEqual(star.errors, []);
});

check('missing required column and empty file are explained', () => {
    assert.ok(parseBatchCsv('machineId\nA89B-1886-1FF1\n').errors[0].includes('company'));
    assert.ok(parseBatchCsv('machineId,company\n').errors[0].includes('at least one'));
});

check('quoted cells and comment lines are handled', () => {
    const { rows, errors } = parseBatchCsv('# customers\nmachineId,company,email\nA89B-1886-1FF1,"Acme, Inc.",a@b.co\n');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(rows[0].customer.company, 'Acme, Inc.');
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-issue-'));
const keyPath = path.join(dir, 'k.pem');
fs.writeFileSync(keyPath, pair.privateKey);
const ledgerPath = path.join(dir, 'ledger.json');
const made = [];

check('issues signed files, writes the ledger and a result CSV', () => {
    const csvPath = path.join(dir, 'customers.csv');
    fs.writeFileSync(csvPath, 'machineId,company,licenseType,days\nA89B-1886-1FF1,Acme,TRIAL,30\nA89B-1886-1FF2,Beta,PERMANENT,\n');
    const { results, resultPath } = runBatch(csvPath, keyPath, { ledgerPath });
    results.forEach(r => made.push(r.outFile));
    assert.strictEqual(results.length, 2);
    const trial = JSON.parse(fs.readFileSync(results[0].outFile, 'utf8'));
    const block = trial.licenseBlock || trial.envelope?.licenseBlock || trial;
    assert.strictEqual(block.machineId, 'A89B-1886-1FF1');
    assert.strictEqual(block.licenseDurationDays, 30);
    assert.strictEqual(ledger.loadLedger(ledgerPath).length, 2);
    const lines = fs.readFileSync(resultPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.ok(results[0].activationKey.length > 10);
});

check('a bad file signs nothing', () => {
    const csvPath = path.join(dir, 'bad.csv');
    fs.writeFileSync(csvPath, 'machineId,company\nA89B-1886-1FF5,Ok\nBROKEN,Bad\n');
    const before = ledger.loadLedger(ledgerPath).length;
    assert.throws(() => runBatch(csvPath, keyPath, { ledgerPath }), /Nothing was issued/);
    assert.strictEqual(ledger.loadLedger(ledgerPath).length, before);
});

check('a key that does not match the embedded public key is refused', () => {
    const other = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const otherPath = path.join(dir, 'other.pem');
    fs.writeFileSync(otherPath, other.privateKey);
    const csvPath = path.join(dir, 'one.csv');
    fs.writeFileSync(csvPath, 'machineId,company\nA89B-1886-1FF6,Acme\n');
    assert.throws(() => runBatch(csvPath, otherPath, { ledgerPath }), /KEYPAIR MISMATCH/);
});

// remove only the files this run created
for (const f of made) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
void ISSUED_LICENSES_DIR;

console.log(`${passed} checks passed`);
