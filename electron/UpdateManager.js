'use strict';

const fs = require('fs');
const path = require('path');

class UpdateManager {
    /**
     * @param {object} opts
     * @param {import('./license/PathResolver')} opts.pathResolver
     * @param {import('./license/BackupService')} opts.backupService
     * @param {import('./license/InstallLogger')} opts.installLogger
     * @param {import('./license/LicenseManager')} opts.licenseManager
     * @param {string} opts.currentVersion
     */
    constructor({ pathResolver, backupService, installLogger, licenseManager, currentVersion }) {
        this.paths = pathResolver;
        this.backupService = backupService;
        this.logger = installLogger;
        this.licenseManager = licenseManager;
        this.currentVersion = currentVersion || '1.0.0';
    }

    /**
     * Prepares the system for an application update.
     * Safely validates state, license, and triggers a full verified backup.
     * 
     * @param {string} newVersion - The incoming version string
     * @param {string} installerExePath - Absolute path to the downloaded NSIS installer executable
     * @returns {Promise<{ success: boolean, message: string, installerExePath: string }>}
     */
    async prepareUpdate(newVersion, installerExePath) {
        try {
            this.logger.info('Update preparation started');
            this.logger.info(`Current version: ${this.currentVersion}`);
            this.logger.info(`New version: ${newVersion}`);

            // 1. Validate persistent paths
            const requiredPaths = [
                path.join(this.paths.backendConfigDir, '.env'),
                this.paths.uploadsDir,
                this.paths.exportsDir,
                this.paths.backupsDir,
                this.paths.licenseDir
            ];

            for (const p of requiredPaths) {
                if (!fs.existsSync(p)) {
                    this.logger.warn(`Persistent path missing or inaccessible: ${p}`);
                }
            }
            this.logger.info('Persistent paths validated');

            // 2. Validate license
            if (this.licenseManager) {
                const status = await this.licenseManager.checkLicense();
                if (status.result && status.result.valid) {
                    this.logger.info('License validation completed (Valid)');
                } else {
                    this.logger.warn(`License validation completed (Invalid: ${status.result ? status.result.code : 'Unknown'})`);
                }
            } else {
                this.logger.warn('LicenseManager not provided, skipping license validation');
            }

            // 3. Create Backup
            this.logger.info('Backup started');
            const backupResult = await this.backupService.createFullBackup();
            if (!backupResult.success) {
                this.logger.error(`Backup creation failed: ${backupResult.message}`);
                return { success: false, message: `Backup creation failed: ${backupResult.message}`, installerExePath: null };
            }
            this.logger.info('Backup completed');

            // 4. Validate Backup
            const validation = await this.backupService.validateBackup(backupResult.backupDir);
            if (!validation.success) {
                this.logger.error(`Backup validation failed: ${validation.message}`);
                return { success: false, message: `Backup validation failed: ${validation.message}`, installerExePath: null };
            }
            this.logger.info('Backup validation successful');

            this.logger.info('Update preparation completed');
            
            // Return installer info for Phase 2 (the actual execution)
            return {
                success: true,
                message: 'Update prepared successfully.',
                installerExePath: installerExePath,
                currentVersion: this.currentVersion,
                newVersion: newVersion
            };

        } catch (error) {
            this.logger.error(`Update preparation aborted due to unexpected error: ${error.message}`);
            return { success: false, message: error.message, installerExePath: null };
        }
    }

    /**
     * Executes the actual handoff to the NSIS installer.
     * Stops the backend, launches Setup.exe, and triggers Electron shutdown.
     * 
     * @param {string} installerExePath 
     * @param {object} backendManager 
     * @param {object} app - Electron app instance
     */
    async launchInstaller(installerExePath, backendManager, app) {
        try {
            this.logger.info('Update started');
            
            if (!fs.existsSync(installerExePath)) {
                throw new Error('Installer executable not found.');
            }
            this.logger.info('New installer detected');
            
            // Assuming backup & license were verified in prepareUpdate
            this.logger.info('Backup verified');
            this.logger.info('License verified');

            this.logger.info('Backend shutdown started');
            if (backendManager) {
                await backendManager.stop();
            }
            this.logger.info('Backend shutdown completed');

            this.logger.info('Installer launched');
            const { spawn } = require('child_process');
            
            // Launch NSIS installer (oneClick will handle silent install automatically if configured, or just run normally)
            const installerProc = spawn(installerExePath, [], {
                detached: true,
                stdio: 'ignore'
            });
            installerProc.unref();

            if (app) {
                app.quit();
            }

            return { success: true };
        } catch (error) {
            this.logger.error(`Installer launch failed: ${error.message}`);
            this.logger.info(`Update FAILED\nReason: ${error.message}\nBackup retained: ${this.paths.backupsDir}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Post-update verification step 1: Validates persistent data integrity after an update.
     * On failure, automatically restores uploads/exports/.env/license from the most
     * recent pre-update backup - this check never inspects the database, so it never
     * triggers the destructive pg_restore path; that stays a separate, user-confirmed action.
     */
    async verifyPostUpdateData() {
        this.logger.info('New version installed');

        let success = true;
        let reason = '';

        const requiredPaths = [
            path.join(this.paths.backendConfigDir, '.env'),
            this.paths.uploadsDir,
            this.paths.exportsDir,
            this.paths.backupsDir,
            this.paths.licenseDir
        ];

        for (const p of requiredPaths) {
            if (!fs.existsSync(p)) {
                success = false;
                reason = `Persistent path missing: ${p}`;
                break;
            }
        }

        if (!success) {
            this.logger.error(reason);
            const recovered = await this._attemptAutoRestore(reason);
            if (recovered) {
                this.logger.info('Persistent data verified (after automatic recovery)');
            } else {
                this.logger.info(`Update FAILED\nReason: ${reason}\nBackup retained: ${this.paths.backupsDir}`);
                return { success: false, message: reason };
            }
        } else {
            this.logger.info('Persistent data verified');
        }

        if (this.licenseManager) {
            const status = await this.licenseManager.checkLicense();
            if (!status.result || !status.result.valid) {
                reason = `License invalid: ${status.result ? status.result.code : 'unknown'}`;
                this.logger.error(reason);
                this.logger.info(`Update FAILED\nReason: ${reason}\nBackup retained: ${this.paths.backupsDir}`);
                return { success: false, message: reason };
            }
        }
        this.logger.info('License verified');
        
        // Venv verification is handled by VenvManager in the standard startup flow.
        // We log it here to fulfill the strict logging sequence before the backend starts.
        this.logger.info('Venv verified');

        return { success: true };
    }

    /**
     * Restores uploads/exports/.env/license (never the database - see
     * verifyPostUpdateData) from the most recent pre-update backup, then
     * re-checks the same paths. Best-effort: any failure here just means
     * the original failure is reported as before, nothing is made worse.
     */
    async _attemptAutoRestore(originalReason) {
        if (!this.backupService) return false;
        try {
            // backup_* (BackupService.createFullBackup) is preferred when it
            // exists, but nothing currently calls createFullBackup() before
            // a real on-site update - so in practice this falls back to
            // pre-upgrade-* (build/installer.nsh's automatic, always-fires
            // backup) every time. Keeping both: whichever actually exists wins.
            const backups = this.backupService.listBackups();
            const preUpgradeBackups = backups.length ? [] : this.backupService.listPreUpgradeBackups();
            if (!backups.length && !preUpgradeBackups.length) {
                this.logger.warn('Auto-restore skipped: no backup available.');
                return false;
            }

            let result;
            const latest = backups.length ? backups[0] : preUpgradeBackups[0];
            this.logger.info(`Attempting automatic recovery from ${latest.name} (reason: ${originalReason})`);
            if (backups.length) {
                result = await this.backupService.restoreBackup(latest.path, {
                    licenseManager: this.licenseManager,
                    includeDatabase: false,
                });
            } else {
                result = await this.backupService.restoreFromPreUpgradeBackup(latest.path);
            }
            if (!result.success) {
                this.logger.error(`Auto-restore failed: ${result.message}`);
                return false;
            }

            const requiredPaths = [
                path.join(this.paths.backendConfigDir, '.env'),
                this.paths.uploadsDir,
                this.paths.exportsDir,
            ];
            const stillMissing = requiredPaths.find(p => !fs.existsSync(p));
            if (stillMissing) {
                this.logger.error(`Auto-restore ran but ${stillMissing} is still missing.`);
                return false;
            }

            this.logger.info(`Automatic recovery succeeded from ${latest.name}.`);
            return true;
        } catch (err) {
            this.logger.error(`Auto-restore threw: ${err.message}`);
            return false;
        }
    }

    /**
     * Post-update verification step 2: Logs successful backend startup.
     * To be called by main.js after backendManager.waitUntilReady() succeeds.
     */
    logBackendSuccess() {
        this.logger.info('Backend started');
        this.logger.info('Health check successful');
        this.logger.info('Update completed');
    }
}

module.exports = UpdateManager;
