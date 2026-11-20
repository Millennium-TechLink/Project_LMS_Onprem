'use strict';

const fs = require('fs');
const path = require('path');

class InstallLogger {
    /**
     * @param {import('./PathResolver')} pathResolver 
     */
    constructor(pathResolver) {
        if (!pathResolver || typeof pathResolver.installationLog !== 'string') {
            throw new Error('InstallLogger: a valid PathResolver instance is required.');
        }
        this._logPath = pathResolver.installationLog;
        
        // Ensure parent directory exists
        const dir = path.dirname(this._logPath);
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (e) {
                // non-fatal
            }
        }
    }

    _write(level, message) {
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const entry = `[${timestamp}] [${level}] ${message}\n`;
        
        // Use promises to not block, catch errors to prevent crashing
        fs.promises.appendFile(this._logPath, entry, 'utf8').catch(() => {
            // non-fatal logging failure
        });
    }

    info(message) {
        this._write('INFO', message);
    }

    warn(message) {
        this._write('WARN', message);
    }

    error(message) {
        this._write('ERROR', message);
    }
}

module.exports = InstallLogger;
