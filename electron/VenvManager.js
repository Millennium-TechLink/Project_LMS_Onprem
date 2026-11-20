'use strict';

const fs = require('fs');
const path = require('path');

class VenvManager {
    constructor(projectRoot, logFn = console.log, logErrFn = console.error, installLogger = null) {
        this.projectRoot = projectRoot;
        this.backendPath = path.join(this.projectRoot, 'backend');
        this.pythonExe = path.join(this.backendPath, 'python', 'python.exe');
        
        this._logFn = logFn;
        this._logErrFn = logErrFn;
        this._installLogger = installLogger;
        
        this._log = (msg) => {
            this._logFn(msg);
            if (this._installLogger) this._installLogger.info(msg);
        };
        this._logErr = (msg) => {
            this._logErrFn(msg);
            if (this._installLogger) this._installLogger.error(msg);
        };
    }

    async setupVenv() {
        if (!fs.existsSync(this.backendPath)) {
            throw new Error(`Backend path not found: ${this.backendPath}`);
        }

        if (fs.existsSync(this.pythonExe)) {
            this._log(`[VenvManager] Using bundled Python: ${this.pythonExe}`);
            return this.pythonExe;
        }

        // Development-only fallback
        let isPackaged = false;
        try {
            isPackaged = require('electron').app.isPackaged;
        } catch (_) { }

        if (isPackaged) {
            const msg = [
                `[VenvManager] FATAL: Bundled Python not found in packaged application.`,
                `Expected: ${this.pythonExe}`,
                `The installer may be corrupted. Please reinstall the application.`,
            ].join('\n');
            this._logErr(msg);
            throw new Error(msg);
        }

        this._log(`[VenvManager] Bundled Python not found at ${this.pythonExe}. Using system Python (dev mode).`);
        
        // In dev mode, we look for the root .venv (as created by the user)
        const venvPy = path.join(this.projectRoot, '.venv', 'Scripts', 'python.exe');
        if (fs.existsSync(venvPy)) {
             return venvPy;
        }
        
        return 'python';
    }

    getPaths() {
        return {
            pythonExe: this.pythonExe,
            requirementsPath: path.join(this.backendPath, 'requirements.txt'),
            backendPath: this.backendPath
        };
    }
}

// Dummy backward compatibility stub
function resolveVenvDir(backendPath) {
    return path.join(backendPath, 'python');
}

module.exports = VenvManager;
module.exports.resolveVenvDir = resolveVenvDir;
