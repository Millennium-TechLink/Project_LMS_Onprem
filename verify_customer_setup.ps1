<#
.SYNOPSIS
    Verifies Lab Management System installation and configuration.

.DESCRIPTION
    This script checks all prerequisites for running the Lab Management System:
    - PostgreSQL service status
    - Runtime .env file existence and validity
    - DATABASE_URL configuration
    - Database connectivity
    - Directory permissions

    Run this script to diagnose startup issues or verify a new installation.

.EXAMPLE
    .\onprem\verify_customer_setup.ps1
#>

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Lab Management System" -ForegroundColor Cyan
Write-Host " Installation Verification" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$allChecksPass = $true

# ── Check 1: PostgreSQL Service ──────────────────────────────────────────────
Write-Host "[1/6] Checking PostgreSQL service..." -ForegroundColor Yellow

$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq "Running" } | Select-Object -First 1

if ($pgService) {
    Write-Host "  ✓ PostgreSQL service is running: $($pgService.Name)" -ForegroundColor Green
} else {
    Write-Host "  ✗ PostgreSQL service not found or not running" -ForegroundColor Red
    Write-Host "    Install PostgreSQL and ensure the service is started." -ForegroundColor Red
    $allChecksPass = $false
}

# ── Check 2: Runtime .env File Location ──────────────────────────────────────
Write-Host ""
Write-Host "[2/6] Checking runtime .env file..." -ForegroundColor Yellow

$runtimeEnvPath = "$env:LOCALAPPDATA\Lab Management System\backend\.env"
Write-Host "  Expected location: $runtimeEnvPath" -ForegroundColor Gray

if (Test-Path $runtimeEnvPath) {
    Write-Host "  ✓ Runtime .env file exists" -ForegroundColor Green
    $envSize = (Get-Item $runtimeEnvPath).Length
    Write-Host "    Size: $envSize bytes" -ForegroundColor Gray
} else {
    Write-Host "  ✗ Runtime .env file NOT FOUND" -ForegroundColor Red
    Write-Host "    Create this file using the template at:" -ForegroundColor Red
    Write-Host "    onprem\config\.env.customer.example" -ForegroundColor Red
    $allChecksPass = $false
}

# ── Check 3: DATABASE_URL Configuration ──────────────────────────────────────
Write-Host ""
Write-Host "[3/6] Checking DATABASE_URL configuration..." -ForegroundColor Yellow

if (Test-Path $runtimeEnvPath) {
    $envContent = Get-Content $runtimeEnvPath -Raw
    $dbUrlLine = $envContent -split "`n" | Where-Object { $_ -match "^DATABASE_URL\s*=" } | Select-Object -First 1
    
    if ($dbUrlLine) {
        $dbUrl = ($dbUrlLine -split "=", 2)[1].Trim()
        
        if ($dbUrl -and $dbUrl -ne "<CUSTOMER_DATABASE_URL>" -and -not ($dbUrl -match "<.*>")) {
            Write-Host "  ✓ DATABASE_URL is configured" -ForegroundColor Green
            
            # Parse the URL to show host/port (without exposing password)
            if ($dbUrl -match "postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)") {
                $dbUser = $matches[1]
                $dbHost = $matches[3]
                $dbPort = $matches[4]
                $dbName = $matches[5]
                Write-Host "    User: $dbUser" -ForegroundColor Gray
                Write-Host "    Host: $dbHost" -ForegroundColor Gray
                Write-Host "    Port: $dbPort" -ForegroundColor Gray
                Write-Host "    Database: $dbName" -ForegroundColor Gray
            } else {
                Write-Host "    Format: $($dbUrl.Substring(0, [Math]::Min(30, $dbUrl.Length)))..." -ForegroundColor Gray
            }
        } else {
            Write-Host "  ✗ DATABASE_URL is not set or still contains placeholder" -ForegroundColor Red
            Write-Host "    Update DATABASE_URL in $runtimeEnvPath" -ForegroundColor Red
            $allChecksPass = $false
        }
    } else {
        Write-Host "  ✗ DATABASE_URL line not found in .env file" -ForegroundColor Red
        Write-Host "    Add: DATABASE_URL=postgresql://user:password@host:5432/database" -ForegroundColor Red
        $allChecksPass = $false
    }
} else {
    Write-Host "  ⊘ Skipped (no .env file)" -ForegroundColor Gray
}

# ── Check 4: Database Connectivity ────────────────────────────────────────────
Write-Host ""
Write-Host "[4/6] Testing database connectivity..." -ForegroundColor Yellow

if (Test-Path $runtimeEnvPath) {
    $envContent = Get-Content $runtimeEnvPath -Raw
    $dbUrlLine = $envContent -split "`n" | Where-Object { $_ -match "^DATABASE_URL\s*=" } | Select-Object -First 1
    
    if ($dbUrlLine) {
        $dbUrl = ($dbUrlLine -split "=", 2)[1].Trim()
        
        # Parse connection details
        if ($dbUrl -match "postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)") {
            $dbUser = $matches[1]
            $dbPass = $matches[2]
            $dbHost = $matches[3]
            $dbPort = $matches[4]
            $dbName = $matches[5]
            
            # Check if psql is available
            $psqlPath = (Get-Command psql -ErrorAction SilentlyContinue).Source
            
            if ($psqlPath) {
                Write-Host "  Testing connection with psql..." -ForegroundColor Gray
                $env:PGPASSWORD = $dbPass
                $testResult = & psql -h $dbHost -p $dbPort -U $dbUser -d $dbName -c "SELECT 1;" 2>&1
                Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
                
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "  ✓ Database connection successful" -ForegroundColor Green
                } else {
                    Write-Host "  ✗ Database connection failed" -ForegroundColor Red
                    Write-Host "    $testResult" -ForegroundColor Red
                    $allChecksPass = $false
                }
            } else {
                Write-Host "  ⊘ psql not found in PATH - skipping connectivity test" -ForegroundColor Gray
                Write-Host "    Connection will be verified when the application starts" -ForegroundColor Gray
            }
        } else {
            Write-Host "  ⊘ Could not parse DATABASE_URL" -ForegroundColor Gray
        }
    } else {
        Write-Host "  ⊘ Skipped (DATABASE_URL not configured)" -ForegroundColor Gray
    }
} else {
    Write-Host "  ⊘ Skipped (no .env file)" -ForegroundColor Gray
}

# ── Check 5: Required Directories ─────────────────────────────────────────────
Write-Host ""
Write-Host "[5/6] Checking required directories..." -ForegroundColor Yellow

$requiredDirs = @(
    "$env:LOCALAPPDATA\Lab Management System\backend",
    "$env:LOCALAPPDATA\Lab Management System\uploads",
    "$env:APPDATA\Lab Management System\license",
    "$env:APPDATA\Lab Management System\logs"
)

$allDirsExist = $true
foreach ($dir in $requiredDirs) {
    $exists = Test-Path $dir
    if ($exists) {
        Write-Host "  ✓ $dir" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $dir (missing)" -ForegroundColor Red
        $allDirsExist = $false
    }
}

if (-not $allDirsExist) {
    Write-Host "    The application will create these on first run." -ForegroundColor Gray
}

# ── Check 6: Permissions ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "[6/6] Checking write permissions..." -ForegroundColor Yellow

$testFile = "$env:LOCALAPPDATA\Lab Management System\backend\.write_test_$(Get-Random)"
try {
    New-Item -Path $testFile -ItemType File -Force | Out-Null
    Remove-Item $testFile -Force
    Write-Host "  ✓ Write permission OK for backend config directory" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Cannot write to backend config directory" -ForegroundColor Red
    Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
    $allChecksPass = $false
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Verification Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if ($allChecksPass) {
    Write-Host "✓ All checks passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Your system is ready to run Lab Management System." -ForegroundColor Green
    Write-Host "You can now launch the application." -ForegroundColor Green
} else {
    Write-Host "✗ Some checks failed" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please resolve the issues above before running the application." -ForegroundColor Red
    Write-Host "Send the output above to your vendor if you need help." -ForegroundColor Red
}

Write-Host ""
Write-Host "Log files location (if app was already run):" -ForegroundColor Cyan
Write-Host "  $env:APPDATA\Lab Management System\logs\" -ForegroundColor Gray
Write-Host ""
