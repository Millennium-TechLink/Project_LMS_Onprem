<#
.SYNOPSIS
    One command to run the LMS in on-prem mode, on localhost or as the desktop installer.

.DESCRIPTION
    -Mode Local (default)  Prepares everything that is missing, then serves the on-prem app at
                           http://127.0.0.1:<Port>: Python venv, backend dependencies, the database,
                           and the on-prem frontend build. Ctrl+C stops it.
    -Mode App              Builds the Windows installer with build_desktop.ps1.

.PARAMETER Rebuild
    Rebuild the frontend even if an on-prem build already exists.

.PARAMETER Port
    Port for Local mode. Default 8001.

.PARAMETER BakeEnv
    App mode only: bake backend/.env into the installer as the ready-to-run config.
    Without it (the default) no env is baked and the customer fills in a copy of
    onprem/config/.env.customer.example.

.PARAMETER EnvFile
    App mode only: bake this env file instead of backend/.env. It must be a real config.

.PARAMETER AllowDevSecrets
    App mode with a baked env: continue even if the baked file has development secrets (OpenAI key, bypass key).
    They then ship inside the installer. Without it the build asks first, or stops when nobody can answer.

.PARAMETER HooksModule
    Python file with this install's deployment hooks (see onprem/docs/examples/customer_hooks.example.py).
    It is copied to backend/app/customer_hooks.py for this run, so Local mode loads it and App mode
    packages it into the installer, then it is removed again.

.EXAMPLE
    .\onprem\run_onprem.ps1
    .\onprem\run_onprem.ps1 -Mode App
    .\onprem\run_onprem.ps1 -Mode App -BakeEnv
    .\onprem\run_onprem.ps1 -Mode App -EnvFile C:\configs\acme.env
#>

param(
    [ValidateSet('Local', 'App')][string]$Mode = 'Local',
    [switch]$Rebuild,
    [int]$Port = 8001,
    [switch]$BakeEnv,
    [string]$EnvFile = '',
    [switch]$AllowDevSecrets,
    [string]$HooksModule = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # app repo root; this script lives in <app repo>/onprem
if (-not (Test-Path (Join-Path $root 'backend\app'))) {
    Write-Host "`n[X] $PSScriptRoot must be cloned inside the LMS app repo as 'onprem' (backend\app not found in $root). See README.md." -ForegroundColor Red
    exit 1
}

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) { Remove-CustomerHooks; Write-Host "`n[X] $text" -ForegroundColor Red; exit 1 }

# A hooks file copied in for this run is removed afterwards so it cannot leak into a later build.
$hooksTarget = Join-Path $root 'backend\app\customer_hooks.py'
$hooksCopied = $false
function Remove-CustomerHooks {
    if ($script:hooksCopied -and (Test-Path $hooksTarget)) { Remove-Item $hooksTarget -Force }
    $script:hooksCopied = $false
}
if ($HooksModule) {
    if (-not (Test-Path $HooksModule)) { Fail "Hooks file not found: $HooksModule" }
    if (Test-Path $hooksTarget) { Fail 'backend/app/customer_hooks.py already exists. Remove it or drop -HooksModule.' }
    Copy-Item $HooksModule $hooksTarget -Force
    $hooksCopied = $true
    Write-Host "  Using hooks from $HooksModule" -ForegroundColor Yellow
} elseif (Test-Path $hooksTarget) {
    Write-Host '  Note: backend/app/customer_hooks.py exists and will be used (and packaged in App mode).' -ForegroundColor Yellow
}

if ($Mode -eq 'App') {
    Step 'Building the Windows installer'
    if ($EnvFile) {
        if (-not (Test-Path $EnvFile)) { Fail "Env file not found: $EnvFile" }
        Write-Host "  Baking $EnvFile into the installer." -ForegroundColor Yellow
        & "$PSScriptRoot\build_desktop.ps1" -EnvFile (Resolve-Path $EnvFile).Path -AllowDevSecrets:$AllowDevSecrets
    } elseif ($BakeEnv) {
        Write-Host '  Baking backend/.env into the installer.' -ForegroundColor Yellow
        & "$PSScriptRoot\build_desktop.ps1" -AllowDevSecrets:$AllowDevSecrets
    } else {
        Write-Host '  No env baked: the customer fills in onprem/config/.env.customer.example.' -ForegroundColor Yellow
        & "$PSScriptRoot\build_desktop.ps1" -SkipEnvBake
    }
    $buildCode = $LASTEXITCODE
    Remove-CustomerHooks
    exit $buildCode
}

# ---- Local mode ----
$backend = Join-Path $root 'backend'
$envFile = Join-Path $backend '.env'
$venvPy  = Join-Path $backend '.venv\Scripts\python.exe'

Step 'Configuration (backend/.env)'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $PSScriptRoot 'config\.env.customer.example') $envFile
    Fail "Created backend/.env from the customer template. Fill in DATABASE_URL and the secrets (see onprem/docs/ONPREM_CONFIGURATION.md), then run this again."
}
$dbLine = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=\s*(.+)$' | Select-Object -First 1
if (-not $dbLine) { Fail 'DATABASE_URL is not set in backend/.env.' }
$dbUrl = $dbLine.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
if ($dbUrl -match 'changeme|your_|<.+>') { Fail 'DATABASE_URL in backend/.env is still a placeholder.' }
Write-Host '  backend/.env found.' -ForegroundColor Green

Step 'Python environment'
if (-not (Test-Path $venvPy)) {
    Write-Host '  Creating backend/.venv ...'
    & python -m venv (Join-Path $backend '.venv'); if ($LASTEXITCODE -ne 0) { Fail 'python -m venv failed. Install Python 3.11+ first.' }
    & $venvPy -m pip install --quiet -r (Join-Path $backend 'requirements.txt'); if ($LASTEXITCODE -ne 0) { Fail 'pip install failed.' }
}
Write-Host '  backend/.venv ready.' -ForegroundColor Green

Step 'Database'
$env:LMS_RUN_DB_URL = $dbUrl
$check = @'
import os, sys
from urllib.parse import urlparse
import psycopg2
url = os.environ["LMS_RUN_DB_URL"]
u = urlparse(url)
name = u.path.lstrip("/").split("?")[0]
try:
    psycopg2.connect(url).close()
    print("exists:" + name)
except psycopg2.OperationalError as e:
    if "does not exist" not in str(e):
        print("unreachable:" + str(e).strip().splitlines()[0]); sys.exit(2)
    if u.hostname not in ("localhost", "127.0.0.1"):
        print("missing-remote:" + name); sys.exit(3)
    admin = url.replace("/" + name, "/postgres", 1)
    c = psycopg2.connect(admin); c.autocommit = True
    c.cursor().execute('CREATE DATABASE "%s"' % name.replace('"', ""))
    print("created:" + name)
'@
$result = $check | & $venvPy -
$code = $LASTEXITCODE
Remove-Item Env:LMS_RUN_DB_URL -ErrorAction SilentlyContinue
if ($code -ne 0) { Fail "Database: $result" }
Write-Host "  $result" -ForegroundColor Green

Step 'On-prem frontend'
$dist = Join-Path $root 'frontend\dist'
$marker = Join-Path $dist '.deployment-mode'
$built = (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq 'onprem')
if ($Rebuild -or -not $built) {
    $fe = Join-Path $root 'frontend'
    if (-not (Test-Path (Join-Path $fe 'node_modules'))) {
        Write-Host '  Installing frontend dependencies ...'
        Push-Location $fe; cmd /c 'npm install --no-audit --no-fund >nul 2>&1'; $c = $LASTEXITCODE; Pop-Location
        if ($c -ne 0) { Fail 'npm install failed.' }
    }
    Write-Host '  Building the frontend (VITE_DEPLOYMENT_MODE=onprem) ...'
    $env:VITE_DEPLOYMENT_MODE = 'onprem'
    Push-Location $fe; cmd /c 'npm run build >nul 2>&1'; $c = $LASTEXITCODE; Pop-Location
    Remove-Item Env:VITE_DEPLOYMENT_MODE -ErrorAction SilentlyContinue
    if ($c -ne 0) { Fail 'Frontend build failed. Run: cd frontend; $env:VITE_DEPLOYMENT_MODE="onprem"; npm run build' }
    Set-Content -Path $marker -Value 'onprem'
}
Write-Host '  On-prem frontend ready.' -ForegroundColor Green

Step "Starting the LMS on http://127.0.0.1:$Port (Ctrl+C to stop)"
$env:DEPLOYMENT_MODE = 'onprem'
$env:PORT = "$Port"
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
Set-Location $backend
try {
    & $venvPy -m uvicorn app.main:app --host 127.0.0.1 --port $Port
} finally {
    Remove-CustomerHooks
}
