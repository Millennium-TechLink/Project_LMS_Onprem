# On-prem requirements and open decisions

What the on-prem desktop and server install depends on, and how the current version behaves. Written from the code. For settings and recovery steps see `ONPREM_CONFIGURATION.md`.

## Source run versus packaged build

| | From source | Packaged |
|---|---|---|
| Python | project `.venv` | bundled Python 3.11, backend `.py` compiled to `.pyc`, sources removed |
| Frontend | Vite build served by the backend (`VITE_DEPLOYMENT_MODE=onprem`) | same bundle, copied to `backend/frontend_dist` |
| Settings | `backend/.env` | `%LOCALAPPDATA%\Lab Management System\backend\.env`, encrypted after the first healthy start |
| License screen | none | shown until activated |
| Logs | console / log file you choose | `%APPDATA%\Lab Management System\logs\` |
| Port | `--port`, default 8001 | 8001, or `LMS_BACKEND_PORT` / `PORT` |
| Not bundled | PostgreSQL | PostgreSQL (must be installed and reachable) |

## Multi-user: requirements to capture from developers

POC scope is "several users share one backend and one database". These need a developer decision before any production claim:

- Authentication: password only on-prem (no email code, no authenticator). Acceptable for all roles?
- Session isolation: tokens carry user and lab; confirm no cross-lab reads on every endpoint, not just customers.
- Data consistency: concurrent edits to the same record (last write wins today). Is optimistic locking needed?
- Concurrent access limits: expected simultaneous users per install, database pool sizing (`DB_POOL_SIZE`, `DB_MAX_OVERFLOW`).
- File uploads from several PCs: Samba share setup and permissions.

## Multi-instance: requirements and assumptions (future architecture)

Nothing here is validated; it records open questions only.

- One server with several instances versus several servers: not decided.
- Port contention: the backend defaults to 8001; each instance needs its own `PORT`.
- Database contention: instances sharing one database need per-instance or per-lab separation. A lab id scopes data today.
- Licensing: a license is tied to one machine ID. Multi-instance needs one license per instance or a site license.
- Shared uploads and `.env`: each instance needs its own config folder.
- Upgrades: rolling versus all-at-once.

## Developer requirements checklist for the POC

Answers from the code, with the open decisions marked.

- Runtime and deployment dependencies: Windows (DPAPI, NSIS installer; tested on Windows 11); PostgreSQL reachable at `DATABASE_URL` (not bundled); Python 3.11 is bundled. Supported PostgreSQL: the version we run and test with today (18).
- Local packages or services: none besides PostgreSQL. `pg_dump` and `pg_restore` must be on `PATH` for backups; they come with the PostgreSQL install, so they are required, not bundled.
- Environment variables: see `ONPREM_CONFIGURATION.md`.
- Offline license assumptions: the license is verified locally against the embedded public key and tied to the machine ID; no network needed. After a hardware change that alters the machine ID, the vendor issues a new license for the new machine ID, same as a lost license (see `ONPREM_CONFIGURATION.md`).
- Data and storage: local uploads under `%LOCALAPPDATA%\Lab Management System\uploads`, or a Samba share for several PCs. Backups are taken on demand and before an upgrade; there is no built-in schedule or pruning, so the customer's regular backup should include the folders listed in `ONPREM_CONFIGURATION.md`.
- Basic user and session scenarios: login, concurrent sessions, same-lab sharing and cross-lab isolation are covered above.
- Operations: the app starts, stops and restarts its own backend and recovers from a crash; backups and upgrades are run by the customer's IT.
- Architecture-dependent items (multi-instance, multi-server): out of POC scope, see above.

## Startup time

Measured on the packaged app, warm start (from the license check to "backend ready", taken from `electron.log`), alternating builds on one quiet Windows 11 machine, three warm runs each:

| Build | Time |
|---|---|
| Before the startup work | about 12.3 s |
| Now | about 8.6 s |

What changed: heavy libraries (pandas, numpy, PDF, Word and Excel tools, reportlab, PIL, qrcode, httpx) are imported when first used instead of at backend startup, and the `.env` permission lock re-applied on every launch no longer holds up the backend start. A test (`backend/tests/test_lazy_imports.py`) fails if any of them loads at startup again, so a new top-level `import pandas` is caught in review.

Where the remaining time goes: Python importing the backend's own modules and the web and database frameworks (about 6 s here), roughly 1.4 s of it just opening module files (typical of antivirus scanning each file), then under 1 s of real startup work (schema check and migrations).

Notes:
- The first start after an install is slower (about 20 s here) because bytecode and antivirus caches are cold.
- Adding the install folder to the Windows Defender exclusions would cut the per-file scanning cost. It needs an administrator and was not measured.
- If more is needed, the next step is registering rarely used routers lazily (estimated saving: about 3 s), which is a design change to `main.py`.

### Keeping startup fast as develop changes

Most of the start time is importing the backend's modules, so it grows as modules and schemas are added. To catch a slow import early:

- `python scripts/startup_profile.py` lists the slowest packages and modules to import. Add `--budget 12` to fail when importing the app takes longer than 12 seconds. Run it before building an installer, and against the packaged Python with `--python` and `--backend-dir`.
- `backend/tests/test_startup_budget.py` fails when importing the app loads more than 10% more modules than the recorded baseline (a count, so it does not depend on machine speed). Raise `BASELINE_MODULES` in it when a feature legitimately adds modules.
- The installer build prints how long its test backend took to become healthy and warns past 25 seconds.
- `backend/tests/test_lazy_imports.py` fails if a heavy library (pandas, PDF, Word, Excel, PIL and similar) is imported at startup. Import such libraries inside the function that uses them.
- Migrations that are already applied are skipped on later starts, and the schema check takes about half a second, so they are not worth tuning.

When the backend does not start, the app now stops waiting as soon as the backend process exits and shows the reason from its output, instead of polling for 2.5 minutes. The splash window no longer stays on top of other applications.

### Closing and reopening

Closing the window stops the backend, which takes about 3 seconds (the stop request to the Python process is never honored, so the app force-ends it after a short wait). The old process keeps the single-instance lock until it exits. While it is closing it writes `closing.json` next to the logs, and a launch during that time waits for it to finish and then starts normally, instead of being refused. Launching while the app is open and running still just brings the existing window to the front. A leftover marker from a crash is ignored once its process is gone or it is 30 seconds old.

