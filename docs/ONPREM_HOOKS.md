# Deployment hooks

Hooks let one on-prem install run its own Python code at fixed points in the backend's life, without editing the shared codebase. They are optional: the app runs on-prem with none registered.

Hooks are for customization. Switching develop into an on-prem app is done by the mode switch and `run_onprem.ps1`, not by hooks. See [README](README.md).

## The hooks

| Hook | Runs | Receives | Typical use |
|---|---|---|---|
| `config` | Start of startup, before the database is touched | the settings object | Refuse an unsafe configuration; adjust settings |
| `migrated` | After the schema and migrations are done | the settings object | Seed install-specific data |
| `startup` | Once startup completes | the FastAPI app | Add routes, start a sync or monitoring job |
| `cssp_portal` | After `startup`, only when `CSSP_PORTAL_URL` is set | the FastAPI app | Customer portal wiring |
| `shutdown` | When the backend stops gracefully | the FastAPI app | Flush state, ship a final backup |

The build itself is driven by `run_onprem.ps1 -Mode App`, a script rather than a Python hook.

Rules:
- Hooks run only when `DEPLOYMENT_MODE=onprem`. In cloud mode they are ignored.
- Hooks for a point run in ascending `priority` (default 100), then in registration order.
- A hook that raises is logged and skipped, unless it was registered with `required=True`, in which case the exception stops startup.
- Registering an unknown hook name raises, so a typo fails at load time.
- `shutdown` runs on a graceful stop, such as Ctrl+C on a source run. The installed desktop app ends its backend process directly when the window closes, so `shutdown` hooks do not run there. Do not rely on it for anything that must happen; use `startup` or a scheduled job instead.

## Write and use hooks

1. Create a Python file that registers its hooks:

```python
from app.core import deployment

@deployment.hook(deployment.HOOK_CONFIG, priority=10)
def check_settings(settings):
    if settings.SECRET_KEY.startswith("changeme"):
        raise RuntimeError("SECRET_KEY is not set for this install")

@deployment.hook(deployment.HOOK_MIGRATED, required=True)   # failure stops startup
def seed_install_data(settings):
    ...

@deployment.hook(deployment.HOOK_SHUTDOWN)
def on_stop(app):
    ...
```

A complete example is in [`examples/customer_hooks.example.py`](examples/customer_hooks.example.py). `deployment.register_hook(name, fn, priority=100, required=False)` is the non-decorator form.

2. Hand it to the run or build:

```powershell
.\onprem\run_onprem.ps1 -HooksModule C:\configs\acme_hooks.py                 # localhost
.\onprem\run_onprem.ps1 -Mode App -HooksModule C:\configs\acme_hooks.py       # installer
```

`run_onprem.ps1` copies the file to `backend/app/customer_hooks.py` for that run, the backend loads it automatically, the installer packages it, and the script removes it afterwards so it cannot leak into a later build. The path is gitignored.

For a source run you can instead put a module on the Python path and name it in `.env`:

```
DEPLOYMENT_HOOKS_MODULE=acme_hooks
```

## Rules for hook code

- A hook runs inside the backend's Python. Any library it imports must be available there: the project venv for a source run, and the bundled Python for an installer (add it to `backend/requirements.txt` before building).
- Keep hooks quick. `config` and `migrated` run during startup and delay the first window.
- Do not rely on the network if the install is meant to be offline.

## Test a hook

```python
from app.core import deployment

def test_my_hook(monkeypatch):
    monkeypatch.setattr(deployment.settings, "DEPLOYMENT_MODE", "onprem")
    deployment.clear_hooks()
    import acme_hooks  # registers on import
    assert deployment.run_hooks(deployment.HOOK_STARTUP, object()) == ["expected result"]
```

The framework itself is covered by `backend/tests/test_deployment_mode.py` (order, isolation, priority, required, real startup and shutdown).

## Add a new hook point

1. Add a `HOOK_<NAME>` constant to `backend/app/core/deployment.py` and include it in `HOOK_NAMES`.
2. Call `deployment.run_hooks(deployment.HOOK_<NAME>, ...)` at the right place in `backend/app/main.py`.
3. Add a row to the table above and a test next to the existing lifecycle test.
