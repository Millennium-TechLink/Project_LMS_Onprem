'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

class BackendManager {
    /**
     * @param {object} opts
     * @param {import('./license/PathResolver')} opts.paths
     * @param {Function} opts.logFn - Logger function
     * @param {Function} opts.logErrFn - Error logger function
     */
    constructor({ paths, logFn = console.log, logErrFn = console.error, port = 8001 }) {
        this._paths = paths;
        this._log = logFn;
        this._logErr = logErrFn;
        
        this._process = null;
        this._pid = null;
        this._port = port;
        this._pidFile = path.join(this._paths.backendConfigDir, 'backend.pid');

        // Crash recovery state (see enableCrashRecovery()) - inert until that's called.
        this._lastCommand = null;
        this._lastArgs = null;
        this._lastOptions = null;
        this._intentionalStop = false;
        this._crashRecovery = null;     // options passed to enableCrashRecovery()
        this._crashAttempts = 0;
        this._healthPollTimer = null;
        this._consecutiveHealthFailures = 0;
        this._sustainedUptimeTimer = null;
        this._restarting = false;       // reentrancy guard for _handleUnexpectedExit
        this._exitInfo = null;          // { code, signal } once the spawned process has exited
    }

    /**
     * Start the backend process.
     * @param {string} command - The executable or command to run
     * @param {string[]} args - Arguments
     * @param {object} options - Spawn options (cwd, env, etc.)
     */
    async start(command, args, options) {
        this._log('Backend startup requested');

        // Cache so a crash-recovery restart can call start() again unchanged.
        this._lastCommand = command;
        this._lastArgs = args;
        this._lastOptions = options;

        // Check if port is available
        const isAvailable = await this._isPortAvailable();
        if (!isAvailable) {
            this._log(`Port ${this._port} is occupied. Checking for stale backend...`);
            const staleHandled = await this._handleStaleBackend();
            if (!staleHandled) {
                const msg = `Port ${this._port} is occupied by an unknown process. Cannot start backend.`;
                this._logErr(msg);
                const err = new Error(msg);
                err.portConflict = true; // lets main.js show the dedicated port-conflict dialog
                throw err;
            }
        }

        this._log(`Starting backend: ${command} ${args.join(' ')}`);
        
        this._exitInfo = null;
        this._process = spawn(command, args, options);
        this._pid = this._process.pid;
        this._log(`Backend PID: ${this._pid}`);

        // Store PID
        try {
            fs.writeFileSync(this._pidFile, this._pid.toString(), 'utf8');
        } catch (err) {
            this._logErr(`Failed to write PID file: ${err.message}`);
        }

        this._process.stdout.on('data', (data) => {
            for (const line of String(data).split(/\r?\n/)) {
                if (line.trim()) {
                    if (this.onBackendLog) this.onBackendLog(`[STDOUT] ${line}`);
                }
            }
        });

        this._process.stderr.on('data', (data) => {
            for (const line of String(data).split(/\r?\n/)) {
                if (line.trim()) {
                    if (this.onBackendErr) this.onBackendErr(`[STDERR] ${line}`);
                }
            }
        });

        this._process.on('error', (err) => {
            this._logErr(`Backend process error: ${err.message}`);
            if (this.onBackendError) this.onBackendError(err);
        });

        this._process.on('exit', (code, signal) => {
            this._log(`Backend exited  code=${code}  signal=${signal}`);
            this._exitInfo = { code, signal };
            this._cleanupTracking();
            if (this.onBackendExit) this.onBackendExit(code, signal);
        });
    }

    /**
     * Stop the backend gracefully, fallback to force terminate.
     * @param {number} timeoutMs 
     */
    // The polite taskkill is never honored by the console-less backend, so keep the wait short.
    async stop(timeoutMs = 1500) {
        this._log('Backend shutdown requested');
        // Marks the upcoming exit as deliberate so _handleUnexpectedExit (if
        // crash recovery is enabled) doesn't try to restart what we're
        // intentionally shutting down.
        this._intentionalStop = true;
        this._clearSupervisionTimers();
        if (!this.isRunning()) {
            this._log('Backend is not running.');
            this._cleanupTracking();
            return true;
        }

        const pid = this._pid;
        this._log('Graceful shutdown started');
        
        // Request graceful termination
        try {
            execSync(`taskkill /PID ${pid} /T`, { stdio: 'ignore' });
        } catch (err) {
            // taskkill failed or process already exited
        }

        // Wait for process exit
        let exited = false;
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (!this.isRunning()) {
                exited = true;
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }

        if (exited) {
            this._log('Backend exited normally.');
        } else {
            this._log('Force termination required');
            try {
                execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
                this._log('Backend force terminated');
            } catch (err) {
                this._logErr(`Failed to force kill backend: ${err.message}`);
            }
            
            // Wait briefly for force kill to take effect
            for (let i = 0; i < 10; i++) {
                if (!this.isRunning()) break;
                await new Promise(r => setTimeout(r, 500));
            }
        }

        await this._waitForPortRelease();
        this._cleanupTracking();
        return true;
    }

    isRunning() {
        if (!this._pid) return false;
        try {
            // process.kill(pid, 0) throws if process doesn't exist
            process.kill(this._pid, 0);
            return true;
        } catch (err) {
            return false;
        }
    }

    /**
     * Polls /health until the backend answers. Fails immediately if the process
     * exits while we wait (e.g. an import or config error), instead of polling a
     * dead process until the timeout.
     * @param {number} timeoutMs
     * @param {(elapsedSeconds: number) => void} [onProgress] called about once a second
     */
    async waitUntilReady(timeoutMs = 150000, onProgress) {
        this._log('Backend health check started');
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        let attempt = 0;
        let lastTick = 0;
        while (Date.now() < deadline) {
            if (await this.healthCheck()) {
                this._log('Backend ready');
                return true;
            }
            if (this._exitInfo) {
                const { code, signal } = this._exitInfo;
                this._logErr(`Backend exited during startup (code=${code}, signal=${signal}); not waiting any longer.`);
                const err = new Error(`Backend exited during startup (code=${code}${signal ? `, signal=${signal}` : ''}).`);
                err.backendExited = true;
                err.exitCode = code;
                throw err;
            }
            if (onProgress && Date.now() - lastTick >= 1000) {
                lastTick = Date.now();
                try { onProgress(Math.round((lastTick - startedAt) / 1000)); } catch { /* cosmetic only */ }
            }
            attempt++;
            // Throttled: avoids hundreds of identical log lines.
            if (attempt === 1 || attempt % 20 === 0) {
                this._log(`Health check attempt ${attempt} failed (${Math.round((deadline - Date.now()) / 1000)} s remaining)`);
            }
            // 250ms, not 1000ms: at 1s polling, up to a full second of "already
            // ready" time was just poll-lag, wasted on every single launch.
            await new Promise(r => setTimeout(r, 250));
        }
        throw new Error(`Backend failed to become ready within ${timeoutMs / 1000} seconds.`);
    }

    async healthCheck() {
        try {
            const response = await fetch(`http://127.0.0.1:${this._port}/health`);
            return response.ok;
        } catch (err) {
            return false;
        }
    }

    /**
     * Opt-in mid-session crash/hang recovery. Detects an unexpected process
     * exit (the 'exit' handler already wired in start()) or an unresponsive-
     * but-alive process (periodic health polling), and auto-restarts with
     * bounded backoff. Does nothing during a deliberate stop() (app quit,
     * backup/restore flows) - callers that never call this keep today's
     * behavior unchanged.
     *
     * @param {object} opts
     * @param {(status: {state: 'restarting'|'restored'|'failed', attempt?: number, maxAttempts?: number, attempts?: number}) => void} opts.onStatusChange
     * @param {number} [opts.maxAttempts=5]
     * @param {number[]} [opts.backoffScheduleMs]
     * @param {number} [opts.healthPollIntervalMs=30000]
     * @param {number} [opts.hangThreshold=3] - consecutive failed health checks (while still running) before treating it as hung
     * @param {number} [opts.sustainedUptimeMs=120000] - how long a restart must stay healthy before the attempt counter resets to 0
     */
    enableCrashRecovery({
        onStatusChange,
        maxAttempts = 5,
        backoffScheduleMs = [3000, 8000, 15000, 30000, 60000],
        healthPollIntervalMs = 30000,
        hangThreshold = 3,
        sustainedUptimeMs = 120000,
    } = {}) {
        this._crashRecovery = { onStatusChange, maxAttempts, backoffScheduleMs, healthPollIntervalMs, hangThreshold, sustainedUptimeMs };
        this.onBackendExit = (code, signal) => this._handleUnexpectedExit(code, signal);
        this._startHealthPoll();
        this._armSustainedUptimeReset();
        this._log('Crash recovery enabled.');
    }

    /**
     * Handles an exit event from the child process (or a hang forced into an
     * exit via _forceKillHungProcess) when crash recovery is enabled. Ignores
     * deliberate stops; otherwise restarts with backoff up to maxAttempts,
     * notifying via onStatusChange throughout. Also used directly (not from a
     * real 'exit' event) when a restart attempt itself fails to become ready.
     */
    async _handleUnexpectedExit(code, signal) {
        if (this._intentionalStop) {
            this._intentionalStop = false;
            return;
        }
        if (!this._crashRecovery || this._restarting) return;
        this._restarting = true;

        const { onStatusChange, maxAttempts, backoffScheduleMs } = this._crashRecovery;
        this._clearSupervisionTimers(); // don't keep polling a process that's already down or being replaced

        this._crashAttempts++;
        this._log(`Unexpected backend exit (code=${code} signal=${signal}) - attempt ${this._crashAttempts}/${maxAttempts}`);

        if (this._crashAttempts > maxAttempts) {
            this._logErr(`Backend crash recovery gave up after ${this._crashAttempts - 1} attempts.`);
            this._restarting = false;
            if (onStatusChange) onStatusChange({ state: 'failed', attempts: this._crashAttempts - 1 });
            return;
        }

        if (onStatusChange) onStatusChange({ state: 'restarting', attempt: this._crashAttempts, maxAttempts });

        const delay = backoffScheduleMs[Math.min(this._crashAttempts - 1, backoffScheduleMs.length - 1)];
        await new Promise(r => setTimeout(r, delay));

        try {
            // If the previous attempt left an unhealthy-but-alive process behind
            // (waitUntilReady timed out below without the process itself exiting),
            // start()'s own port-conflict handling (_isPortAvailable/_handleStaleBackend)
            // detects and clears it via the PID file before spawning the next one.
            await this.start(this._lastCommand, this._lastArgs, this._lastOptions);
            await this.waitUntilReady();
            this._log('Backend recovered after unexpected exit.');
            this._restarting = false;
            this._startHealthPoll();
            this._armSustainedUptimeReset();
            if (onStatusChange) onStatusChange({ state: 'restored' });
        } catch (err) {
            this._logErr(`Backend restart attempt ${this._crashAttempts} failed: ${err.message}`);
            this._restarting = false;
            await this._handleUnexpectedExit(null, 'RESTART_FAILED');
        }
    }

    /** Resets the crash-attempt counter once a restart has stayed healthy for sustainedUptimeMs. */
    _armSustainedUptimeReset() {
        if (!this._crashRecovery) return;
        clearTimeout(this._sustainedUptimeTimer);
        this._sustainedUptimeTimer = setTimeout(() => {
            if (this._crashAttempts > 0) {
                this._log('Backend has been stable - resetting crash-recovery attempt count.');
                this._crashAttempts = 0;
            }
        }, this._crashRecovery.sustainedUptimeMs);
    }

    /**
     * Periodic liveness check. A process that's alive (isRunning() true) but
     * fails /health repeatedly is hung, not crashed - force-kill it so the
     * normal 'exit' handler (and _handleUnexpectedExit) picks it up, instead
     * of maintaining a second, parallel recovery path.
     */
    _startHealthPoll() {
        if (!this._crashRecovery) return;
        clearInterval(this._healthPollTimer);
        this._consecutiveHealthFailures = 0;
        this._healthPollTimer = setInterval(async () => {
            if (!this.isRunning()) return; // already gone; the exit handler deals with it
            const alive = await this.healthCheck();
            if (alive) {
                this._consecutiveHealthFailures = 0;
                return;
            }
            this._consecutiveHealthFailures++;
            if (this._consecutiveHealthFailures >= this._crashRecovery.hangThreshold) {
                this._logErr(`Backend unresponsive for ${this._consecutiveHealthFailures} consecutive checks - treating as hung.`);
                this._forceKillHungProcess();
            }
        }, this._crashRecovery.healthPollIntervalMs);
    }

    /** Force-kills a hung (unresponsive but alive) backend; its 'exit' event drives normal recovery. */
    _forceKillHungProcess() {
        clearInterval(this._healthPollTimer);
        this._healthPollTimer = null;
        if (!this._pid) return;
        try {
            execSync(`taskkill /F /T /PID ${this._pid}`, { stdio: 'ignore' });
        } catch (err) {
            this._logErr(`Failed to force-kill hung backend: ${err.message}`);
        }
    }

    _clearSupervisionTimers() {
        clearInterval(this._healthPollTimer);
        this._healthPollTimer = null;
        clearTimeout(this._sustainedUptimeTimer);
        this._sustainedUptimeTimer = null;
    }

    _isPortAvailable() {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(this._port, '127.0.0.1');
        });
    }

    async _waitForPortRelease(maxRetries = 10) {
        for (let i = 0; i < maxRetries; i++) {
            if (await this._isPortAvailable()) {
                this._log('Port released');
                return true;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        this._logErr(`Port ${this._port} was not released in time.`);
        return false;
    }

    async _handleStaleBackend() {
        if (!fs.existsSync(this._pidFile)) {
            return false; // No PID file, cannot determine if it's ours
        }

        let stalePid;
        try {
            stalePid = parseInt(fs.readFileSync(this._pidFile, 'utf8').trim(), 10);
        } catch (err) {
            return false;
        }

        if (!stalePid || isNaN(stalePid)) return false;

        // Check if process exists
        try {
            process.kill(stalePid, 0);
        } catch (err) {
            // Process doesn't exist, so whatever is on 8001 is NOT our known backend
            return false;
        }

        this._log(`Stale backend detected with PID ${stalePid}`);
        try {
            execSync(`taskkill /F /T /PID ${stalePid}`, { stdio: 'ignore' });
            this._log('Stale backend terminated');
        } catch (err) {
            this._logErr(`Failed to terminate stale backend: ${err.message}`);
        }

        const released = await this._waitForPortRelease();
        if (released) {
            this._cleanupTracking(); // Remove the old PID file
        }
        return released;
    }

    _cleanupTracking() {
        this._process = null;
        if (this._pid) {
            this._pid = null;
        }
        try {
            if (fs.existsSync(this._pidFile)) {
                fs.unlinkSync(this._pidFile);
                this._log('PID file removed');
            }
        } catch (err) {
            this._logErr(`Failed to remove PID file: ${err.message}`);
        }
    }
}

module.exports = BackendManager;
