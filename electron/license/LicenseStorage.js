/**
 * LicenseStorage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles ALL file-system I/O for the licensing subsystem.
 *
 * Manages three files, all under the roaming profile (%APPDATA%):
 *
 *   license/license.dat      ← vendor-provided license data (immutable after activation)
 *   license/machine.dat      ← locally-maintained runtime state (mutable on every launch)
 *   license/activation.log   ← append-only plaintext audit trail
 *
 * Paths come exclusively from a PathResolver instance injected at construction.
 * This class never calls path.join(), process.env, or app.getPath() directly.
 *
 * Design principles:
 *   - Single responsibility: I/O only. No validation, no crypto, no UI.
 *   - All file writes are atomic (write to .tmp → rename) to prevent
 *     partial writes from corrupting license data on power loss.
 *   - All read operations return null on any failure — never throw.
 *   - activation.log writes are best-effort — log failure must never crash startup.
 *   - Backups of license.dat are kept (max 5); machine.dat is not backed up
 *     because it is regenerated on every launch.
 */

'use strict';

const fs  = require('fs');

class LicenseStorage {

    /**
     * @param {import('./PathResolver')} pathResolver
     *   A fully initialised PathResolver instance.
     *   Directories must already exist (call pathResolver.ensureAllDirs() first).
     */
    constructor(pathResolver) {
        if (!pathResolver || typeof pathResolver.licenseFile !== 'string') {
            throw new Error(
                'LicenseStorage: a valid PathResolver instance is required. ' +
                'If you are still passing a userDataPath string, update the ' +
                'call site to pass a PathResolver instead.'
            );
        }
        this._paths = pathResolver;
    }

    // ════════════════════════════════════════════════════════════════════════
    // license.dat
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Check whether license.dat exists on disk.
     * @returns {boolean}
     */
    licenseExists() {
        return fs.existsSync(this._paths.licenseFile);
    }

    /**
     * Read and parse license.dat.
     *
     * Returns the raw envelope object or null if:
     *   - file is missing
     *   - file has a read permission error
     *   - file is not valid JSON
     *   - envelope is missing formatVersion or licenseBlock
     *
     * Never throws.
     *
     * @returns {{ formatVersion: number, licenseBlock: object,
     *             vendorSignature: string,
     *             runtimeBlock: object, runtimeHmac: string } | null}
     */
    readLicense() {
        const parsed = this._readJson(this._paths.licenseFile);
        if (!parsed) return null;

        // Validate minimum envelope structure
        if (
            typeof parsed.formatVersion !== 'number' ||
            !parsed.licenseBlock        ||
            typeof parsed.licenseBlock !== 'object'
        ) {
            return null;
        }

        return parsed;
    }

    /**
     * Atomically write a license envelope to license.dat.
     * Also writes a timestamped backup copy.
     *
     * @param {{ formatVersion: number, licenseBlock: object,
     *            vendorSignature: string,
     *            runtimeBlock: object, runtimeHmac: string }} envelope
     * @throws {Error} if the atomic write fails (disk full, permissions, etc.)
     */
    writeLicense(envelope) {
        if (
            !envelope                          ||
            typeof envelope.formatVersion !== 'number' ||
            !envelope.licenseBlock             ||
            typeof envelope.licenseBlock !== 'object'
        ) {
            throw new Error('LicenseStorage.writeLicense: invalid envelope structure');
        }

        const json = JSON.stringify(envelope, null, 2);
        this._atomicWrite(this._paths.licenseFile, json);
        this._writeLicenseBackup(json);
    }

    /**
     * Delete license.dat. Silent no-op if file does not exist.
     */
    deleteLicense() {
        this._silentUnlink(this._paths.licenseFile);
    }

    // ════════════════════════════════════════════════════════════════════════
    // machine.dat
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Check whether machine.dat exists on disk.
     * @returns {boolean}
     */
    machineExists() {
        return fs.existsSync(this._paths.machineFile);
    }

    /**
     * Read and parse machine.dat.
     * Returns null on any failure — never throws.
     *
     * @returns {{ version: number, machineId: string, installDate: string,
     *             firstInstallDetected: boolean, activationCount: number,
     *             lastLaunch: string|null, lastVersion: string,
     *             updatedAt: string, hmac: string } | null}
     */
    readMachine() {
        return this._readJson(this._paths.machineFile);
    }

    /**
     * Atomically write machine state to machine.dat.
     *
     * @param {object} machineData
     * @throws {Error} if the write fails
     */
    writeMachine(machineData) {
        if (!machineData || typeof machineData !== 'object') {
            throw new Error('LicenseStorage.writeMachine: machineData must be an object');
        }
        if (!machineData.machineId || !machineData.installDate) {
            throw new Error('LicenseStorage.writeMachine: machineId and installDate are required');
        }

        const json = JSON.stringify(machineData, null, 2);
        this._atomicWrite(this._paths.machineFile, json);
    }

    /**
     * Delete machine.dat. Silent no-op if file does not exist.
     * USE WITH CAUTION — deleting machine.dat removes the first-install marker.
     */
    deleteMachine() {
        this._silentUnlink(this._paths.machineFile);
    }

    // ════════════════════════════════════════════════════════════════════════
    // activation.dat — encrypted activation record (enterprise hardening)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Check whether activation.dat exists on disk.
     * @returns {boolean}
     */
    activationRecordExists() {
        return fs.existsSync(this._paths.activationFile);
    }

    /**
     * Read and parse the encrypted activation record.
     * Returns null on any failure — never throws.
     *
     * Structure (encrypted):
     *   {
     *     licenseId:              string,
     *     machineId:              string,
     *     firstActivationTime:    string (ISO UTC),
     *     lastValidationTime:     string (ISO UTC),
     *     activationCount:        number,
     *     hmac:                   string (hex),
     *   }
     *
     * @returns {object|null}
     */
    readActivationRecord() {
        return this._readJson(this._paths.activationFile);
    }

    /**
     * Atomically write the encrypted activation record.
     * The HMAC field must already be computed by the caller (LicenseManager).
     *
     * @param {object} activationData
     * @throws {Error} if the write fails
     */
    writeActivationRecord(activationData) {
        if (!activationData || typeof activationData !== 'object') {
            throw new Error('LicenseStorage.writeActivationRecord: activationData must be an object');
        }
        if (!activationData.licenseId || !activationData.machineId || !activationData.hmac) {
            throw new Error('LicenseStorage.writeActivationRecord: licenseId, machineId, and hmac are required');
        }

        const json = JSON.stringify(activationData, null, 2);
        this._atomicWrite(this._paths.activationFile, json);
    }

    /**
     * Delete activation.dat. Silent no-op if file does not exist.
     * USE WITH EXTREME CAUTION — removes first-activation record.
     */
    deleteActivationRecord() {
        this._silentUnlink(this._paths.activationFile);
    }

    // ════════════════════════════════════════════════════════════════════════
    // activation.log
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Append a structured entry to activation.log.
     *
     * Format:  TIMESTAMP | EVENT | key1=val1 key2=val2 ...
     * Example: 2026-08-05T09:00:00.000Z | FIRST_INSTALL | machineId=A3F9-B2C1 version=1.0.0
     *
     * This method is intentionally best-effort. A log write failure must
     * never prevent the application from starting.
     *
     * @param {string} event   - One of ACTIVATION_LOG_EVENTS
     * @param {object} [fields] - Key-value pairs to include in the log line
     */
    appendActivationLog(event, fields = {}) {
        try {
            const timestamp = new Date().toISOString();
            const fieldStr  = Object.entries(fields)
                .map(([k, v]) => `${k}=${String(v).replace(/[\r\n|]/g, ' ')}`)
                .join(' ');
            const line = fieldStr
                ? `${timestamp} | ${event} | ${fieldStr}\n`
                : `${timestamp} | ${event}\n`;

            fs.appendFileSync(this._paths.activationLog, line, { encoding: 'utf8' });
        } catch {
            // Log write failure is non-fatal — never propagate
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private helpers
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Read and JSON-parse a file. Returns null on any error — never throws.
     * @param {string} filePath
     * @returns {object|null}
     */
    _readJson(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const raw    = fs.readFileSync(filePath, { encoding: 'utf8' });
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    /**
     * Write JSON string atomically: write to .tmp file then rename.
     * If the rename fails, the .tmp file is cleaned up.
     * File permissions set to owner read/write only (0o600).
     *
     * @param {string} filePath  - Target file path
     * @param {string} json      - Serialised content to write
     * @throws {Error} on write or rename failure
     */
    _atomicWrite(filePath, json) {
        const tmpPath = filePath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tmpPath, filePath);
        } catch (err) {
            // Clean up orphaned .tmp file — best effort
            try { fs.unlinkSync(tmpPath); } catch {}
            throw err;
        }
    }

    /**
     * Write a timestamped backup of license.dat.
     * Keeps at most 5 backups — oldest are pruned.
     * Silent on any failure.
     *
     * @param {string} json
     */
    _writeLicenseBackup(json) {
        try {
            const ts         = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = require('path').join(
                this._paths.licenseBackupDir,
                `license_${ts}.dat`
            );
            fs.writeFileSync(backupPath, json, { encoding: 'utf8', mode: 0o600 });
            this._pruneBackups(5);
        } catch {
            // Backup failure is non-fatal
        }
    }

    /**
     * Remove the oldest backup files from licenseBackupDir,
     * keeping at most maxKeep files.
     *
     * @param {number} maxKeep
     */
    _pruneBackups(maxKeep) {
        try {
            const backupDir = this._paths.licenseBackupDir;
            const pathMod   = require('path');

            const files = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('license_') && f.endsWith('.dat'))
                .map(f => ({
                    name:  f,
                    mtime: fs.statSync(pathMod.join(backupDir, f)).mtime.getTime(),
                }))
                .sort((a, b) => a.mtime - b.mtime);   // oldest first

            while (files.length > maxKeep) {
                const oldest = files.shift();
                fs.unlinkSync(pathMod.join(backupDir, oldest.name));
            }
        } catch {
            // Prune failure is non-fatal
        }
    }

    /**
     * Unlink a file silently (no error on missing file).
     * @param {string} filePath
     */
    _silentUnlink(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch {
            // Silent
        }
    }
}

module.exports = LicenseStorage;
