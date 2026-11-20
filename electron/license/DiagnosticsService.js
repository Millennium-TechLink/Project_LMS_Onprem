/**
 * DiagnosticsService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Collects and exports a professional support bundle ZIP.
 *
 * The bundle is saved to:
 *   %LOCALAPPDATA%\Lab Management System\diagnostics\
 *   lms-diagnostics-YYYY-MM-DD-HHmmss.zip
 *
 * Bundle contents:
 *   electron.log          ← last 500 lines of Electron main process log
 *   backend.log           ← last 500 lines of backend log
 *   activation.log        ← complete audit trail (append-only)
 *   license-summary.txt   ← safe license info (no signatures)
 *   system-info.json      ← versions, paths, OS info, machine ID
 *   machine-info.txt      ← machine.dat summary (no HMAC)
 *
 * Design decisions:
 *   - Zero npm dependencies. Uses only Node.js built-ins (fs, zlib, path, os).
 *   - ZIP written manually using the ZIP local file format (PKZIP spec).
 *     DEFLATE compression via Node's built-in zlib.deflateRawSync().
 *   - Sensitive data excluded: no HMAC values, no ECDSA signatures,
 *     no DATABASE_URL, no JWT_SECRET_KEY, no API keys from .env.
 *   - Each export is a new file — existing bundles are never overwritten.
 *   - Keeps at most 10 diagnostics bundles; oldest pruned automatically.
 *   - collectBundle() never throws — all errors are caught and returned
 *     as { success: false, message: '...' }.
 *
 * Usage:
 *   const diag = new DiagnosticsService(pathResolver, licenseManager, appVersion);
 *   const result = await diag.collectBundle();
 *   // result: { success, filePath, sizeBytes, message }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');

// Maximum lines to include from each log file
const MAX_LOG_LINES = 500;

// Maximum diagnostics bundles to keep before pruning
const MAX_BUNDLES = 10;

class DiagnosticsService {

    /**
     * @param {import('./PathResolver')} pathResolver
     * @param {import('./LicenseManager')} licenseManager
     * @param {string} appVersion   - from app.getVersion()
     * @param {string} electronVersion - from process.versions.electron
     */
    constructor(pathResolver, licenseManager, appVersion, electronVersion) {
        if (!pathResolver || typeof pathResolver.diagnosticsDir !== 'string') {
            throw new Error('DiagnosticsService: valid PathResolver required');
        }
        this._paths            = pathResolver;
        this._licenseManager   = licenseManager;
        this._appVersion       = appVersion       || '0.0.0';
        this._electronVersion  = electronVersion  || process.versions.electron || 'unknown';
    }

    // ════════════════════════════════════════════════════════════════════════
    // Public API
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Collect all diagnostic data and write a ZIP bundle.
     *
     * @returns {Promise<{ success: boolean, filePath?: string, sizeBytes?: number, message: string }>}
     */
    async collectBundle() {
        try {
            const timestamp   = new Date().toISOString()
                .replace(/[:.]/g, '-')
                .replace('T', '-');  // keeps full precision including ms
            const fileName    = `lms-diagnostics-${timestamp}.zip`;
            const outputPath  = path.join(this._paths.diagnosticsDir, fileName);

            fs.mkdirSync(this._paths.diagnosticsDir, { recursive: true });

            // ── Collect all files to bundle ───────────────────────────────
            const files = await this._collectFiles();

            // ── Write ZIP ─────────────────────────────────────────────────
            const zipBuffer = this._buildZip(files);
            fs.writeFileSync(outputPath, zipBuffer);

            // ── Prune old bundles ─────────────────────────────────────────
            this._pruneBundles();

            const sizeBytes = fs.statSync(outputPath).size;
            const sizeKB    = Math.round(sizeBytes / 1024);

            return {
                success:   true,
                filePath:  outputPath,
                sizeBytes,
                message:   `Diagnostics bundle created (${sizeKB} KB): ${fileName}`,
            };

        } catch (err) {
            return {
                success: false,
                message: `Failed to create diagnostics bundle: ${err.message}`,
            };
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Data collection
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Collect all bundle entries.
     * Each entry: { name: string, content: string }
     * Never throws — missing files produce placeholder content.
     *
     * @returns {Promise<Array<{ name: string, content: string }>>}
     */
    async _collectFiles() {
        const files = [];

        // ── electron.log (last 500 lines) ─────────────────────────────────
        files.push({
            name:    'electron.log',
            content: this._tailFile(this._paths.electronLog, MAX_LOG_LINES),
        });

        // ── backend.log (last 500 lines) ──────────────────────────────────
        files.push({
            name:    'backend.log',
            content: this._tailFile(this._paths.backendLog, MAX_LOG_LINES),
        });

        // ── activation.log (complete — it's the audit trail) ──────────────
        files.push({
            name:    'activation.log',
            content: this._readFileSafe(this._paths.activationLog),
        });

        // ── license-summary.txt ───────────────────────────────────────────
        files.push({
            name:    'license-summary.txt',
            content: await this._buildLicenseSummary(),
        });

        // ── system-info.json ──────────────────────────────────────────────
        files.push({
            name:    'system-info.json',
            content: await this._buildSystemInfo(),
        });

        // ── machine-info.txt ──────────────────────────────────────────────
        files.push({
            name:    'machine-info.txt',
            content: this._buildMachineInfo(),
        });

        return files;
    }

    // ── Individual collectors ─────────────────────────────────────────────

    /**
     * Build a human-readable license summary.
     * Intentionally excludes: HMAC signatures, vendor signatures, raw key material.
     */
    async _buildLicenseSummary() {
        try {
            const info = this._licenseManager
                ? await this._licenseManager.getLicenseInfo()
                : null;

            if (!info) return 'License information unavailable.';

            const lines = [
                '═══ LMS License Summary ═══════════════════════════════════',
                `Generated At      : ${new Date().toISOString()}`,
                `Application       : Lab Management System v${this._appVersion}`,
                `Electron Version  : ${this._electronVersion}`,
                '',
                '── License ──────────────────────────────────────────────────',
                `Type              : ${info.licenseType  || 'Unknown'}`,
                `Status            : ${info.status       || 'Unknown'}`,
                `Edition           : ${info.edition      || 'N/A'}`,
                `Expiry Date       : ${info.expiryDate   || 'N/A'}`,
                `Days Remaining    : ${Number.isFinite(info.daysRemaining)
                    ? info.daysRemaining
                    : (info.daysRemaining === Infinity ? 'Unlimited' : '0')}`,
                `License ID        : ${info.licenseId    || 'N/A (trial)'}`,
                `Activation Count  : ${info.activationCount ?? 0}`,
                `Last Launch       : ${info.lastLaunch   || 'N/A'}`,
                `Last Version      : ${info.lastVersion  || 'N/A'}`,
                '',
                '── Machine ──────────────────────────────────────────────────',
                `Machine ID        : ${info.machineId || 'Unknown'}`,
                `Install Date      : ${info.installDate  || 'Unknown'}`,
                '',
                '── Customer ─────────────────────────────────────────────────',
                `Name              : ${info.customerName    || 'N/A'}`,
                `Company           : ${info.customerCompany || 'N/A'}`,
                '',
                '── NOTE ─────────────────────────────────────────────────────',
                'This summary excludes cryptographic signatures and key material.',
                'Share this file with Millennium TechLink support.',
                '═════════════════════════════════════════════════════════════',
            ];
            return lines.join('\n');
        } catch (err) {
            return `Error collecting license info: ${err.message}`;
        }
    }

    /**
     * Build a JSON system information object.
     * Excludes: DATABASE_URL, JWT secrets, API keys, passwords from .env.
     */
    async _buildSystemInfo() {
        try {
            const info = this._licenseManager
                ? await this._licenseManager.getLicenseInfo()
                : {};

            const systemInfo = {
                generatedAt:  new Date().toISOString(),
                application: {
                    name:            'Lab Management System',
                    version:         this._appVersion,
                    electronVersion: this._electronVersion,
                    nodeVersion:     process.versions.node,
                    v8Version:       process.versions.v8,
                    platform:        process.platform,
                    arch:            process.arch,
                },
                license: {
                    type:            info.licenseType   || null,
                    status:          info.status         || null,
                    daysRemaining:   Number.isFinite(info.daysRemaining)
                                         ? info.daysRemaining
                                         : 'Unlimited',
                    expiryDate:      info.expiryDate     || null,
                    machineId:       info.machineId || null,
                    edition:         info.edition         || null,
                    activationCount: info.activationCount ?? 0,
                },
                system: {
                    hostname:    os.hostname(),
                    osType:      os.type(),
                    osRelease:   os.release(),
                    osPlatform:  os.platform(),
                    totalMemMB:  Math.round(os.totalmem() / 1024 / 1024),
                    freeMemMB:   Math.round(os.freemem()  / 1024 / 1024),
                    cpuModel:    os.cpus().length > 0 ? os.cpus()[0].model : 'Unknown',
                    cpuCount:    os.cpus().length,
                    uptime:      Math.round(os.uptime()),
                    timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
                paths: this._paths.toDisplayObject(),
                directoryStatus: this._checkDirectories(),
            };

            return JSON.stringify(systemInfo, null, 2);
        } catch (err) {
            return JSON.stringify({ error: `Failed to collect system info: ${err.message}` });
        }
    }

    /**
     * Build a human-readable machine.dat summary.
     * Excludes the HMAC field.
     */
    _buildMachineInfo() {
        try {
            const machineFile = this._paths.machineFile;
            if (!fs.existsSync(machineFile)) {
                return 'machine.dat not found — application has not been initialised on this machine.';
            }

            const raw  = fs.readFileSync(machineFile, 'utf8');
            const data = JSON.parse(raw);

            // Exclude HMAC from output — it's internal crypto material
            const { hmac: _hmac, ...safeData } = data;

            const lines = [
                '═══ Machine State (machine.dat) ════════════════════════════',
                `Schema Version        : ${safeData.version             || 'N/A'}`,
                `Machine ID           : ${safeData.machineId           || 'N/A'}`,
                `Install Date          : ${safeData.installDate         || 'N/A'}`,
                `First Install         : ${safeData.firstInstallDetected ?? 'N/A'}`,
                `Activation Count      : ${safeData.activationCount     ?? 0}`,
                `Last Launch           : ${safeData.lastLaunch          || 'Never'}`,
                `Last Version          : ${safeData.lastVersion         || 'N/A'}`,
                `Updated At            : ${safeData.updatedAt           || 'N/A'}`,
                '',
                'NOTE: HMAC field excluded for security.',
                '═════════════════════════════════════════════════════════════',
            ];
            return lines.join('\n');
        } catch (err) {
            return `Error reading machine.dat: ${err.message}`;
        }
    }

    /**
     * Check which application directories exist and their sizes.
     * @returns {object}
     */
    _checkDirectories() {
        const dirs = this._paths.toDisplayObject();
        const result = {};
        for (const [key, dirPath] of Object.entries(dirs)) {
            try {
                const exists = fs.existsSync(dirPath);
                let fileCount = 0;
                if (exists) {
                    fileCount = fs.readdirSync(dirPath).length;
                }
                result[key] = { exists, fileCount, path: dirPath };
            } catch {
                result[key] = { exists: false, fileCount: 0, path: dirPath };
            }
        }
        return result;
    }

    // ════════════════════════════════════════════════════════════════════════
    // ZIP builder — pure Node.js, no npm dependencies
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Build a ZIP archive buffer from an array of { name, content } entries.
     *
     * Implements PKZIP local file format:
     *   - Local file headers + DEFLATE-compressed data for each entry
     *   - Central directory at end
     *   - End of central directory record
     *
     * @param {Array<{ name: string, content: string }>} entries
     * @returns {Buffer}
     */
    _buildZip(entries) {
        const parts          = [];
        const centralDirs    = [];
        let   offset         = 0;

        for (const entry of entries) {
            const nameBuffer    = Buffer.from(entry.name,    'utf8');
            const contentBuffer = Buffer.from(entry.content, 'utf8');
            const compressed    = zlib.deflateRawSync(contentBuffer, { level: 6 });
            const crc32         = this._crc32(contentBuffer);
            const now           = new Date();
            const dosDate       = this._toDosDate(now);
            const dosTime       = this._toDosTime(now);

            // ── Local file header (30 bytes + name) ──────────────────────
            const localHeader = Buffer.allocUnsafe(30 + nameBuffer.length);
            localHeader.writeUInt32LE(0x04034b50,            0);  // Local file header signature
            localHeader.writeUInt16LE(20,                    4);  // Version needed: 2.0
            localHeader.writeUInt16LE(0,                     6);  // General purpose bit flag
            localHeader.writeUInt16LE(8,                     8);  // Compression: DEFLATE
            localHeader.writeUInt16LE(dosTime,              10);  // Last mod time
            localHeader.writeUInt16LE(dosDate,              12);  // Last mod date
            localHeader.writeUInt32LE(crc32,                14);  // CRC-32
            localHeader.writeUInt32LE(compressed.length,   18);  // Compressed size
            localHeader.writeUInt32LE(contentBuffer.length, 22);  // Uncompressed size
            localHeader.writeUInt16LE(nameBuffer.length,   26);  // File name length
            localHeader.writeUInt16LE(0,                   28);  // Extra field length
            nameBuffer.copy(localHeader, 30);

            parts.push(localHeader);
            parts.push(compressed);

            // ── Central directory entry (46 bytes + name) ─────────────────
            const centralEntry = Buffer.allocUnsafe(46 + nameBuffer.length);
            centralEntry.writeUInt32LE(0x02014b50,            0);  // Central dir signature
            centralEntry.writeUInt16LE(20,                    4);  // Version made by
            centralEntry.writeUInt16LE(20,                    6);  // Version needed
            centralEntry.writeUInt16LE(0,                     8);  // General purpose bit flag
            centralEntry.writeUInt16LE(8,                    10);  // Compression: DEFLATE
            centralEntry.writeUInt16LE(dosTime,              12);  // Last mod time
            centralEntry.writeUInt16LE(dosDate,              14);  // Last mod date
            centralEntry.writeUInt32LE(crc32,                16);  // CRC-32
            centralEntry.writeUInt32LE(compressed.length,   20);  // Compressed size
            centralEntry.writeUInt32LE(contentBuffer.length, 24);  // Uncompressed size
            centralEntry.writeUInt16LE(nameBuffer.length,   28);  // File name length
            centralEntry.writeUInt16LE(0,                   30);  // Extra field length
            centralEntry.writeUInt16LE(0,                   32);  // Comment length
            centralEntry.writeUInt16LE(0,                   34);  // Disk number start
            centralEntry.writeUInt16LE(0,                   36);  // Internal attributes
            centralEntry.writeUInt32LE(0,                   38);  // External attributes
            centralEntry.writeUInt32LE(offset,              42);  // Relative offset of local header
            nameBuffer.copy(centralEntry, 46);

            centralDirs.push(centralEntry);
            offset += localHeader.length + compressed.length;
        }

        const centralDirBuffer = Buffer.concat(centralDirs);
        const centralDirOffset = offset;
        const centralDirSize   = centralDirBuffer.length;

        // ── End of central directory record (22 bytes) ────────────────────
        const endRecord = Buffer.allocUnsafe(22);
        endRecord.writeUInt32LE(0x06054b50,          0);  // End of central dir signature
        endRecord.writeUInt16LE(0,                   4);  // Disk number
        endRecord.writeUInt16LE(0,                   6);  // Disk with central dir
        endRecord.writeUInt16LE(entries.length,      8);  // Entries on this disk
        endRecord.writeUInt16LE(entries.length,     10);  // Total entries
        endRecord.writeUInt32LE(centralDirSize,     12);  // Central dir size
        endRecord.writeUInt32LE(centralDirOffset,   16);  // Central dir offset
        endRecord.writeUInt16LE(0,                  20);  // Comment length

        return Buffer.concat([...parts, centralDirBuffer, endRecord]);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Utility methods
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Read a file safely. Returns placeholder text on any error.
     * @param {string} filePath
     * @returns {string}
     */
    _readFileSafe(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return `File not found: ${filePath}`;
            }
            return fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            return `Error reading ${path.basename(filePath)}: ${err.message}`;
        }
    }

    /**
     * Read the last N lines of a file.
     * @param {string} filePath
     * @param {number} maxLines
     * @returns {string}
     */
    _tailFile(filePath, maxLines) {
        try {
            if (!fs.existsSync(filePath)) {
                return `File not found: ${filePath}`;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lines   = content.split('\n');
            const tail    = lines.slice(-maxLines);
            const header  = lines.length > maxLines
                ? `[Showing last ${maxLines} of ${lines.length} lines]\n\n`
                : '';
            return header + tail.join('\n');
        } catch (err) {
            return `Error reading ${path.basename(filePath)}: ${err.message}`;
        }
    }

    /**
     * Remove oldest diagnostics bundles keeping at most MAX_BUNDLES.
     * Sorts by filename (which embeds an ISO timestamp) for stable ordering.
     */
    _pruneBundles() {
        try {
            const dir   = this._paths.diagnosticsDir;
            const files = fs.readdirSync(dir)
                .filter(f => f.startsWith('lms-diagnostics-') && f.endsWith('.zip'))
                .sort();   // lexicographic = chronological because names are ISO-based

            while (files.length > MAX_BUNDLES) {
                const oldest = files.shift();
                fs.unlinkSync(path.join(dir, oldest));
            }
        } catch {
            // Prune failure is non-fatal
        }
    }

    /**
     * CRC-32 calculation (PKZIP standard, polynomial 0xEDB88320).
     * @param {Buffer} buf
     * @returns {number}
     */
    _crc32(buf) {
        // Build CRC table once per instance
        if (!DiagnosticsService._crcTable) {
            const table = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) {
                    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                }
                table[i] = c;
            }
            DiagnosticsService._crcTable = table;
        }

        const table = DiagnosticsService._crcTable;
        let   crc   = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * Convert a Date to MS-DOS date format (16-bit).
     * @param {Date} date
     * @returns {number}
     */
    _toDosDate(date) {
        return ((date.getFullYear() - 1980) << 9) |
               ((date.getMonth() + 1) << 5) |
               date.getDate();
    }

    /**
     * Convert a Date to MS-DOS time format (16-bit).
     * @param {Date} date
     * @returns {number}
     */
    _toDosTime(date) {
        return (date.getHours() << 11) |
               (date.getMinutes() << 5) |
               Math.floor(date.getSeconds() / 2);
    }
}

module.exports = DiagnosticsService;
