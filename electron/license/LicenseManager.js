/**
 * LicenseManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates the complete license lifecycle.
 * Single entry point for all license operations from main.js.
 *
 * Coordinates: MachineId, LicenseStorage, LicenseValidator, TimeValidator,
 *              ActivationService — each module has a single responsibility.
 *
 * Public API (called by main.js):
 *   initialize()          → resolves machineId, first-install detection / bypass check
 *   checkLicense([now])   → validates; returns { result, licenseBlock, daysRemaining }
 *   updateLastLaunch([now]) → writes timestamp to machine.dat (NOT license.dat)
 *   activate(key)         → ECDSA-verified activation; writes storage
 *   activateFromFile(content) → import .lic file; delegates to activate()
 *   getLicenseInfo()      → safe UI-friendly summary (no signatures)
 *   getMachineId()        → the single Machine ID used for display and license binding
 *
 * SIMPLIFIED Machine ID design:
 *   - ONE Machine ID throughout the system (XXXX-XXXX-XXXX format).
 *   - The same ID shown to the user is the ID embedded in licenses.
 *   - No hidden internal IDs, no conversion between formats.
 *
 * Other design decisions:
 *   - No Electron APIs inside this class. Paths come via PathResolver (injected).
 *   - updateLastLaunch() writes to machine.dat only; license.dat is immutable
 *     after activation (vendor signature is preserved untouched).
 *   - machine.dat presence is the first-install marker. Deleting license.dat
 *     while machine.dat exists → BYPASS_ATTEMPT logged → INTEGRITY_FAILED.
 *   - All state mutations are logged to activation.log.
 */

'use strict';

const { getMachineId, setMachineDatPath } = require('./MachineId');
const LicenseStorage   = require('./LicenseStorage');
const LicenseValidator = require('./LicenseValidator');
const TimeValidator    = require('./TimeValidator');
const { ActivationService } = require('./ActivationService');

const {
    LICENSE_TYPES,
    LICENSE_STATUS,
    LICENSE_STATES,
    LICENSE_START_MODES,
    VALIDATION_RESULT,
    ACTIVATION_LOG_EVENTS,
    AUTO_TRIAL_ENABLED,
    TRIAL_DURATION_DAYS,
    LICENSE_SCHEMA_VERSION,
    MACHINE_SCHEMA_VERSION,
    ENVELOPE_FORMAT_VERSION,
} = require('./LicenseConstants');

class LicenseManager {

    /**
     * @param {object}   opts
     * @param {import('./PathResolver')} opts.pathResolver
     *   Fully initialised PathResolver with ensureAllDirs() already called.
     * @param {string}   opts.appVersion  - from app.getVersion()
     * @param {Function} [opts.log]       - logElectron function from main.js
     */
    constructor({ pathResolver, appVersion, log }) {
        if (!pathResolver || typeof pathResolver.licenseFile !== 'string') {
            throw new Error('LicenseManager: a valid PathResolver instance is required.');
        }

        setMachineDatPath(pathResolver.machineFile);

        this._storage    = new LicenseStorage(pathResolver);
        this._validator  = new LicenseValidator();
        this._timeVal    = new TimeValidator();
        this._activation = new ActivationService();
        this._appVersion = appVersion || '0.0.0';
        this._log        = log || console.log;
        this._machineId  = null;   // resolved once in initialize()
        this._paths      = pathResolver;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Initialisation
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Must be called once before any other method.
     *
     * Decision tree:
     *   license.dat present → normal flow; proceed to checkLicense()
     *   license.dat absent + machine.dat absent → FIRST INSTALL.
     *       Create machine.dat; trial only if AUTO_TRIAL_ENABLED, else await activation.
     *   license.dat absent + machine.dat PRESENT → check for a prior REAL
     *       activation (HMAC-verified activationCount). None → still awaiting
     *       activation, not a bypass. Found → BYPASS ATTEMPT, logged.
     *
     * @returns {Promise<{ isFirstInstall: boolean, isBypassAttempt: boolean }>}
     */
    async initialize() {
        this._log('[License] Initializing LicenseManager...');

        // Must snapshot before getMachineId(), which persists machine.dat as
        // a side effect - checking after would misdiagnose every fresh install as a bypass.
        const machinePresent = this._storage.machineExists();

        // getMachineId() now returns the single XXXX-XXXX-XXXX display ID
        this._machineId = await getMachineId();
        this._log(`[License] Machine ID: ${this._machineId}`);

        const licensePresent = this._storage.licenseExists();

        if (licensePresent) {
            this._log('[License] Existing license.dat found.');
            return { isFirstInstall: false, isBypassAttempt: false };
        }

        if (!machinePresent) {
            // ── Genuine first install ────────────────────────────────────────
            await this._writeMachineDat(true, 0);

            if (AUTO_TRIAL_ENABLED) {
                this._log('[License] First install detected. Creating trial...');
                await this._createTrialLicense();
                this._log('[License] Trial license created.');
            } else {
                this._log('[License] First install detected. No auto-trial (AUTO_TRIAL_ENABLED=false) - awaiting activation.');
                this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.AWAITING_ACTIVATION, {
                    machineId: this._machineId,
                    version:   this._appVersion,
                });
            }
            return { isFirstInstall: true, isBypassAttempt: false };
        }

        // machine.dat present, license.dat absent: activationCount only
        // increments on a real _doActivate() call, never for an auto-trial -
        // that's what distinguishes "never activated" from "was deleted".
        const machineData = this._storage.readMachine();
        if (!this._hasVerifiedPriorActivation(machineData)) {
            this._log('[License] machine.dat present but no prior activation on record. Awaiting activation (not a bypass).');
            return { isFirstInstall: false, isBypassAttempt: false };
        }

        // ── Bypass attempt: a previously-activated license.dat was deleted ──
        this._log('[License] WARNING: license.dat missing but machine.dat present with a prior activation. Bypass attempt logged.');
        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.BYPASS_ATTEMPT, {
            machineId: this._machineId,
            version:   this._appVersion,
        });
        return { isFirstInstall: false, isBypassAttempt: true };
    }

    /**
     * Was this machine ever the target of a real (vendor-issued) activation?
     * Only trusts activationCount if machine.dat's own HMAC verifies.
     * @param {object|null} machineData - from LicenseStorage.readMachine()
     * @returns {boolean}
     */
    _hasVerifiedPriorActivation(machineData) {
        if (!machineData || typeof machineData.activationCount !== 'number' || machineData.activationCount < 1) {
            return false;
        }
        const { hmac: storedHmac, ...dataWithoutHmac } = machineData;
        return !!storedHmac && this._validator.verifyRuntimeHmac(dataWithoutHmac, storedHmac, this._machineId);
    }

    // ════════════════════════════════════════════════════════════════════════
    // License check
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Validate the current license.
     *
     * Enhanced with activation record validation (Phase 2 enterprise hardening):
     *   - For vendor-issued licenses: check activation.dat first (zero-tolerance rollback)
     *   - Then validate the license.dat envelope (signature, machine, expiry)
     *   - Finally update lastValidationTime in activation.dat
     *
     * @param {Date} [now] - Injectable for testing
     * @returns {Promise<{ result: ValidationResult, licenseBlock: object|null, daysRemaining: number }>}
     */
    async checkLicense(now = new Date()) {
        if (!this._machineId) {
            throw new Error('LicenseManager.checkLicense() called before initialize()');
        }

        this._log('[License] Checking license...');

        const envelope            = this._storage.readLicense();
        const machineData         = this._storage.readMachine();
        const activationRecord    = this._storage.readActivationRecord();

        // ── Step 1: Activation record check (for activated licenses only) ────
        // Trial licenses do not have activation records.
        // Vendor-issued licenses (with vendorSignature) DO have activation records.
        const isVendorLicense = envelope && envelope.vendorSignature;

        if (isVendorLicense && activationRecord) {
            // Validate activation record FIRST — this is the zero-tolerance rollback check
            const activationResult = this._validator.validateActivationRecord(
                activationRecord,
                this._machineId,
                now
            );

            if (!activationResult.valid) {
                this._log(`[License] Activation record validation failed: ${activationResult.code}`);

                if (activationResult.code === VALIDATION_RESULT.ACTIVATION_RECORD_TAMPERED) {
                    this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_RECORD_TAMPERED, {
                        machineId: this._machineId,
                    });
                } else if (activationResult.code === VALIDATION_RESULT.CLOCK_TAMPER) {
                    this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.CLOCK_ROLLBACK_DETECTED, {
                        machineId:          this._machineId,
                        lastValidationTime: activationRecord.lastValidationTime,
                        currentTime:        now.toISOString(),
                    });
                }

                return {
                    result:        activationResult,
                    licenseBlock:  null,
                    daysRemaining: 0,
                };
            }

            // Activation record is valid — proceed to license validation
            this._log('[License] Activation record validated successfully.');

        } else if (isVendorLicense && !activationRecord) {
            // activation.dat missing could mean a legitimate pre-Phase-2 migration,
            // or tampering. Distinguish via machine.dat's HMAC-sealed activationCount
            // (only incremented post-activation): < 1 means INTEGRITY_FAILED, don't recreate it.

            const legitimateMigration = this._hasVerifiedPriorActivation(machineData);

            if (!legitimateMigration) {
                // activation.dat absent with no evidence of prior activation.
                // Treat as integrity failure — do not allow the application to start.
                this._log('[License] Vendor license found without activation record and no activation history. Blocking.');
                this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.INTEGRITY_FAILED, {
                    machineId: this._machineId,
                    code:      VALIDATION_RESULT.INTEGRITY_FAILED,
                    reason:    'activation.dat absent with no prior activation evidence in machine.dat',
                });
                return {
                    result: {
                        code:    VALIDATION_RESULT.INTEGRITY_FAILED,
                        valid:   false,
                        message: 'Activation data is missing or corrupted. Please contact your administrator.',
                    },
                    licenseBlock:  null,
                    daysRemaining: 0,
                };
            }

            // Legitimate pre-Phase 2 migration: activation was done in an older
            // build that did not write activation.dat. Allow the migration to
            // proceed — activation.dat will be created below in Step 3.
            this._log('[License] Vendor license found without activation record (pre-Phase 2 migration). activationCount confirmed >= 1. Will create record.');
        }

        // ── Step 2: License envelope validation ──────────────────────────────
        let envelopeForValidation = envelope;
        if (envelope && machineData && machineData.lastLaunch) {
            envelopeForValidation = {
                ...envelope,
                runtimeBlock: {
                    ...(envelope.runtimeBlock || {}),
                    lastLaunch: machineData.lastLaunch,
                },
            };
        }

        const result = this._validator.validate(envelopeForValidation, this._machineId, now);
        this._log(`[License] Validation: ${result.code} — ${result.message}`);

        if (result.code === VALIDATION_RESULT.EXPIRED) {
            this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.LICENSE_EXPIRED, {
                machineId: this._machineId,
                version:   this._appVersion,
            });
        } else if (result.code === VALIDATION_RESULT.CLOCK_TAMPER) {
            this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.CLOCK_TAMPER, {
                machineId:  this._machineId,
                lastLaunch: machineData ? machineData.lastLaunch : 'unknown',
            });
        } else if (
            result.code === VALIDATION_RESULT.INTEGRITY_FAILED ||
            result.code === VALIDATION_RESULT.MACHINE_MISMATCH
        ) {
            this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.INTEGRITY_FAILED, {
                machineId: this._machineId,
                code:      result.code,
            });
        }

        // ── Step 3: Update activation record (if license is valid) ───────────
        if (result.valid && isVendorLicense) {
            if (activationRecord) {
                // Update lastValidationTime
                await this._updateActivationRecord(activationRecord, now);
            } else if (envelope && envelope.licenseBlock) {
                // Create activation record (migration for pre-Phase 2 licenses)
                await this._createActivationRecord(envelope.licenseBlock, now);
            }
        }

        const licenseBlock = (result.valid && envelope) ? envelope.licenseBlock : null;

        return {
            result,
            licenseBlock,
            daysRemaining: result.daysRemaining ?? 0,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Last-launch persistence (machine.dat only)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Update lastLaunch in machine.dat.
     * Called AFTER the backend is confirmed running (not before).
     *
     * @param {Date} [now]
     */
    async updateLastLaunch(now = new Date()) {
        if (!this._machineId) return;

        const existing = this._storage.readMachine() || {};
        const updated  = {
            version:              existing.version              || MACHINE_SCHEMA_VERSION,
            machineId:            this._machineId,
            persistedMachineId:   existing.persistedMachineId   || this._machineId,
            installDate:          existing.installDate          || now.toISOString(),
            firstInstallDetected: existing.firstInstallDetected ?? true,
            activationCount:      existing.activationCount      || 0,
            lastLaunch:           now.toISOString(),
            lastVersion:          this._appVersion,
            updatedAt:            now.toISOString(),
        };

        const { hmac: _old, ...dataWithoutHmac } = updated;
        updated.hmac = this._validator.signRuntime(dataWithoutHmac, this._machineId);

        this._storage.writeMachine(updated);
        this._log(`[License] Last-launch updated in machine.dat: ${now.toISOString()}`);

        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.LAUNCH, {
            machineId: this._machineId,
            version:   this._appVersion,
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    // Activation
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Activate using a Base64 key string (email/paste delivery).
     * @param {string} activationKey
     * @returns {Promise<{ success: boolean, message: string }>}
     */
    async activate(activationKey) {
        return this._doActivate(() =>
            this._activation.activateOffline(activationKey, this._machineId)
        );
    }

    /**
     * Activate by importing a .lic file's contents.
     * @param {string} fileContents - UTF-8 content of the .lic file
     * @returns {Promise<{ success: boolean, message: string }>}
     */
    async activateFromFile(fileContents) {
        return this._doActivate(() =>
            this._activation.activateFromFile(fileContents, this._machineId)
        );
    }

    /**
     * Shared activation pipeline.
     * @param {Function} activateFn - Returns a synchronous ActivationResult
     * @returns {Promise<{ success: boolean, message: string }>}
     */
    async _doActivate(activateFn) {
        if (!this._machineId) {
            return { success: false, message: 'License manager not initialized.' };
        }

        this._log('[License] Activation attempt...');
        const result = activateFn();

        if (!result.success) {
            this._log(`[License] Activation failed: ${result.message}`);

            // Log activation window expiry separately
            if (result.activationWindowExpired) {
                this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_WINDOW_EXPIRED, {
                    machineId:             this._machineId,
                    issueTimestampUtc:     result.deadlineInfo?.issueTimestampUtc || 'unknown',
                    activationWindowDays:  result.deadlineInfo?.activationWindowDays || 'unknown',
                    activationDeadlineUtc: result.deadlineInfo?.activationDeadlineUtc || 'unknown',
                    currentUtc:            result.deadlineInfo?.currentUtc || new Date().toISOString(),
                    reason:                result.message.slice(0, 120),
                });
            } else {
                this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_FAIL, {
                    machineId: this._machineId,
                    reason:    result.message.slice(0, 80),
                });
            }

            // Forward the activationWindowExpired flag and deadlineInfo to the
            // caller so it can branch on type rather than message string.
            return {
                success:                 false,
                message:                 result.message,
                activationWindowExpired: result.activationWindowExpired || false,
                deadlineInfo:            result.deadlineInfo || null,
            };
        }

        const verifiedEnvelope = result.licenseData.verifiedEnvelope;
        const licenseBlock     = verifiedEnvelope.licenseBlock;
        const existingMachine  = this._storage.readMachine() || {};
        const now              = new Date();

        // FIRST_ACTIVATION mode: validity counts from activation time (now), not
        // issue date - expiry = now + licenseDurationDays, so the customer gets
        // the full purchased duration. ISSUE_DATE mode (or absent): use expiryDate as-is.
        let runtimeExpiryDate = licenseBlock.expiryDate;
        const licenseStartMode = licenseBlock.licenseStartMode || LICENSE_START_MODES.ISSUE_DATE;

        if (licenseStartMode === LICENSE_START_MODES.FIRST_ACTIVATION && licenseBlock.licenseDurationDays) {
            const durationDays = parseInt(licenseBlock.licenseDurationDays, 10);
            if (!Number.isNaN(durationDays) && durationDays > 0) {
                const computedExpiry = this._timeVal.computeExpiryDate(now, durationDays);
                runtimeExpiryDate = computedExpiry.toISOString();
                this._log(`[License] FIRST_ACTIVATION mode: expiry computed from activation time.`);
                this._log(`[License]   Activation: ${now.toISOString()}`);
                this._log(`[License]   Duration:   ${durationDays} days`);
                this._log(`[License]   Expiry:     ${runtimeExpiryDate}`);
            }
        }

        // licenseBlock must stay the original vendor-signed block - mutating any
        // field breaks the ECDSA signature. Runtime overrides go in runtimeBlock instead.
        const storageEnvelope = {
            formatVersion:   ENVELOPE_FORMAT_VERSION,
            licenseBlock:    licenseBlock,               // ← ORIGINAL vendor-signed block (never mutate)
            vendorSignature: verifiedEnvelope.vendorSignature,  // ← NEVER mutate
            runtimeBlock: {
                lastLaunch:       null,
                lastVersion:      this._appVersion,
                updatedAt:        now.toISOString(),
                // Runtime overrides — values computed/resolved at activation time
                runtimeExpiryDate: runtimeExpiryDate,   // computed expiry (FIRST_ACTIVATION mode)
                runtimeMachineId:  this._machineId,     // resolved machineId (replaces wildcard '*')
                runtimeInstallDate: now.toISOString(),  // activation timestamp
            },
            runtimeHmac: '',
        };

        this._storage.writeLicense(storageEnvelope);

        const machineUpdate = {
            version:              existingMachine.version              || MACHINE_SCHEMA_VERSION,
            machineId:            this._machineId,
            persistedMachineId:   existingMachine.persistedMachineId   || this._machineId,
            installDate:          existingMachine.installDate          || now.toISOString(),
            firstInstallDetected: existingMachine.firstInstallDetected ?? true,
            activationCount:      (existingMachine.activationCount || 0) + 1,
            lastLaunch:           existingMachine.lastLaunch           || null,
            lastVersion:          this._appVersion,
            updatedAt:            now.toISOString(),
        };
        const { hmac: _h, ...machineWithoutHmac } = machineUpdate;
        machineUpdate.hmac = this._validator.signRuntime(machineWithoutHmac, this._machineId);
        this._storage.writeMachine(machineUpdate);

        // ── Create activation record (Phase 2 enterprise hardening) ──────────
        // First successful vendor license activation: create activation.dat
        await this._createActivationRecord(licenseBlock, now);

        // ── Log successful activation with window info ───────────────────────
        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_OK, {
            machineId:              this._machineId,
            licenseId:              result.licenseData.licenseId,
            licenseType:            result.licenseData.licenseType,
            expiry:                 runtimeExpiryDate,
            issueTimestampUtc:      result.licenseData.issueTimestampUtc || result.licenseData.issuedAt,
            activationWindowDays:   result.licenseData.activationWindowDays || 'N/A',
            activationDeadlineUtc:  result.licenseData.activationDeadlineUtc || 'N/A',
            licenseStartMode:       licenseStartMode,
            licenseDurationDays:    licenseBlock.licenseDurationDays || 'N/A',
            version:                this._appVersion,
        });

        if (result.licenseData.activationWindowDays) {
            this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_WINDOW_PASSED, {
                machineId:              this._machineId,
                activationWindowDays:   result.licenseData.activationWindowDays,
                activationDeadlineUtc:  result.licenseData.activationDeadlineUtc,
                activationTimestampUtc: now.toISOString(),
            });
        }

        this._log(`[License] Activation OK. Type=${result.licenseData.licenseType} Expiry=${runtimeExpiryDate}`);
        return { success: true, message: result.message };
    }

    // ════════════════════════════════════════════════════════════════════════
    // License info for UI (non-sensitive summary)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Return a safe summary for dialogs, About screen, and IPC.
     * Never includes signatures or raw crypto material.
     *
     * machineId in the returned object is the XXXX-XXXX-XXXX display ID
     * — the same ID the user sees and the vendor uses for license generation.
     *
     * @returns {Promise<object>}
     */
    async getLicenseInfo() {
        const envelope    = this._storage.readLicense();
        const machineData = this._storage.readMachine();

        if (!envelope || !envelope.licenseBlock) {
            return {
                machineId:                this._machineId,
                licenseType:              null,
                status:                   null,
                licenseState:             null,
                installDate:              null,
                expiryDate:               null,
                daysRemaining:            0,
                lastLaunch:               null,
                lastVersion:              null,
                licenseId:                null,
                activationCount:          machineData ? machineData.activationCount : 0,
                // Activation Window fields
                issueTimestampUtc:        null,
                activationWindowDays:     null,
                activationDeadlineUtc:    null,
                licenseStartMode:         null,
                licenseDurationDays:      null,
            };
        }

        const block         = envelope.licenseBlock;
        const runtimeBlock  = envelope.runtimeBlock || {};
        // Prefer runtime overrides stored in runtimeBlock (set at activation time)
        // over the original vendor-signed values in licenseBlock.
        const effectiveExpiryDate  = runtimeBlock.runtimeExpiryDate  || block.expiryDate;
        const effectiveInstallDate = runtimeBlock.runtimeInstallDate || block.installDate;
        const daysRemaining = this._timeVal.daysRemaining(effectiveExpiryDate, new Date());

        // ── Determine license state ──────────────────────────────────────────
        // State governs the activation pipeline, independent of status:
        // PENDING_ACTIVATION / ACTIVATED / EXPIRED / TAMPER_DETECTED (set elsewhere).
        let licenseState = LICENSE_STATES.ACTIVATED;  // default for backward compat
        const hasActivationRecord = this._storage.activationRecordExists();

        if (envelope.vendorSignature) {
            // Vendor-issued license (not trial)
            if (!hasActivationRecord) {
                licenseState = LICENSE_STATES.PENDING_ACTIVATION;
            } else if (daysRemaining === 0) {
                licenseState = LICENSE_STATES.EXPIRED;
            } else {
                licenseState = LICENSE_STATES.ACTIVATED;
            }
        } else {
            // Trial license — no activation window concept
            licenseState = daysRemaining === 0 ? LICENSE_STATES.EXPIRED : LICENSE_STATES.ACTIVATED;
        }

        return {
            machineId:                this._machineId,
            licenseType:              block.licenseType,
            status:                   block.status,
            licenseState,
            installDate:              effectiveInstallDate,
            expiryDate:               effectiveExpiryDate,
            daysRemaining,
            lastLaunch:               machineData ? machineData.lastLaunch  : null,
            lastVersion:              machineData ? machineData.lastVersion : null,
            licenseId:                block.licenseId  || null,
            edition:                  block.product    ? block.product.edition   : null,
            features:                 block.product    ? block.product.features  : [],
            customerName:             block.customer   ? block.customer.name     : null,
            customerCompany:          block.customer   ? block.customer.company  : null,
            activationCount:          machineData ? machineData.activationCount : 0,
            // Activation Window fields (Phase 3)
            issueTimestampUtc:        block.issueTimestampUtc    || block.issueTimestamp || block.issuedAt || null,
            activationWindowDays:     block.activationWindowDays || null,
            activationDeadlineUtc:    block.activationDeadlineUtc || null,
            licenseStartMode:         block.licenseStartMode     || LICENSE_START_MODES.ISSUE_DATE,
            licenseDurationDays:      block.licenseDurationDays  || null,
        };
    }

    /**
     * Return the Machine ID (XXXX-XXXX-XXXX format).
     * This is the same ID shown in dialogs and used for license binding.
     * @returns {Promise<string>}
     */
    async getMachineId() {
        return getMachineId();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private helpers
    // ════════════════════════════════════════════════════════════════════════

    async _writeMachineDat(firstInstall, activationCount, now = new Date()) {
        const existingMachine = this._storage.readMachine() || {};
        const data = {
            version:              MACHINE_SCHEMA_VERSION,
            machineId:            this._machineId,
            persistedMachineId:   existingMachine.persistedMachineId || this._machineId,
            installDate:          now.toISOString(),
            firstInstallDetected: firstInstall,
            activationCount,
            lastLaunch:           null,
            lastVersion:          this._appVersion,
            updatedAt:            now.toISOString(),
        };

        data.hmac = this._validator.signRuntime(data, this._machineId);
        this._storage.writeMachine(data);

        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.FIRST_INSTALL, {
            machineId: this._machineId,
            version:   this._appVersion,
        });
    }

    /**
     * Create and persist a 30-day trial license.
     * Trial uses HMAC-SHA256 (machine-bound). vendorSignature is null.
     * @param {Date} [now]
     */
    async _createTrialLicense(now = new Date()) {
        const expiry = this._timeVal.computeExpiryDate(now, TRIAL_DURATION_DAYS);

        const licenseBlock = {
            schemaVersion:   LICENSE_SCHEMA_VERSION,
            machineId:       this._machineId,
            licenseType:     LICENSE_TYPES.TRIAL,
            expiryDate:      expiry.toISOString(),
            status:          LICENSE_STATUS.ACTIVE,
            installDate:     now.toISOString(),
            issuedAt:        now.toISOString(),
            createdAt:       now.toISOString(),
            licenseId:       null,
            gracePeriodDays: 0,
            product:         { name: 'Lab Management System', edition: 'TRIAL', features: [] },
            customer:        { name: '', company: '', email: '' },
        };

        const trialSig = this._validator.signRuntime(licenseBlock, this._machineId);

        const envelope = {
            formatVersion:   ENVELOPE_FORMAT_VERSION,
            licenseBlock,
            vendorSignature: null,
            runtimeBlock: {
                lastLaunch:  null,
                lastVersion: this._appVersion,
                updatedAt:   now.toISOString(),
            },
            runtimeHmac: trialSig,
        };

        this._storage.writeLicense(envelope);

        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.TRIAL_CREATED, {
            machineId: this._machineId,
            expiry:    expiry.toISOString(),
            days:      TRIAL_DURATION_DAYS,
            version:   this._appVersion,
        });
    }

    /**
     * Create the encrypted activation record on first successful activation.
     * Enterprise hardening (Phase 2): Records first activation time and
     * last validation time for zero-tolerance clock rollback detection.
     *
     * @param {object} licenseBlock - Verified license block from activation
     * @param {Date}   [now]
     */
    async _createActivationRecord(licenseBlock, now = new Date()) {
        const activationData = {
            licenseId:            licenseBlock.licenseId,
            machineId:            this._machineId,
            firstActivationTime:  now.toISOString(),
            lastValidationTime:   now.toISOString(),
            activationCount:      1,
        };

        // Sign with HMAC (machine-bound)
        const { hmac: _old, ...dataWithoutHmac } = activationData;
        activationData.hmac = this._validator.signRuntime(dataWithoutHmac, this._machineId);

        this._storage.writeActivationRecord(activationData);
        this._log(`[License] Activation record created: firstActivation=${now.toISOString()}`);

        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_RECORD_CREATED, {
            machineId:           this._machineId,
            licenseId:           licenseBlock.licenseId,
            firstActivationTime: now.toISOString(),
        });
    }

    /**
     * Update lastValidationTime in the activation record on every successful
     * startup validation. Zero-tolerance clock rollback: only updates when
     * current time > stored time.
     *
     * @param {object} existingRecord - from LicenseStorage.readActivationRecord()
     * @param {Date}   [now]
     */
    async _updateActivationRecord(existingRecord, now = new Date()) {
        const lastValidationMs = new Date(existingRecord.lastValidationTime).getTime();
        const currentMs        = now.getTime();

        // Only update if time moved forward (zero tolerance on rollback)
        if (currentMs <= lastValidationMs) {
            this._log('[License] Activation record NOT updated (time did not advance).');
            return;
        }

        const updated = {
            ...existingRecord,
            lastValidationTime: now.toISOString(),
            activationCount:    (existingRecord.activationCount || 0) + 1,
        };

        // Re-sign with HMAC
        const { hmac: _old, ...dataWithoutHmac } = updated;
        updated.hmac = this._validator.signRuntime(dataWithoutHmac, this._machineId);

        this._storage.writeActivationRecord(updated);
        this._log(`[License] Activation record updated: lastValidation=${now.toISOString()}`);

        this._storage.appendActivationLog(ACTIVATION_LOG_EVENTS.ACTIVATION_RECORD_UPDATED, {
            machineId:          this._machineId,
            licenseId:          updated.licenseId,
            lastValidationTime: now.toISOString(),
        });
    }
}

module.exports = LicenseManager;
