# LMS on-prem

Packaging for the offline, single-customer install of the LMS: the Windows desktop shell (Electron), the license system and vendor license tools, the installer build, customer configuration templates and the on-prem docs.

The application itself (backend and frontend, including the `DEPLOYMENT_MODE` / `VITE_DEPLOYMENT_MODE` switches and the feature switches) lives in the LMS app repo. This repo only wraps it.

## Setup

This repo is cloned **inside** the app repo, as a folder named `onprem`. The build scripts and `package.json` read `../backend` and `../frontend`, and stop with an error if the app repo is not there.

```powershell
git clone https://github.com/Millennium-TechLink/Project_LMS.git Project_LMS
cd Project_LMS
git clone https://github.com/Millennium-TechLink/Project_LMS_Onprem.git onprem
```

The app repo ignores `/onprem/`, so the two repos do not see each other's files.

## Use

```powershell
.\onprem\run_onprem.ps1                 # run on localhost in on-prem mode
.\onprem\run_onprem.ps1 -Mode App       # build the Windows installer
```

Everything else (configuration, hooks, licensing, release checklist) is in [docs/](docs/README.md).

## Layout

| Path | What it is |
|---|---|
| `run_onprem.ps1` | Run on localhost, or build the installer (the entry point) |
| `build_desktop.ps1` | The installer build and its checks |
| `verify_customer_setup.ps1`, `setup_local_runtime_env.ps1`, `smoke_onprem.py` | Customer-machine check, developer test setup, smoke test |
| `package.json` | Electron and electron-builder settings (what goes in the installer) |
| `electron/` | Desktop shell, license system and the vendor license tools |
| `config/` | `features.json` and the customer `.env` template |
| `docs/` | The on-prem documentation (start at `docs/README.md`) |
| `assets/` | App icons |

Paths in the docs that start with `backend/` or `frontend/` are in the app repo: the mode switch (`app/core/deployment.py`), the feature switches (`app/core/features.py`, `frontend/src/features/`) and the hook loader live there, not here.

## Tests

The license and desktop-shell unit tests are plain Node scripts. Run one with `node electron/license/__tests__/<name>.test.js`. They use temporary folders, but set `APPDATA` and `LOCALAPPDATA` to a scratch folder when you run them, and unset `ELECTRON_RUN_AS_NODE`. `BackupService.test.js` also needs the Electron binary from `npm install`.

## Versions

An installer is built from this repo plus whatever the app repo has checked out. Note the app repo commit or tag next to each release, and when the app adds a feature switch, add it to [config/features.json](config/features.json) too (the app's `tests/test_features.py` checks the two agree).

## Never commit

- `electron/tools/vendor-data/`, any `.pem` / `.key`, issued `.lic` files and the license ledger (vendor keys and customer data). Covered by `.gitignore`.
- A real `.env`. Only `config/.env.customer.example` is tracked.
- `node_modules/`, `build-cache/`, `desktop-app-build/` (generated).
