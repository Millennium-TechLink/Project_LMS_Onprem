/**
 * TimeValidator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all time-related validation concerns for the license system.
 *
 * Responsibilities:
 *   - Clock rollback detection (compare now vs. stored last-launch)
 *   - Expiry date comparison
 *   - Days-remaining calculation
 *
 * Design rationale:
 *   - Separated from LicenseValidator so that the time logic can be replaced
 *     independently (e.g., future online time-server verification).
 *   - Using injectable `now` parameters everywhere allows deterministic unit
 *     testing without mocking the global Date object.
 *   - We deliberately do NOT use any third-party time library to minimise the
 *     supply-chain surface area.
 */

'use strict';

const { CLOCK_ROLLBACK_TOLERANCE_MS } = require('./LicenseConstants');

class TimeValidator {

    /**
     * Determine whether the system clock appears to have been rolled back.
     *
     * @param {string|null} lastLaunchISO - ISO-8601 string from license payload
     * @param {Date} now - Current time (injectable for testing)
     * @returns {{ tampered: boolean, detail: string }}
     */
    detectRollback(lastLaunchISO, now = new Date()) {
        if (!lastLaunchISO) {
            // No previous launch recorded; can't detect rollback.
            return { tampered: false, detail: 'No previous launch recorded.' };
        }

        const lastLaunchMs = new Date(lastLaunchISO).getTime();
        if (Number.isNaN(lastLaunchMs)) {
            return { tampered: false, detail: 'Invalid last-launch timestamp in license.' };
        }

        const currentMs    = now.getTime();
        const deltaMs      = lastLaunchMs - currentMs;  // positive = clock went back

        if (deltaMs > CLOCK_ROLLBACK_TOLERANCE_MS) {
            return {
                tampered: true,
                detail: (
                    `System clock appears to have been rolled back. ` +
                    `Last recorded launch: ${new Date(lastLaunchISO).toLocaleString()}. ` +
                    `Current time: ${now.toLocaleString()}. ` +
                    `Difference: ${Math.round(deltaMs / 1000)} seconds.`
                ),
            };
        }

        return { tampered: false, detail: 'Clock appears normal.' };
    }

    /**
     * Calculate how many full days remain until an expiry date.
     *
     * @param {string} expiryDateISO - ISO-8601 string
     * @param {Date}   now
     * @returns {number} days remaining (0 if expired; Infinity if 'NEVER')
     */
    daysRemaining(expiryDateISO, now = new Date()) {
        if (expiryDateISO === 'NEVER') return Infinity;

        const expiryMs = new Date(expiryDateISO).getTime();
        if (Number.isNaN(expiryMs)) return 0;

        const diff = expiryMs - now.getTime();
        return diff > 0 ? Math.ceil(diff / (1000 * 60 * 60 * 24)) : 0;
    }

    /**
     * Check whether a license is expired.
     *
     * @param {string} expiryDateISO
     * @param {Date}   now
     * @returns {boolean}
     */
    isExpired(expiryDateISO, now = new Date()) {
        if (expiryDateISO === 'NEVER') return false;
        const expiryMs = new Date(expiryDateISO).getTime();
        return Number.isNaN(expiryMs) || now.getTime() > expiryMs;
    }

    /**
     * Calculate the expiry date from an install date plus a duration.
     *
     * @param {Date}   installDate
     * @param {number} durationDays
     * @returns {Date}
     */
    computeExpiryDate(installDate, durationDays) {
        const expiry = new Date(installDate.getTime());
        expiry.setDate(expiry.getDate() + durationDays);
        return expiry;
    }
}

module.exports = TimeValidator;
