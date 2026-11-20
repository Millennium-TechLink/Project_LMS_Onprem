/**
 * MachineId.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates a stable, hardware-derived machine identifier.
 *
 * DESIGN — SINGLE PERSISTED ID:
 *   - The Machine ID is computed ONCE from hardware sources on first launch.
 *   - It is immediately written to machine.dat under the key "persistedMachineId".
 *   - On every subsequent launch it is READ from machine.dat, never recomputed.
 *   - This eliminates all sources of instability: WMI variability, disk ordering
 *     changes, hostname renames, username changes, and anything else that could
 *     make the hardware fingerprint return different values across restarts.
 *
 * FORMAT: XXXX-XXXX-XXXX  (12 uppercase hex chars, grouped by 4 with dashes)
 * Example: A89B-1886-1FF1
 *
 * This is the ONLY Machine ID in the system:
 *   - Shown to users in dialogs and About screens
 *   - Sent to vendor for license generation
 *   - Embedded in license.dat by the vendor
 *   - Compared during license validation
 *
 * PERSISTENCE PATH:
 *   %APPDATA%\Lab Management System\license\machine.dat
 *   key: persistedMachineId
 *
 * LOGGING: Every call logs whether the ID was loaded from machine.dat or
 *   freshly computed, plus the full fingerprint input used for computation.
 *
 * Dependencies: Node.js built-ins only (no npm packages).
 */

'use strict';

const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');
const os       = require('os');
const { MACHINE_ID_SALT } = require('./LicenseConstants');

// ── In-process cache (valid for one process lifetime only) ────────────────
let _cachedMachineId = null;

// ── Logger (overridable for testing) ─────────────────────────────────────
let _log = (msg) => {};  // silent by default; main.js injects logElectron

/**
 * Inject a logger function so MachineId logs go to electron.log.
 * Call this once from main.js before calling getMachineId().
 *
 * @param {Function} logFn
 */
function setMachineIdLogger(logFn) {
    _log = logFn || (() => {});
}

// ── PowerShell helper ─────────────────────────────────────────────────────

/**
 * Run a PowerShell command and return its stdout as a trimmed string.
 * Returns empty string on any failure.
 *
 * @param {string} cmd
 * @returns {string}
 */
function _runPS(cmd) {
    try {
        const result = execSync(
            `powershell -NoProfile -NonInteractive -Command "${cmd}"`,
            { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return (result || '').toString().trim();
    } catch {
        return '';
    }
}

// ── Hardware fingerprint collection ──────────────────────────────────────

/**
 * Collect all available hardware identifiers.
 * Each source is independent; failures are silently skipped.
 *
 * STABLE sources (hardware serial numbers — don't change unless hardware replaced):
 *   CPU ProcessorId, Motherboard serial, BIOS serial, Disk serial, Machine SID
 *
 * LOW-STABILITY sources (included for extra entropy but can change):
 *   Hostname (changes if PC is renamed), Username (changes if account renamed)
 *
 * NOTE: Even though hostname and username are low-stability, it doesn't matter
 *   because once the Machine ID is persisted to machine.dat, these values are
 *   never used again for ID generation.
 *
 * @returns {{ sources: string[], details: object }}
 */
function _collectHardwareSources() {
    const details = {};

    const cpuId = _runPS(
        "(Get-WmiObject -Class Win32_Processor | Select-Object -First 1).ProcessorId"
    );
    details.cpu = cpuId;

    const mbSerial = _runPS(
        "(Get-WmiObject -Class Win32_BaseBoard | Select-Object -First 1).SerialNumber"
    );
    details.mb = mbSerial;

    const biosSerial = _runPS(
        "(Get-WmiObject -Class Win32_BIOS | Select-Object -First 1).SerialNumber"
    );
    details.bios = biosSerial;

    const diskSerial = _runPS(
        "(Get-WmiObject -Class Win32_DiskDrive | Sort-Object -Property Size -Descending | Select-Object -First 1).SerialNumber"
    );
    details.disk = diskSerial;

    const machineSID = _runPS(
        "(New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME + '$')).Translate([System.Security.Principal.SecurityIdentifier]).Value"
    );
    details.sid = machineSID;

    details.hostname = os.hostname();
    details.platform = os.platform() + '-' + os.arch();
    details.username = os.userInfo().username;

    const OEM = new Set(['None', 'To be filled by O.E.M.', 'Default string', '']);

    const sources = [];
    if (cpuId)                                    sources.push(`CPU:${cpuId}`);
    if (mbSerial   && !OEM.has(mbSerial))          sources.push(`MB:${mbSerial}`);
    if (biosSerial && !OEM.has(biosSerial))        sources.push(`BIOS:${biosSerial}`);
    if (diskSerial && diskSerial.trim())           sources.push(`DISK:${diskSerial.trim()}`);
    if (machineSID && machineSID.startsWith('S-1-')) sources.push(`SID:${machineSID}`);
    sources.push(`HOST:${details.hostname}`);
    sources.push(`PLATFORM:${details.platform}`);
    sources.push(`USER:${details.username}`);

    return { sources, details };
}

// ── Machine ID formatting ─────────────────────────────────────────────────

/**
 * Format 12 hex chars as XXXX-XXXX-XXXX.
 * @param {string} hex12 - exactly 12 uppercase hex characters
 * @returns {string}
 */
function _formatId(hex12) {
    return `${hex12.slice(0,4)}-${hex12.slice(4,8)}-${hex12.slice(8,12)}`;
}

/**
 * Compute a fresh Machine ID from hardware sources.
 * @returns {{ machineId: string, inputString: string, details: object }}
 */
function _computeMachineId() {
    const { sources, details } = _collectHardwareSources();

    const inputString = sources.length > 0
        ? sources.sort().join('|')
        : `FALLBACK:${os.hostname()}|${os.platform()}|${os.arch()}`;

    const fullHash = crypto.createHmac('sha256', MACHINE_ID_SALT).update(inputString).digest('hex');
    const hex12    = fullHash.slice(0, 12).toUpperCase();
    const machineId = _formatId(hex12);

    return { machineId, inputString, details };
}

let _machineDatPath = null;

/**
 * Set the resolved path to machine.dat from PathResolver.
 * This removes the need for duplicate path constants.
 * @param {string} p 
 */
function setMachineDatPath(p) {
    _machineDatPath = p;
}

/**
 * @returns {string|null}
 */
function _getMachineDatPath() {
    return _machineDatPath;
}

/**
 * Try to read the persisted Machine ID from machine.dat.
 * Returns null if the file doesn't exist, is unreadable, or has no persistedMachineId.
 *
 * @returns {string|null}
 */
function _readPersistedId() {
    const datPath = _getMachineDatPath();
    if (!datPath) return null;
    try {
        if (!fs.existsSync(datPath)) return null;
        const raw    = fs.readFileSync(datPath, 'utf8');
        const parsed = JSON.parse(raw);
        const id     = parsed && parsed.persistedMachineId;
        // Validate format: XXXX-XXXX-XXXX
        if (id && /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(id)) {
            return id;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Write the Machine ID into machine.dat under the key "persistedMachineId".
 * Merges with any existing data — never overwrites fields written by LicenseManager.
 *
 * Uses atomic write (tmp → rename) to prevent corruption.
 *
 * @param {string} machineId
 */
function _persistId(machineId) {
    const datPath = _getMachineDatPath();
    if (!datPath) return;
    try {
        // Ensure directory exists
        const dir = path.dirname(datPath);
        fs.mkdirSync(dir, { recursive: true });

        let existing = {};
        try {
            if (fs.existsSync(datPath)) {
                existing = JSON.parse(fs.readFileSync(datPath, 'utf8')) || {};
                // Never mutate a cryptographically sealed machine.dat directly.
                // LicenseManager is responsible for sealing and writing it.
                if (existing.hmac) {
                    return;
                }
            }
        } catch { /* start fresh if corrupt */ }

        const updated = { ...existing, persistedMachineId: machineId };
        const json    = JSON.stringify(updated, null, 2);

        // Atomic write
        const tmpPath = datPath + '.tmp';
        fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmpPath, datPath);
    } catch (err) {
        _log(`[MachineId] WARNING: Could not persist Machine ID to machine.dat: ${err.message}`);
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get the Machine ID in XXXX-XXXX-XXXX format.
 *
 * FIRST CALL (first ever launch on this machine):
 *   1. Checks machine.dat for a persisted ID → not found
 *   2. Collects hardware sources via WMI
 *   3. Computes HMAC-SHA256, takes first 12 hex chars
 *   4. Persists the ID to machine.dat
 *   5. Returns the ID
 *
 * ALL SUBSEQUENT CALLS (same process or after restart):
 *   - In-process cache hit → returns immediately (no I/O, no WMI)
 *   - Cache miss (new process) → reads from machine.dat → returns persisted ID
 *
 * This guarantees the same ID is returned on every launch, forever,
 * regardless of WMI variability, disk reordering, hostname changes, etc.
 *
 * @returns {Promise<string>} Machine ID in XXXX-XXXX-XXXX format
 */
async function getMachineId() {
    // ── 1. In-process cache ───────────────────────────────────────────────
    if (_cachedMachineId) {
        _log(`[MachineId] Returning cached Machine ID: ${_cachedMachineId}`);
        return _cachedMachineId;
    }

    // ── 2. Read from machine.dat if already persisted ─────────────────────
    const persisted = _readPersistedId();
    if (persisted) {
        _cachedMachineId = persisted;
        _log(`[MachineId] Loaded Machine ID from machine.dat: ${_cachedMachineId}`);
        _log(`[MachineId] Source: PERSISTED (not recomputed from hardware)`);
        return _cachedMachineId;
    }

    // ── 3. First time: compute from hardware and persist ──────────────────
    _log('[MachineId] No persisted Machine ID found. Computing from hardware...');
    const { machineId, inputString, details } = _computeMachineId();

    _log(`[MachineId] Fingerprint inputs:`);
    _log(`[MachineId]   CPU      : ${details.cpu      || '(unavailable)'}`);
    _log(`[MachineId]   MB       : ${details.mb       || '(unavailable)'}`);
    _log(`[MachineId]   BIOS     : ${details.bios     || '(unavailable)'}`);
    _log(`[MachineId]   DISK     : ${details.disk     || '(unavailable)'}`);
    _log(`[MachineId]   SID      : ${details.sid      || '(unavailable)'}`);
    _log(`[MachineId]   HOST     : ${details.hostname}`);
    _log(`[MachineId]   USER     : ${details.username}`);
    _log(`[MachineId]   Input    : ${inputString}`);
    _log(`[MachineId] Computed Machine ID: ${machineId}`);
    _log(`[MachineId] Persisting to machine.dat...`);

    _persistId(machineId);
    _log(`[MachineId] Machine ID persisted. Source: COMPUTED FROM HARDWARE`);

    _cachedMachineId = machineId;
    return _cachedMachineId;
}

module.exports = { getMachineId, setMachineIdLogger, setMachineDatPath };
