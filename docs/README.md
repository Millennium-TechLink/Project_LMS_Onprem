# On-prem LMS

The same codebase as the cloud product, switched into an offline, single-customer install. One mode switch decides the behavior; nothing is edited per customer.

| | Cloud (default) | On-prem |
|---|---|---|
| Backend switch | `DEPLOYMENT_MODE=cloud` | `DEPLOYMENT_MODE=onprem` |
| Frontend switch | `VITE_DEPLOYMENT_MODE` unset | `VITE_DEPLOYMENT_MODE=onprem` |
| Delivery | Hosted web app | Windows desktop installer, or run from source on localhost |
| Login | Password + email/authenticator steps | Password only |
| Access control | Subscription | Vendor-signed, machine-bound license |
| Configuration | Server environment | Encrypted `.env` in the user profile |

## Start here

| I want to... | Command | Details |
|---|---|---|
| Run the app on localhost in on-prem mode | `.\onprem\run_onprem.ps1` | [Build and run](ONPREM_BUILD.md#run-on-localhost) |
| Build the Windows installer | `.\onprem\run_onprem.ps1 -Mode App` | [Build and run](ONPREM_BUILD.md#build-the-installer) |
| Bake a customer's configuration into the installer | `.\onprem\run_onprem.ps1 -Mode App -EnvFile C:\configs\acme.env` | [Build and run](ONPREM_BUILD.md#choosing-what-is-baked-in) |
| Customize one install (seed data, jobs, backups) | `.\onprem\run_onprem.ps1 -Mode App -HooksModule C:\configs\acme_hooks.py` | [Hooks](ONPREM_HOOKS.md) |
| Issue one license, or hundreds | `node onprem/electron/tools/issue-license.js` or `--batch customers.csv` | [Licensing](ONPREM_LICENSING.md) |
| Check a running on-prem backend | `python onprem/smoke_onprem.py` | [Build and run](ONPREM_BUILD.md#verify-before-you-ship) |
| Configure, back up or recover an install | edit the install's `.env` | [Configuration](ONPREM_CONFIGURATION.md) |

## Documents

| Document | Read it for |
|---|---|
| [ONPREM_BUILD.md](ONPREM_BUILD.md) | Running from source, building the installer, what the build checks, verification and release checklist |
| [ONPREM_CONFIGURATION.md](ONPREM_CONFIGURATION.md) | Settings reference, secure-configuration checklist, create / store / update / back up / recover |
| [ONPREM_HOOKS.md](ONPREM_HOOKS.md) | The hook points, how to write and ship hooks, how to add a new one |
| [ONPREM_LICENSING.md](ONPREM_LICENSING.md) | Vendor key setup, issuing single and bulk licenses, activation, troubleshooting |
| [ONPREM_FEATURES.md](ONPREM_FEATURES.md) | What on-prem turns off or changes, and the checklist for each new develop feature |
| [ONPREM_REQUIREMENTS.md](ONPREM_REQUIREMENTS.md) | Dependencies, source versus packaged behavior, multi-user and multi-instance scope, startup time |

## How the pieces fit

```
develop code ──► mode switch (DEPLOYMENT_MODE / VITE_DEPLOYMENT_MODE)
                        │
        ┌───────────────┼────────────────────┐
        ▼               ▼                    ▼
 run_onprem.ps1   deployment hooks      license system
 (run or build)   (per-install code)    (issue, sign, activate)
        │               │                    │
        └───────► desktop installer ◄────────┘
```

- The **mode switch** is the only thing that makes the code behave as on-prem.
- **`run_onprem.ps1`** is the single entry point for running and building.
- **Hooks** are optional Python extension points inside the backend for one install's needs.
- The **license system** lives in `onprem/electron/` and is checked before the backend starts.

## Where things live

Everything that exists only for the on-prem product sits in one folder, `onprem/`, which is its own git repository, cloned inside the app repo (see the [repo README](../README.md)). Only the code that has to be part of the shared app stays outside it: the mode switch and hooks in `backend/` (`app/core/deployment.py`, `app/core/spa.py`, `app/customer_hooks.py`) and the `VITE_DEPLOYMENT_MODE` checks in `frontend/`.

```
onprem/
  run_onprem.ps1              run on localhost, or build the installer
  build_desktop.ps1           the installer build and its checks (called by run_onprem.ps1)
  setup_local_runtime_env.ps1 copy backend/.env for testing the unpacked exe (developers only)
  verify_customer_setup.ps1   checks on a customer machine after install
  smoke_onprem.py             HTTP smoke test against a running on-prem backend
  package.json                electron and electron-builder settings (what goes in the installer)
  electron/                   desktop shell, license system and vendor license tools
  config/                     features.json (what is on or off) and .env.customer.example (the customer template)
  assets/                     app icons
  docs/                       these documents and the hooks example
  node_modules/               electron and electron-builder (gitignored)
  build-cache/                downloaded Python runtime and build cache (gitignored)
  desktop-app-build/          installer and unpacked app output (gitignored)
```

Run the scripts from the repo root (`.\onprem\run_onprem.ps1`) or from anywhere; they find the repo root themselves. `backend/python/` (the Python runtime the build stages for packaging) is the one build artifact that stays under `backend/`, because the installer packages it from there.
