<#
.SYNOPSIS
    Sets up the runtime .env for local packaged-EXE testing.

.DESCRIPTION
    Copies backend/.env to:
        %LOCALAPPDATA%\Lab Management System\backend\.env

    This allows you to run:
        onprem\desktop-app-build\win-unpacked\Lab Management System.exe

    without placing any secrets inside the installer itself.

    IMPORTANT:
    - This script is for LOCAL DEVELOPER TESTING ONLY.
    - Never run this script on a customer machine.
    - The development .env is NOT copied into the installer at any point.
    - To deploy to a customer, provide them with a filled-in copy of:
        onprem/config/.env.customer.example

.PARAMETER Force
    Overwrite the target .env if it already exists.

.EXAMPLE
    .\onprem\setup_local_runtime_env.ps1
    .\onprem\setup_local_runtime_env.ps1 -Force
#>

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# ── Source: backend/.env (development config) ─────────────────────────────────
$scriptRoot   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # repo root; this script lives in <repo>/onprem
$sourceEnv    = Join-Path $scriptRoot "backend\.env"

if (-Not (Test-Path $sourceEnv)) {
    Write-Host "ERROR: backend\.env not found at: $sourceEnv" -ForegroundColor Red
    Write-Host "Create backend\.env first, then re-run this script." -ForegroundColor Red
    exit 1
}

# ── Target: %LOCALAPPDATA%\Lab Management System\backend\.env ─────────────────
$localAppData = $env:LOCALAPPDATA
if (-Not $localAppData) {
    Write-Host "ERROR: %LOCALAPPDATA% environment variable is not set." -ForegroundColor Red
    exit 1
}

$targetDir = Join-Path $localAppData "Lab Management System\backend"
$targetEnv = Join-Path $targetDir ".env"

Write-Host ""
Write-Host "=== Local Runtime .env Setup ===" -ForegroundColor Cyan
Write-Host "Source : $sourceEnv"
Write-Host "Target : $targetEnv"
Write-Host ""

# ── Create target directory ────────────────────────────────────────────────────
if (-Not (Test-Path $targetDir)) {
    Write-Host "Creating directory: $targetDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

# ── Check if target already exists ────────────────────────────────────────────
if ((Test-Path $targetEnv) -and (-Not $Force)) {
    Write-Host "INFO: Runtime .env already exists at:" -ForegroundColor Yellow
    Write-Host "  $targetEnv" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To overwrite it, run:" -ForegroundColor Cyan
    Write-Host "  .\onprem\setup_local_runtime_env.ps1 -Force" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Skipping copy. Existing runtime .env was NOT modified." -ForegroundColor Green
    exit 0
}

# ── Copy .env ─────────────────────────────────────────────────────────────────
Copy-Item -Path $sourceEnv -Destination $targetEnv -Force
Write-Host "OK: Runtime .env installed at:" -ForegroundColor Green
Write-Host "  $targetEnv" -ForegroundColor Green
Write-Host ""
Write-Host "You can now launch the packaged application:" -ForegroundColor Cyan
Write-Host "  onprem\desktop-app-build\win-unpacked\`"Lab Management System.exe`"" -ForegroundColor Cyan
Write-Host ""
Write-Host "NOTE: This .env is for LOCAL TESTING ONLY." -ForegroundColor Yellow
Write-Host "      Do NOT distribute it to customers." -ForegroundColor Yellow
Write-Host ""
