/**
 * ActivationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles license activation workflows.
 *
 * Security model:
 *   - The vendor generates and signs license files/keys using the PRIVATE key
 *     stored only in onprem/electron/tools/LicenseIssuer.js (never shipped in app).
 *   - This class uses ONLY the PUBLIC key (embedded in LicenseConstants) to
 *     VERIFY signatures. It can never generate valid vendor signatures.
 *   - ECDSA P-256 / SHA-256: equivalent to RSA-3072 security, shorter keys,
 *     fully supported by Node.js built-in crypto — no npm dependencies.
 *
 * Activation formats supported:
 *   A. License file import (.lic):
 *      activateFromFile(fileContents, machineId)
 *      The .lic file is a JSON envelope: { licenseBlock, vendorSignature, ... }
 *      This is the preferred method — no paste errors, binary-safe.
 *
 *   B. Activation key string:
 *      activateOffline(keyString, machineId)
 *      Base64-encoded JSON of the same envelope — for email delivery.
 *      activateFromFile() is called internally after decode.
 *
 * Strategy pattern:
 *   Future activation methods (online, USB dongle, license server) are added
 *   as new methods on this class. LicenseManager.activate() dispatches to them
 *   without knowing the implementation details.
 *
 * @typedef {Object} ActivationResult
 * @property {boolean}     success
 * @property {string}      message
 * @property {object|null} licenseData  - Parsed activation data on success
 */

'use strict';

const {
    LICENSE_TYPES,
    LICENSE_STATUS,
} = require('./LicenseConstants');
const { verifyVendorSignature } = require('./CryptoService');

class ActivationService {

    // ════════════════════════════════════════════════════════════════════════
    // Public activation methods
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Activate from a .lic file's contents (preferred method).
     *
     * The file content is a JSON string containing:
     *   {
     *     formatVersion:   number,
     *     licenseBlock:    { machineId, licenseType, expiryDate, issuedAt,
     *                        licenseId, schemaVersion, ... },
     *     vendorSignature: string,   ← ECDSA P-256 Base64 DER signature
     *   }
     *
     * @param {string} fileContents  - UTF-8 content of the .lic file
     * @param {string} machineId     - Current machine's ID
     * @returns {ActivationResult}
     */
    activateFromFile(fileContents, machineId) {
        if (!fileContents || typeof fileContents !== 'string') {
            return { success: false, message: 'License file content is empty.', licenseData: null };
        }

        // ── Step 1: Parse JSON ──────────────────────────────────────────────
        let envelope;
        try {
            envelope = JSON.parse(fileContents.trim());
        } catch {
            return {
                success:     false,
                message:     'License file is not valid JSON. The file may be corrupted.',
                licenseData: null,
            };
        }

        return this._validateEnvelope(envelope, machineId);
    }

    /**
     * Activate from a Base64-encoded key string (fallback method).
     *
     * Now supports two formats:
     *   1. New format: LMS-V1-XXXX-[base64]  (with checksum verification)
     *   2. Legacy format: Plain Base64 JSON   (backward compatibility)
     *
     * The new format provides:
     *   - Instant identification (LMS- prefix)
     *   - Quick checksum validation (catches typos)
     *   - Version tracking (V1, V2, etc.)
     *   - Full ECDSA signature verification
     *
     * @param {string} activationKey  - Formatted activation key or legacy Base64
     * @param {string} machineId
     * @returns {ActivationResult}
     */
    activateOffline(activationKey, machineId) {
        if (!activationKey || typeof activationKey !== 'string') {
            return { success: false, message: 'Activation key is required.', licenseData: null };
        }

        const trimmed = activationKey.trim().replace(/\s+/g, '');

        // ── Step 1: Detect and parse key format ─────────────────────────────
        let envelope;
        
        // Check for new LMS-V1-XXXX-[base64] format
        if (trimmed.startsWith('LMS-')) {
            const parseResult = this._parseFormattedKey(trimmed);
            if (!parseResult.success) {
                return {
                    success:     false,
                    message:     parseResult.message,
                    licenseData: null,
                };
            }
            envelope = parseResult.envelope;
        } else {
            // Legacy format: plain Base64
            try {
                const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
                envelope      = JSON.parse(decoded);
            } catch {
                return {
                    success:     false,
                    message:     'Invalid activation key format. The key could not be decoded. Please check for typos or request a new key.',
                    licenseData: null,
                };
            }
        }

        return this._validateEnvelope(envelope, machineId);
    }

    /**
     * Parse a formatted activation key (LMS-V1-XXXX-[base64]).
     * 
     * @param {string} keyString - Formatted key
     * @returns {{ success: boolean, message?: string, envelope?: object }}
     */
    _parseFormattedKey(keyString) {
        // Format: LMS-V1-XXXX-[base64]
        const pattern = /^LMS-V(\d+)-([0-9A-F]{4})-(.+)$/i;
        const match = keyString.match(pattern);
        
        if (!match) {
            return {
                success: false,
                message: 'Invalid activation key format. Expected format: LMS-V1-XXXX-[key]. Please verify you copied the complete key.',
            };
        }
        
        const [, version, checksumHex, base64Payload] = match;
        
        // ── Step 1: Validate version ────────────────────────────────────────
        if (version !== '1') {
            return {
                success: false,
                message: `Unsupported activation key version: V${version}. This version of the application only supports V1 keys. Please update the application or contact support.`,
            };
        }
        
        // ── Step 2: Decode Base64 payload ───────────────────────────────────
        let decoded;
        try {
            decoded = Buffer.from(base64Payload, 'base64').toString('utf8');
        } catch {
            return {
                success: false,
                message: 'Activation key payload is corrupted. Please verify you copied the complete key without modifications.',
            };
        }
        
        // ── Step 3: Verify checksum ──────────────────────────────────────────
        const expectedChecksum = parseInt(checksumHex, 16);
        const actualChecksum   = this._computeCRC16(decoded);
        
        if (actualChecksum !== expectedChecksum) {
            return {
                success: false,
                message: `Activation key checksum mismatch. Expected ${checksumHex}, got ${actualChecksum.toString(16).toUpperCase().padStart(4, '0')}. The key may have been modified or corrupted. Please copy the key again carefully.`,
            };
        }
        
        // ── Step 4: Parse JSON envelope ──────────────────────────────────────
        let envelope;
        try {
            envelope = JSON.parse(decoded);
        } catch {
            return {
                success: false,
                message: 'Activation key content is not valid JSON. The key may be corrupted.',
            };
        }
        
        return { success: true, envelope };
    }

    /**
     * Compute CRC16-CCITT checksum.
     * Same algorithm as LicenseIssuer for consistency.
     * 
     * @param {string} data
     * @returns {number}
     */
    _computeCRC16(data) {
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
     * Placeholder for future online activation.
     *
     * Implementation will:
     *   POST /api/v1/license/activate { machineId, key }
     *   Receive signed envelope from vendor server
     *   Call LicenseStorage.writeLicense(envelope)
     *
     * @returns {Promise<ActivationResult>}
     */
    async activateOnline(activationKey, machineId) { // eslint-disable-line no-unused-vars
        return {
            success:     false,
            message:     'Online activation is not yet available. Please use an offline activation key or import a .lic file.',
            licenseData: null,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private validation logic
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Validate a parsed activation envelope.
     * Shared by activateFromFile() and activateOffline().
     *
     * Checks (in order):
     *   1. Required fields present
     *   2. ECDSA signature valid (vendor public key)
     *   3. Machine binding (or wildcard '*')
     *   4. License type recognised
     *   5. Issue timestamp present and valid
     *   6. Current UTC >= Issue timestamp (no activation before official issue date)
     *   7. Activation Window check (Phase 3):
     *        If activationDeadlineUtc is present in signed block:
     *          Current UTC must be <= activationDeadlineUtc
     *          If expired → ACTIVATION_WINDOW_EXPIRED, do NOT activate
     *   8. License not expired at activation time
     *
     * Backward compatibility:
     *   If activationDeadlineUtc is absent (legacy license), skip step 7.
     *   The activation window concept does not apply to pre-Phase 3 licenses.
     *
     * @param {object} envelope
     * @param {string} machineId
     * @returns {ActivationResult}
     */
    _validateEnvelope(envelope, machineId) {

        // ── Step 1: Required fields ─────────────────────────────────────────
        if (!envelope || typeof envelope !== 'object') {
            return { success: false, message: 'Activation data is not a valid object.', licenseData: null };
        }

        if (!envelope.licenseBlock || typeof envelope.licenseBlock !== 'object') {
            return { success: false, message: 'Activation data is missing licenseBlock.', licenseData: null };
        }

        if (!envelope.vendorSignature) {
            return { success: false, message: 'Activation data is missing vendorSignature.', licenseData: null };
        }

        const block = envelope.licenseBlock;
        const requiredBlockFields = ['machineId', 'licenseType', 'expiryDate', 'issuedAt', 'licenseId'];
        for (const field of requiredBlockFields) {
            if (!block[field]) {
                return {
                    success:     false,
                    message:     `Activation key is missing required field: licenseBlock.${field}`,
                    licenseData: null,
                };
            }
        }

        // ── Step 2: ECDSA signature verification ────────────────────────────
        // Must be done BEFORE trusting any field in the block.
        // Any tampered field (including activation window fields) invalidates the sig.
        if (!this._verifyEcdsaSignature(block, envelope.vendorSignature)) {
            return {
                success:     false,
                message:     'Activation key signature is invalid. Please contact support to obtain a valid key.',
                licenseData: null,
            };
        }

        // ── Step 3: Machine binding ──────────────────────────────────────────
        // '*' is the wildcard for enterprise floating licenses.
        if (block.machineId !== '*' && block.machineId !== machineId) {
            return {
                success:     false,
                message:     'This activation key was issued for a different machine. Please provide your Machine ID to support.',
                licenseData: null,
            };
        }

        // ── Step 4: License type ─────────────────────────────────────────────
        if (!Object.values(LICENSE_TYPES).includes(block.licenseType)) {
            return {
                success:     false,
                message:     `Unknown license type: ${block.licenseType}`,
                licenseData: null,
            };
        }

        // ── Step 5: Issue timestamp presence ────────────────────────────────
        // issueTimestampUtc is the canonical field (Phase 3).
        // issueTimestamp is Phase 2 compat. issuedAt is the original fallback.
        // All three point to the same moment; we take the first non-null one.
        const issueTimeStr = block.issueTimestampUtc || block.issueTimestamp || block.issuedAt;
        if (!issueTimeStr) {
            return {
                success:     false,
                message:     'Activation key is missing issue timestamp. Please request a new license from support.',
                licenseData: null,
            };
        }

        const issueTime = new Date(issueTimeStr);
        if (Number.isNaN(issueTime.getTime())) {
            return {
                success:     false,
                message:     'Activation key contains an invalid issue timestamp.',
                licenseData: null,
            };
        }

        // ── Step 6: Issue-time validation ────────────────────────────────────
        // Current UTC must be >= issue timestamp.
        // Rejects activation if system clock is behind issue date (clock manipulation).
        const now = new Date();
        if (now.getTime() < issueTime.getTime()) {
            return {
                success: false,
                message: (
                    `License activation failed: System date/time (${now.toISOString()}) is earlier than ` +
                    `the license issue date (${issueTime.toISOString()}). ` +
                    `Please correct your system clock before activating. If the system time is correct, ` +
                    `contact support — this license may not have been officially issued yet.`
                ),
                licenseData: null,
            };
        }

        // ── Step 7: Activation Window enforcement (Phase 3) ──────────────────
        // Only applies when activationDeadlineUtc is present in the signed block.
        // This field is inside the ECDSA signature (verified in Step 2), so it
        // cannot be tampered with. Any modification invalidates the signature.
        //
        // Logic:
        //   - activationDeadlineUtc present AND current UTC > deadline → REJECT
        //   - activationDeadlineUtc absent (legacy license)             → SKIP (backward compat)
        //   - activationDeadlineUtc present AND current UTC <= deadline → PASS
        //
        // Once activated successfully, the activation window is permanently closed.
        // Subsequent startups use the activation.dat record, NOT this check.
        if (block.activationDeadlineUtc) {
            const deadline = new Date(block.activationDeadlineUtc);

            if (Number.isNaN(deadline.getTime())) {
                return {
                    success:     false,
                    message:     'License contains an invalid activation deadline. Please contact support.',
                    licenseData: null,
                };
            }

            if (now.getTime() > deadline.getTime()) {
                // Activation window has expired. Do NOT activate. Do NOT create activation.dat.
                const deadlineStr  = deadline.toUTCString();
                const windowDays   = block.activationWindowDays || '?';
                return {
                    success:                  false,
                    activationWindowExpired:  true,   // flag for UI to show specific dialog
                    message:                  (
                        `This activation request has expired. The license had a ${windowDays}-day activation ` +
                        `window that ended on ${deadlineStr}. ` +
                        `Please contact Millennium TechLink to generate a new activation license.`
                    ),
                    licenseData: null,
                    // Pass deadline info so the UI can display it clearly
                    deadlineInfo: {
                        issueTimestampUtc:      issueTimeStr,
                        activationWindowDays:   block.activationWindowDays || null,
                        activationDeadlineUtc:  block.activationDeadlineUtc,
                        currentUtc:             now.toISOString(),
                    },
                };
            }
        }

        // ── Step 8: License expiry at activation time ────────────────────────
        // For FIRST_ACTIVATION mode: expiryDate may be 'NEVER' or a computed
        // future date set at issue time. Either way must not already be expired.
        if (block.expiryDate !== 'NEVER') {
            const expiry = new Date(block.expiryDate);
            if (Number.isNaN(expiry.getTime())) {
                return {
                    success:     false,
                    message:     'Activation key contains an invalid expiry date.',
                    licenseData: null,
                };
            }
            if (expiry.getTime() < now.getTime()) {
                return {
                    success:     false,
                    message:     `This activation key expired on ${expiry.toLocaleDateString()} and can no longer be used.`,
                    licenseData: null,
                };
            }
        }

        // ── All checks passed ────────────────────────────────────────────────
        // For FIRST_ACTIVATION mode (Phase 3), the caller (LicenseManager._doActivate)
        // is responsible for computing and writing the correct expiryDate based on
        // licenseDurationDays from the activation timestamp. The expiryDate in the
        // licenseBlock here is the vendor-set ceiling; the runtime expiry is computed
        // from the actual activation moment.
        return {
            success: true,
            message: 'Activation successful.',
            licenseData: {
                licenseType:          block.licenseType,
                expiryDate:           block.expiryDate,
                licenseId:            block.licenseId,
                issuedAt:             block.issuedAt,
                issueTimestampUtc:    issueTimeStr,
                licenseStartMode:     block.licenseStartMode     || 'ISSUE_DATE',
                licenseDurationDays:  block.licenseDurationDays  || null,
                activationWindowDays: block.activationWindowDays || null,
                activationDeadlineUtc: block.activationDeadlineUtc || null,
                status:               LICENSE_STATUS.ACTIVE,
                // Bind to this machine (replace wildcard if present)
                machineId:            machineId,
                // Pass the full verified envelope through so LicenseManager
                // can write it directly to storage with the ECDSA sig intact
                verifiedEnvelope:     envelope,
            },
        };
    }

    /**
     * Verify ECDSA P-256 signature over a licenseBlock.
     * Delegates to CryptoService — single source of truth for vendor signature
     * verification. Do not re-implement the crypto here.
     *
     * @param {object} licenseBlock
     * @param {string} vendorSignature  - Base64-encoded DER signature
     * @returns {boolean}
     */
    _verifyEcdsaSignature(licenseBlock, vendorSignature) {
        return verifyVendorSignature(licenseBlock, vendorSignature);
    }
}

module.exports = { ActivationService };
