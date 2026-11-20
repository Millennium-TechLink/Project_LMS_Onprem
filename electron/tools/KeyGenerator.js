/**
 * KeyGenerator.js  —  VENDOR TOOL — NOT SHIPPED IN APPLICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time utility to generate the ECDSA P-256 keypair used for license signing.
 *
 * Run ONCE by Millennium TechLink when setting up the signing infrastructure:
 *   node onprem/electron/tools/KeyGenerator.js
 *   node onprem/electron/tools/KeyGenerator.js --label "2026-relaunch"   (optional, own naming)
 *
 * Output:
 *   - PUBLIC KEY:  written directly into LicenseConstants.js → VENDOR_PUBLIC_KEY_PEM
 *   - PRIVATE KEY: written to vendor-data/keys/ (gitignored). Store securely
 *                  offline too. Used by LicenseIssuer.js to sign license files.
 *   - vendor-data/keys/ACTIVE_KEY.txt: points at this run's key file, so
 *     issue-license.js can suggest the right one instead of a stale guess.
 *
 * Security requirements:
 *   - The private key must be stored in a Hardware Security Module (HSM),
 *     encrypted vault, or at minimum an encrypted offline file.
 *   - Only authorised Millennium TechLink personnel may access the private key.
 *   - If the private key is compromised, generate a new keypair and re-issue
 *     all active licenses with the new key.
 *
 * This file is excluded from the electron-builder bundle via package.json
 * files exclusion pattern for onprem/electron/tools/.
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { computeKeyFingerprint } = require('./LicenseIssuer');

const CONSTANTS_PATH = path.join(__dirname, '..', 'license', 'LicenseConstants.js');
const PUBLIC_KEY_RE  = /const VENDOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/;

// Private keys live under vendor-data/keys/ (gitignored), not loose next to
// the scripts - keeps generated/sensitive artifacts out of onprem/electron/tools/.
const KEYS_DIR = path.join(__dirname, 'vendor-data', 'keys');
// Points at whichever key file currently matches LicenseConstants.js, so
// issue-license.js can suggest it instead of someone guessing/using a stale
// key (that mismatch has already caused a real activation failure before).
const ACTIVE_KEY_POINTER = path.join(KEYS_DIR, 'ACTIVE_KEY.txt');
// Append-only log of every key ever generated - ACTIVE_KEY.txt only tracks
// the CURRENT one, so once you rotate you'd otherwise lose track of which
// file/fingerprint an older, already-shipped build used. Never rewritten,
// only appended to - safe even if this run's constants-update fails partway.
const KEY_INDEX_PATH = path.join(KEYS_DIR, 'KEY_INDEX.txt');

/**
 * Writes the new public key into LicenseConstants.js in place of the old one.
 * Throws if the expected block isn't found, rather than silently no-op'ing.
 */
function writePublicKeyToConstants(publicKeyPem) {
    const content = fs.readFileSync(CONSTANTS_PATH, 'utf8');
    if (!PUBLIC_KEY_RE.test(content)) {
        throw new Error(
            `Could not find the VENDOR_PUBLIC_KEY_PEM block in ${CONSTANTS_PATH}. ` +
            `Update it manually with the public key printed above.`
        );
    }
    const replacement = `const VENDOR_PUBLIC_KEY_PEM = \`${publicKeyPem.trim()}\`;`;
    fs.writeFileSync(CONSTANTS_PATH, content.replace(PUBLIC_KEY_RE, replacement), 'utf8');
}

function _slugify(text) {
    const slug = String(text || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug.slice(0, 40);
}

function generateKeypair(label) {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║  LMS License Keypair Generator — Millennium TechLink      ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding:  { type: 'spki',   format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8',  format: 'pem' },
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const labelSuffix = label ? `-${_slugify(label)}` : '';

    // Write private key to a local file (never commit this)
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    const privateKeyPath = path.join(KEYS_DIR, `lms-private-key-${timestamp}${labelSuffix}.pem`);
    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });

    const fingerprint = computeKeyFingerprint(publicKey);

    console.log('✅  ECDSA P-256 keypair generated.\n');
    console.log('═══ PUBLIC KEY ═══════════════════════════════════════════\n');
    console.log(publicKey);
    console.log(`Fingerprint: ${fingerprint}  (not secret - identifies this keypair; write it on anything you archive)\n`);

    let constantsUpdated = false;
    try {
        writePublicKeyToConstants(publicKey);
        constantsUpdated = true;
        console.log(`✅  VENDOR_PUBLIC_KEY_PEM updated in: ${CONSTANTS_PATH}`);
        console.log('   Review the change (git diff) before committing.\n');

        // Only mark this key "active" once LicenseConstants.js actually
        // matches it - otherwise ACTIVE_KEY.txt would point at a key that
        // doesn't yet verify against anything built from this repo.
        fs.writeFileSync(ACTIVE_KEY_POINTER, path.basename(privateKeyPath), 'utf8');
        console.log(`✅  Marked as the active key: ${ACTIVE_KEY_POINTER}`);
        console.log('   issue-license.js will suggest this key automatically.\n');
    } catch (err) {
        console.log(`⚠️  Could not update LicenseConstants.js automatically: ${err.message}\n`);
    }

    // Append-only, so KEY_INDEX.txt is the permanent record of every key
    // ever generated even after several rotations - see README's "Which key
    // for which build" section for how this gets used.
    fs.appendFileSync(
        KEY_INDEX_PATH,
        `${new Date().toISOString()}  ${path.basename(privateKeyPath)}  fingerprint=${fingerprint}  label=${label || '-'}  setActive=${constantsUpdated}\n`,
        'utf8'
    );

    console.log('═══ PRIVATE KEY FILE ═══════════════════════════════════════\n');
    console.log(`Saved to: ${privateKeyPath}`);
    console.log('\n⚠️  IMPORTANT:');
    if (!constantsUpdated) {
        console.log('   1. Copy the PUBLIC KEY above into:');
        console.log('      onprem/electron/license/LicenseConstants.js → VENDOR_PUBLIC_KEY_PEM');
    } else {
        console.log('   1. LicenseConstants.js was updated automatically - review it with');
        console.log('      `git diff onprem/electron/license/LicenseConstants.js` before committing.');
    }
    console.log('   2. For anything beyond internal/dev use, also copy the PRIVATE KEY');
    console.log('      file to a Hardware Security Module or an encrypted offline vault.');
    console.log('   3. Keep this local copy too - do NOT delete it after rotating away');
    console.log('      from it. Any build made while it was active still needs it for');
    console.log('      future renewals. See README.md "Which key for which build".');
    console.log('   4. NEVER commit the private key to git or any VCS.');
    console.log('   5. NEVER share the private key via email or chat.');
    console.log('\n   If the private key is lost, you cannot issue new licenses');
    console.log('   without generating a new keypair and re-issuing all licenses.\n');

    return { privateKeyPath, publicKey, fingerprint, constantsUpdated };
}

if (require.main === module) {
    const _labelIdx = process.argv.indexOf('--label');
    generateKeypair(_labelIdx >= 0 ? process.argv[_labelIdx + 1] : null);
}

module.exports = {
    generateKeypair, writePublicKeyToConstants,
    CONSTANTS_PATH, PUBLIC_KEY_RE, KEYS_DIR, ACTIVE_KEY_POINTER, KEY_INDEX_PATH,
};
