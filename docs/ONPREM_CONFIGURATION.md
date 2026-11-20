# On-prem configuration

How an offline (on-prem) install is configured, secured and recovered. Applies to the desktop app built by `build_desktop.ps1` and to running the branch from source with `DEPLOYMENT_MODE=onprem`. Start with the [on-prem README](README.md); the build and run steps are in [ONPREM_BUILD.md](ONPREM_BUILD.md).

## Quick start

One command either way, from the repo root:

| Goal | Command | What it does |
|---|---|---|
| Run on localhost | `.\onprem\run_onprem.ps1` | Checks `backend/.env`, creates `backend/.venv` and installs dependencies if missing, creates the local database if it does not exist, builds the on-prem frontend if needed, then serves the app at `http://127.0.0.1:8001` in on-prem mode. |
| Build the desktop installer | `.\onprem\run_onprem.ps1 -Mode App` | Runs `build_desktop.ps1` (installs its own prerequisites). By default no env is baked: the customer fills in a copy of `onprem/config/.env.customer.example`. |
| Installer with your env baked in | `.\onprem\run_onprem.ps1 -Mode App -BakeEnv` | Bakes `backend/.env` as the ready-to-run config. It must be a real config (no template values, no development secrets). |
| Installer with a specific env file | `.\onprem\run_onprem.ps1 -Mode App -EnvFile C:\configs\acme.env` | Bakes that file instead, with the same checks. |
| Installer or localhost run with hooks | `.\onprem\run_onprem.ps1 -Mode App -HooksModule C:\configs\acme_hooks.py` | Loads that Python file as the install's [hooks](ONPREM_HOOKS.md). Works with `-Mode Local` too, and combines with `-BakeEnv` or `-EnvFile`. |

The build starts from the code you have checked out, so it works from `develop` once this is merged. The first run on a machine without `backend/.env` copies `onprem/config/.env.customer.example` and stops so you can fill in `DATABASE_URL` and the secrets. Use `-Rebuild` to force a fresh frontend build and `-Port` to change the port.

## Where things live (Windows desktop app)

| What | Path |
|---|---|
| Runtime settings (`.env`) | `%LOCALAPPDATA%\Lab Management System\backend\.env` |
| Pre-encryption backup of `.env` (latest) | `%LOCALAPPDATA%\Lab Management System\backups\config\.env.pre-encrypt.bak` |
| Dated `.env` backups | `%LOCALAPPDATA%\Lab Management System\backups\config\history\` |
| Uploads (local storage mode) | `%LOCALAPPDATA%\Lab Management System\uploads` |
| License files | `%APPDATA%\Lab Management System\license\` |
| Logs | `%APPDATA%\Lab Management System\logs\` |

From source, the backend reads `backend/.env` instead. Set `LMS_BACKEND_CONFIG_DIR` to point it at another folder.

## Settings reference

Start from `onprem/config/.env.customer.example`. Lines starting with `#` are optional.

| Setting | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string for this customer's database. A local database keeps the app fully offline. |
| `SECRET_KEY` | yes | Generate a fresh value per customer: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `JWT_SECRET_KEY` | yes | A different fresh value. Changing it signs every user out. |
| `CRM_ENCRYPTION_KEY` | no | Must be a valid Fernet key or empty. A leftover `changeme...` template value is treated as empty; any other invalid value stops the backend at startup. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `DEPLOYMENT_MODE` | yes for on-prem | `onprem` turns on the offline behaviour (password-only login, SPA served by the backend). Default is `cloud`. |
| `CSSP_PORTAL_URL` | no | Customer portal URL. Empty keeps the portal module hidden. |
| `DEPLOYMENT_HOOKS_MODULE` | no | Python module imported at startup (on-prem only) that registers deployment hooks. See Hooks below. |
| `FEATURE_FLAGS` | no | Turn features on or off for this install only, e.g. `audits=on,online_payment=off`. Overrides the product defaults in `features.json`. See [Features](ONPREM_FEATURES.md). |
| `FEATURES_FILE` | no | Path of a different `features.json` to use instead of the one shipped with the app. |
| `HOST`, `PORT` | no | Defaults `0.0.0.0` and `8001`. The desktop app can override the port with `LMS_BACKEND_PORT`. |
| `CORS_ORIGINS` | no | Origin(s) the frontend is served from. Default `http://localhost:8001`. |
| `ALLOWED_REGISTRATION_DOMAINS` | no | Comma-separated email domains allowed to self-register. The template lists internal and public domains; trim it to the customer's own. |
| `STORAGE_TYPE`, `UPLOAD_DIR` | no | `local` by default. For several client PCs, point `UPLOAD_DIR` at the Samba share (UNC path) and set `LMS_SVC_SMB_USER` and `LMS_SVC_SMB_PASSWORD`. |
| `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_POOL_RECYCLE_SECONDS` | no | Connection pool tuning. Recycle defaults to 300 seconds. |
| `DB_KEEP_ALIVE_MINUTES` | no | For serverless databases that suspend when idle: ping the pool this often. Default 0 (off). |
| SMTP, OpenAI, CRM, S3, lab-engine settings | no | Cloud-only features. Leave unset on an offline install. |

## Secure configuration checklist

- [ ] `SECRET_KEY` and `JWT_SECRET_KEY` are freshly generated for this customer and are not the `changeme` placeholders.
- [ ] `.env` is not committed anywhere. `.gitignore` covers `.env`, `*.pem` and `*.lic`.
- [ ] No private signing key (`.pem`) is on the customer machine or in the installer. Only the public key is embedded in the app.
- [ ] The installer was built with the default (no `.env` baked), or the baked one (`-BakeEnv` / `-EnvFile`) was made for this customer only.
- [ ] `quick-login` is disabled on-prem (it returns 404 when `DEPLOYMENT_MODE=onprem`).
- [ ] `ALLOWED_REGISTRATION_DOMAINS` lists only the customer's own domains.
- [ ] `DATABASE_URL` points at a local or LAN database, not a cloud one.
- [ ] The database user is not a superuser where avoidable.
- [ ] Optional cloud integrations (SMTP, OpenAI, CRM, S3) are unset.

## Configuration lifecycle

**Create.** Copy `onprem/config/.env.customer.example` to `%LOCALAPPDATA%\Lab Management System\backend\.env`, fill in the required settings, then start the app. The app leaves the file editable until the backend is up and the database connection works, then encrypts it for the current Windows user. If the database is unreachable, the file stays plaintext so you can fix it.

**Store.** After the first start the file is encrypted with Windows DPAPI. It can only be read by the same Windows user on the same machine. Just before encrypting, the app saves a plaintext copy under `backups\config\` (see paths above). Those copies are readable by the current user only. Keep them, or move them to a secure location.

**Update.** Edit the `.env` while the app is closed, then restart. If the file is encrypted, restore a plaintext copy from `backups\config\`, edit it, and put it back; the app re-encrypts it on the next start. Do not edit `JWT_SECRET_KEY` unless you want everyone signed out.

**Back up.** Include `backups\config\`, the uploads folder and the database in the customer's regular backup. Back up the license folder (`%APPDATA%\Lab Management System\license\`) too. The app keeps its own license backups in `license\backups\`.

**Recover.**
- Lost or unreadable `.env` (new PC, new Windows user, or the "could not be decrypted" startup error): copy the latest plaintext backup into `backend\.env` and start the app again.
- Lost license: re-activate with the activation key or `.lic` file. Activation is tied to the machine ID shown on the activation screen.
- Backend fails at startup: read `%APPDATA%\Lab Management System\logs\backend.log`; the usual causes are a wrong `DATABASE_URL` and an invalid `CRM_ENCRYPTION_KEY`.

## Hooks

Optional Python hooks customize one install (seed data, jobs, shutdown backups). See [ONPREM_HOOKS.md](ONPREM_HOOKS.md).

## Forgotten passwords

On-prem has no email, so there is no self-service reset. An Admin opens User Management, clicks the key icon on the user's row and sets a new password (`POST /api/v1/auth/users/{id}/reset-password`). Admins can only reset users in their own lab, not Superusers or primary accounts, and not themselves (they use Change Password). Every reset is written to the audit log.

## Licensing

Licenses are vendor-signed and bound to a machine ID. See [ONPREM_LICENSING.md](ONPREM_LICENSING.md) for issuing (single and bulk), activation and troubleshooting.
