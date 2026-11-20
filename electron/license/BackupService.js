'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');
const { restrictToCurrentUser } = require('./FilePermissions');

// Same candidates as main.js's ensureRuntimeEnv().
function bakedEnvCandidates() {
    if (!app.isPackaged) return [];
    return [
        path.join(process.resourcesPath, 'backend', '.env'),
        path.join(process.resourcesPath, 'backend', '_internal', '.env'),
    ];
}

// Same check as main.js's ensureRuntimeEnv() - a restored .env should come
// back with the same lock a normal boot would have applied.
function isBakedBuild() {
    return bakedEnvCandidates().some(c => fs.existsSync(c));
}

class BackupService {
    /**
     * @param {object} opts
     * @param {import('./PathResolver')} opts.pathResolver
     * @param {Function} [opts.log]
     * @param {import('./InstallLogger')} [opts.installLogger]
     */
    constructor({ pathResolver, log, installLogger }) {
        if (!pathResolver || typeof pathResolver.backupsDir !== 'string') {
            throw new Error('BackupService: a valid PathResolver instance is required.');
        }
        this._paths = pathResolver;
        this._logFn = log || (() => {});
        this._installLogger = installLogger;

        this._log = (msg) => {
            this._logFn(msg);
            if (this._installLogger) this._installLogger.info(msg);
        };
    }

    // Keeps main.js's ensureRuntimeEnv() from undoing this restore on the next
    // launch: it refreshes the runtime .env whenever the baked resources copy's
    // hash doesn't match ".env.bake-hash". A restore intentionally puts back a
    // .env that may predate the currently-installed build's bake (e.g. an
    // auto-rollback to a pre-upgrade backup after a failed update), so the
    // marker must be re-synced to "this build's bake is already accounted for"
    // - otherwise that refresh would immediately overwrite the restored file.
    _syncBakeHashMarker() {
        const markerPath = path.join(this._paths.backendConfigDir, '.env.bake-hash');
        try {
            const bakedSrc = bakedEnvCandidates().find(c => fs.existsSync(c));
            if (bakedSrc) {
                const hash = crypto.createHash('sha256').update(fs.readFileSync(bakedSrc)).digest('hex');
                fs.writeFileSync(markerPath, hash, 'utf8');
            } else if (fs.existsSync(markerPath)) {
                fs.unlinkSync(markerPath);
            }
        } catch (err) {
            this._log(`[Backup] Could not sync .env.bake-hash marker: ${err.message}`);
        }
    }

    async _getDatabaseUrl() {
        const envPath = path.join(this._paths.backendConfigDir, '.env');
        if (!fs.existsSync(envPath)) return null;
        const raw = await fs.promises.readFile(envPath);
        // After the first healthy start the .env is DPAPI-encrypted; only the backend's env_crypto can read it
        if (raw.subarray(0, 7).toString('latin1') === 'DPAPI1:') return this._getDatabaseUrlFromEncrypted(envPath);
        const match = raw.toString('utf8').match(/^DATABASE_URL\s*=\s*(.+)$/m);
        return match ? match[1].trim() : null;
    }

    _getDatabaseUrlFromEncrypted(envPath) {
        const res = process.resourcesPath || '';
        const candidates = [
            [path.join(res, 'backend', 'python', 'python.exe'), path.join(res, 'backend', 'app', 'core', 'env_crypto.pyc')],
            [process.env.LMS_PYTHON || 'python', path.join(__dirname, '..', '..', '..', 'backend', 'app', 'core', 'env_crypto.py')],
        ];
        for (const [python, script] of candidates) {
            if (!fs.existsSync(script)) continue;
            const r = spawnSync(python, [script, 'dburl', envPath], { encoding: 'utf8' });
            if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
        }
        return null;
    }

    _runPgDump(dbUrl, outputPath) {
        return new Promise((resolve, reject) => {
            const proc = spawn('pg_dump', ['--format=custom', '--file', outputPath, dbUrl], { stdio: 'ignore' });
            proc.on('error', (err) => {
                reject(new Error(`pg_dump error: ${err.message}. Is PostgreSQL installed and in PATH?`));
            });
            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`pg_dump exited with code ${code}`));
            });
        });
    }

    _runPgRestore(dbUrl, inputPath) {
        return new Promise((resolve, reject) => {
            const proc = spawn('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', dbUrl, inputPath], { stdio: 'ignore' });
            proc.on('error', (err) => {
                reject(new Error(`pg_restore error: ${err.message}. Is PostgreSQL installed and in PATH?`));
            });
            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`pg_restore exited with code ${code}`));
            });
        });
    }

    async _copyDir(src, dest) {
        if (!fs.existsSync(src)) return;
        await fs.promises.mkdir(dest, { recursive: true });
        const entries = await fs.promises.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'backups') continue; // Avoid recursive backup if backups are somehow inside these dirs
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                await this._copyDir(srcPath, destPath);
            } else {
                await fs.promises.copyFile(srcPath, destPath);
            }
        }
    }

    async createFullBackup() {
        this._log('Backup started');
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupName = `backup_${timestamp}`;
            const backupDir = path.join(this._paths.backupsDir, backupName);
            
            await fs.promises.mkdir(backupDir, { recursive: true });
            
            const dbDir = path.join(backupDir, 'database');
            const uploadsDir = path.join(backupDir, 'uploads');
            const exportsDir = path.join(backupDir, 'exports');
            const configDir = path.join(backupDir, 'config');
            const licenseDir = path.join(backupDir, 'license');
            
            await fs.promises.mkdir(dbDir);
            await fs.promises.mkdir(uploadsDir);
            await fs.promises.mkdir(exportsDir);
            await fs.promises.mkdir(configDir);
            await fs.promises.mkdir(licenseDir);
            
            // 1. Database Backup
            this._log('Database backup started');
            const dbUrl = await this._getDatabaseUrl();
            if (!dbUrl) {
                throw new Error('DATABASE_URL not found in .env');
            }
            
            const dumpPath = path.join(dbDir, 'database.dump');
            await this._runPgDump(dbUrl, dumpPath);
            this._log('Database backup completed');
            
            // 2. Uploads and Exports
            this._log('Files backup started');
            await this._copyDir(this._paths.uploadsDir, uploadsDir);
            await this._copyDir(this._paths.exportsDir, exportsDir);
            this._log('Files backup completed');
            
            // 3. Config (.env)
            const envPath = path.join(this._paths.backendConfigDir, '.env');
            if (fs.existsSync(envPath)) {
                await fs.promises.copyFile(envPath, path.join(configDir, '.env'));
            }
            
            // 4. License files
            await this._copyDir(this._paths.licenseDir, licenseDir);
            this._log('License backup completed');
            
            // 5. Metadata
            const metadata = {
                backupVersion: 1,
                createdAt: new Date().toISOString(),
                applicationVersion: '1.0.0', // Using generic 1.0.0 if app version isn't directly passed
                databaseBackup: true,
                uploadsBackup: true,
                exportsBackup: true
            };
            await fs.promises.writeFile(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
            
            this._log('Backup completed');
            
            return {
                success: true,
                message: 'Full backup completed successfully.',
                backupDir
            };
        } catch (err) {
            this._log(`[Backup] Failed: ${err.message}`);
            return { success: false, message: `Backup failed: ${err.message}` };
        }
    }

    async validateBackup(backupDir) {
        this._log('Backup validation started');
        try {
            if (!fs.existsSync(backupDir)) {
                throw new Error('Backup directory does not exist.');
            }
            const metadataPath = path.join(backupDir, 'metadata.json');
            if (!fs.existsSync(metadataPath)) {
                throw new Error('metadata.json missing.');
            }
            
            const dbPath = path.join(backupDir, 'database', 'database.dump');
            if (!fs.existsSync(dbPath)) {
                throw new Error('database.dump missing.');
            }
            
            if (!fs.existsSync(path.join(backupDir, 'uploads'))) {
                throw new Error('uploads directory missing.');
            }
            
            if (!fs.existsSync(path.join(backupDir, 'exports'))) {
                throw new Error('exports directory missing.');
            }
            
            if (!fs.existsSync(path.join(backupDir, 'config', '.env'))) {
                throw new Error('config/.env missing.');
            }
            
            if (!fs.existsSync(path.join(backupDir, 'license'))) {
                throw new Error('license directory missing.');
            }
            
            this._log('Backup validation successful');
            return { success: true, message: 'Backup is valid.' };
        } catch (err) {
            return { success: false, message: `Backup invalid: ${err.message}` };
        }
    }

    /**
     * @param {string} backupDir
     * @param {object} [opts]
     * @param {boolean} [opts.includeDatabase=true] - false for an automatic,
     *   unattended restore; only true after the user explicitly confirms.
     */
    async restoreBackup(backupDir, { backendManager, backendStartConfig, licenseManager, includeDatabase = true } = {}) {
        this._log('Restore started');

        try {
            // 1. Validate
            const validation = await this.validateBackup(backupDir);
            if (!validation.success) {
                this._log('Backup validation failed');
                return validation; // Failed
            }
            this._log('Backup validation successful');

            // 2. Stop backend
            if (backendManager) {
                this._log('Backend stopped');
                await backendManager.stop();
            }

            // 3. Database restore
            if (includeDatabase) {
                this._log('Database restore started');
                const dbUrl = await this._getDatabaseUrl();
                if (!dbUrl) {
                    throw new Error('DATABASE_URL not found.');
                }
                const dbPath = path.join(backupDir, 'database', 'database.dump');
                try {
                    await this._runPgRestore(dbUrl, dbPath);
                    this._log('Database restore completed');
                } catch (err) {
                    throw new Error(`Database restore failed: ${err.message}`);
                }
            } else {
                this._log('Database restore skipped (includeDatabase=false)');
            }

            // 4. Restore files (uploads, exports)
            await this._copyDir(path.join(backupDir, 'uploads'), this._paths.uploadsDir);
            await this._copyDir(path.join(backupDir, 'exports'), this._paths.exportsDir);
            this._log('Files restored');

            // 5. Restore .env with safety copy
            const currentEnv = path.join(this._paths.backendConfigDir, '.env');
            const backupEnv = path.join(backupDir, 'config', '.env');
            const tempEnv = currentEnv + '.bak';
            try {
                if (fs.existsSync(currentEnv)) {
                    await fs.promises.copyFile(currentEnv, tempEnv);
                }
                await fs.promises.copyFile(backupEnv, currentEnv);
                restrictToCurrentUser(currentEnv, this._log, { readOnly: isBakedBuild() });
                this._syncBakeHashMarker();
                this._log('Configuration restored');
            } catch (err) {
                // Rollback .env
                if (fs.existsSync(tempEnv)) {
                    await fs.promises.copyFile(tempEnv, currentEnv);
                }
                throw new Error(`Failed to restore .env: ${err.message}`);
            } finally {
                if (fs.existsSync(tempEnv)) {
                    await fs.promises.unlink(tempEnv).catch(() => {});
                }
            }

            // 6. Restore license with validation and safety copy
            let shouldRestoreLicense = true;
            if (licenseManager) {
                const currentStatus = await licenseManager.checkLicense();
                if (currentStatus.result && currentStatus.result.valid) {
                    shouldRestoreLicense = false;
                    this._log('Current license is valid, skipping license restore.');
                }
            }

            if (shouldRestoreLicense) {
                this._log('Restoring license from backup...');
                const backupLicenseDir = path.join(backupDir, 'license');
                const tempLicenseDir = this._paths.licenseDir + '_bak';
                try {
                    // Safety copy of current license dir
                    if (fs.existsSync(this._paths.licenseDir)) {
                        await this._copyDir(this._paths.licenseDir, tempLicenseDir);
                    }
                    
                    // Overwrite with backup license
                    await this._copyDir(backupLicenseDir, this._paths.licenseDir);
                    
                    // Validate restored license
                    if (licenseManager) {
                        const restoredStatus = await licenseManager.checkLicense();
                        if (!restoredStatus.result || !restoredStatus.result.valid) {
                            throw new Error(`Backup license is invalid: ${restoredStatus.result ? restoredStatus.result.code : 'Unknown'}`);
                        }
                    }
                    this._log('License validation completed');
                } catch (err) {
                    this._log(`License restore failed: ${err.message}. Rolling back to previous license.`);
                    // Rollback
                    if (fs.existsSync(tempLicenseDir)) {
                        await this._copyDir(tempLicenseDir, this._paths.licenseDir);
                    }
                } finally {
                    if (fs.existsSync(tempLicenseDir)) {
                        await fs.promises.rm(tempLicenseDir, { recursive: true, force: true }).catch(() => {});
                    }
                }
            }

            // 7. Start backend
            if (backendManager && backendStartConfig) {
                this._log('Backend restarted');
                await backendManager.start(backendStartConfig.command, backendStartConfig.args, backendStartConfig.options);
                await backendManager.waitUntilReady();
                this._log('Health check successful');
            }

            this._log('Restore completed');
            return { success: true, message: 'Backup restored successfully.' };

        } catch (err) {
            this._log(`[Backup] Restore Failed: ${err.message}`);
            return { success: false, message: `Restore failed: ${err.message}` };
        }
    }

    listBackups() {
        if (!fs.existsSync(this._paths.backupsDir)) return [];
        const entries = fs.readdirSync(this._paths.backupsDir, { withFileTypes: true });
        return entries
            .filter(e => e.isDirectory() && e.name.startsWith('backup_'))
            .map(e => {
                const dir = path.join(this._paths.backupsDir, e.name);
                let metadata = {};
                try {
                    metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
                } catch (err) {}
                return {
                    name: e.name,
                    path: dir,
                    createdAt: metadata.createdAt || null
                };
            })
            .sort((a, b) => b.name.localeCompare(a.name)); // newest first
    }

    getStatus() {
        const backups = this.listBackups();
        return {
            count: backups.length,
            latest: backups.length > 0 ? backups[0].createdAt : null,
        };
    }

    // Written by installer.nsh's customInstall macro on every real reinstall.
    // Fallback source when listBackups() (the backup_* format) is empty.
    listPreUpgradeBackups() {
        if (!fs.existsSync(this._paths.backupsDir)) return [];
        const entries = fs.readdirSync(this._paths.backupsDir, { withFileTypes: true });
        return entries
            .filter(e => e.isDirectory() && e.name.startsWith('pre-upgrade-'))
            .map(e => ({ name: e.name, path: path.join(this._paths.backupsDir, e.name) }))
            .sort((a, b) => b.name.localeCompare(a.name)); // newest first (timestamp is sortable as text)
    }

    // Restores .env/uploads/exports from a pre-upgrade-<ts> backup - no
    // database, that format never included one.
    async restoreFromPreUpgradeBackup(backupDir) {
        this._log(`Restore started (pre-upgrade backup: ${path.basename(backupDir)})`);
        try {
            const backupEnv = path.join(backupDir, '.env');
            if (fs.existsSync(backupEnv)) {
                const currentEnv = path.join(this._paths.backendConfigDir, '.env');
                await fs.promises.mkdir(path.dirname(currentEnv), { recursive: true });
                await fs.promises.copyFile(backupEnv, currentEnv);
                restrictToCurrentUser(currentEnv, this._log, { readOnly: isBakedBuild() });
                this._syncBakeHashMarker();
            }
            await this._copyDir(path.join(backupDir, 'uploads'), this._paths.uploadsDir);
            await this._copyDir(path.join(backupDir, 'exports'), this._paths.exportsDir);
            this._log('Restore completed');
            return { success: true, message: 'Restored from pre-upgrade backup.' };
        } catch (err) {
            this._log(`Restore failed: ${err.message}`);
            return { success: false, message: `Restore failed: ${err.message}` };
        }
    }
}

module.exports = BackupService;
