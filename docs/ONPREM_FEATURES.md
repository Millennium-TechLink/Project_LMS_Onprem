# Features: what on-prem turns on and off

Same code as develop, switched by `DEPLOYMENT_MODE=onprem` (backend) and `VITE_DEPLOYMENT_MODE=onprem` (frontend build). Cloud is the default and runs with every feature on.

Everything that differs between cloud and on-prem is a named **feature switch**. The list lives in one place, `backend/app/core/features.py`, and the product's choice for each one is in [`onprem/config/features.json`](../config/features.json). Nothing is hard-coded per page any more.

## The switches

| Feature | What it covers | On-prem | API blocked when off |
|---|---|---|---|
| `self_signup` | Sign-up, Register lab, Get started, and the checks behind them | off | yes |
| `password_reset_email` | Forgot password by email | off | no |
| `otp_login` | Mobile OTP sign-in | off | yes |
| `mfa` | Email code and authenticator steps at login, and their setup screens | off | yes |
| `dev_quick_login` | Quick login, quick-auth and validate pages, dev toolbar | off | yes |
| `marketing_pages` | Changelog, release notes | off | no |
| `audits` | Audits list, detail, schedule, analytics, checklist library | off | no |
| `lab_recommendations` | Lab recommendations | off | no |
| `lab_approvals` | Lab approvals and registration submission | off | no |
| `online_payment` | Online payment (needs the payment gateway) | off | no |
| `crm_connectors` | Salesforce and HubSpot connectors (need the internet) | off | no |
| `lab_onboarding` | Lab code and invite UI (cloud multi-lab onboarding) | off | no |
| `report_email` | Emailing reports from a project (needs SMTP) | off | no |
| `email_notifications` | Email notification preferences and digests | off | no |
| `customer_portal` | Customer self-service portal (on-prem also needs `CSSP_PORTAL_URL`) | on | n/a |
| `admin_password_reset` | An admin resets another user's password from User Management (the reverse of the rest: on-prem has no email reset) | on | n/a |

"API blocked when off" means the endpoint answers 404 while the feature is off. For the others the UI is hidden but the endpoint still exists, so treat them as hidden rather than secured; add `Depends(features.require('<key>'))` to a route if one must be unreachable.

## Turning a feature on or off

| Where | How | Scope |
|---|---|---|
| The product | Edit `onprem/config/features.json` (`true` / `false`). It ships inside the installer as `backend/features.json` | Every installer built afterwards |
| One install | Add `FEATURE_FLAGS=audits=on,online_payment=off` to that install's `.env` (see [Configuration](ONPREM_CONFIGURATION.md)) | That install only, no rebuild |
| A source run | `FEATURES_FILE=C:\path\features.json` to use another file | That run |

Order of precedence: `FEATURE_FLAGS`, then `features.json`, then the default in `features.py`. The frontend asks the backend (`GET /api/v1/deployment/features`) before it first renders, so one change covers both sides and needs no frontend rebuild.

Turning a feature on only shows it again. It does not make a feature that needs the internet or a mail server work offline.

## Different, not removed

| Behaviour | On-prem | Where |
|---|---|---|
| Frontend serving | The backend serves the built app itself | `backend/app/core/spa.py`, `main.py` |
| WebSocket and API URLs | Same origin as the page | `frontend/src/utils/wsUrl.js`, `labManagementApi.js` |
| Licensing | Vendor-signed license, checked by the desktop app | `onprem/electron/license/` |
| Configuration | Encrypted `.env` in the user profile | `backend/app/core/env_crypto.py`, `config.py` |

SMTP, OpenAI, S3, CRM and lab-engine settings are cloud services: leave them unset. They have no switch.

## When develop gets a new feature

1. Does it need the internet, email or a cloud service? If not, nothing to do.
2. If it does, add a `Feature(...)` to `backend/app/core/features.py` with its on-prem default.
3. List the same key in `onprem/config/features.json`. `backend/tests/test_features.py` fails until you do, and also fails if the frontend asks for a key that does not exist or a catalog entry is never used.
4. Gate the UI with `useFeature('<key>')` (`frontend/src/features/featureFlags.js`) and, if the API must be unreachable, `Depends(features.require('<key>'))` on the route.
5. Add a row to the table above, then run the smoke test (`onprem/smoke_onprem.py`) against an on-prem backend before building an installer.

A feature nobody registers behaves as it does in cloud: on. That is the only way a new cloud feature can appear in on-prem unnoticed, which is why step 2 matters.
