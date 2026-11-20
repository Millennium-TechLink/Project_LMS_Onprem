/**
 * LicenseConstants.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for ALL licensing constants.
 *
 * Rules:
 *   - No magic values anywhere in the licensing system.
 *   - Every value that controls behaviour is named here.
 *   - No module may hard-code a path, channel name, duration, or algorithm.
 *
 * Schema version history:
 *   v1  — Original single-file HMAC design
 *   v2  — Split envelope: vendor ECDSA block + local HMAC runtime block
 */

'use strict';

// ── License types ──────────────────────────────────────────────────────────────
// Enum-style frozen object. Add new types here only — never inline.
// Future: CLOUD, USB_DONGLE, VOLUME, FLOATING
const LICENSE_TYPES = Object.freeze({
    TRIAL:        'TRIAL',
    PERMANENT:    'PERMANENT',
    SUBSCRIPTION: 'SUBSCRIPTION',
    ENTERPRISE:   'ENTERPRISE',
    ANNUAL:       'ANNUAL',
});

// ── License status values ──────────────────────────────────────────────────────
// Future: GRACE_PERIOD, OFFLINE_PENDING, REVOKED
const LICENSE_STATUS = Object.freeze({
    ACTIVE:       'ACTIVE',
    EXPIRED:      'EXPIRED',
    INVALID:      'INVALID',
    SUSPENDED:    'SUSPENDED',
    GRACE_PERIOD: 'GRACE_PERIOD',
});

// ── Validation result codes ────────────────────────────────────────────────────
// Returned by LicenseValidator. Callers branch on code, not on message strings.
const VALIDATION_RESULT = Object.freeze({
    VALID:               'VALID',
    EXPIRED:             'EXPIRED',
    GRACE_PERIOD:        'GRACE_PERIOD',
    CLOCK_TAMPER:        'CLOCK_TAMPER',
    INTEGRITY_FAILED:    'INTEGRITY_FAILED',
    NOT_FOUND:           'NOT_FOUND',
    MACHINE_MISMATCH:    'MACHINE_MISMATCH',
    MALFORMED:           'MALFORMED',
    ACTIVATION_REQUIRED: 'ACTIVATION_REQUIRED',
    // Enterprise activation hardening (Phase 2)
    PRE_ISSUE_CLOCK:     'PRE_ISSUE_CLOCK',     // system time < license issue time at activation
    ACTIVATION_RECORD_TAMPERED: 'ACTIVATION_RECORD_TAMPERED', // activation.dat HMAC invalid
    // Activation Window enforcement (Phase 3)
    ACTIVATION_WINDOW_EXPIRED: 'ACTIVATION_WINDOW_EXPIRED', // current UTC > activationDeadlineUtc
});

// ── License lifecycle states ───────────────────────────────────────────────────
// Independent of LICENSE_STATUS. These govern the activation pipeline.
//   PENDING_ACTIVATION  — license issued, not yet activated (within window)
//   ACTIVATED           — successfully activated; commercial validity running
//   EXPIRED             — license validity period ended post-activation
//   REVOKED             — vendor-side revocation (future: online check)
//   TAMPER_DETECTED     — integrity check failed
const LICENSE_STATES = Object.freeze({
    PENDING_ACTIVATION: 'PENDING_ACTIVATION',
    ACTIVATED:          'ACTIVATED',
    EXPIRED:            'EXPIRED',
    REVOKED:            'REVOKED',
    TAMPER_DETECTED:    'TAMPER_DETECTED',
});

// ── License start mode ─────────────────────────────────────────────────────────
// Controls when the commercial validity period begins counting.
//   FIRST_ACTIVATION — validity starts from the moment the customer activates.
//                      This is the correct behaviour for all paid licenses.
//   ISSUE_DATE       — legacy behaviour (validity starts from issue date).
//                      Kept for backward compatibility only.
const LICENSE_START_MODES = Object.freeze({
    FIRST_ACTIVATION: 'FIRST_ACTIVATION',
    ISSUE_DATE:       'ISSUE_DATE',
});

// ── Default activation window ─────────────────────────────────────────────────
// Used by LicenseIssuer.js when --activationWindowDays is not supplied.
// Configurable per-issuance via CLI argument.
const DEFAULT_ACTIVATION_WINDOW_DAYS = 7;

// ── Trial configuration ────────────────────────────────────────────────────────
// Whether initialize() auto-mints a 30-day trial license.dat on first install.
// false: fresh installs block on "activate your license" until a vendor key
// is entered (see LicenseIssuer.js --type TRIAL for a deliberate trial issue).
const AUTO_TRIAL_ENABLED = false;
const TRIAL_DURATION_DAYS = 30;

// Days before expiry to show the "expiring soon" warning banner in the main window
const TRIAL_WARNING_THRESHOLD_DAYS = 7;

// ── Clock rollback detection ───────────────────────────────────────────────────
// STARTUP rollback check (against activation record lastValidationTimestamp):
//   Zero tolerance — any backward movement is rejected.
//   The activation record is only updated when current time > stored time,
//   so NTP corrections and DST transitions that move time *forward* are fine.
//   A legitimate backward DST transition (clocks go back 1 hr) would only
//   trigger for that one launch; the user can restart 1 hr later. For an
//   offline, security-first system this is an acceptable trade-off.
const CLOCK_ROLLBACK_TOLERANCE_MS = 0;   // zero tolerance on activation record

// Legacy tolerance kept only for the OLD runtimeBlock/lastLaunch path (machine.dat).
// Used by LicenseValidator.validate() for licenses that pre-date the activation record.
const CLOCK_ROLLBACK_LEGACY_TOLERANCE_MS = 90 * 60 * 1000;  // 90 minutes

// ── Cryptographic salts ────────────────────────────────────────────────────────
// Two separate salts for two separate cryptographic purposes.
// Keeping them separate means rotating one never affects the other.
//
// MACHINE_ID_SALT:   Namespaces the hardware fingerprint to this application.
//                    Used ONLY in MachineId.js.
//
// RUNTIME_HMAC_SALT: Used ONLY to protect machine.dat runtime state.
//                    The HMAC key = HMAC(RUNTIME_HMAC_SALT + machineId).
//
// These values must be changed when forking the product to a new application.
const MACHINE_ID_SALT   = 'LMS-MTL-MACHINEID-2024-1A2B3C4D5E6F7G8H';
const RUNTIME_HMAC_SALT = 'LMS-MTL-RUNTIME-2024-5E6F7G8H9I0J1K2L';

// ── HMAC algorithm ─────────────────────────────────────────────────────────────
// Used for: machine.dat runtime integrity (local protection only).
// NOT used for: vendor license signing (that uses ECDSA below).
const HMAC_ALGORITHM = 'sha256';

// ── ECDSA algorithm ────────────────────────────────────────────────────────────
// Used ONLY for verifying vendor-signed license blocks.
// The private key is NEVER embedded in this application — it lives only in the
// vendor's offline signing tools (onprem/electron/tools/LicenseIssuer.js).
// Only the PUBLIC key is embedded here. Embedding a public key is safe:
// it allows verification but cannot be used to forge signatures.
const ECDSA_ALGORITHM = 'SHA256';   // digest algorithm passed to crypto.verify()

// ── Vendor ECDSA public key (P-256 / secp256r1) ────────────────────────────────
// This key was generated once by the vendor with KeyGenerator.js.
// To rotate: generate a new keypair, update this constant, re-issue all licenses.
// The corresponding PRIVATE key is stored only offline by Millennium TechLink.
//
// IMPORTANT FOR PRODUCTION:
//   Replace this test key with the real vendor public key before shipping.
//   The test private key is in onprem/electron/tools/ — never commit that file to VCS.
const VENDOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEe+xQkOo3954ryVW4QKSCBveE6TuJ
aMIwLqEa1fe/Bn3hA/sWSiQ3WcAf+mzuIemGqHr+/nUyATQdl/O9qvSghQ==
-----END PUBLIC KEY-----`;

// ── Schema versions ────────────────────────────────────────────────────────────
// LICENSE_SCHEMA_VERSION: version of the license payload schema.
// Increment when adding required fields. LicenseStorage migration logic uses this.
const LICENSE_SCHEMA_VERSION  = 2;
const MACHINE_SCHEMA_VERSION  = 1;
const ENVELOPE_FORMAT_VERSION = 1;

// ── File names ─────────────────────────────────────────────────────────────────
// PathResolver owns the full paths. These are the leaf file names only.
const LICENSE_FILENAME            = 'license.dat';
const MACHINE_FILENAME            = 'machine.dat';
const ACTIVATION_LOG_FILENAME     = 'activation.log';
const ACTIVATION_RECORD_FILENAME  = 'activation.dat';  // encrypted activation record

// ── Activation log event names ─────────────────────────────────────────────────
// Used by LicenseManager when writing to activation.log.
// Append-only audit trail — never modify or delete these values.
const ACTIVATION_LOG_EVENTS = Object.freeze({
    FIRST_INSTALL:              'FIRST_INSTALL',
    TRIAL_CREATED:              'TRIAL_CREATED',
    AWAITING_ACTIVATION:        'AWAITING_ACTIVATION',        // first install / relaunch with no license issued yet (AUTO_TRIAL_ENABLED=false)
    LAUNCH:                     'LAUNCH',
    ACTIVATION_OK:              'ACTIVATION_OK',
    ACTIVATION_FAIL:            'ACTIVATION_FAIL',
    LICENSE_EXPIRED:            'LICENSE_EXPIRED',
    INTEGRITY_FAILED:           'INTEGRITY_FAILED',
    CLOCK_TAMPER:               'CLOCK_TAMPER',
    MACHINE_MISMATCH:           'MACHINE_MISMATCH',
    BYPASS_ATTEMPT:             'BYPASS_ATTEMPT',
    // Enterprise activation hardening events
    PRE_ISSUE_CLOCK_REJECTED:   'PRE_ISSUE_CLOCK_REJECTED',   // system clock < issue time at activation
    ACTIVATION_RECORD_CREATED:  'ACTIVATION_RECORD_CREATED',  // first successful activation record written
    ACTIVATION_RECORD_UPDATED:  'ACTIVATION_RECORD_UPDATED',  // lastValidationTimestamp updated on startup
    ACTIVATION_RECORD_TAMPERED: 'ACTIVATION_RECORD_TAMPERED', // activation.dat HMAC mismatch
    CLOCK_ROLLBACK_DETECTED:    'CLOCK_ROLLBACK_DETECTED',    // current time < lastValidationTimestamp
    ISSUE_TIME_VALIDATED:       'ISSUE_TIME_VALIDATED',       // issue time check passed
    SIGNATURE_VALIDATED:        'SIGNATURE_VALIDATED',        // ECDSA signature verified OK
    EXPIRY_VALIDATED:           'EXPIRY_VALIDATED',           // expiry check passed
    // Activation Window enforcement events (Phase 3)
    ACTIVATION_WINDOW_PASSED:   'ACTIVATION_WINDOW_PASSED',   // activation deadline validated OK
    ACTIVATION_WINDOW_EXPIRED:  'ACTIVATION_WINDOW_EXPIRED',  // activation attempted after deadline
});

// ── IPC channel names ──────────────────────────────────────────────────────────
// All IPC channels between main process and renderer are declared here.
// Never use a raw string for a channel name — always reference this object.
const IPC_CHANNELS = Object.freeze({
    // License
    LICENSE_STATUS:           'license:status',
    LICENSE_ACTIVATE:         'license:activate',
    LICENSE_IMPORT_FILE:      'license:import-file',

    // System / About
    SYSTEM_INFO:              'system:info',

    // Backup / restore
    BACKUP_LIST:              'backup:list',
    BACKUP_RESTORE_DATABASE:  'backup:restore-database',

    // App actions
    APP_QUIT:                 'app:quit',
    APP_OPEN_LOGS:            'app:open-logs',
    APP_OPEN_FOLDER:          'app:open-folder',
    APP_EXPORT_DIAGNOSTICS:   'app:export-diagnostics',

    // Backend health (main -> renderer push)
    BACKEND_STATUS:           'backend:status',
});

// ── Support contact ────────────────────────────────────────────────────────────
// Shown on all license dialogs and in the About dialog.
const SUPPORT_CONTACT = Object.freeze({
    email:   'support@millenniumtechlink.com',
    website: 'https://millenniumtechlink.com',
    phone:   '+91-8669723133',
    company: 'Millennium TechLink',
});

// ── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
    // Enums
    LICENSE_TYPES,
    LICENSE_STATUS,
    LICENSE_STATES,
    LICENSE_START_MODES,
    VALIDATION_RESULT,
    ACTIVATION_LOG_EVENTS,

    // Trial
    AUTO_TRIAL_ENABLED,
    TRIAL_DURATION_DAYS,
    TRIAL_WARNING_THRESHOLD_DAYS,

    // Activation Window
    DEFAULT_ACTIVATION_WINDOW_DAYS,

    // Clock
    CLOCK_ROLLBACK_TOLERANCE_MS,
    CLOCK_ROLLBACK_LEGACY_TOLERANCE_MS,

    // Crypto
    MACHINE_ID_SALT,
    RUNTIME_HMAC_SALT,
    HMAC_ALGORITHM,
    ECDSA_ALGORITHM,
    VENDOR_PUBLIC_KEY_PEM,

    // Schema versions
    LICENSE_SCHEMA_VERSION,
    MACHINE_SCHEMA_VERSION,
    ENVELOPE_FORMAT_VERSION,

    // File names (leaf names only — PathResolver owns full paths)
    LICENSE_FILENAME,
    MACHINE_FILENAME,
    ACTIVATION_LOG_FILENAME,
    ACTIVATION_RECORD_FILENAME,

    // IPC
    IPC_CHANNELS,

    // Support
    SUPPORT_CONTACT,
};
