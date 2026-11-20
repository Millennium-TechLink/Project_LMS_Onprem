/**
 * LicenseIssuer.js  —  VENDOR TOOL — NOT SHIPPED IN APPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates signed license files (.lic) and activation key strings for customers.
 *
 * This tool runs ONLY on the vendor's secure machine (Millennium TechLink).
 * It holds the PRIVATE key and produces signatures that the application verifies
 * using the PUBLIC key embedded in LicenseConstants.js.
 *
 * Usage:
 *   node onprem/electron/tools/LicenseIssuer.js \
 *     --privateKey ./lms-private-key.pem \
 *     --machineId  A3F9B2C1D4E5 \
 *     --type       PERMANENT \
 *     --expiry     NEVER \
 *     --customer   "Shruti Nimbarkar" \
 *     --company    "Millennium TechLink" \
 *     --email      "shruti@company.com"
 *
 * Outputs:
 *   - license_LICENSEID.lic  — JSON file to email to customer
 *   - Activation key string  — Base64 for copy-paste delivery
 *
 * This file is excluded from the electron-builder bundle via package.json.
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

/**
 * Generate a signed license envelope.
 *
 * @param {object} opts
 * @param {string} opts.privateKeyPem  - PEM string of the vendor ECDSA private key
 * @param {string} opts.machineId      - Target machine ID (or '*' for floating)
 * @param {string} opts.licenseType    - One of: TRIAL, PERMANENT, SUBSCRIPTION, ENTERPRISE, ANNUAL
 * @param {string} opts.expiryDate     - ISO date string or 'NEVER'
 * @param {string} [opts.licenseId]    - UUID (generated if omitted)
 * @param {object} [opts.customer]     - { name, company, email }
 * @param {string} [opts.edition]      - License edition label
 * @param {string[]} [opts.features]   - Feature flags enabled
 * @param {number} [opts.gracePeriodDays] - Days past expiry before hard block
 * @param {number} [opts.activationWindowDays] - Days within which activation must occur
 * @param {number} [opts.licenseDurationDays] - Total license validity days (used if expiryDate is computed)
 * @param {string} [opts.licenseStartMode] - 'FIRST_ACTIVATION' or 'ISSUE_DATE'
 * @returns {{ envelope: object, licFile: string, activationKey: string }}
 */
function issueLicense(opts) {
    const {
        privateKeyPem,
        machineId,
        licenseType,
        expiryDate,
        licenseId    = crypto.randomUUID(),
        customer     = {},
        edition      = null,
        features     = [],
        gracePeriodDays = 0,
        activationWindowDays = null,
        licenseDurationDays  = null,
        licenseStartMode     = 'FIRST_ACTIVATION',
        issueTimestampUtc: providedIssueTimestampUtc = null,
    } = opts;

    if (!privateKeyPem) throw new Error('privateKeyPem is required');
    if (!machineId)     throw new Error('machineId is required');
    if (!licenseType)   throw new Error('licenseType is required');
    if (!expiryDate)    throw new Error('expiryDate is required');

    let issueTimestampUtc;
    if (providedIssueTimestampUtc) {
        const timestamp = Date.parse(providedIssueTimestampUtc);
        if (Number.isNaN(timestamp) || !providedIssueTimestampUtc.endsWith('Z')) {
            throw new Error(`Invalid issueTimestampUtc: must be a valid ISO-8601 UTC timestamp ending in Z. Got: ${providedIssueTimestampUtc}`);
        }
        issueTimestampUtc = new Date(timestamp).toISOString();
    } else {
        issueTimestampUtc = new Date().toISOString();
    }
    const issueDateObj = new Date(issueTimestampUtc);

    // ── Resolve expiry as a full UTC ISO timestamp ─────────────────────────
    // Backward-compat: if caller passed a bare date (YYYY-MM-DD), interpret
    // it as 23:59:59 UTC on that day so the customer gets the full last day.
    let resolvedExpiry = expiryDate;
    if (expiryDate !== 'NEVER') {
        const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(expiryDate);
        if (bareDate) {
            resolvedExpiry = `${expiryDate}T23:59:59Z`;
        }
    }

    // ── Activation Window calculation ──────────────────────────────────────
    // If activationWindowDays is provided, calculate activationDeadlineUtc.
    // This is the UTC timestamp by which the license MUST be activated.
    // After this deadline, activation is rejected with ACTIVATION_WINDOW_EXPIRED.
    let activationDeadlineUtc = null;
    if (activationWindowDays !== null && activationWindowDays > 0) {
        const deadlineDate = new Date(issueDateObj.getTime() + activationWindowDays * 24 * 60 * 60 * 1000);
        activationDeadlineUtc = deadlineDate.toISOString();
    }

    // ── Build the licenseBlock (everything the application trusts) ─────────
    // issueTimestampUtc is the authoritative "not-before" time.
    // It is set from the vendor's machine clock at issuance time.
    // It is inside the signed payload — any modification invalidates the sig.
    //
    // New fields (Phase 3 — Activation Window):
    //   issueTimestampUtc      — UTC ISO, inside signature: cannot be forged
    //   activationWindowDays   — Number of days to activate (or null)
    //   activationDeadlineUtc  — Computed UTC deadline (or null)
    //   licenseDurationDays    — Total validity period in days (or null if NEVER)
    //   licenseStartMode       — FIRST_ACTIVATION or ISSUE_DATE
    const licenseBlock = {
        schemaVersion:    2,
        licenseId,
        licenseType,
        expiryDate:       resolvedExpiry,
        issueTimestampUtc,
        issuedAt:         issueTimestampUtc,  // kept for backward compat (same value)
        issuedBy:         'LicenseIssuer/3.0-ActivationWindow',
        machineId,
        installDate:      issueTimestampUtc,
        status:           'ACTIVE',
        createdAt:        issueTimestampUtc,
        gracePeriodDays,
        // ── Activation Window fields (Phase 3) ────────────────────────────
        activationWindowDays:  activationWindowDays ?? null,
        activationDeadlineUtc: activationDeadlineUtc,
        licenseDurationDays:   licenseDurationDays ?? null,
        licenseStartMode:      licenseStartMode,
        // ──────────────────────────────────────────────────────────────────
        customer: {
            name:    customer.name    || '',
            company: customer.company || '',
            email:   customer.email   || '',
        },
        product: {
            name:    'Lab Management System',
            edition: edition || licenseType,
            features,
        },
    };

    // ── Sign licenseBlock with ECDSA P-256 private key ─────────────────────
    // Canonical JSON: keys sorted alphabetically for stable serialisation.
    const canonical     = JSON.stringify(licenseBlock, Object.keys(licenseBlock).sort());
    const sigBuffer     = crypto.sign('SHA256', Buffer.from(canonical, 'utf8'), {
        key:         privateKeyPem,
        dsaEncoding: 'der',
    });
    const vendorSignature = sigBuffer.toString('base64');

    // ── Assemble the full envelope ─────────────────────────────────────────
    const envelope = {
        formatVersion:   1,
        licenseBlock,
        vendorSignature,
        // runtimeBlock and runtimeHmac are written by the application on first activation.
        // They are NOT present in the issued file — the app adds them.
    };

    // ── Produce output formats ─────────────────────────────────────────────
    const licFile       = JSON.stringify(envelope, null, 2);
    
    // ── Generate a unique, formatted activation key ─────────────────────────
    // Format: LMS-[VERSION]-[CHECKSUM]-[BASE64_PAYLOAD]
    // Example: LMS-V1-A7F2-eyJmb3JtYXRWZXJzaW9uIjoxLCJs...
    //
    // This format provides:
    //   1. Prefix "LMS-" for easy identification
    //   2. Version marker "V1" for format versioning
    //   3. 4-char checksum for quick validation (CRC16)
    //   4. Base64 payload (the actual signed envelope)
    //
    // Benefits:
    //   - Instantly recognizable as an LMS activation key
    //   - Checksum catches typos before full decoding
    //   - Version allows future format changes
    //   - Still contains the full ECDSA-signed envelope
    const activationKey = _formatActivationKey(licFile);

    return { envelope, licFile, activationKey };
}

/**
 * Format a license envelope as a unique, verifiable activation key.
 * 
 * Format: LMS-V1-[CHECKSUM]-[BASE64]
 * 
 * @param {string} licFileJson - JSON string of the license envelope
 * @returns {string} Formatted activation key
 */
function _formatActivationKey(licFileJson) {
    const base64Payload = Buffer.from(licFileJson, 'utf8').toString('base64');
    
    // Compute CRC16 checksum for quick validation
    const checksum = _computeCRC16(licFileJson);
    const checksumHex = checksum.toString(16).toUpperCase().padStart(4, '0');
    
    // Format: LMS-V1-XXXX-[base64]
    return `LMS-V1-${checksumHex}-${base64Payload}`;
}

/**
 * Compute CRC16-CCITT checksum for quick validation.
 * Used to catch typos/corruption before full ECDSA verification.
 * 
 * @param {string} data - Input data
 * @returns {number} 16-bit checksum
 */
// ── Issued-license output location + naming ────────────────────────────────
// All generated vendor artifacts (private keys, issued .lic files, the
// ledger) live under this one gitignored folder, not scattered loose next to
// the tool scripts themselves.
const VENDOR_DATA_DIR    = path.join(__dirname, 'vendor-data');
const ISSUED_LICENSES_DIR = path.join(VENDOR_DATA_DIR, 'issued-licenses');

function _slugify(text) {
    const slug = String(text || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (slug || 'Unassigned').slice(0, 40);
}

/**
 * Filename that identifies a license at a glance: date, machine, type, a
 * name segment, and a short license-ID suffix for uniqueness -
 * `2026-09-08_FD41-F5DD-F0C0_PERMANENT_Millennium-Techlink_96e61d01.lic`.
 * Shared by LicenseIssuer.js's own CLI and issue-license.js so both tools
 * write into the same place with the same convention.
 *
 * @param {object} envelope - from issueLicense()
 * @param {object} [customer] - { name, company }
 * @param {object} [opts]
 * @param {string} [opts.label] - user-chosen name segment, overrides the
 *   auto customer/company slug (whoever is issuing knows their own labeling
 *   scheme better than an auto-derived one). licenseId suffix still keeps
 *   filenames unique even if the same label is reused across issuances.
 * @returns {string} full path, with ISSUED_LICENSES_DIR already created
 */
function buildLicenseOutputPath(envelope, customer = {}, opts = {}) {
    fs.mkdirSync(ISSUED_LICENSES_DIR, { recursive: true });
    const block = envelope.licenseBlock;
    const dateStr = (block.issueTimestampUtc || new Date().toISOString()).slice(0, 10);
    const machinePart = block.machineId === '*' ? 'WILDCARD' : block.machineId;
    const who = _slugify(opts.label || customer.name || customer.company);
    const shortId = String(block.licenseId).split('-')[0];
    const filename = `${dateStr}_${machinePart}_${block.licenseType}_${who}_${shortId}.lic`;
    return path.join(ISSUED_LICENSES_DIR, filename);
}

/**
 * Short, stable identifier for a keypair - always derived from the PUBLIC
 * half, so a private key file and its matching VENDOR_PUBLIC_KEY_PEM produce
 * the same fingerprint. Used to record which key signed a license (so a
 * renewal years later can look up the right key instead of guessing) and to
 * label generated keys. Not secret - safe to print/log/commit.
 *
 * @param {string} pem - a private OR public key PEM
 * @returns {string} 12 hex chars
 */
function computeKeyFingerprint(pem) {
    const priv = /BEGIN (EC )?PRIVATE KEY/.test(pem);
    const publicKeyObj = priv ? crypto.createPublicKey(crypto.createPrivateKey(pem)) : crypto.createPublicKey(pem);
    const publicPem = publicKeyObj.export({ type: 'spki', format: 'pem' }).toString().trim();
    return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 12);
}

function _computeCRC16(data) {
    let crc = 0xFFFF;
    const polynomial = 0x1021;
    
    for (let i = 0; i < data.length; i++) {
        crc ^= (data.charCodeAt(i) << 8);
        for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ polynomial) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    
    return crc;
}

/**
 * CLI entry point.
 */
function main() {
    const args = process.argv.slice(2);
    const get  = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 ? args[idx + 1] : null;
    };

    const privateKeyPath       = get('--privateKey');
    const machineId            = get('--machineId');
    const licenseType          = get('--type') || 'PERMANENT';
    const expiryDate           = get('--expiry') || 'NEVER';
    const customerName         = get('--customer');
    const company              = get('--company');
    const email                = get('--email');
    const activationWindowDays = get('--activationWindowDays');
    const licenseDurationDays  = get('--licenseDurationDays');
    const issueTimestampUtcStr = get('--issueTimestampUtc');
    const issueTimestampIstStr = get('--issueTimestampIst');
    const label                = get('--label');

    if (!privateKeyPath || !machineId) {
        console.error('Usage: node LicenseIssuer.js --privateKey <path> --machineId <id> [options]');
        console.error('');
        console.error('Required:');
        console.error('  --privateKey <path>       Path to vendor private key PEM file');
        console.error('  --machineId <id>          Target machine ID (XXXX-XXXX-XXXX format or "*")');
        console.error('');
        console.error('Options:');
        console.error('  --type <type>             License type: PERMANENT|TRIAL|SUBSCRIPTION|ENTERPRISE|ANNUAL (default: PERMANENT)');
        console.error('  --expiry <date>           Expiry date: NEVER or ISO date (YYYY-MM-DD) (default: NEVER)');
        console.error('  --customer <name>         Customer name');
        console.error('  --company <name>          Company name');
        console.error('  --email <email>           Customer email');
        console.error('  --label <text>            Name segment for the .lic filename (default: customer/company)');
        console.error('  --activationWindowDays <days>  Days within which the license must be activated (default: 7)');
        console.error('  --licenseDurationDays <days>   Total validity days (used with FIRST_ACTIVATION mode)');
        console.error('  --issueTimestampUtc <iso>      Exact issue timestamp in UTC (e.g. 2026-08-13T10:00:00Z)');
        console.error('  --issueTimestampIst <date>     Exact issue timestamp in IST (e.g. "2026-08-13 11:30")');
        console.error('');
        console.error('IMPORTANT: --machineId must be in XXXX-XXXX-XXXX format');
        console.error('  (e.g. A89B-1886-1FF1) — exactly as shown in the activation dialog.');
        console.error('');
        console.error('Activation Window:');
        console.error('  If --activationWindowDays is specified, the generated license can ONLY be');
        console.error('  activated within that many days from the issue date. After the deadline,');
        console.error('  activation will be rejected.');
        console.error('');
        console.error('  Example: --activationWindowDays 5');
        console.error('    Issued: 2026-08-10 10:00:00 UTC');
        console.error('    Deadline: 2026-08-15 10:00:00 UTC');
        console.error('    Customer must activate before the deadline.');
        process.exit(1);
    }

    // ── Validate machineId format ─────────────────────────────────────────────
    // The single Machine ID format is XXXX-XXXX-XXXX (4-4-4 uppercase hex with dashes).
    // Wildcard '*' is also accepted for enterprise floating licenses.
    const MACHINE_ID_PATTERN = /^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$/;

    if (machineId !== '*' && !MACHINE_ID_PATTERN.test(machineId)) {
        console.error('\n❌  ERROR: Invalid --machineId format.');
        console.error('   Expected: XXXX-XXXX-XXXX (e.g. A89B-1886-1FF1)');
        console.error('   Got:', machineId);
        console.error('');
        console.error('   Copy the Machine ID exactly as shown in the activation dialog.');
        process.exit(1);
    }

    if (issueTimestampUtcStr && issueTimestampIstStr) {
        console.error('\n❌  ERROR: Cannot specify both --issueTimestampUtc and --issueTimestampIst.');
        console.error('   Please provide only one.');
        process.exit(1);
    }

    let parsedIssueTimestampUtc = null;
    if (issueTimestampUtcStr) {
        const timestamp = Date.parse(issueTimestampUtcStr);
        if (Number.isNaN(timestamp) || !issueTimestampUtcStr.endsWith('Z')) {
            console.error('\n❌  ERROR: --issueTimestampUtc must be a valid ISO-8601 UTC timestamp (e.g. 2026-08-13T10:00:00Z).');
            console.error('   Got:', issueTimestampUtcStr);
            process.exit(1);
        }
        parsedIssueTimestampUtc = new Date(timestamp).toISOString();
    } else if (issueTimestampIstStr) {
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(issueTimestampIstStr)) {
            console.error('\n❌  ERROR: --issueTimestampIst must be in the format YYYY-MM-DD HH:mm (e.g. "2026-08-13 11:30").');
            console.error('   Got:', issueTimestampIstStr);
            process.exit(1);
        }
        const isoWithOffset = issueTimestampIstStr.replace(' ', 'T') + '+05:30';
        const timestamp = Date.parse(isoWithOffset);
        if (Number.isNaN(timestamp)) {
            console.error('\n❌  ERROR: Invalid date/time provided for --issueTimestampIst.');
            console.error('   Got:', issueTimestampIstStr);
            process.exit(1);
        }
        parsedIssueTimestampUtc = new Date(timestamp).toISOString();
    }

    const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');

    // ── Verify private key matches the embedded public key ────────────────────
    // This catches the most common deployment error: using a stale private key
    // after the public key in LicenseConstants.js has been rotated.
    // We do a sign+verify roundtrip with a known test payload.
    try {
        const { VENDOR_PUBLIC_KEY_PEM, ECDSA_ALGORITHM } = require('../license/LicenseConstants');
        const testPayload = Buffer.from('keypair-consistency-check', 'utf8');
        const testSig     = crypto.sign(ECDSA_ALGORITHM, testPayload, {
            key: privateKeyPem, dsaEncoding: 'der',
        });
        const consistent  = crypto.verify(ECDSA_ALGORITHM, testPayload, {
            key: VENDOR_PUBLIC_KEY_PEM, dsaEncoding: 'der',
        }, testSig);

        if (!consistent) {
            console.error('\n❌  KEYPAIR MISMATCH ERROR');
            console.error('   The private key in:', privateKeyPath);
            console.error('   does NOT match the VENDOR_PUBLIC_KEY_PEM embedded in LicenseConstants.js.');
            console.error('');
            console.error('   Any license issued with this private key will fail with:');
            console.error('   "Activation key signature is invalid."');
            console.error('');
            console.error('   This happens when the public key is rotated (LicenseConstants.js updated)');
            console.error('   but the old private key is used for signing.');
            console.error('');
            console.error('   Fix options:');
            console.error('   A) Use the private key that matches the current LicenseConstants.js:');
            console.error('      The correct private key was generated alongside the current public key.');
            console.error('   B) If the correct private key is lost, generate a new keypair:');
            console.error('      node onprem/electron/tools/KeyGenerator.js');
            console.error('      Then update VENDOR_PUBLIC_KEY_PEM in LicenseConstants.js');
            console.error('      and re-issue all existing licenses.');
            process.exit(1);
        }

        console.log('✓  Private key / public key consistency: OK');
    } catch (err) {
        console.error('\n❌  KEYPAIR VERIFICATION ERROR:', err.message);
        console.error('   Could not verify the private key. Check the key file format.');
        process.exit(1);
    }

    // ── Parse activation window days ──────────────────────────────────────────
    const { DEFAULT_ACTIVATION_WINDOW_DAYS } = require('../license/LicenseConstants');
    let parsedActivationWindowDays = activationWindowDays
        ? parseInt(activationWindowDays, 10)
        : DEFAULT_ACTIVATION_WINDOW_DAYS;

    if (Number.isNaN(parsedActivationWindowDays) || parsedActivationWindowDays < 1) {
        console.error('\n❌  ERROR: --activationWindowDays must be a positive integer.');
        console.error('   Got:', activationWindowDays);
        process.exit(1);
    }

    // ── Parse license duration days ───────────────────────────────────────────
    let parsedLicenseDurationDays = null;
    if (licenseDurationDays) {
        parsedLicenseDurationDays = parseInt(licenseDurationDays, 10);
        if (Number.isNaN(parsedLicenseDurationDays) || parsedLicenseDurationDays < 1) {
            console.error('\n❌  ERROR: --licenseDurationDays must be a positive integer.');
            console.error('   Got:', licenseDurationDays);
            process.exit(1);
        }
    }

    const { licFile, activationKey, envelope } = issueLicense({
        privateKeyPem,
        machineId,
        licenseType,
        expiryDate,
        customer: { name: customerName, company, email },
        activationWindowDays: parsedActivationWindowDays,
        licenseDurationDays:  parsedLicenseDurationDays,
        licenseStartMode:     'FIRST_ACTIVATION',
        issueTimestampUtc:    parsedIssueTimestampUtc,
    });

    const outFile = buildLicenseOutputPath(envelope, { name: customerName, company }, { label });
    fs.writeFileSync(outFile, licFile, 'utf8');

    // Extract key format components for display
    const keyMatch = activationKey.match(/^LMS-V(\d+)-([0-9A-F]{4})-(.+)$/);
    const keyVersion = keyMatch ? keyMatch[1] : '?';
    const keyChecksum = keyMatch ? keyMatch[2] : '?';

    console.log('\n✅  License issued successfully.\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    LICENSE DETAILS                            ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║ Machine ID           : ${machineId.padEnd(37)} ║`);
    console.log(`║ License ID           : ${envelope.licenseBlock.licenseId.padEnd(37)} ║`);
    console.log(`║ License Type         : ${licenseType.padEnd(37)} ║`);
    console.log(`║ Expiry Date          : ${expiryDate.padEnd(37)} ║`);
    console.log(`║ Issue Timestamp (UTC): ${envelope.licenseBlock.issueTimestampUtc.padEnd(37)} ║`);
    console.log(`║ Activation Window    : ${(parsedActivationWindowDays + ' days').padEnd(37)} ║`);
    if (envelope.licenseBlock.activationDeadlineUtc) {
        console.log(`║ Activation Deadline  : ${envelope.licenseBlock.activationDeadlineUtc.padEnd(37)} ║`);
    }
    if (parsedLicenseDurationDays) {
        console.log(`║ License Duration     : ${(parsedLicenseDurationDays + ' days').padEnd(37)} ║`);
    }
    console.log(`║ License Start Mode   : ${envelope.licenseBlock.licenseStartMode.padEnd(37)} ║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');
    
    console.log('📄 License file saved to:');
    console.log(`   ${outFile}\n`);
    
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║              ACTIVATION KEY (Copy & Paste)                    ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║ Format  : LMS-V${keyVersion}-[Checksum]-[Payload]                        ║`);
    console.log(`║ Version : V${keyVersion}                                                   ║`);
    console.log(`║ Checksum: ${keyChecksum} (CRC16 - validates integrity)              ║`);
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    
    // Display the key with word wrapping for readability
    const keyLines = activationKey.match(/.{1,61}/g) || [activationKey];
    keyLines.forEach((line, idx) => {
        if (idx === 0) {
            console.log(`║ ${line.padEnd(61)} ║`);
        } else {
            console.log(`║ ${line.padEnd(61)} ║`);
        }
    });
    
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');
    
    console.log('📋 Instructions:');
    console.log('   1. Email the .lic file to the customer (preferred method)');
    console.log('   2. OR copy the activation key above for manual entry');
    console.log('   3. Customer can use either method to activate\n');
    
    console.log('🔐 Security:');
    console.log('   • Key is ECDSA P-256 signed (cannot be forged)');
    console.log('   • CRC16 checksum detects typos instantly');
    console.log('   • Machine-bound (only works on target machine)');
    console.log(`   • Valid until: ${envelope.licenseBlock.activationDeadlineUtc || 'N/A'}\n`);
}

// Export for unit testing and programmatic use
module.exports = { issueLicense, buildLicenseOutputPath, computeKeyFingerprint, VENDOR_DATA_DIR, ISSUED_LICENSES_DIR };

// Run CLI if called directly
if (require.main === module) {
    main();
}
