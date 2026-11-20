# Build and run

How to run the on-prem app from source and how to build the Windows installer. Both start from whatever code you have checked out, so they work from `develop` unchanged.

## Prerequisites

| Needed for | Requirement |
|---|---|
| Both | Windows, PowerShell, Git |
| Both | PostgreSQL running locally (18 is the tested version) |
| Both | Node.js LTS and Python 3.11 or newer on `PATH` |
| Installer | Internet for the build only: npm packages, the Electron binary (from GitHub) and the portable Python runtime |
| Installer | A real vendor license key in `onprem/electron/license/LicenseConstants.js` (see [Licensing](ONPREM_LICENSING.md#one-time-vendor-setup)) |
| Installer | Several GB of free disk space on the drive that holds the repo |

## Run on localhost

```powershell
.\onprem\run_onprem.ps1
```

It prepares whatever is missing, then serves everything from one process:

1. Checks `backend/.env`. On the first run it copies `onprem/config/.env.customer.example` there and stops so you can fill in `DATABASE_URL`, `SECRET_KEY` and `JWT_SECRET_KEY`. Run it again afterwards.
2. Creates `backend/.venv` and installs the dependencies if they are missing.
3. Creates the local database if it does not exist (localhost only).
4. Builds the frontend with `VITE_DEPLOYMENT_MODE=onprem` if there is no on-prem build yet.
5. Starts the backend with `DEPLOYMENT_MODE=onprem` at `http://127.0.0.1:8001`. The backend serves the frontend itself. Press Ctrl+C to stop.

| Option | Effect |
|---|---|
| `-Port 9000` | Use another port |
| `-Rebuild` | Rebuild the frontend even if an on-prem build exists |
| `-HooksModule <file.py>` | Load this install's [hooks](ONPREM_HOOKS.md) for this run |

Day-to-day development stays the normal cloud run: backend with `uvicorn app.main:app --reload --port 8001` and the frontend with `npm run dev`. Use `.\onprem\run_onprem.ps1` when you want to see how a change behaves on-prem.

## Build the installer

```powershell
.\onprem\run_onprem.ps1 -Mode App
```

A build takes about 5 minutes when the downloads are already cached; a first build on a clean machine downloads Electron, the portable Python and the npm packages and takes about 15 minutes (both measured). The installer is about 757 MB and holds about 13,000 files. Installing it takes about 5 minutes, because the installer extracts every file and antivirus scans each one. The build leaves pip, the lint tools and the packages' own test folders out of the installer (see `extraResources` in `package.json`) and then imports the packaged backend to prove nothing it needs was left out.

This runs `build_desktop.ps1` and produces the installer in `onprem\desktop-app-build\` (`Lab Management System Setup <version>.exe`). The build:

| Step | What it does |
|---|---|
| 0 | Installs root npm dependencies with `npm install --no-save`, so `package.json` and the lock files are never edited |
| 1 to 1e | Pre-build security checks: a usable `backend/.env`, no development secrets, no private keys in the repo, the config to bake is real, and the vendor license key is not the known test key |
| 2 | Builds the frontend with `VITE_DEPLOYMENT_MODE=onprem`, after starting a test backend in on-prem mode to check it |
| 3 | Verifies the backend source |
| 4 | Prepares the portable Python 3.11 runtime and installs the backend dependencies into it |
| 4.5 | Pre-packaging sanity checks |
| 4.9 | Packages the Electron app with electron-builder (NSIS installer) |
| 5 | Post-build secret audit of the output |

The build needs `backend/.env` to exist because step 1 starts a backend from it. That file is not baked into the installer unless you ask for it.

### Choosing what is baked in

| Command | Baked into the installer |
|---|---|
| `.\onprem\run_onprem.ps1 -Mode App` | **Nothing.** The customer fills in a copy of `onprem/config/.env.customer.example` after installing. |
| `.\onprem\run_onprem.ps1 -Mode App -BakeEnv` | Your `backend/.env` |
| `.\onprem\run_onprem.ps1 -Mode App -EnvFile C:\configs\acme.env` | That file |

A baked file is refused if it still has template values (`changeme`, `your_`, `<...>`) or development secrets. The development-secret check reads the file being baked, so a normal build that bakes nothing is never blocked by it. If a baked file has an OpenAI or bypass key, the build lists what it found and asks you to type YES to continue; without a console it stops. Add `-AllowDevSecrets` to continue without asking (the secrets then ship inside the installer). `onprem/config/.env.customer.example` itself is never accepted: it is a template. To use it, take the default and let the customer complete it.

Add `-HooksModule <file.py>` to include per-install hooks. See [Hooks](ONPREM_HOOKS.md).

### What the installer does

On the customer's PC it installs the app per user (one click, desktop and Start Menu shortcuts). On first launch:

1. A license screen appears until a valid license for that machine is activated.
2. The app then creates the encrypted runtime `.env`, starts its bundled backend and opens the app.
3. The first start takes about 20 seconds; later starts about 9 seconds.

Settings, uploads, logs and licenses live in the user profile, so an upgrade installs over the old version and keeps all data. Paths are in [Configuration](ONPREM_CONFIGURATION.md#where-things-live-windows-desktop-app).

## Verify before you ship

| Check | Command | Covers |
|---|---|---|
| Deployment and hook tests | `cd backend; .\.venv\Scripts\python.exe -m pytest tests/test_deployment_mode.py` | Mode switch, hooks, SPA serving, quick-login off, config loading |
| License tests | `node onprem/electron/license/__tests__/LicenseNegativeCases.test.js` (and the other files in that folder) | Activation, negative cases, persistence, batch issuing |
| Smoke test | `python onprem/smoke_onprem.py --base-url http://127.0.0.1:8001 [--user ... --password ...] [--path /api/v1/sops]` | A running on-prem backend: app served, deep links, quick-login disabled, login, and key endpoints (add lab-scoped paths with `--path`; they need a user that belongs to a lab) |

Run the smoke test against `.\onprem\run_onprem.ps1` before every installer build. After a build, install it on a clean machine or user profile, activate a license and open the main pages.

### Release checklist

- [ ] `develop` merged in and the backend suite shows no new failures
- [ ] [ONPREM_FEATURES.md](ONPREM_FEATURES.md) reviewed for any new develop feature that needs the internet
- [ ] Smoke test passes against a local on-prem run
- [ ] Installer builds; no secrets flagged in step 5
- [ ] Clean install: license screen, activation, login, core pages
- [ ] In-place upgrade over the previous version keeps data and license
- [ ] Customer license issued ([Licensing](ONPREM_LICENSING.md))

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Build stops at "LicenseConstants.js still has the known TEST vendor public key" | Generate the real key pair (see [Licensing](ONPREM_LICENSING.md#one-time-vendor-setup)). Use `build_desktop.ps1 -SkipInstaller` only for local test builds. |
| Packaging hangs or fails while downloading Electron | The build machine cannot reach GitHub. Fix the network or proxy and rerun. |
| Packaging fails with `ECONNRESET` after all the checks pass | Same cause. If Electron's zip is already in `%LOCALAPPDATA%\electron\Cache`, unzip it to a folder and run just the last step with `npx electron-builder --win nsis --x64 --config.electronDist=<that folder>`; no download is needed. Then run the packaged-import check by hand or re-run the build once the network is back. |
| "root is not HTML" in the frontend check | The test backend ran in cloud mode. The build sets `DEPLOYMENT_MODE=onprem` for it; do not override it. |
| Port 8001 is busy | Another backend is running. Stop it, or use `-Port` for a source run. The build reclaims port 8001 for its own check. |
| `backend/.env` not found | Run `.\onprem\run_onprem.ps1` once to create it from the template, then fill it in. |
