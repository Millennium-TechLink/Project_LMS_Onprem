/**
 * CryptoService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all vendor-side cryptographic operations.
 *
 * Responsibilities:
 *   1. Canonical JSON serialisation of license payloads (stable across all
 *      Node.js versions — keys sorted alphabetically).
 *   2. ECDSA vendor signature verification (public key only — application can
 *      NEVER sign; the private key exists only in onprem/electron/tools/).
 *   3. Future signature algorithm dispatch (add new algorithm here, not in
 *      callers).
 *
 * This module is deliberately narrow:
 *   - No I/O, no UI, no side effects.
 *   - Pure functions: same input always produces same output.
 *   - No HMAC / runtime-state operations (those remain in LicenseValidator).
 *
 * Why this module exists:
 *   LicenseValidator.validate() and ActivationService._validateEnvelope() both
 *   verify the vendor ECDSA signature. Having two independent implementations
 *   of the same cryptographic operation creates an operational risk: if the
 *   algorithm or canonicalisation ever changes, both must be updated in sync.
 *   Missing one produces a silent asymmetry where activation accepts what
 *   startup rejects (or vice versa). This module eliminates that class of defect.
 *
 * Callers:
 *   LicenseValidator.verifyVendorSignature()  → delegates here
 *   ActivationService._verifyEcdsaSignature() → delegates here
 *   LicenseIssuer.js (signing tool)           → uses crypto.sign directly
 *     (intentional: the tool is offline-only and does not ship in the app)
 */

'use strict';

const crypto = require('crypto');
const {
    ECDSA_ALGORITHM,
    VENDOR_PUBLIC_KEY_PEM,
} = require('./LicenseConstants');

/**
 * Produce the canonical JSON string for a license block.
 *
 * Canonicalisation rule: JSON.stringify with all top-level keys sorted
 * alphabetically. This is the same rule used by LicenseIssuer.js at signing
 * time and must never change without re-issuing all existing licenses.
 *
 * Note: only top-level keys are sorted. Nested objects (customer, product)
 * are serialised in their natural insertion order. LicenseIssuer.js does the
 * same, so the canonical string is stable.
 *
 * @param {object} licenseBlock - The vendor-provided license data object
 * @returns {string} Canonical JSON string
 */
function canonicalise(licenseBlock) {
    return JSON.stringify(licenseBlock, Object.keys(licenseBlock).sort());
}

/**
 * Verify an ECDSA P-256 / SHA-256 signature over a license block.
 *
 * This is the primary cryptographic security boundary of the entire licensing
 * system. The application holds ONLY the public key. It can verify but never
 * forge a vendor signature.
 *
 * Algorithm:
 *   1. Canonicalise licenseBlock → stable UTF-8 JSON string
 *   2. Decode vendorSignature from Base64 → DER bytes
 *   3. Run crypto.verify(SHA256, payload, publicKey, signature)
 *
 * Returns false (never throws) on any failure — malformed input, wrong key,
 * tampered payload, or Node.js crypto error.
 *
 * @param {object} licenseBlock    - The license payload object to verify
 * @param {string} vendorSignature - Base64-encoded DER signature from vendor
 * @returns {boolean} true if and only if the signature is valid
 */
function verifyVendorSignature(licenseBlock, vendorSignature) {
    try {
        if (!licenseBlock || !vendorSignature) return false;

        const canonical  = canonicalise(licenseBlock);
        const sigBuffer  = Buffer.from(vendorSignature, 'base64');

        return crypto.verify(
            ECDSA_ALGORITHM,
            Buffer.from(canonical, 'utf8'),
            {
                key:         VENDOR_PUBLIC_KEY_PEM,
                dsaEncoding: 'der',
            },
            sigBuffer
        );
    } catch {
        return false;
    }
}

module.exports = { canonicalise, verifyVendorSignature };
