// electron-builder afterPack hook: robocopy the backend venv into the
// packaged app instead of electron-builder's own extraResources copy, which
// is single-threaded and takes minutes for the ~19k-file venv. Runs after
// win-unpacked exists but before the NSIS installer archives it, so the
// installer still picks up these files.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
    compileAppToPyc(context);
    bakeCustomerEnv(context);
};

// Compiles backend/app to .pyc and deletes the .py source, so the installed
// app doesn't ship readable Python. db_migrations/ is left untouched -
// migrations.py discovers scripts by f.endswith(".py").
function compileAppToPyc(context) {
    const appDir = path.join(context.appOutDir, 'resources', 'backend', 'app');
    const pythonExe = path.join(context.appOutDir, 'resources', 'backend', 'python', 'python.exe');
    if (!fs.existsSync(appDir) || !fs.existsSync(pythonExe)) {
        console.log('[afterPack] backend/app or portable python not found - skipping .pyc compilation.');
        return;
    }

    console.log('[afterPack] Compiling backend/app to .pyc...');
    const t0 = Date.now();
    // -b: legacy layout (foo.pyc next to foo.py) - importable with no .py present.
    const result = spawnSync(pythonExe, ['-m', 'compileall', '-b', '-q', appDir], { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`compileall failed compiling ${appDir} (exit code ${result.status})`);
    }

    // Also strips stale __pycache__ dirs (leftover dev bytecode) - unused by
    // the .pyc-next-to-module loader, but still decompilable if left in.
    let removed = 0;
    let pycacheDirsRemoved = 0;
    (function stripPy(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '__pycache__') {
                    fs.rmSync(full, { recursive: true, force: true });
                    pycacheDirsRemoved++;
                } else {
                    stripPy(full);
                }
                continue;
            }
            if (entry.name.endsWith('.py')) { fs.unlinkSync(full); removed++; }
        }
    })(appDir);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[afterPack] Compiled backend/app to .pyc, removed ${removed} .py source files and ${pycacheDirsRemoved} stale __pycache__ dirs in ${elapsed}s.`);
}

// Bakes a real customer .env into the package when build_desktop.ps1 ran with
// -BakeCustomerEnv (staged at backend/.env.bake - see its Step 1d). Not wired
// through extraResources, which would apply unconditionally to every build.
// Absent for an ordinary build, so this is a no-op then.
function bakeCustomerEnv(context) {
    const src = path.join(__dirname, '..', '..', 'backend', '.env.bake');
    if (!fs.existsSync(src)) {
        console.log('[afterPack] backend/.env.bake not found - not a customer-baked build, skipping.');
        return;
    }

    const dest = path.join(context.appOutDir, 'resources', 'backend', '.env');
    fs.copyFileSync(src, dest);
    console.log(`[afterPack] Baked customer .env into ${dest}.`);
}
