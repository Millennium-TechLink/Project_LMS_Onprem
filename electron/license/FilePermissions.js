/**
 * FilePermissions.js
 * Restricts a file's NTFS permissions to the current user + Administrators,
 * removing inherited broad access. Used for backend/.env (plaintext
 * DATABASE_URL/SECRET_KEY/etc). Best-effort - never blocks app startup.
 */

'use strict';

const { execFile, execFileSync } = require('child_process');
const os = require('os');

/**
 * @param {string} filePath
 * @param {Function} [logFn]
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly=false] - Grant Read only instead of Full
 *   Control for a baked customer .env, which nobody legitimately edits again.
 * @returns {boolean} true if restricted, false on any failure.
 */
function restrictToCurrentUser(filePath, logFn, opts = {}) {
    const log = logFn || (() => {});
    const { readOnly = false } = opts;
    try {
        const username = os.userInfo().username;
        const userGrant = readOnly ? `${username}:R` : `${username}:F`;
        execFileSync('icacls', [
            filePath,
            '/inheritance:r',
            '/grant:r', userGrant,
            '/grant:r', '*S-1-5-32-544:F',     // local Administrators, locale-independent SID
        ], { stdio: 'ignore' });
        log(`[Permissions] Restricted access on ${filePath} to ${username} (${readOnly ? 'read-only' : 'full control'}) + Administrators.`);
        return true;
    } catch (err) {
        log(`[Permissions] Could not restrict ${filePath}: ${err.message}`);
        return false;
    }
}

/**
 * Same as restrictToCurrentUser, but does not block the caller. For the lock re-applied on
 * every launch: icacls takes over a second, and one call applies the new ACL atomically,
 * so the backend can start while it runs.
 */
function restrictToCurrentUserAsync(filePath, logFn, opts = {}) {
    const log = logFn || (() => {});
    const { readOnly = false } = opts;
    const username = os.userInfo().username;
    const userGrant = readOnly ? `${username}:R` : `${username}:F`;
    return new Promise((resolve) => {
        execFile('icacls', [
            filePath,
            '/inheritance:r',
            '/grant:r', userGrant,
            '/grant:r', '*S-1-5-32-544:F',
        ], { windowsHide: true }, (err) => {
            if (err) {
                log(`[Permissions] Could not restrict ${filePath}: ${err.message}`);
                return resolve(false);
            }
            log(`[Permissions] Restricted access on ${filePath} to ${username} (${readOnly ? 'read-only' : 'full control'}) + Administrators.`);
            resolve(true);
        });
    });
}

module.exports = { restrictToCurrentUser, restrictToCurrentUserAsync };
