# LMS on-prem

Packaging for the offline, single-customer install of the LMS: the Windows desktop shell (Electron), the license system and vendor license tools, the installer build, customer configuration templates and the on-prem docs.

The application itself (backend and frontend, including the `DEPLOYMENT_MODE` / `VITE_DEPLOYMENT_MODE` switches and the feature switches) lives in the LMS app repo. This repo only wraps it.

## Setup

This repo is cloned **inside** the app repo, as a folder named `onprem`. The build scripts and `package.json` read `../backend` and `../frontend`, and stop with an error if the app repo is not there.

```powershell
git clone <app-repo-url> Project_LMS
cd Project_LMS
git clone <this-repo-url> onprem
```

The app repo ignores `/onprem/`, so the two repos do not see each other's files.

## Use

```powershell
.\onprem\run_onprem.ps1                 # run on localhost in on-prem mode
.\onprem\run_onprem.ps1 -Mode App       # build the Windows installer
```

Everything else (configuration, hooks, licensing, release checklist) is in [docs/](docs/README.md).

## Versions

An installer is built from this repo plus whatever the app repo has checked out. Note the app repo commit or tag next to each release, and when the app adds a feature switch, add it to [config/features.json](config/features.json) too (the app's `tests/test_features.py` checks the two agree).

## Never commit

- `electron/tools/vendor-data/`, any `.pem` / `.key`, issued `.lic` files and the license ledger (vendor keys and customer data). Covered by `.gitignore`.
- A real `.env`. Only `config/.env.customer.example` is tracked.
- `node_modules/`, `build-cache/`, `desktop-app-build/` (generated).
