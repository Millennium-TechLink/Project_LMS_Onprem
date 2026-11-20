/**
 * LicenseValidator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure validation logic — no I/O, no UI, no side effects.
 *
 * Two distinct cryptographic operations:
 *
 *   1. ECDSA verification (vendor → application)
 *      verifyVendorSignature(licenseBlock, vendorSignature)
 *      Uses the vendor PUBLIC key embedded in LicenseConstants.
 *      The application can VERIFY but NEVER SIGN with this key.
 *      This is the primary security boundary.
 *
 *   2. HMAC runtime signing (application → machine.dat only)
 *      signRuntime(data, machineId)
 *      verifyRuntimeHmac(data, storedHmac, machineId)
 *      Local tamper-detection for mutable runtime state (lastLaunch, etc.)
 *      Key is derived from machineId + RUNTIME_HMAC_SALT so the seal is
 *      machine-specific but does not protect against the vendor level.
 *
 * Backward-compatibility shims (removed in Phase 4):
 *   sign()           → alias for signRuntime()
 *   verifyIntegrity()→ alias for verifyRuntimeHmac()
 *   validate()       → accepts both old { payload, signature } and new envelope shapes
 *
 * Design principles:
 *   - Pure functions: same input always produces same output.
 *   - Injectable `now` parameter on all time-sensitive methods for testing.
 *   - All validation paths return a structured ValidationResult, never throw.
 *   - Uses Node.js built-in crypto only — no npm dependencies.
 */

'use strict';

const crypto = require('crypto');
const {
    HMAC_ALGORITHM,
    RUNTIME_HMAC_SALT,
    VALIDATION_RESULT,
    CLOCK_ROLLBACK_TOLERANCE_MS,
    CLOCK_ROLLBACK_LEGACY_TOLERANCE_MS,
} = require('./LicenseConstants');
const { verifyVendorSignature } = require('./CryptoService');

/**
 * @typedef {Object} ValidationResult
 * @property {string}  code           - One of VALIDATION_RESULT constants
 * @property {boolean} valid          - true only when code === VALIDATION_RESULT.VALID
 * @property {string}  message        - Human-readable explanation
 * @property {number}  [daysRemaining]- Present when code is VALID or EXPIRED
 * @property {string}  [licenseType]  - Present when code is VALID
 * @property {string}  [status]       - Present when code is VALID
 */

class LicenseValidator {

    // ════════════════════════════════════════════════════════════════════════
    // ECDSA — Vendor signature verification
    // The application can ONLY verify. It never holds the private key.
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Verify an ECDSA P-256 signature on a licenseBlock.
     * Delegates to CryptoService — single source of truth for vendor signature
     * verification. Do not re-implement the crypto here.
     *
     * @param {object} licenseBlock     - The vendor-provided license data object
     * @param {string} vendorSignature  - Base64-encoded DER signature from vendor
     * @returns {boolean}
     */
    verifyVendorSignature(licenseBlock, vendorSignature) {
        return verifyVendorSignature(licenseBlock, vendorSignature);
    }

    // ════════════════════════════════════════════════════════════════════════
    // HMAC — Runtime state integrity (machine.dat only)
    // Machine-bound local tamper-detection. Not for vendor license data.
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Derive the machine-specific HMAC key.
     * Key = HMAC-SHA256(RUNTIME_HMAC_SALT, machineId)
     * Unique per machine × application, preventing cross-machine reuse.
     *
     * @param {string} machineId
     * @returns {string} hex key
     */
    _deriveRuntimeKey(machineId) {
        return crypto
            .createHmac(HMAC_ALGORITHM, RUNTIME_HMAC_SALT)
            .update(machineId)
            .digest('hex');
    }

    /**
     * Compute an HMAC-SHA256 seal over a data object.
     * Used to protect machine.dat runtime state.
     *
     * @param {object} data       - Object to seal (keys sorted for stability)
     * @param {string} machineId
     * @returns {string} hex digest
     */
    signRuntime(data, machineId) {
        const key       = this._deriveRuntimeKey(machineId);
        const canonical = JSON.stringify(data, Object.keys(data).sort());
        return crypto
            .createHmac(HMAC_ALGORITHM, key)
            .update(canonical)
            .digest('hex');
    }

    /**
     * Verify a runtime HMAC seal.
     * Uses timingSafeEqual to prevent timing-oracle attacks.
     *
     * @param {object} data
     * @param {string} storedHmac - hex string
     * @param {string} machineId
     * @returns {boolean}
     */
    verifyRuntimeHmac(data, storedHmac, machineId) {
        try {
            const expected = this.signRuntime(data, machineId);
            const a = Buffer.from(expected,   'hex');
            const b = Buffer.from(storedHmac, 'hex');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch {
            return false;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Activation record validation (enterprise hardening)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Validate an encrypted activation record.
     * Used on every startup to enforce clock rollback protection.
     *
     * Checks:
     *   1. HMAC integrity (machine-bound seal)
     *   2. Current time >= lastValidationTime (zero-tolerance rollback check)
     *
     * @param {object} activationRecord - from LicenseStorage.readActivationRecord()
     * @param {string} machineId
     * @param {Date}   [now]
     * @returns {ValidationResult}
     */
    validateActivationRecord(activationRecord, machineId, now = new Date()) {
        if (!activationRecord) {
            return {
                code:    VALIDATION_RESULT.NOT_FOUND,
                valid:   false,
                message: 'Activation record not found.',
            };
        }

        // ── 1. HMAC integrity ─────────────────────────────────────────────────
        const { hmac: storedHmac, ...dataWithoutHmac } = activationRecord;
        if (!storedHmac || !this.verifyRuntimeHmac(dataWithoutHmac, storedHmac, machineId)) {
            return {
                code:    VALIDATION_RESULT.ACTIVATION_RECORD_TAMPERED,
                valid:   false,
                message: 'Activation record integrity check failed. The record may have been modified.',
            };
        }

        // ── 2. Zero-tolerance clock rollback check ────────────────────────────
        const lastValidationMs = new Date(activationRecord.lastValidationTime).getTime();
        if (Number.isNaN(lastValidationMs)) {
            return {
                code:    VALIDATION_RESULT.MALFORMED,
                valid:   false,
                message: 'Activation record contains an invalid lastValidationTime.',
            };
        }

        const currentMs = now.getTime();
        if (currentMs < lastValidationMs - CLOCK_ROLLBACK_TOLERANCE_MS) {
            // CLOCK_ROLLBACK_TOLERANCE_MS = 0 for activation records.
            // Any backward movement is rejected.
            return {
                code:    VALIDATION_RESULT.CLOCK_TAMPER,
                valid:   false,
                message: (
                    `Clock rollback detected. Current time (${now.toISOString()}) is earlier than ` +
                    `last recorded validation (${activationRecord.lastValidationTime}). ` +
                    `Restore the correct system time and restart.`
                ),
            };
        }

        return {
            code:    VALIDATION_RESULT.VALID,
            valid:   true,
            message: 'Activation record validated successfully.',
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Full license validation
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Validate a license envelope read from license.dat.
     *
     * Accepts both:
     *   - New envelope format: { formatVersion, licenseBlock, vendorSignature, ... }
     *   - Legacy shim format:  { payload, signature }  (used by Phase 3 shims)
     *
     * Validation order (each step only runs if previous passes):
     *   1. Null / missing — NOT_FOUND
     *   2. Structural sanity — MALFORMED
     *   3. ECDSA vendor signature — INTEGRITY_FAILED
     *   4. Machine binding — MACHINE_MISMATCH
     *   5. Clock rollback (from lastLaunch in envelope) — CLOCK_TAMPER
     *   6. Expiry — EXPIRED
     *   7. All pass — VALID
     *
     * @param {object|null} envelope  - from LicenseStorage.read() or .readLicense()
     * @param {string}      currentMachineId
     * @param {Date}        [now]     - Injectable for testing
     * @returns {ValidationResult}
     */
    validate(envelope, currentMachineId, now = new Date()) {

        // ── 1. Missing ──────────────────────────────────────────────────────
        if (!envelope) {
            return {
                code:    VALIDATION_RESULT.NOT_FOUND,
                valid:   false,
                message: 'No license file found. This appears to be a fresh installation.',
            };
        }

        // ── Normalise envelope shapes ────────────────────────────────────────
        // Three possible shapes:
        //   A. New ECDSA envelope:   { licenseBlock, vendorSignature (non-null), ... }
        //   B. Trial envelope:       { licenseBlock, vendorSignature: null, runtimeHmac }
        //   C. Legacy shim format:   { payload, signature }  (Phase 2 backward compat)
        let licenseBlock, vendorSignature, runtimeHmac, lastLaunchFromEnvelope, isTrial;

        if (envelope.licenseBlock) {
            // Shapes A and B
            licenseBlock           = envelope.licenseBlock;
            vendorSignature        = envelope.vendorSignature || null;
            runtimeHmac            = envelope.runtimeHmac    || null;
            isTrial                = !vendorSignature;
            lastLaunchFromEnvelope = envelope.runtimeBlock
                ? envelope.runtimeBlock.lastLaunch
                : null;
        } else if (envelope.payload && envelope.signature) {
            // Shape C — legacy shim format
            licenseBlock           = envelope.payload;
            vendorSignature        = null;
            runtimeHmac            = envelope.signature;
            isTrial                = true;  // legacy format is always HMAC-only
            lastLaunchFromEnvelope = envelope.payload.lastLaunch || null;
        } else {
            return {
                code:    VALIDATION_RESULT.MALFORMED,
                valid:   false,
                message: 'License file structure is invalid.',
            };
        }

        // ── 2. Structural sanity ─────────────────────────────────────────────
        if (!licenseBlock || typeof licenseBlock !== 'object') {
            return {
                code:    VALIDATION_RESULT.MALFORMED,
                valid:   false,
                message: 'License block is missing or not an object.',
            };
        }

        const requiredFields = [
            'machineId', 'installDate', 'expiryDate', 'licenseType',
            'status', 'createdAt', 'schemaVersion',
        ];
        for (const field of requiredFields) {
            if (licenseBlock[field] === undefined || licenseBlock[field] === null) {
                return {
                    code:    VALIDATION_RESULT.MALFORMED,
                    valid:   false,
                    message: `License is missing required field: ${field}`,
                };
            }
        }

        // ── 3. Signature verification ────────────────────────────────────────
        if (!isTrial && vendorSignature) {
            // Vendor-issued license: ECDSA verification
            if (!this.verifyVendorSignature(licenseBlock, vendorSignature)) {
                return {
                    code:    VALIDATION_RESULT.INTEGRITY_FAILED,
                    valid:   false,
                    message: 'License ECDSA signature verification failed. The license may have been modified or was issued for a different application.',
                };
            }
        } else {
            // Trial or legacy: HMAC integrity check against this machine
            if (!runtimeHmac || !this.verifyRuntimeHmac(licenseBlock, runtimeHmac, currentMachineId)) {
                return {
                    code:    VALIDATION_RESULT.INTEGRITY_FAILED,
                    valid:   false,
                    message: 'License integrity check failed. The trial license may have been modified or was created for a different machine.',
                };
            }
        }

        // ── 4. Machine binding ───────────────────────────────────────────────
        // Prefer runtimeBlock.runtimeMachineId (set during activation to resolve
        // wildcard '*' licenses to the actual machine). Fall back to licenseBlock.
        const effectiveMachineId = (envelope.runtimeBlock && envelope.runtimeBlock.runtimeMachineId)
            || licenseBlock.machineId;
        if (effectiveMachineId !== currentMachineId) {
            return {
                code:    VALIDATION_RESULT.MACHINE_MISMATCH,
                valid:   false,
                message: 'This license is not valid for this machine.',
            };
        }

        // ── 5. Clock rollback detection ──────────────────────────────────────
        if (lastLaunchFromEnvelope) {
            const lastLaunchMs = new Date(lastLaunchFromEnvelope).getTime();
            if (!Number.isNaN(lastLaunchMs)) {
                const currentMs = now.getTime();
                if (currentMs < lastLaunchMs - CLOCK_ROLLBACK_LEGACY_TOLERANCE_MS) {
                    return {
                        code:    VALIDATION_RESULT.CLOCK_TAMPER,
                        valid:   false,
                        message: `Clock rollback detected. Current time (${now.toISOString()}) is earlier than last recorded launch (${lastLaunchFromEnvelope}). Restore the correct system time and restart.`,
                    };
                }
            }
        }

        // ── 6. Expiry ────────────────────────────────────────────────────────
        // Prefer runtimeBlock.runtimeExpiryDate (computed at activation for
        // FIRST_ACTIVATION mode). Fall back to licenseBlock.expiryDate.
        const effectiveExpiryDate = (envelope.runtimeBlock && envelope.runtimeBlock.runtimeExpiryDate)
            || licenseBlock.expiryDate;

        if (effectiveExpiryDate !== 'NEVER') {
            const expiry    = new Date(effectiveExpiryDate);
            const nowTime   = now.getTime();

            if (Number.isNaN(expiry.getTime())) {
                return {
                    code:    VALIDATION_RESULT.MALFORMED,
                    valid:   false,
                    message: 'License expiryDate is not a valid date.',
                };
            }

            const daysRemainingRaw = (expiry.getTime() - nowTime) / (1000 * 60 * 60 * 24);
            const daysRemaining    = Math.ceil(daysRemainingRaw);

            if (nowTime > expiry.getTime()) {
                return {
                    code:          VALIDATION_RESULT.EXPIRED,
                    valid:         false,
                    message:       `License expired on ${expiry.toLocaleDateString()}.`,
                    daysRemaining: 0,
                };
            }

            return {
                code:          VALIDATION_RESULT.VALID,
                valid:         true,
                message:       `License is active. ${daysRemaining} day(s) remaining.`,
                daysRemaining,
                licenseType:   licenseBlock.licenseType,
                status:        licenseBlock.status,
            };
        }

        // Permanent / no-expiry
        return {
            code:          VALIDATION_RESULT.VALID,
            valid:         true,
            message:       'License is active (permanent).',
            daysRemaining: Infinity,
            licenseType:   licenseBlock.licenseType,
            status:        licenseBlock.status,
        };
    }

}

module.exports = LicenseValidator;
