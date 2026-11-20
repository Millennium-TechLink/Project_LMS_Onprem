/**
 * BackupService.test.js
 * Full backup, validation, restore and the update-preparation flow, against temp folders.
 * pg_dump / pg_restore are stubbed; the .env encryption uses the real backend env_crypto (Windows DPAPI).
 * Run with the Electron runtime: electron onprem/electron/license/__tests__/BackupService.test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PathResolver = require('../PathResolver');
const BackupService = require('../BackupService');
const UpdateManager = require('../../UpdateManager');

const REPO = path.join(__dirname, '..', '..', '..');
const ENV_CRYPTO = path.join(REPO, 'backend', 'app', 'core', 'env_crypto.py');
const PYTHON = process.env.LMS_PYTHON || path.join(REPO, 'backend', '.venv', 'Scripts', 'python.exe');
process.env.LMS_PYTHON = PYTHON;

let passed = 0, failed = 0;
function check(label, cond) {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
    cond ? passed++ : failed++;
}

function fixture(name) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `lms-bk-${name}-`));
    const pr = new PathResolver({ userData: path.join(base, 'R'), localAppData: path.join(base, 'L'), appName: 'Lab Management System' });
    pr.ensureAllDirs();
    const logs = [];
    const svc = new BackupService({ pathResolver: pr, log: m => logs.push(m) });
    svc._runPgDump = async (url, out) => fs.writeFileSync(out, 'FAKE-DUMP of ' + url);
    svc._runPgRestore = async () => {};
    fs.writeFileSync(path.join(pr.backendConfigDir, '.env'), 'DATABASE_URL=postgresql://u:p@localhost:5432/lms\nSECRET_KEY=abc\n');
    fs.mkdirSync(pr.uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(pr.uploadsDir, 'a.txt'), 'upload-a');
    fs.mkdirSync(pr.exportsDir, { recursive: true });
    fs.writeFileSync(path.join(pr.exportsDir, 'e.csv'), 'x,y');
    fs.mkdirSync(pr.licenseDir, { recursive: true });
    fs.writeFileSync(path.join(pr.licenseDir, 'license.dat'), 'LIC');
    return { base, pr, svc, logs };
}
const envPath = pr => path.join(pr.backendConfigDir, '.env');

(async () => {
    console.log('\nPlaintext .env');
    {
        const { pr, svc } = fixture('plain');
        check('no backups at first', svc.listBackups().length === 0 && svc.getStatus().count === 0);
        const r = await svc.createFullBackup();
        check('createFullBackup succeeds', r.success === true);
        const v = await svc.validateBackup(r.backupDir);
        check('backup validates', v.success === true);
        check('backup holds .env, upload, export, license and dump',
            fs.existsSync(path.join(r.backupDir, 'config', '.env')) && fs.existsSync(path.join(r.backupDir, 'uploads', 'a.txt')) &&
            fs.existsSync(path.join(r.backupDir, 'exports', 'e.csv')) && fs.existsSync(path.join(r.backupDir, 'license', 'license.dat')) &&
            fs.existsSync(path.join(r.backupDir, 'database', 'database.dump')));
        check('listBackups and getStatus see it', svc.listBackups().length === 1 && svc.getStatus().count === 1 && !!svc.getStatus().latest);

        // damage the live data, then restore without the database
        fs.writeFileSync(envPath(pr), 'DATABASE_URL=broken\n');
        fs.rmSync(path.join(pr.uploadsDir, 'a.txt'));
        const rr = await svc.restoreBackup(r.backupDir, { includeDatabase: false });
        check('restoreBackup (no database) succeeds', rr.success === true);
        check('.env restored', fs.readFileSync(envPath(pr), 'utf8').includes('localhost:5432/lms'));
        check('uploads restored', fs.existsSync(path.join(pr.uploadsDir, 'a.txt')));

        // an incomplete backup is rejected
        fs.rmSync(path.join(r.backupDir, 'config', '.env'));
        check('backup missing config/.env is invalid', (await svc.validateBackup(r.backupDir)).success === false);
        check('restore refuses an invalid backup', (await svc.restoreBackup(r.backupDir, { includeDatabase: false })).success === false);
        check('missing directory is invalid', (await svc.validateBackup(path.join(pr.backupsDir, 'nope'))).success === false);

        // no DATABASE_URL => backup fails cleanly
        fs.writeFileSync(envPath(pr), 'SECRET_KEY=abc\n');
        const bad = await svc.createFullBackup();
        check('createFullBackup fails cleanly without DATABASE_URL', bad.success === false && /DATABASE_URL/.test(bad.message));
    }

    console.log('\nEncrypted .env (what an installed app has after its first healthy start)');
    {
        const { pr, svc } = fixture('enc');
        const enc = spawnSync(PYTHON, [ENV_CRYPTO, 'encrypt', envPath(pr)]);
        check('env_crypto encrypted the file', enc.status === 0 && fs.readFileSync(envPath(pr)).slice(0, 7).toString('latin1') === 'DPAPI1:');
        const r = await svc.createFullBackup();
        check('createFullBackup works with an encrypted .env', r.success === true);
        if (r.success) {
            check('the dump was taken with the right database url', fs.readFileSync(path.join(r.backupDir, 'database', 'database.dump'), 'utf8').includes('localhost:5432/lms'));
            check('backup keeps the .env encrypted', fs.readFileSync(path.join(r.backupDir, 'config', '.env')).slice(0, 7).toString('latin1') === 'DPAPI1:');
        }
    }

    console.log('\nUpdate flow');
    {
        const { pr, svc, logs } = fixture('upd');
        const lm = { checkLicense: async () => ({ result: { valid: true } }) };
        const logger = { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) };
        const um = new UpdateManager({ pathResolver: pr, backupService: svc, installLogger: logger, licenseManager: lm, currentVersion: '1.0.0' });
        const prep = await um.prepareUpdate('1.0.1', 'C:\\x\\Setup.exe');
        check('prepareUpdate succeeds and takes a verified backup', prep.success === true && svc.listBackups().length === 1);
        check('prepareUpdate reports the versions', prep.currentVersion === '1.0.0' && prep.newVersion === '1.0.1');
        const lmBad = { checkLicense: async () => ({ result: { valid: false, code: 'NOT_FOUND' } }) };
        const um2 = new UpdateManager({ pathResolver: pr, backupService: svc, installLogger: logger, licenseManager: lmBad, currentVersion: '1.0.0' });
        check('post-update check passes with data and license intact', (await um.verifyPostUpdateData()).success === true);
        check('post-update check fails when the license is invalid', (await um2.verifyPostUpdateData()).success === false);
        // lose the .env after an "update": automatic recovery from the backup
        fs.rmSync(envPath(pr));
        const rec = await um.verifyPostUpdateData();
        check('post-update check recovers a lost .env from the backup', rec.success === true && fs.existsSync(envPath(pr)));
        const noInstaller = await um.launchInstaller(path.join(pr.backupsDir, 'missing-setup.exe'), null, null);
        check('launchInstaller refuses a missing installer', noInstaller.success === false);
    }

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    console.log(failed ? 'BACKUPSERVICE TEST FAILED' : 'BACKUPSERVICE TEST PASSED');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
