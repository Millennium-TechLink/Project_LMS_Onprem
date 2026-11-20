# Licensing

On-prem installs run only with a license that the vendor signed for that machine. Licenses are checked offline: the app embeds the vendor's public key and verifies the signature locally. The private key never ships.

## How it works

| Piece | Where |
|---|---|
| Public key (embedded in the app) | `VENDOR_PUBLIC_KEY_PEM` in `onprem/electron/license/LicenseConstants.js` |
| Private key (vendor only) | `onprem/electron/tools/vendor-data/keys/`, gitignored, also stored offline |
| Vendor tools (not shipped) | `onprem/electron/tools/`: `KeyGenerator.js`, `issue-license.js`, `LicenseIssuer.js`, `LicenseLedger.js`, `switch-vendor-key.js` |
| Issued files and ledger | `onprem/electron/tools/vendor-data/issued-licenses/` and `license-ledger.json`, gitignored |
| App-side checks | `onprem/electron/license/` |
| License on the customer PC | `%APPDATA%\Lab Management System\license\` (backups in `license\backups\`) |

A license is bound to a **machine ID**, shown on the app's activation screen. Validity can start at activation, so a customer who installs late still gets the full period.

## License types

| Type | Use |
|---|---|
| `TRIAL` | Evaluation for a number of days |
| `ANNUAL` | One-year paid license |
| `SUBSCRIPTION` | Recurring term |
| `ENTERPRISE` | Negotiated term |
| `PERMANENT` | Never expires |

Every non-permanent type takes **days valid from activation**. The customer has an activation window (default 7 days from issue) to activate; the outer expiry date on the license is that window plus the days.

## One-time vendor setup

1. Generate the key pair on the vendor machine: `node onprem/electron/tools/KeyGenerator.js`. It writes the public key into `LicenseConstants.js`, saves the private key under `onprem/electron/tools/vendor-data/keys/` and marks it active.
2. Store the private key offline as well (encrypted vault or HSM). Only authorized people may hold it.
3. Rebuild the installer. The build refuses the known test key, so an installer cannot ship with a placeholder identity.

Never commit a `.pem`, `.lic` or anything under `vendor-data/`. If the private key is exposed, generate a new pair and re-issue every active license.

## Issue one license

```powershell
node onprem/electron/tools/issue-license.js
```

It asks only what changes the license:

| Prompt | Notes |
|---|---|
| Company | Required |
| Contact name | Defaults to the company |
| License type | Default `PERMANENT` |
| Valid for how many days from activation | Not asked for `PERMANENT` |
| Machine ID | From the customer's activation screen. `*` makes a site license for any machine. |

It writes a signed `.lic` file, prints an **activation key** (`LMS-V1-...`) and records the license in the ledger.

## Issue many licenses

Write a CSV and run one command. Nothing is asked.

```
machineId,company,licenseType,days
A89B-1886-1FF1,Acme Labs,TRIAL,30
A89B-1886-1FF2,Beta Testing,ANNUAL,365
C3D4-5566-77AA,Gamma QA,PERMANENT,
```

```powershell
node onprem/electron/tools/issue-license.js --batch customers.csv [--key path\to\private.pem]
```

| Column | Required | Notes |
|---|---|---|
| `machineId` | yes | Format `XXXX-XXXX-XXXX`, or `*` |
| `company` | yes | |
| `licenseType` | no | Default `PERMANENT` |
| `days` | for non-permanent types | Days valid from activation |
| `name`, `email`, `label` | no | Contact details and `.lic` file label |
| `activationWindowDays`, `expiryDate` | no | Override the defaults (`expiryDate` is `NEVER` or `YYYY-MM-DD`) |

The whole file is validated first and **nothing is signed if any row is wrong**; every problem is reported together. Duplicate machine IDs are refused (a `*` may repeat). Without `--key`, the key marked active by `KeyGenerator.js` is used, and a key that does not match the embedded public key is rejected. The run writes `customers.issued.csv` listing each customer's `.lic` path and activation key, ready to send.

## Activate on the customer machine

1. Install and start the app. The activation screen shows the **machine ID**; send it to the vendor.
2. The vendor issues the license and sends the activation key or the `.lic` file.
3. The customer chooses **Enter Activation Key** (paste the key) or **Import .lic File** (pick the file).

Activation is offline. The license then persists across restarts, crashes and in-place upgrades. If the machine ID changes (new PC, major hardware change), the old license no longer matches and a new license is needed.

## Manage issued licenses

| Command | Purpose |
|---|---|
| `node onprem/electron/tools/issue-license.js --list` | Show the ledger |
| `node onprem/electron/tools/issue-license.js --lookup <text>` | Search by customer, company or email |
| `node onprem/electron/tools/issue-license.js --reissue <id>` | Re-sign from a ledger record |
| `node onprem/electron/tools/switch-vendor-key.js --show` | Identify the key currently embedded in the app |

## Troubleshooting

| Screen or symptom | Meaning and fix |
|---|---|
| "Invalid license" (corrupted, tampered with, or issued for a different machine) | The key was altered or signed by another key, or the machine ID does not match. Check the machine ID and issue a new license if needed. |
| `EXPIRED` | The validity period ended. Issue a renewal. |
| `WINDOW EXPIRED` | The customer did not activate within the activation window. Issue a new license. |
| Clock rollback message | The system date was moved back. Correct the clock. |
| `KEYPAIR MISMATCH` when issuing | The private key does not match `VENDOR_PUBLIC_KEY_PEM`. Use the active key or `switch-vendor-key.js`. |

## Tests

```powershell
node onprem/electron/license/__tests__/LicenseNegativeCases.test.js   # missing, garbage, tampered, wrong machine, other signer
node onprem/electron/license/__tests__/BatchIssue.test.js             # CSV validation and bulk issuing
```

The other files in `onprem/electron/license/__tests__/` cover validation, storage, backup, activation and diagnostics.
