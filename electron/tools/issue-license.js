/**
 * issue-license.js  —  VENDOR TOOL — NOT SHIPPED IN APPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Interactive wrapper around LicenseIssuer.js's issueLicense(). Prompts for
 * customer details instead of a long CLI flag string, supports issuing to
 * one machine, several specific machines, or one wildcard/site license in a
 * single run, and records every issuance in LicenseLedger.js so a lookup or
 * a reissue later doesn't require digging through old emails.
 *
 * This tool never signs anything itself - it only collects input and calls
 * LicenseIssuer.js's issueLicense(), which owns the actual crypto.
 *
 * Usage:
 *   node onprem/electron/tools/issue-license.js                 interactive issuance
 *   node onprem/electron/tools/issue-license.js --list           show the ledger
 *   node onprem/electron/tools/issue-license.js --lookup <text>  search customer/company/email
 *   node onprem/electron/tools/issue-license.js --reissue <id>   re-sign from a ledger record
 *   node onprem/electron/tools/issue-license.js --batch <file.csv> [--key <private.pem>]
 *                                                         issue many licenses with no prompts
 *
 * Batch CSV columns (header row required): machineId, company, and optionally licenseType
 * (default PERMANENT), days (valid for this many days from activation; blank = never expires),
 * name, email, activationWindowDays, expiryDate, label. Every row is checked before anything
 * is signed; a result file <file>.issued.csv lists each .lic path and activation key.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const { issueLicense, buildLicenseOutputPath, computeKeyFingerprint, VENDOR_DATA_DIR } = require('./LicenseIssuer');
const {
    LICENSE_TYPES,
    LICENSE_START_MODES,
    DEFAULT_ACTIVATION_WINDOW_DAYS,
    VENDOR_PUBLIC_KEY_PEM,
    ECDSA_ALGORITHM,
} = require('../license/LicenseConstants');
const ledger = require('./LicenseLedger');

const MACHINE_ID_PATTERN = /^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/;

let rl;

// A manual line queue instead of rl.question(): readline's own question()
// (promise or callback form) races against the input stream reaching EOF
// once an `await` puts a microtask tick between one answer and the next
// question() call - fine on a live TTY, but drops answers reliably when
// stdin is a fast, finite source (a file, or another process's piped
// output). One persistent 'line' listener sidesteps that entirely.
const _lineQueue = [];
const _waiters = [];
function _setupLineQueue() {
    rl.on('line', (line) => {
        if (_waiters.length > 0) _waiters.shift()(line);
        else _lineQueue.push(line);
    });
}
function questionAsync(prompt) {
    process.stdout.write(prompt);
    if (_lineQueue.length > 0) return Promise.resolve(_lineQueue.shift());
    return new Promise(resolve => _waiters.push(resolve));
}

async function ask(question, { default: def = null, validate = null } = {}) {
    while (true) {
        const suffix = def !== null ? ` [${def}]` : '';
        const raw = (await questionAsync(`${question}${suffix}: `)).trim();
        const value = raw || def;
        if (value === null || value === '') {
            console.log('  A value is required.');
            continue;
        }
        if (validate) {
            const err = validate(value);
            if (err) { console.log(`  ${err}`); continue; }
        }
        return value;
    }
}

async function askYesNo(question, defaultYes = false) {
    const suffix = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await questionAsync(`${question} [${suffix}]: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
}

/** Same check LicenseIssuer.js's own CLI does - catches a stale/rotated key early. */
function verifyKeypairConsistency(privateKeyPem) {
    try {
        const testPayload = Buffer.from('keypair-consistency-check', 'utf8');
        const testSig = crypto.sign(ECDSA_ALGORITHM, testPayload, { key: privateKeyPem, dsaEncoding: 'der' });
        return crypto.verify(ECDSA_ALGORITHM, testPayload, { key: VENDOR_PUBLIC_KEY_PEM, dsaEncoding: 'der' }, testSig);
    } catch {
        return false;
    }
}

function validateMachineId(id) {
    if (id === '*') return null;
    if (!MACHINE_ID_PATTERN.test(id)) {
        return 'Expected XXXX-XXXX-XXXX (e.g. A89B-1886-1FF1), or * for a wildcard/site license.';
    }
    return null;
}

function validatePositiveInt(v) {
    return /^\d+$/.test(v) && parseInt(v, 10) > 0 ? null : 'Enter a positive whole number.';
}

/** @returns {Promise<string[]>} one machine ID, several, or ['*'] */
async function collectMachineIds() {
    console.log('\nHow many machines is this license for?');
    console.log('  1) One specific machine');
    console.log('  2) Several specific machines (enter each Machine ID)');
    console.log('  3) Wildcard / site license - activates on ANY machine.');
    console.log('     No per-machine cap is enforced (this system is fully offline);');
    console.log('     treat this as an unlimited-seat license for that customer.');
    const choice = await ask('Choice', {
        default: '1',
        validate: v => ['1', '2', '3'].includes(v) ? null : 'Enter 1, 2, or 3.',
    });

    if (choice === '3') return ['*'];

    let count = 1;
    if (choice === '2') {
        count = parseInt(await ask('How many machines', { default: '2', validate: validatePositiveInt }), 10);
    }

    const ids = [];
    for (let i = 1; i <= count; i++) {
        const label = count > 1 ? `Machine ID ${i}/${count}` : 'Machine ID';
        const id = await ask(`  ${label} (XXXX-XXXX-XXXX)`, { validate: validateMachineId });
        ids.push(id.toUpperCase());
    }
    return ids;
}

function loadPrivateKey(keyPath) {
    if (!fs.existsSync(keyPath)) throw new Error(`File not found: ${keyPath}`);
    return fs.readFileSync(keyPath, 'utf8');
}

/** Path to the key KeyGenerator.js last marked active, if any - used as the
 *  default answer so issuing doesn't depend on remembering the right file. */
function suggestActiveKeyPath() {
    try {
        const pointerPath = path.join(VENDOR_DATA_DIR, 'keys', 'ACTIVE_KEY.txt');
        if (!fs.existsSync(pointerPath)) return null;
        const name = fs.readFileSync(pointerPath, 'utf8').trim();
        const keyPath = name && path.join(VENDOR_DATA_DIR, 'keys', name);
        return keyPath && fs.existsSync(keyPath) ? keyPath : null;
    } catch {
        return null;
    }
}

/**
 * Signs and writes one .lic file + one ledger record for a single machine ID.
 */
function issueOne({ privateKeyPem, machineId, licenseType, expiryDate, customer,
                     activationWindowDays, licenseDurationDays, label = null, reissueOf = null,
                     ledgerPath = ledger.DEFAULT_LEDGER_PATH }) {
    const { envelope, licFile, activationKey } = issueLicense({
        privateKeyPem,
        machineId,
        licenseType,
        expiryDate,
        customer,
        activationWindowDays,
        licenseDurationDays,
        licenseStartMode: LICENSE_START_MODES.FIRST_ACTIVATION,
    });

    const outFile = buildLicenseOutputPath(envelope, customer, { label });
    fs.writeFileSync(outFile, licFile, 'utf8');

    ledger.appendRecord({
        licenseId: envelope.licenseBlock.licenseId,
        machineId,
        customer: customer.name,
        company: customer.company,
        email: customer.email,
        licenseType,
        expiryDate,
        activationWindowDays,
        licenseDurationDays,
        label,
        // Which key signed this - so a renewal months/years later, once the
        // active key has moved on, can look up the ORIGINAL key instead of
        // guessing (that customer's already-installed build only trusts
        // whichever key was embedded when it was built, not today's).
        signingKeyFingerprint: computeKeyFingerprint(privateKeyPem),
        issuedAt: new Date().toISOString(),
        licFile: outFile,
        reissueOf,
    }, ledgerPath);

    return { envelope, outFile, activationKey };
}

// ════════════════════════════════════════════════════════════════════════
// Interactive issuance
// ════════════════════════════════════════════════════════════════════════

async function runIssueFlow() {
    console.log('\n=== LMS License Issuer ===\n');

    const privateKeyPath = await ask('Path to vendor private key (.pem)', {
        default: suggestActiveKeyPath(),
        validate: p => fs.existsSync(p) ? null : 'File not found.',
    });
    const privateKeyPem = loadPrivateKey(privateKeyPath);

    if (!verifyKeypairConsistency(privateKeyPem)) {
        console.log('\n[X] KEYPAIR MISMATCH: this private key does not match VENDOR_PUBLIC_KEY_PEM');
        console.log('    in LicenseConstants.js. Any license issued now would fail activation.');
        console.log('    Fix LicenseConstants.js, or point at the correct private key file.');
        process.exitCode = 1;
        return;
    }
    console.log('[OK] Private/public keypair consistency verified.\n');

    // Only what changes the license: who, which type, how many days. Email, filename label and the
    // activation window take their defaults (use --batch with a CSV to override them).
    const company = await ask('Company');
    const customerName = await ask('Contact name', { default: company });
    const email = '';
    const label = customerName;

    console.log(`\nLicense types: ${Object.values(LICENSE_TYPES).join(' / ')}`);
    const licenseType = (await ask('License type', {
        default: 'PERMANENT',
        validate: v => Object.values(LICENSE_TYPES).includes(v.toUpperCase()) ? null : 'Not a recognised license type.',
    })).toUpperCase();

    const activationWindowDays = DEFAULT_ACTIVATION_WINDOW_DAYS;
    let licenseDurationDays = null;
    let expiryDate = 'NEVER';
    if (licenseType !== LICENSE_TYPES.PERMANENT) {
        licenseDurationDays = parseInt(await ask('Valid for how many days from activation', {
            validate: validatePositiveInt,
        }), 10);
        expiryDate = latestExpiry(activationWindowDays, licenseDurationDays);
    }

    const machineIds = await collectMachineIds();

    console.log('\n--- Summary ---');
    console.log(`Customer:          ${customerName} (${company}) <${email}>`);
    console.log(`Filename label:    ${label}`);
    console.log(`Type:              ${licenseType}`);
    console.log(`Expiry:            ${expiryDate}`);
    console.log(`Activation window: ${activationWindowDays} day(s)`);
    if (licenseDurationDays) console.log(`Duration from activation: ${licenseDurationDays} day(s)`);
    console.log(`Machine(s):        ${machineIds.join(', ')}`);
    console.log('');

    if (!(await askYesNo('Issue this license now?', false))) {
        console.log('Cancelled - nothing was signed.');
        return;
    }

    const customer = { name: customerName, company, email };
    for (const machineId of machineIds) {
        const { envelope, outFile, activationKey } = issueOne({
            privateKeyPem, machineId, licenseType, expiryDate, customer,
            activationWindowDays, licenseDurationDays, label,
        });

        console.log(`\n[OK] Issued for ${machineId}`);
        console.log(`     License ID: ${envelope.licenseBlock.licenseId}`);
        console.log(`     File:       ${outFile}`);
        console.log(`     Key:        ${activationKey}`);
    }

    console.log(`\nRecorded ${machineIds.length} issuance(s) in ${ledger.DEFAULT_LEDGER_PATH}`);
}

// ════════════════════════════════════════════════════════════════════════
// --list / --lookup
// ════════════════════════════════════════════════════════════════════════

function printRecords(records) {
    if (records.length === 0) {
        console.log('(no matching records)');
        return;
    }
    for (const r of records) {
        console.log('');
        console.log(`License ID : ${r.licenseId}${r.reissueOf ? `  (reissue of ${r.reissueOf})` : ''}`);
        if (r.label) console.log(`Label      : ${r.label}`);
        console.log(`Customer   : ${r.customer} (${r.company}) <${r.email}>`);
        console.log(`Machine    : ${r.machineId}`);
        console.log(`Type       : ${r.licenseType}   Expiry: ${r.expiryDate}`);
        if (r.signingKeyFingerprint) console.log(`Signed by  : key ${r.signingKeyFingerprint}`);
        console.log(`Issued     : ${r.issuedAt}`);
        console.log(`File       : ${r.licFile}`);
    }
}

// ════════════════════════════════════════════════════════════════════════
// --reissue <licenseId>
// ════════════════════════════════════════════════════════════════════════

async function runReissueFlow(licenseId) {
    const record = ledger.findByLicenseId(licenseId);
    if (!record) {
        console.log(`No ledger record found for license ID: ${licenseId}`);
        process.exitCode = 1;
        return;
    }

    console.log('\n=== Reissue License ===');
    console.log(`Original license ID: ${record.licenseId}`);
    console.log(`Customer:            ${record.customer} (${record.company}) <${record.email}>`);
    console.log(`Original machine:    ${record.machineId}`);
    console.log(`Type:                ${record.licenseType}   Expiry: ${record.expiryDate}`);
    if (record.signingKeyFingerprint) {
        console.log(`Originally signed by: key ${record.signingKeyFingerprint}`);
        console.log(`  -> that customer's EXISTING install only trusts this key. Use the`);
        console.log(`     matching private key below unless they're also getting a fresh`);
        console.log(`     rebuild with a newer one.`);
    }
    console.log('');

    const privateKeyPath = await ask('Path to vendor private key (.pem)', {
        default: suggestActiveKeyPath(),
        validate: p => fs.existsSync(p) ? null : 'File not found.',
    });
    const privateKeyPem = loadPrivateKey(privateKeyPath);

    if (!verifyKeypairConsistency(privateKeyPem)) {
        console.log('\n[X] KEYPAIR MISMATCH: this private key does not match VENDOR_PUBLIC_KEY_PEM in LicenseConstants.js.');
        process.exitCode = 1;
        return;
    }

    if (record.signingKeyFingerprint && computeKeyFingerprint(privateKeyPem) !== record.signingKeyFingerprint) {
        console.log(`\n⚠️  This key (${computeKeyFingerprint(privateKeyPem)}) differs from the one that signed`);
        console.log(`   the original license (${record.signingKeyFingerprint}). The result will NOT activate`);
        console.log('   on that customer\'s existing install - only on a fresh build made with this key.');
        if (!(await askYesNo('Continue anyway?', false))) {
            console.log('Cancelled.');
            return;
        }
    }

    const sameMachine = await askYesNo(`Reissue for the same machine (${record.machineId})?`, true);
    const machineId = sameMachine
        ? record.machineId
        : (await ask('New Machine ID (XXXX-XXXX-XXXX, or * for wildcard)', { validate: validateMachineId })).toUpperCase();

    const expiryDate = await ask('Expiry date (NEVER or YYYY-MM-DD)', { default: record.expiryDate });
    const activationWindowDays = parseInt(await ask('Activation window (days)', {
        default: String(record.activationWindowDays || DEFAULT_ACTIVATION_WINDOW_DAYS),
        validate: validatePositiveInt,
    }), 10);
    const label = await ask('Label for the .lic filename', {
        default: record.label || record.customer || record.company || 'License',
    });

    if (!(await askYesNo(`Reissue license for ${machineId} now?`, false))) {
        console.log('Cancelled - nothing was signed.');
        return;
    }

    const customer = { name: record.customer, company: record.company, email: record.email };
    const { envelope, outFile, activationKey } = issueOne({
        privateKeyPem, machineId, licenseType: record.licenseType, expiryDate, customer,
        activationWindowDays, licenseDurationDays: record.licenseDurationDays || null,
        label, reissueOf: record.licenseId,
    });

    console.log(`\n[OK] Reissued as a new license`);
    console.log(`     New License ID: ${envelope.licenseBlock.licenseId}`);
    console.log(`     File:           ${outFile}`);
    console.log(`     Key:            ${activationKey}`);
}

// ════════════════════════════════════════════════════════════════════════
// CLI entry point
// ════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════
// Batch issuance (no prompts)
// ═════════════════════════════════════════════════

function splitCsvLine(line) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    out.push(cur.trim());
    return out;
}

/** Parses and validates a batch CSV. Returns { rows, errors }; rows are only usable when errors is empty. */
function parseBatchCsv(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    const errors = [];
    if (lines.length < 2) return { rows: [], errors: ['The file needs a header row and at least one data row.'] };
    const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
    for (const required of ['machineid', 'company']) {
        if (!header.includes(required)) errors.push(`Missing required column "${required}".`);
    }
    if (errors.length) return { rows: [], errors };

    const rows = [];
    const seen = new Set();
    lines.slice(1).forEach((line, i) => {
        const cells = splitCsvLine(line);
        const r = {};
        header.forEach((h, idx) => { r[h] = cells[idx] || ''; });
        const where = `Row ${i + 2}`;
        const machineId = r.machineid.toUpperCase();
        const idErr = validateMachineId(machineId);
        if (idErr) errors.push(`${where}: machineId "${r.machineid}". ${idErr}`);
        if (machineId !== '*' && seen.has(machineId)) errors.push(`${where}: machineId ${machineId} appears twice.`);
        seen.add(machineId);
        if (!r.company) errors.push(`${where}: company is required.`);
        const licenseType = (r.licensetype || 'PERMANENT').toUpperCase();
        if (!Object.values(LICENSE_TYPES).includes(licenseType)) errors.push(`${where}: licenseType "${r.licensetype}" is not recognised.`);
        const activationWindowDays = r.activationwindowdays ? parseInt(r.activationwindowdays, 10) : DEFAULT_ACTIVATION_WINDOW_DAYS;
        const daysText = r.days || r.licensedurationdays;
        const licenseDurationDays = daysText ? parseInt(daysText, 10) : null;
        if (!(activationWindowDays > 0)) errors.push(`${where}: activationWindowDays must be a positive number.`);
        if (licenseDurationDays !== null && !(licenseDurationDays > 0)) errors.push(`${where}: days must be a positive number.`);
        if (licenseType === LICENSE_TYPES.PERMANENT && licenseDurationDays) errors.push(`${where}: a PERMANENT license has no days; leave it blank or pick another type.`);
        let expiryDate = r.expirydate || 'NEVER';
        if (expiryDate !== 'NEVER' && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) errors.push(`${where}: expiryDate must be NEVER or YYYY-MM-DD.`);
        if (licenseDurationDays && !r.expirydate) expiryDate = latestExpiry(activationWindowDays, licenseDurationDays);
        rows.push({
            machineId, licenseType, expiryDate, activationWindowDays, licenseDurationDays,
            customer: { name: r.name || r.company, company: r.company, email: r.email || '' },
            label: r.label || r.name || r.company,
        });
    });
    return { rows, errors };
}

/** Outer bound for "valid N days from activation": the last day the customer could activate, plus N days. */
function latestExpiry(activationWindowDays, days) {
    return new Date(Date.now() + (activationWindowDays + days) * 86400000).toISOString().slice(0, 10);
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Issues every row of a batch CSV. Nothing is signed unless the whole file validates. */
function runBatch(csvPath, keyPath, { ledgerPath = ledger.DEFAULT_LEDGER_PATH } = {}) {
    if (!fs.existsSync(csvPath)) throw new Error(`File not found: ${csvPath}`);
    const resolvedKey = keyPath || suggestActiveKeyPath();
    if (!resolvedKey) throw new Error('No private key: pass --key <path> or mark one active with KeyGenerator.js.');
    const privateKeyPem = loadPrivateKey(resolvedKey);
    if (!verifyKeypairConsistency(privateKeyPem)) {
        throw new Error('KEYPAIR MISMATCH: this private key does not match VENDOR_PUBLIC_KEY_PEM in LicenseConstants.js.');
    }
    const { rows, errors } = parseBatchCsv(fs.readFileSync(csvPath, 'utf8'));
    if (errors.length) throw new Error(`Nothing was issued. Fix the file first:\n  ${errors.join('\n  ')}`);

    const results = rows.map(row => {
        const { envelope, outFile, activationKey } = issueOne({ privateKeyPem, ...row, ledgerPath });
        return { row, licenseId: envelope.licenseBlock.licenseId, outFile, activationKey };
    });

    const resultPath = csvPath.replace(/\.csv$/i, '') + '.issued.csv';
    const lines = ['machineId,company,email,licenseId,licFile,activationKey'];
    for (const r of results) {
        lines.push([r.row.machineId, r.row.customer.company, r.row.customer.email, r.licenseId, r.outFile, r.activationKey].map(csvCell).join(','));
    }
    fs.writeFileSync(resultPath, lines.join('\n') + '\n', 'utf8');
    return { results, resultPath };
}

async function main() {
    const args = process.argv.slice(2);

    const batchIdx = args.indexOf('--batch');
    if (batchIdx >= 0) {
        const csvPath = args[batchIdx + 1];
        const keyIdx = args.indexOf('--key');
        if (!csvPath) {
            console.error('Usage: node issue-license.js --batch <file.csv> [--key <private.pem>]');
            process.exitCode = 1;
            return;
        }
        try {
            const { results, resultPath } = runBatch(csvPath, keyIdx >= 0 ? args[keyIdx + 1] : null);
            console.log(`Issued ${results.length} license(s). Details: ${resultPath}`);
        } catch (err) {
            console.error(`
[X] ${err.message}`);
            process.exitCode = 1;
        }
        return;
    }

    if (args.includes('--list')) {
        printRecords(ledger.loadLedger());
        return;
    }

    const lookupIdx = args.indexOf('--lookup');
    if (lookupIdx >= 0) {
        const query = args[lookupIdx + 1];
        if (!query) {
            console.error('Usage: node issue-license.js --lookup <customer/company/email text>');
            process.exitCode = 1;
            return;
        }
        printRecords(ledger.findByCustomer(query));
        return;
    }

    const reissueIdx = args.indexOf('--reissue');
    if (reissueIdx >= 0) {
        const licenseId = args[reissueIdx + 1];
        if (!licenseId) {
            console.error('Usage: node issue-license.js --reissue <licenseId>');
            process.exitCode = 1;
            return;
        }
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        _setupLineQueue();
        try {
            await runReissueFlow(licenseId);
        } finally {
            rl.close();
        }
        return;
    }

    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    _setupLineQueue();
    try {
        await runIssueFlow();
    } finally {
        rl.close();
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(`\nUnexpected error: ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = { verifyKeypairConsistency, validateMachineId, parseBatchCsv, runBatch, latestExpiry };
