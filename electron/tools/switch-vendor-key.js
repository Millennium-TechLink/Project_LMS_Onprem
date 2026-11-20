/**
 * switch-vendor-key.js  —  VENDOR TOOL — NOT SHIPPED IN APPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Points LicenseConstants.js's VENDOR_PUBLIC_KEY_PEM at a specific private
 * key file's public half. For two situations:
 *
 *   1. Intentionally building against an OLDER key - e.g. shipping an
 *      update to a customer whose existing install still trusts Key A,
 *      while day-to-day issuance has since moved on to Key B.
 *   2. Restoring back to the normal current key afterward.
 *
 * This edits a tracked, committed source file - review with `git diff`
 * before building or committing either direction.
 *
 * Usage:
 *   node onprem/electron/tools/switch-vendor-key.js <path-to-private-key.pem>
 *   node onprem/electron/tools/switch-vendor-key.js --active   (restore ACTIVE_KEY.txt's key)
 *   node onprem/electron/tools/switch-vendor-key.js --show     (identify the CURRENT key, no changes)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
    writePublicKeyToConstants, CONSTANTS_PATH, KEYS_DIR, ACTIVE_KEY_POINTER,
} = require('./KeyGenerator');
const { computeKeyFingerprint } = require('./LicenseIssuer');

function readCurrentPublicKeyPem() {
    const content = fs.readFileSync(CONSTANTS_PATH, 'utf8');
    const m = content.match(/const VENDOR_PUBLIC_KEY_PEM = `([\s\S]*?)`;/);
    if (!m) throw new Error(`Could not find VENDOR_PUBLIC_KEY_PEM in ${CONSTANTS_PATH}`);
    return m[1].trim();
}

/** Scans every .pem in KEYS_DIR and returns the one matching a fingerprint, or null. */
function findKeyFileByFingerprint(fingerprint) {
    if (!fs.existsSync(KEYS_DIR)) return null;
    for (const name of fs.readdirSync(KEYS_DIR)) {
        if (!name.endsWith('.pem')) continue;
        try {
            const pem = fs.readFileSync(path.join(KEYS_DIR, name), 'utf8');
            if (computeKeyFingerprint(pem) === fingerprint) return name;
        } catch { /* unreadable/corrupt file - skip */ }
    }
    return null;
}

function showCurrent() {
    const pubPem = readCurrentPublicKeyPem();
    const fingerprint = computeKeyFingerprint(pubPem);
    console.log(`Current VENDOR_PUBLIC_KEY_PEM fingerprint: ${fingerprint}`);
    const match = findKeyFileByFingerprint(fingerprint);
    if (match) {
        console.log(`Matches local private key file: ${path.join(KEYS_DIR, match)}`);
    } else {
        console.log(`No matching .pem found in ${KEYS_DIR}.`);
        console.log('The private key for this build may be archived elsewhere (HSM/vault),');
        console.log(`or check ${path.join(KEYS_DIR, 'KEY_INDEX.txt')} / git history for a lead.`);
    }
}

function switchTo(privateKeyPath) {
    if (!fs.existsSync(privateKeyPath)) {
        console.error(`File not found: ${privateKeyPath}`);
        process.exitCode = 1;
        return;
    }
    const privatePem = fs.readFileSync(privateKeyPath, 'utf8');
    let publicPem;
    try {
        publicPem = crypto.createPublicKey(crypto.createPrivateKey(privatePem))
            .export({ type: 'spki', format: 'pem' }).toString().trim();
    } catch (err) {
        console.error(`Not a valid private key PEM: ${err.message}`);
        process.exitCode = 1;
        return;
    }

    const before = computeKeyFingerprint(readCurrentPublicKeyPem());
    writePublicKeyToConstants(publicPem);
    const after = computeKeyFingerprint(publicPem);

    console.log(`Switched VENDOR_PUBLIC_KEY_PEM: ${before} -> ${after}`);
    console.log(`Source of truth: ${privateKeyPath}`);
    console.log(`\nReview with: git diff ${CONSTANTS_PATH}`);

    const activeFile = fs.existsSync(ACTIVE_KEY_POINTER) ? fs.readFileSync(ACTIVE_KEY_POINTER, 'utf8').trim() : null;
    const isActive = activeFile && path.resolve(path.join(KEYS_DIR, activeFile)) === path.resolve(privateKeyPath);
    if (!isActive) {
        console.log('\n⚠️  This is NOT the key in ACTIVE_KEY.txt.');
        console.log('   LicenseConstants.js now targets an OLDER/different key than day-to-day');
        console.log('   issuance uses. Do not run a normal build or issue a new license while');
        console.log('   in this state - only build the one thing you meant to build here.');
        console.log('   Restore afterward with: node onprem/electron/tools/switch-vendor-key.js --active');
    }
}

function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.error('Usage:');
        console.error('  node onprem/electron/tools/switch-vendor-key.js <path-to-private-key.pem>');
        console.error('  node onprem/electron/tools/switch-vendor-key.js --active');
        console.error('  node onprem/electron/tools/switch-vendor-key.js --show');
        process.exitCode = 1;
        return;
    }
    if (arg === '--show') return showCurrent();
    if (arg === '--active') {
        if (!fs.existsSync(ACTIVE_KEY_POINTER)) {
            console.error(`No ${ACTIVE_KEY_POINTER} found - run KeyGenerator.js first, or pass a key path directly.`);
            process.exitCode = 1;
            return;
        }
        const activeFile = fs.readFileSync(ACTIVE_KEY_POINTER, 'utf8').trim();
        return switchTo(path.join(KEYS_DIR, activeFile));
    }
    return switchTo(arg);
}

if (require.main === module) main();

module.exports = { showCurrent, switchTo, findKeyFileByFingerprint };
