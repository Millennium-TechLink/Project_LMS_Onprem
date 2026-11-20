/**
 * LicenseLedger.js  —  VENDOR TOOL — NOT SHIPPED IN APPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Local record of every license this vendor has issued via issue-license.js.
 * Never committed (contains customer PII — see .gitignore) and never read by
 * the application itself; this is bookkeeping for whoever issues licenses,
 * so a lookup or a reissue doesn't require digging through old emails.
 *
 * One JSON array, one record per license issued. Not a database - fine for
 * the volume a small vendor team issues by hand.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LEDGER_PATH = path.join(__dirname, 'vendor-data', 'license-ledger.json');

/**
 * @param {string} [ledgerPath]
 * @returns {object[]} All records, or [] if the ledger is missing/corrupt.
 */
function loadLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
    try {
        if (!fs.existsSync(ledgerPath)) return [];
        const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Atomic write: write to .tmp then rename, same pattern LicenseStorage.js
 * uses for the app's own runtime files.
 * @param {object[]} records
 * @param {string} [ledgerPath]
 */
function saveLedger(records, ledgerPath = DEFAULT_LEDGER_PATH) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const tmpPath = ledgerPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmpPath, ledgerPath);
}

/**
 * Append one issuance record.
 * @param {object} record
 * @param {string} [ledgerPath]
 */
function appendRecord(record, ledgerPath = DEFAULT_LEDGER_PATH) {
    const records = loadLedger(ledgerPath);
    records.push(record);
    saveLedger(records, ledgerPath);
    return records;
}

/**
 * @param {string} licenseId
 * @param {string} [ledgerPath]
 * @returns {object|null}
 */
function findByLicenseId(licenseId, ledgerPath = DEFAULT_LEDGER_PATH) {
    return loadLedger(ledgerPath).find(r => r.licenseId === licenseId) || null;
}

/**
 * Case-insensitive substring match against customer/company/email.
 * @param {string} query
 * @param {string} [ledgerPath]
 * @returns {object[]}
 */
function findByCustomer(query, ledgerPath = DEFAULT_LEDGER_PATH) {
    const q = query.toLowerCase();
    return loadLedger(ledgerPath).filter(r =>
        String(r.customer || '').toLowerCase().includes(q) ||
        String(r.company  || '').toLowerCase().includes(q) ||
        String(r.email    || '').toLowerCase().includes(q)
    );
}

module.exports = {
    DEFAULT_LEDGER_PATH,
    loadLedger,
    saveLedger,
    appendRecord,
    findByLicenseId,
    findByCustomer,
};
