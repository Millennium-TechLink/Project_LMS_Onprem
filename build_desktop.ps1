param(
    [switch]$SkipFrontend,
    # Bakes backend/.env into the installer as the real config (see Step 1d).
    # On by default - pass this to build a generic, unconfigured installer instead
    # (e.g. the placeholder template, for a customer who edits their own .env).
    [switch]$SkipEnvBake,
    # Lets the build continue when the env file being baked has development secrets (OpenAI key, bypass key).
    # They then ship inside the installer, readable by whoever installs it. Without this switch an interactive
    # run asks for confirmation and a non-interactive run stops.
    [switch]$AllowDevSecrets,
    # Bake this env file instead of backend/.env (it still has to be a real config, not the template).
    [string]$EnvFile = "",
    # Skips NSIS installer generation - packages win-unpacked only. Measured ~90s
    # faster (NSIS compression of the ~600MB payload). For local test launches;
    # not for anything handed to a customer, since there's no Setup.exe to give them.
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"

# This script lives in <app repo>/onprem; every path below is relative to the app repo root.
$appRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $appRoot "backend\app"))) {
    Write-Host "[X] $PSScriptRoot must be cloned inside the LMS app repo as 'onprem' (backend\app not found in $appRoot). See README.md." -ForegroundColor Red
    exit 1
}
Set-Location $appRoot
# .NET calls (File.ReadAllText etc.) resolve relative paths against the process directory, not the PowerShell location
[Environment]::CurrentDirectory = (Get-Location).Path

# Fixes "ΓÇó" mojibake from electron-builder's UTF-8 bullets.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ==========================================
# HELPER: Structured failure reporter
# ==========================================

function Invoke-FailBuild {
    param(
        [string]$Stage,
        [string]$Check,
        [string]$ErrorMessage,
        [string]$FilePath       = "",
        [string]$Command        = "",
        [string]$RootCause      = "",
        [string]$ActionRequired = ""
    )
    Write-Host "" -ForegroundColor Red
    Write-Host "======================================================" -ForegroundColor Red
    Write-Host "  BUILD GATE FAILURE" -ForegroundColor Red
    Write-Host "======================================================" -ForegroundColor Red
    Write-Host "  STAGE:          $Stage"           -ForegroundColor Red
    Write-Host "  CHECK:          $Check"           -ForegroundColor Red
    Write-Host "  ERROR:          $ErrorMessage"    -ForegroundColor Red
    if ($FilePath)       { Write-Host "  FILE/PATH:      $FilePath"       -ForegroundColor Red }
    if ($Command)        { Write-Host "  COMMAND:        $Command"        -ForegroundColor Red }
    if ($RootCause)      { Write-Host "  ROOT CAUSE:     $RootCause"      -ForegroundColor Red }
    if ($ActionRequired) { Write-Host "  ACTION:         $ActionRequired" -ForegroundColor Yellow }
    Write-Host "======================================================" -ForegroundColor Red
    Write-Host "" -ForegroundColor Red
    exit 1
}

# ==========================================
# HELPER: Clean up test artifacts
# ==========================================

function Remove-TestArtifacts {
    param(
        [string]$TestVenvDir = "",
        [int]   $BackendPid  = 0
    )

    # Terminate test backend if still running
    if ($BackendPid -gt 0) {
        try {
            $proc = Get-Process -Id $BackendPid -ErrorAction SilentlyContinue
            if ($proc) {
                taskkill /PID $BackendPid /T /F 2>&1 | Out-Null
                try { $proc | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue } catch { }
                Write-Host "  [cleanup] Terminated test backend process tree (PID $BackendPid)." -ForegroundColor Cyan
            }
        } catch { }

        # Wait up to 10 s for port 8001 to be released
        $released = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            $conn = netstat -ano 2>$null | Select-String ":8001 "
            if (-not $conn) { $released = $true; break }
        }
        if (-not $released) {
            Write-Host "  [cleanup] WARNING: port 8001 may still be occupied." -ForegroundColor Yellow
        }
    }

    # Remove test venv
    if ($TestVenvDir -and (Test-Path $TestVenvDir)) {
        Remove-Item -Recurse -Force $TestVenvDir -ErrorAction SilentlyContinue
        Write-Host "  [cleanup] Removed test venv: $TestVenvDir" -ForegroundColor Cyan
    }
}

# ==========================================
# FUNCTIONS
# ==========================================

function Test-Prerequisites {
    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Magenta
    Write-Host "  Step 0: NEW USER SETUP - Installing Prerequisites" -ForegroundColor Magenta
    Write-Host "===================================================" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "  This step downloads and installs the tools needed to" -ForegroundColor White
    Write-Host "  build the Electron desktop app. It runs automatically." -ForegroundColor White
    Write-Host ""
    Write-Host "  Packages that will be installed (if not already present):" -ForegroundColor White
    Write-Host "    - electron          - Desktop app runtime (wraps the web UI)" -ForegroundColor Cyan
    Write-Host "    - electron-builder  - Packages the app into a .exe installer" -ForegroundColor Cyan
    Write-Host ""

    # 0a. Verify Node.js is installed
    Write-Host "  [0a] Checking Node.js..." -ForegroundColor Yellow
    if (-Not (Get-Command "node" -ErrorAction SilentlyContinue)) {
        Invoke-FailBuild `
            -Stage "Prerequisites" `
            -Check "Node.js installed" `
            -ErrorMessage "Node.js is NOT installed or not in PATH." `
            -RootCause "Node.js is required to run npm and electron-builder." `
            -ActionRequired "Download and install Node.js LTS from https://nodejs.org, then close PowerShell, reopen it, and re-run this script."
    }
    $nodeVersion = node --version
    Write-Host "  OK: Node.js $nodeVersion is installed." -ForegroundColor Green

    # 0b. Verify npm is available
    Write-Host "  [0b] Checking npm..." -ForegroundColor Yellow
    if (-Not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
        Invoke-FailBuild `
            -Stage "Prerequisites" `
            -Check "npm installed" `
            -ErrorMessage "npm is not available." `
            -RootCause "npm ships with Node.js; its absence suggests a broken installation." `
            -ActionRequired "Reinstall Node.js LTS from https://nodejs.org."
    }
    $npmVersion = npm --version
    Write-Host "  OK: npm $npmVersion is installed." -ForegroundColor Green

    # 0c. Install root dependencies (electron, electron-builder).
    # npm install --no-save never edits package.json or package-lock.json, so a build leaves the repo clean.
    Write-Host ""
    Write-Host "  [0c] Checking root dependencies ..." -ForegroundColor Yellow
    # npm install takes ~40 s even when nothing changed: skip it when node_modules is current.
    $hiddenLock = "onprem\node_modules\.package-lock.json"
    $depsCurrent = (Test-Path "onprem\node_modules\electron\package.json") -and
                   (Test-Path "onprem\node_modules\electron-builder\package.json") -and
                   (Test-Path $hiddenLock) -and
                   ((Get-Item $hiddenLock).LastWriteTime -gt (Get-Item "onprem\package.json").LastWriteTime)
    if ($depsCurrent) {
        Write-Host "  OK: node_modules is current (skipping npm install)." -ForegroundColor Green
    } else {
    Write-Host "  Running: npm install --no-save" -ForegroundColor White
    Push-Location onprem
    npm install --no-save
    $npmInstallCode = $LASTEXITCODE
    Pop-Location
    if ($npmInstallCode -ne 0) {
        Invoke-FailBuild `
            -Stage "Prerequisites" `
            -Check "npm install --no-save" `
            -ErrorMessage "npm install --no-save failed (exit $npmInstallCode)." `
            -Command "npm install --no-save" `
            -ActionRequired "Check your internet connection. If package.json and package-lock.json are out of sync, run npm install once and commit both."
    }
    Write-Host "  OK: All root npm dependencies are installed." -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Magenta
    Write-Host "  Step 0 COMPLETE -- All prerequisites are ready!" -ForegroundColor Magenta
    Write-Host "===================================================" -ForegroundColor Magenta
    Write-Host ""
}

function Test-Security {
    # 1. Check for .env file
    Write-Host "Step 1: Checking for backend/.env file..." -ForegroundColor Yellow
    if (-Not (Test-Path "backend\.env")) {
        Invoke-FailBuild `
            -Stage "Security" `
            -Check "backend/.env exists" `
            -ErrorMessage "backend\.env file is missing." `
            -FilePath "backend\.env" `
            -ActionRequired "Create backend\.env with customer database configuration before building."
    }
    Write-Host "OK: backend\.env found." -ForegroundColor Green

    # -- Security check: refuse to build if development secrets are in .env ------
    Write-Host "Step 1b: Checking the env file to bake for development secrets..." -ForegroundColor Yellow
    $scanFile = if ($EnvFile) { $EnvFile } else { "backend\.env" }
    if ($SkipEnvBake) {
        Write-Host "OK: No env is baked into this installer, so there is nothing to check." -ForegroundColor Green
    } elseif (-Not (Test-Path $scanFile)) {
        Write-Host "SKIP: $scanFile not found (reported by the next steps)." -ForegroundColor Yellow
    } else {
        $envContent = Get-Content $scanFile -Raw

        # Pattern -> what it is. Only the description is printed, never the secret itself.
        $devPatterns = [ordered]@{
            'sk-proj-'              = 'an OpenAI API key (a personal development key)'
            'pranav-quick-access'   = 'the hard-coded quick-login bypass key'
            'QUICK_AUTH_BYPASS_KEY' = 'the quick-login bypass key setting'
        }
        $found = @($devPatterns.Keys | Where-Object { $envContent -match [regex]::Escape($_) })

        if ($found.Count -eq 0) {
            Write-Host "OK: No development secrets detected in $scanFile." -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "WARNING: $scanFile has development secrets that would be baked into the installer:" -ForegroundColor Yellow
            foreach ($f in $found) { Write-Host "  - $($devPatterns[$f])" -ForegroundColor Yellow }
            Write-Host "  Anyone who installs the app could read them. The chatbot works without the OpenAI key" -ForegroundColor Yellow
            Write-Host "  (it only adds rephrased answers), and a customer can add their own key after installing." -ForegroundColor Yellow
            Write-Host "  Ways forward:" -ForegroundColor Yellow
            Write-Host "    1. Bake a clean file:    .\onprem\run_onprem.ps1 -Mode App -EnvFile C:\configs\customer.env" -ForegroundColor Yellow
            Write-Host "    2. Bake nothing:         .\onprem\run_onprem.ps1 -Mode App   (the customer fills in their own .env)" -ForegroundColor Yellow
            Write-Host "    3. Ship them knowingly:  add -AllowDevSecrets" -ForegroundColor Yellow

            $allow = [bool]$AllowDevSecrets
            if (-not $allow -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
                Write-Host ""
                try {
                    $answer = Read-Host "  Type YES to include them in the installer anyway, anything else stops the build"
                    $allow = ($answer -ceq 'YES')
                } catch { $allow = $false }  # no console to ask on
            }
            if ($allow) {
                Write-Host "CONTINUING: development secrets will be shipped inside this installer." -ForegroundColor Red
            } else {
                Invoke-FailBuild `
                    -Stage "Security" `
                    -Check "Development secrets absent from the env file to bake" `
                    -ErrorMessage "$scanFile contains development secrets: $(($found | ForEach-Object { $devPatterns[$_] }) -join '; ')." `
                    -FilePath $scanFile `
                    -RootCause "This file is about to be baked into the installer, so the secrets would reach every customer." `
                    -ActionRequired "Use a clean customer .env (-EnvFile), bake nothing (omit -BakeEnv), or add -AllowDevSecrets to ship them on purpose."
            }
        }
    }

    # -- Security check: refuse to build if private keys exist in repository -
    # git ls-files (gitignore-respecting) instead of a raw recursive filesystem
    # walk - the old approach crawled node_modules/.venv/build-cache in full
    # before filtering, taking minutes on this repo.
    Write-Host "Step 1c: Checking for private keys in repository..." -ForegroundColor Yellow
    $keyFiles = (git ls-files --cached --others --exclude-standard -- "*.pem" "*.key" "*.p12" "*.pfx" 2>$null) |
        Where-Object { (Split-Path $_ -Leaf) -notin @("cacert.pem", "roots.pem") }

    if ($keyFiles) {
        $fileList = $keyFiles -join "`n"
        Invoke-FailBuild `
            -Stage "Security" `
            -Check "No private keys in repository" `
            -ErrorMessage "Private key file(s) found in repository." `
            -FilePath $fileList `
            -RootCause "Private keys committed to source code pose a security risk." `
            -ActionRequired "Remove private key files from the repository before building."
    }
    Write-Host "OK: No private keys detected." -ForegroundColor Green

    # On by default: this .env ships as-is, ready to run, so an unfilled
    # template value here would silently break the install. Pass -SkipEnvBake
    # to build a generic, unconfigured installer instead (skips this whole check).
    if (-not $SkipEnvBake) {
        $bakeSource = if ($EnvFile) { $EnvFile } else { "backend\.env" }
        if (-not (Test-Path $bakeSource)) {
            Invoke-FailBuild `
                -Stage "Security" `
                -Check "Env file to bake exists" `
                -ErrorMessage "$bakeSource was not found." `
                -FilePath $bakeSource `
                -ActionRequired "Pass an existing file to -EnvFile, or build without baking."
        }
        $envContent = Get-Content $bakeSource -Raw
        Write-Host "Step 1d: Validating $bakeSource is a real config (it will be baked into the installer)..." -ForegroundColor Yellow

        # Per-field, not whole-file - CORS_ORIGINS legitimately lists localhost.
        function Get-EnvValue($name) {
            $line = ($envContent -split "`r?`n") | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
            if ($line) { ($line -split '=', 2)[1].Trim() } else { "" }
        }
        $dbValue      = Get-EnvValue "DATABASE_URL"
        $secretValue  = Get-EnvValue "SECRET_KEY"
        $jwtValue     = Get-EnvValue "JWT_SECRET_KEY"

        # Only the literal unedited template value is rejected - localhost is a
        # legitimate real target (e.g. DB on the same on-prem machine as the app).
        if ($dbValue -match 'user:password@host') {
            Invoke-FailBuild `
                -Stage "Security" `
                -Check "backend/.env is a real config" `
                -ErrorMessage "DATABASE_URL is still the unfilled template placeholder." `
                -FilePath "backend\.env" `
                -RootCause "This .env is about to be baked into the installer as-is." `
                -ActionRequired "Set DATABASE_URL in backend\.env, or pass -SkipEnvBake to ship a generic installer instead."
        }
        foreach ($secretName in @('SECRET_KEY', 'JWT_SECRET_KEY')) {
            $value = if ($secretName -eq 'SECRET_KEY') { $secretValue } else { $jwtValue }
            if ($value -match 'changeme-generate-a-.*-value') {
                Invoke-FailBuild `
                    -Stage "Security" `
                    -Check "backend/.env is a real config" `
                    -ErrorMessage "$secretName is still the unfilled template placeholder." `
                    -FilePath "backend\.env" `
                    -RootCause "This .env is about to be baked into the installer as-is." `
                    -ActionRequired "Generate a fresh, unique $secretName, or pass -SkipEnvBake to ship a generic installer instead."
            }
        }
        if (-not $dbValue) {
            Invoke-FailBuild `
                -Stage "Security" `
                -Check "backend/.env is a real config" `
                -ErrorMessage "DATABASE_URL is missing or empty in backend\.env." `
                -FilePath "backend\.env" `
                -ActionRequired "Set DATABASE_URL, or pass -SkipEnvBake to ship a generic installer instead."
        }
        Write-Host "OK: backend\.env looks like a real config." -ForegroundColor Green

        # Staged copy for afterPack.js to pick up.
        Copy-Item $bakeSource "backend\.env.bake" -Force
        Write-Host "OK: Staged $bakeSource as backend\.env.bake for this build to bake in." -ForegroundColor Green
    }

    # -- Security check: refuse to ship an installer with the known test vendor key --
    # LicenseConstants.js ships with a placeholder ECDSA keypair for dev/testing, not
    # a real vendor identity - no offline-held private key exists for it, so no
    # PERMANENT license can be legitimately issued against it either.
    # Only enforced for installer builds - -SkipInstaller output never reaches a customer.
    if (-not $SkipInstaller) {
        Write-Host "Step 1e: Checking vendor license key has been rotated..." -ForegroundColor Yellow
        $constantsPath = "onprem\electron\license\LicenseConstants.js"
        $constantsContent = Get-Content $constantsPath -Raw
        $knownTestKeyFragment = 'ES8JUz1xYvjwwBxWQhP/TEQvdyXG2'
        if ($constantsContent.Contains($knownTestKeyFragment)) {
            Invoke-FailBuild `
                -Stage "Security" `
                -Check "Vendor license key rotated" `
                -ErrorMessage "LicenseConstants.js still has the known TEST vendor public key." `
                -FilePath $constantsPath `
                -RootCause "This is a placeholder keypair, not a real vendor identity - there is no offline private key for it to sign real customer licenses with." `
                -ActionRequired "Run 'node onprem/electron/tools/KeyGenerator.js', put the new public key in VENDOR_PUBLIC_KEY_PEM, and store the private key offline before building an installer. Pass -SkipInstaller for local test builds."
        }
        Write-Host "OK: Vendor license key is not the known test key." -ForegroundColor Green
    }
}

function Invoke-FrontendBuild {
    Write-Host "Step 2: Building Frontend..." -ForegroundColor Yellow

    # Ensure frontend node_modules exists
    if (-Not (Test-Path "frontend\node_modules")) {
        Write-Host "  Installing frontend dependencies..." -ForegroundColor Cyan
        $OriginalLocation = Get-Location
        Set-Location "frontend"
        npm install --no-save
        if ($LASTEXITCODE -ne 0) {
            Set-Location $OriginalLocation
            Invoke-FailBuild `
                -Stage "Frontend" `
                -Check "npm install (frontend)" `
                -ErrorMessage "Frontend npm install failed (exit $LASTEXITCODE)." `
                -Command "cd frontend; npm install" `
                -ActionRequired "Check frontend/package.json for errors."
        }
        Set-Location $OriginalLocation
    }

    # Desktop app is always the offline build (drops signup and dev-credential pages)
    $env:VITE_DEPLOYMENT_MODE = "onprem"
    # The pre-build test backend must run in on-prem mode too, or it does not serve the frontend (check 7)
    $env:DEPLOYMENT_MODE = "onprem"
    npm --prefix frontend run build
    if ($LASTEXITCODE -ne 0) {
        Invoke-FailBuild `
            -Stage "Frontend" `
            -Check "Vite build" `
            -ErrorMessage "Frontend build failed (exit $LASTEXITCODE)." `
            -Command "npm --prefix frontend run build" `
            -ActionRequired "Fix frontend TypeScript / Vite errors before packaging."
    }
    Write-Host "OK: Frontend build succeeded." -ForegroundColor Green
}

function Test-BackendSource {
    Write-Host "Step 3: Verifying Backend Source Code..." -ForegroundColor Yellow

    if (-Not (Test-Path "backend\app")) {
        Invoke-FailBuild `
            -Stage "Backend source" `
            -Check "backend/app directory exists" `
            -ErrorMessage "backend\app directory is missing." `
            -FilePath "backend\app" `
            -ActionRequired "Ensure the backend application code exists at backend\app."
    }
    Write-Host "OK: backend\app directory found." -ForegroundColor Green

    if (-Not (Test-Path "backend\requirements.txt")) {
        Invoke-FailBuild `
            -Stage "Backend source" `
            -Check "backend/requirements.txt exists" `
            -ErrorMessage "backend\requirements.txt is missing." `
            -FilePath "backend\requirements.txt" `
            -ActionRequired "Create backend\requirements.txt listing Python dependencies."
    }
    Write-Host "OK: backend\requirements.txt found." -ForegroundColor Green
}

function Get-PortablePython {
    Write-Host "Step 4: Managing Portable Python 3.11 Runtime..." -ForegroundColor Yellow

    $CacheDir = "onprem\build-cache"
    $PythonZip = "$CacheDir\python-3.11.9-embed-amd64.zip"
    # package.json's extraResources ships from here ("backend/python" -> "backend/python") -
    # NOT the onprem\desktop-app-build output, which electron-builder wipes and recreates from
    # scratch on every packaging run (re-extracting the Electron zip), destroying anything
    # placed there earlier in the script. This also means it persists as a real build
    # cache across runs (gitignored), unlike the old output-path location.
    $PythonDir = "backend\python"
    $ExpectedSha256 = "009D6BF7E3B2DDCA3D784FA09F90FE54336D5B60F0E0F305C37F400BF83CFD3B"

    if (-Not (Test-Path $CacheDir)) {
        New-Item -ItemType Directory -Path $CacheDir | Out-Null
    }

    if (Test-Path $PythonZip) {
        Write-Host "  Found cached Python zip. Verifying SHA-256..." -ForegroundColor Yellow
        $ActualSha256 = (Get-FileHash $PythonZip -Algorithm SHA256).Hash
        if ($ActualSha256 -ne $ExpectedSha256) {
            Remove-Item $PythonZip -Force -ErrorAction SilentlyContinue
            Invoke-FailBuild `
                -Stage "Python runtime" `
                -Check "SHA-256 checksum" `
                -ErrorMessage "Checksum mismatch for downloaded Python runtime." `
                -FilePath $PythonZip `
                -RootCause "Cached zip file is corrupted or tampered with." `
                -ActionRequired "Re-run the build script to redownload portable Python."
        }
        Write-Host "  OK: Checksum verified." -ForegroundColor Green
    } else {
        Write-Host "  Downloading Portable Python 3.11.9..." -ForegroundColor Yellow
        $Url = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
        Invoke-WebRequest -Uri $Url -OutFile $PythonZip
        Write-Host "  OK: Downloaded to $PythonZip." -ForegroundColor Green
    }

    if (-Not (Test-Path $PythonDir)) {
        New-Item -ItemType Directory -Path $PythonDir -Force | Out-Null
        Expand-Archive -Path $PythonZip -DestinationPath $PythonDir -Force
    }

    if (-Not (Test-Path "$PythonDir\python.exe")) {
        Invoke-FailBuild `
            -Stage "Python runtime" `
            -Check "python.exe present after extraction" `
            -ErrorMessage "python.exe not found after extraction." `
            -FilePath "$PythonDir\python.exe" `
            -ActionRequired "Check extraction destination path."
    }

    # Enable site-packages by modifying python311._pth
    $PthFile = Get-ChildItem -Path $PythonDir -Filter "python*._pth" | Select-Object -First 1
    if ($PthFile) {
        $Content = Get-Content $PthFile.FullName
        $newContent = @()
        $hasSitePackages = $false
        foreach ($line in $Content) {
            if ($line -match "^#import site") { $newContent += "import site" }
            else { $newContent += $line }
            if ($line -match "Lib\\site-packages") { $hasSitePackages = $true }
        }
        if (-not $hasSitePackages) {
            $newContent += "Lib\site-packages"
        }
        Set-Content -Path $PthFile.FullName -Value $newContent
    }

    # Verify python runs
    & "$PythonDir\python.exe" --version
    if ($LASTEXITCODE -ne 0) {
        Invoke-FailBuild `
            -Stage "Python runtime" `
            -Check "python runs" `
            -ErrorMessage "Bundled Python failed to execute." `
            -ActionRequired "Check extraction destination path."
    }

    Write-Host "OK: Portable Python ready at $PythonDir." -ForegroundColor Green
}

function Test-Backend {
    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host "  BUILD GATE: Backend Production Runtime Validation" -ForegroundColor Cyan
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host "  Validating Python dependencies, app imports, and HTTP health..." -ForegroundColor White
    Write-Host ""

    # Must match Get-PortablePython's $PythonDir - see the comment there for why
    # this is backend\python (repo root, the extraResources source) and not the
    # onprem\desktop-app-build output.
    $PythonDir = "backend\python"
    $PythonExe = "$PythonDir\python.exe"

    if (-Not (Test-Path $PythonExe)) {
        Invoke-FailBuild `
            -Stage "Backend validation" `
            -Check "Bundled Python executable exists" `
            -ErrorMessage "Python executable not found at '$PythonExe'." `
            -FilePath $PythonExe `
            -RootCause "Step 4 (Acquire-PortablePython) did not produce python.exe." `
            -ActionRequired "Re-run Step 4 to download and extract Portable Python."
    }

    # ----------------------------------------------------------
    # CHECK 1 - Verify Python 3.11.x version
    # ----------------------------------------------------------
    Write-Host "  [CHECK 1/9] Verifying Python version..." -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $VersionStr = & $PythonExe --version 2>&1
    $ErrorActionPreference = $prevEAP
    if ($VersionStr -notmatch "Python 3\.11\.") {
        Invoke-FailBuild `
            -Stage "Backend validation" `
            -Check "Bundled Python version is 3.11.x" `
            -ErrorMessage "Bundled Python reports: '$VersionStr' (expected 3.11.x)." `
            -RootCause "The python folder contains an incompatible Python release." `
            -ActionRequired "Delete onprem\build-cache\python-3.11.9-embed-amd64.zip and re-run the build."
    }
    Write-Host "  OK: Bundled Python is 3.11.x ($VersionStr)." -ForegroundColor Green

    # ----------------------------------------------------------
    # CHECK 2 - Virtual environment & requirements installation
    # ----------------------------------------------------------
    Write-Host "  [CHECK 2/9] Validating requirements.txt against portable Python..." -ForegroundColor Yellow

    $TestVenvDir = ""
    $TestVenvPy  = $PythonExe

    # Reuse embedded Python if pip works AND requirements.txt hasn't changed since
    # it was installed, skipping the full reinstall.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    $ReqHashFile = "onprem\build-cache\.requirements_hash"
    $CurrentReqHash = (Get-FileHash "backend\requirements.txt" -Algorithm SHA256).Hash

    $VenvCacheHit = $false
    if (Test-Path $ReqHashFile) {
        & $TestVenvPy -c "import pip" 2>&1 | Out-Null
        $cachedReqHash = (Get-Content $ReqHashFile -Raw -ErrorAction SilentlyContinue)
        if ($LASTEXITCODE -eq 0 -and $cachedReqHash -and $cachedReqHash.Trim() -eq $CurrentReqHash) {
            $VenvCacheHit = $true
        }
    }

    if (-not $VenvCacheHit) {
        # Install get-pip if pip is absent from embedded python
        & $TestVenvPy -c "import pip" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [CHECK 2/9] Installing pip into embedded Python..." -ForegroundColor Yellow
            $getPipPath = "onprem\build-cache\get-pip.py"
            if (-not (Test-Path $getPipPath)) {
                Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPipPath
            }
            & $TestVenvPy $getPipPath --no-warn-script-location 2>&1 | Out-Null
        }

        Write-Host "  [CHECK 2/9] Installing requirements.txt into embedded Python (this takes 1-2 min on first run)..." -ForegroundColor Yellow

        $ShortTarget = "onprem\build-cache\site-packages"
        if (Test-Path $ShortTarget) { Remove-Item $ShortTarget -Recurse -Force -ErrorAction SilentlyContinue }

        $pipStartOpt = New-Object System.Diagnostics.ProcessStartInfo
        $pipStartOpt.FileName               = (Resolve-Path $TestVenvPy).Path
        $pipStartOpt.Arguments              = "-m pip install -r backend\requirements.txt --no-cache-dir --no-warn-script-location --target `"$ShortTarget`""
        $pipStartOpt.WorkingDirectory       = (Get-Location).Path
        $pipStartOpt.RedirectStandardOutput = $true
        $pipStartOpt.RedirectStandardError  = $true
        $pipStartOpt.UseShellExecute        = $false
        $pipStartOpt.CreateNoWindow         = $true

        $pipProc = [System.Diagnostics.Process]::Start($pipStartOpt)
        $pipOutAsync = $pipProc.StandardOutput.ReadToEndAsync()
        $pipErrAsync = $pipProc.StandardError.ReadToEndAsync()
        $pipProc.WaitForExit()
        $pipOut = $pipOutAsync.Result
        $pipErr = $pipErrAsync.Result

        if ($pipProc.ExitCode -ne 0) {
            $failDetail = "Pip Exit Code: $($pipProc.ExitCode)`n`n--- STDOUT ---`n$pipOut`n--- STDERR ---`n$pipErr"

            Invoke-FailBuild `
                -Stage "Backend validation" `
                -Check "pip install -r requirements.txt" `
                -ErrorMessage "One or more packages from requirements.txt failed to install." `
                -RootCause "Package compilation failure or incompatible binary wheels for Python 3.11 Windows x64.`n`n$failDetail" `
                -ActionRequired "Fix package version pins in backend\requirements.txt or check network connectivity."
        }

        # The app only ever calls "python.exe -m uvicorn ..." or imports modules
        # directly - it never runs any of pip's generated console-script .exe
        # stubs (uvicorn.exe, mypy.exe, pytest.exe, alembic.exe, ...). With
        # --target, pip writes all of them into bin\ - deleting the whole
        # folder is safe and also means electron-builder has ~40 fewer files
        # to individually sign (each signtool call round-trips to a timestamp
        # server - this alone was a large chunk of packaging time).
        $UnusedBin = Join-Path $ShortTarget "bin"
        if (Test-Path $UnusedBin) { Remove-Item $UnusedBin -Recurse -Force -ErrorAction SilentlyContinue }

        # Dev/lint/test tooling and an unused AWS SDK - zero live imports in
        # backend/app/, but pip installs them since they're in requirements.txt.
        $UnusedPackages = @('boto3', 'botocore', 's3transfer', 'mypy', 'mypy_extensions', 'mypyc', 'pytest', '_pytest', 'pyflakes', 'pluggy', 'pycodestyle')
        foreach ($pkg in $UnusedPackages) {
            Get-ChildItem -Path $ShortTarget -Filter "$pkg*" -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq $pkg -or $_.Name -like "$pkg-*.dist-info" } |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }

        # Same reasoning for the pip/wheel CLI stubs get-pip.py wrote straight
        # into $PythonDir\Scripts - never invoked (the cache-hit check above
        # only needs "import pip" to work, not pip.exe itself).
        foreach ($stub in @('pip.exe', 'pip3.exe', 'pip3.11.exe', 'wheel.exe')) {
            $stubPath = Join-Path "$PythonDir\Scripts" $stub
            if (Test-Path $stubPath) { Remove-Item $stubPath -Force -ErrorAction SilentlyContinue }
        }

        Write-Host "  [CHECK 2/9] Moving installed packages to embedded Python..." -ForegroundColor Yellow
        $FinalSitePackages = "$PythonDir\Lib\site-packages"
        if (-not (Test-Path $FinalSitePackages)) {
            New-Item -ItemType Directory -Path $FinalSitePackages -Force | Out-Null
        }
        
        # /MT:16 - single-threaded robocopy on ~tens of thousands of small
        # package files (pandas, Pillow, reportlab, ...) took 20+ minutes in
        # testing; parallelized it's the same job in well under a minute.
        # Retry a couple of times - /MOVE deleting thousands of files while an
        # AV scanner or sync client (OneDrive, etc.) briefly locks one is a
        # real, transient failure mode, not a real corruption.
        $roboArgs = @($ShortTarget, $FinalSitePackages, "/E", "/MOVE", "/MT:16", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
        $roboAttempt = 0
        do {
            $roboAttempt++
            & robocopy @roboArgs
            $roboExit = $LASTEXITCODE
            if ($roboExit -ge 8 -and $roboAttempt -lt 3) {
                Write-Host "  [CHECK 2/9] robocopy move failed (exit $roboExit), retrying ($roboAttempt/3)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 3
            }
        } while ($roboExit -ge 8 -and $roboAttempt -lt 3)
        if ($roboExit -ge 8) {
            Invoke-FailBuild `
                -Stage "Backend validation" `
                -Check "move site-packages" `
                -ErrorMessage "robocopy failed to move packages after $roboAttempt attempts (exit code $roboExit)." `
                -RootCause "A file-sync client (OneDrive/Dropbox) or antivirus actively watching the repo folder can lock files mid-move." `
                -ActionRequired "Move the repo out of any synced folder, or exclude onprem\build-cache\ and onprem\desktop-app-build\ from sync/AV scanning."
        }

        Set-Content -Path $ReqHashFile -Value $CurrentReqHash -NoNewline
        Write-Host "  OK: requirements.txt installed cleanly into embedded Python." -ForegroundColor Green
    } else {
        Write-Host "  OK: Cached embedded Python reused (skipping pip install)." -ForegroundColor Green
    }
    $ErrorActionPreference = $prevEAP

    # ----------------------------------------------------------
    # CHECK 3 - Critical package imports
    # ----------------------------------------------------------
    Write-Host "  [CHECK 3/9] Testing imports of core packages..." -ForegroundColor Yellow
    $CriticalPackages = @(
        "fastapi",
        "uvicorn",
        "sqlalchemy",
        "pydantic",
        "jwt",       # PyJWT - jose was replaced
        "bcrypt",    # passlib was replaced (bcrypt/Python version conflicts)
        "multipart"
    )

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    foreach ($pkg in $CriticalPackages) {
        & $TestVenvPy -c "import $pkg" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $ErrorActionPreference = $prevEAP
            Remove-TestArtifacts -TestVenvDir $TestVenvDir
            Invoke-FailBuild `
                -Stage "Backend validation" `
                -Check "Import: $pkg" `
                -ErrorMessage "Failed to import '$pkg' from the test venv." `
                -RootCause "Package '$pkg' is missing from requirements.txt or corrupted." `
                -ActionRequired "Add '$pkg' to backend\requirements.txt."
        }
        Write-Host "    - $pkg : OK" -ForegroundColor Green
    }
    $ErrorActionPreference = $prevEAP

    # ----------------------------------------------------------
    # CHECK 4 - Application entry point import (app.main)
    # ----------------------------------------------------------
    Write-Host "  [CHECK 4/9] Testing import of backend application entry point (app.main)..." -ForegroundColor Yellow

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $importOutput = & $TestVenvPy -c "import sys; sys.path.insert(0, 'backend'); import app.main" 2>&1
    $ErrorActionPreference = $prevEAP

    if ($LASTEXITCODE -ne 0) {
        $importDetail = ($importOutput | Select-Object -Last 30) -join "`n"
        Remove-TestArtifacts -TestVenvDir $TestVenvDir
        Invoke-FailBuild `
            -Stage "Backend validation" `
            -Check "Import: app.main" `
            -ErrorMessage "backend/app/main.py failed to import." `
            -RootCause "Syntax error, missing module, or bad import path in backend source code:`n`n$importDetail" `
            -ActionRequired "Fix python errors in backend\app\main.py or imported modules."
    }
    Write-Host "  OK: app.main imported without errors." -ForegroundColor Green

    # ----------------------------------------------------------
    # CHECK 5 - Pre-run database / app initialization dry run
    # ----------------------------------------------------------
    Write-Host "  [CHECK 5/9] Validating FastAPI application object..." -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $TestVenvPy -c "import sys; sys.path.insert(0, 'backend'); from app.main import app; assert app is not None" 2>$null | Out-Null
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) {
        Remove-TestArtifacts -TestVenvDir $TestVenvDir
        Invoke-FailBuild `
            -Stage "Backend validation" `
            -Check "FastAPI app instance exists" `
            -ErrorMessage "Variable 'app' is not exported or is None in backend/app/main.py." `
            -RootCause "app/main.py does not define 'app = FastAPI(...)'." `
            -ActionRequired "Ensure backend\app\main.py defines the top-level 'app' instance."
    }
    Write-Host "  OK: FastAPI app object valid." -ForegroundColor Green

    # ----------------------------------------------------------
    # CHECK 6 - Live HTTP server test (Uvicorn on port 8001)
    # ----------------------------------------------------------
    Write-Host "  [CHECK 6/9] Starting test Uvicorn backend on port 8001..." -ForegroundColor Yellow

    # Confirm port 8001 is free before starting. A stale test backend from an
    # earlier interrupted build run is the usual cause - reclaim it instead of
    # failing outright, same as onprem/electron/main.js's own killPortIfBusy() does
    # for the real app at runtime.
    # LISTENING only - TIME_WAIT/ESTABLISHED entries are closed-connection
    # leftovers with no live owner actually holding the port; matching those
    # too caused taskkill attempts against PIDs that had already exited on
    # their own, which crashed the script (see the EAP guard below).
    $portBusy = netstat -ano 2>&1 | Select-String ":8001 " | Where-Object { $_ -match "LISTENING" }
    if ($portBusy) {
        Write-Host "  [CHECK 6/9] Port 8001 is occupied - attempting to reclaim it..." -ForegroundColor Yellow
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        foreach ($line in $portBusy) {
            $stalePid = ($line -split '\s+')[-1]
            if ($stalePid -match '^\d+$') {
                taskkill /PID $stalePid /T /F 2>&1 | Out-Null
            }
        }
        $ErrorActionPreference = $prevEAP
        $reclaimed = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            if (-not (netstat -ano 2>&1 | Select-String ":8001 " | Where-Object { $_ -match "LISTENING" })) { $reclaimed = $true; break }
        }
        if (-not $reclaimed) {
            Remove-TestArtifacts -TestVenvDir $TestVenvDir
            Invoke-FailBuild `
                -Stage "Backend validation" `
                -Check "Port 8001 free before Uvicorn start" `
                -ErrorMessage "Port 8001 is still occupied after attempting to reclaim it." `
                -RootCause "Another process is holding port 8001 and could not be terminated." `
                -ActionRequired "Close whatever application is using port 8001 and re-run the build."
        }
        Write-Host "  OK: Port 8001 reclaimed." -ForegroundColor Green
    }

    $outLog = "$env:TEMP\uvicorn_test_out.log"
    $errLog = "$env:TEMP\uvicorn_test_err.log"
    Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

    # Start Uvicorn process using Start-Process with native file redirection to prevent a 
    # buffering deadlock. If RedirectStandardOutput/Error is set to true on ProcessStartInfo 
    # without active stream reading, the process blocks once the stdout/stderr buffer is full.
    $uvProc = Start-Process -FilePath $TestVenvPy -ArgumentList "-m uvicorn app.main:app --host 127.0.0.1 --port 8001" -WorkingDirectory (Resolve-Path "backend").Path -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    $TestBackendPid = $uvProc.Id
    Write-Host "  Uvicorn started (PID $TestBackendPid). Logs: $outLog and $errLog. Waiting up to 150 s for startup..." -ForegroundColor Yellow
 
    # Poll /health until HTTP 200 or 150s timeout
    $healthy = $false
    $startTime = Get-Date
    while (((Get-Date) - $startTime).TotalSeconds -lt 150) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8001/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($resp -and $resp.StatusCode -eq 200) {
                $healthy = $true
                break
            }
        } catch { }
 
        # Refresh the process object state; otherwise, HasExited checks a cached value
        # and the script will continue looping even if Uvicorn crashed.
        $uvProc.Refresh()
        if ($uvProc.HasExited) { break }
    }

    if (-not $healthy) {
        # Capture stderr for failure report
        $errText = if (Test-Path $errLog) { Get-Content $errLog -Raw } else { "No stderr output captured." }
        $outText = if (Test-Path $outLog) { Get-Content $outLog -Raw } else { "No stdout output captured." }
        $failDetail = "Timeout after 150 seconds.`n`n--- STDOUT ---`n$outText`n--- STDERR ---`n$errText"

        Remove-TestArtifacts -TestVenvDir $TestVenvDir -BackendPid $TestBackendPid
        Invoke-FailBuild `
            -Stage "Backend validation" `
            -Check "Health endpoint HTTP 200" `
            -ErrorMessage "http://127.0.0.1:8001/health did not return HTTP 200 within 150 seconds." `
            -RootCause "Backend server failed to start or crashed on startup:`n`n$failDetail" `
            -ActionRequired "Check backend/app/main.py and backend dependencies."
    }
    Write-Host "  OK: /health endpoint returned HTTP 200 OK." -ForegroundColor Green
    # Warn-only startup-time watch.
    $startupSeconds = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
    Write-Host "  Backend became healthy in $startupSeconds s." -ForegroundColor Green
    if ($startupSeconds -gt 25) {
        Write-Host "  WARNING: backend startup took over 25 s. Run 'python scripts/startup_profile.py' to see which imports got slower." -ForegroundColor Yellow
    }

    # ----------------------------------------------------------
    # CHECK 7 - Frontend Serving Verification
    # ----------------------------------------------------------
    Write-Host "  [CHECK 7/9] Verifying Frontend HTML Serving on Root URL..." -ForegroundColor Yellow
    try {
        $rootResp = Invoke-WebRequest -Uri "http://127.0.0.1:8001/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $htmlContent = $rootResp.Content

        if ($rootResp.StatusCode -ne 200) {
            Remove-TestArtifacts -TestVenvDir $TestVenvDir -BackendPid $TestBackendPid
            Invoke-FailBuild `
                -Stage "Frontend validation" `
                -Check "Root frontend response" `
                -ErrorMessage "http://127.0.0.1:8001/ returned HTTP $($rootResp.StatusCode)." `
                -RootCause "Backend root route failed to return 200 OK." `
                -ActionRequired "Check backend root route handler implementation."
        }

        # Check for JSON error response
        if ($htmlContent -match '"success"\s*:\s*false' -or $htmlContent -match '"error"\s*:') {
            Remove-TestArtifacts -TestVenvDir $TestVenvDir -BackendPid $TestBackendPid
            Invoke-FailBuild `
                -Stage "Frontend validation" `
                -Check "Root frontend response" `
                -ErrorMessage "Root endpoint returned a JSON error response instead of HTML." `
                -RootCause "Backend is returning an API error on '/' instead of serving frontend_dist/index.html." `
                -ActionRequired "Ensure frontend static mount or catch-all route is functioning."
        }

        # Check for expected HTML tags
        if (-not ($htmlContent -match "<html" -and $htmlContent -match "<script")) {
            Remove-TestArtifacts -TestVenvDir $TestVenvDir -BackendPid $TestBackendPid
            Invoke-FailBuild `
                -Stage "Frontend validation" `
                -Check "Root frontend response" `
                -ErrorMessage "Root endpoint did not return valid frontend HTML." `
                -RootCause "Response body is missing standard HTML elements." `
                -ActionRequired "Verify index.html build output in frontend/dist."
        }

        Write-Host "  OK: Root endpoint served valid HTML frontend." -ForegroundColor Green
    } catch {
        Remove-TestArtifacts -TestVenvDir $TestVenvDir -BackendPid $TestBackendPid
        Invoke-FailBuild `
            -Stage "Frontend validation" `
            -Check "Root frontend response" `
            -ErrorMessage "Failed to request http://127.0.0.1:8001/ - $_" `
            -RootCause "Backend root route crashed or unhandled exception occurred." `
            -ActionRequired "Inspect backend log for stack trace."
    }

    # ----------------------------------------------------------
    # CHECK 8 - Clean shutdown & process tree termination
    # ----------------------------------------------------------
    Write-Host "  [CHECK 8/9] Terminating test backend (PID $TestBackendPid)..." -ForegroundColor Yellow
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    taskkill /PID $TestBackendPid /T /F 2>&1 | Out-Null
    $ErrorActionPreference = $prevEAP
    try { $uvProc | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue } catch { }

    # Verify port 8001 is released after termination. LISTENING only - same
    # reasoning as the port-reclaim check above.
    $portReleased = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $portCheck = netstat -ano 2>&1 | Select-String ":8001 " | Where-Object { $_ -match "LISTENING" }
        if (-not $portCheck) {
            $portReleased = $true
            break
        } else {
            # Check if port is held by a surviving process from our tree
            $portPid = ($portCheck -split '\s+')[-1]
            if ($portPid -match '^\d+$') {
                $portProc = Get-Process -Id $portPid -ErrorAction SilentlyContinue
                Write-Host "    [port-check] Port 8001 held by PID $portPid ($($portProc.ProcessName))" -ForegroundColor Yellow

                # If child of test backend, force kill child directly
                $parentPid = 0
                try {
                    $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$portPid").ParentProcessId
                } catch { }

                Write-Host "    [port-check] PID $portPid parent is $parentPid (test backend was $TestBackendPid)" -ForegroundColor Yellow
                if ($parentPid -eq $TestBackendPid -or $portPid -eq $TestBackendPid) {
                    $prevEAP = $ErrorActionPreference
                    $ErrorActionPreference = "Continue"
                    taskkill /PID $portPid /T /F 2>&1 | Out-Null
                    $ErrorActionPreference = $prevEAP
                } else {
                    Write-Host "    Same tree:    NO" -ForegroundColor Red
                    Remove-TestArtifacts -TestVenvDir $TestVenvDir -BackendPid 0
                    Invoke-FailBuild `
                        -Stage "Backend validation" `
                        -Check "Port 8001 free" `
                        -ErrorMessage "Port 8001 is occupied by an unrelated process (PID $portPid)." `
                        -RootCause "External process is occupying port 8001." `
                        -ActionRequired "Terminate the process on port 8001."
                }
            }
        }
    }

    # Remove temporary log files
    Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

    # Test venv is kept as a cache for $VenvCacheHit above, not deleted here.

    if (-not $portReleased) {
        Invoke-FailBuild `
            -Stage "Backend validation" `
            -Check "Port 8001 released after test backend stop" `
            -ErrorMessage "Port 8001 was not released within 10 seconds after test backend termination." `
            -RootCause "Child process lingering on port 8001." `
            -ActionRequired "Inspect task manager for orphan Python processes."
    }
    Write-Host "  OK: Test backend stopped cleanly and port 8001 released." -ForegroundColor Green

    # ----------------------------------------------------------
    # CHECK 9 - Cache persistence verification
    # ----------------------------------------------------------
    Write-Host "  [CHECK 9/9] Verifying embedded Python cache..." -ForegroundColor Yellow
    if (Test-Path $TestVenvPy) {
        Write-Host "  OK: embedded Python prepared successfully at $PythonDir." -ForegroundColor Green
    } else {
        Write-Host "  WARNING: embedded Python cache miss." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host "  BUILD GATE PASSED: Backend Production Runtime Verified" -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Test-PrePackage {
    Write-Host "Step 4.5: Running Pre-Packaging Sanity Checks..." -ForegroundColor Yellow

    # CHECK 11 - Frontend source assets
    Write-Host "  [CHECK 11/20] Frontend source assets..." -ForegroundColor Yellow
    if (-Not (Test-Path "frontend\dist\index.html")) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 11" -ErrorMessage "frontend\dist\index.html does not exist."
    }
    if (-Not (Test-Path "frontend\dist\assets")) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 11" -ErrorMessage "frontend\dist\assets does not exist."
    }
    $jsFiles = Get-ChildItem "frontend\dist\assets\*.js" -ErrorAction SilentlyContinue
    if (-Not $jsFiles) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 11" -ErrorMessage "frontend\dist\assets contains no .js files."
    }
    $cssFiles = Get-ChildItem "frontend\dist\assets\*.css" -ErrorAction SilentlyContinue
    if (-Not $cssFiles) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 11" -ErrorMessage "frontend\dist\assets contains no .css files."
    }
    Write-Host "  OK: Frontend source assets exist." -ForegroundColor Green

    # CHECK 12 - Frontend asset references in index.html
    Write-Host "  [CHECK 12/20] Frontend asset references..." -ForegroundColor Yellow
    $indexHtml = Get-Content "frontend\dist\index.html" -Raw
    $assetMatches = [regex]::Matches($indexHtml, '(?:src|href)="/assets/([^"]+)"|(?:src|href)="\./assets/([^"]+)"')
    foreach ($match in $assetMatches) {
        $assetName = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        $assetPath = Join-Path "frontend\dist\assets" $assetName
        if (-Not (Test-Path $assetPath)) {
            Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 12" -ErrorMessage "Referenced asset missing: /assets/$assetName"
        }
    }
    Write-Host "  OK: Frontend asset references are valid." -ForegroundColor Green

    # bugfix/backend-code-exposure-fixes collapses package.json's whole extraResources list
    # to one "backend/dist/LMS_Backend_Server" -> "backend" entry (its PyInstaller output).
    # Not adopted here: this branch still needs the granular entries below (backend/app,
    # backend/python, backend/db_migrations, etc.) since it has no PyInstaller build step.
    # CHECK 13 - package.json extraResources mapping for frontend
    Write-Host "  [CHECK 13/20] Frontend packaging mapping..." -ForegroundColor Yellow
    $pkgJson = Get-Content "onprem\package.json" -Raw | ConvertFrom-Json
    $extraResources = $pkgJson.build.extraResources
    $hasMapping = $false
    foreach ($res in $extraResources) {
        if ($res.from -eq "../frontend/dist" -and $res.to -eq "backend/frontend_dist") {
            $hasMapping = $true
            break
        }
    }
    if (-Not $hasMapping) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 13" -ErrorMessage "package.json missing extraResources mapping: frontend/dist -> backend/frontend_dist"
    }
    Write-Host "  OK: Frontend packaging mapping verified." -ForegroundColor Green

    # CHECK 13b - the on-prem feature switches ship with the installer
    $featuresMapped = $false
    foreach ($res in $extraResources) {
        if ($res.from -eq "config/features.json" -and $res.to -eq "backend/features.json") { $featuresMapped = $true }
    }
    if (-Not ($featuresMapped -and (Test-Path "onprem\config\features.json"))) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 13b" `
            -ErrorMessage "onprem/config/features.json is missing or not mapped to backend/features.json in onprem/package.json." `
            -ActionRequired "Restore onprem/config/features.json and its extraResources entry; without it the installer would run with catalog defaults."
    }
    Write-Host "  OK: Feature switches (features.json) are packaged." -ForegroundColor Green

    # CHECK 14 - Backend static assets mount
    Write-Host "  [CHECK 14/20] Backend static assets..." -ForegroundColor Yellow
    $mainPy = Get-Content "backend\app\main.py" -Raw
    $spaPy = Get-Content "backend\app\core\spa.py" -Raw
    # The mount lives in core/spa.py; main.py must call install_spa
    if (($spaPy -notmatch 'app\.mount\("/assets",\s*StaticFiles\(directory=assets_dir\)') -or ($mainPy -notmatch 'install_spa\(')) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 14" -ErrorMessage "backend must mount StaticFiles for /assets (core/spa.py install_spa, called from main.py)."
    }
    Write-Host "  OK: Backend static assets mount verified." -ForegroundColor Green

    # CHECK 15 - LicenseConstants source
    Write-Host "  [CHECK 15/20] LicenseConstants source..." -ForegroundColor Yellow
    if (-Not (Test-Path "onprem\electron\license\LicenseConstants.js")) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 15" -ErrorMessage "onprem\electron\license\LicenseConstants.js does not exist."
    }
    Write-Host "  OK: LicenseConstants source exists." -ForegroundColor Green

    # CHECK 16 - Preload dependency
    Write-Host "  [CHECK 16/20] Preload dependency..." -ForegroundColor Yellow
    $preloadJs = Get-Content "onprem\electron\preload.js" -Raw
    if (-Not ($preloadJs.Contains('LicenseConstants'))) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 16" -ErrorMessage "onprem/electron/preload.js does not require LicenseConstants."
    }
    Write-Host "  OK: Preload dependency exists in preload.js." -ForegroundColor Green

    # CHECK 17 - Electron packaging configuration
    Write-Host "  [CHECK 17/20] Electron packaging configuration..." -ForegroundColor Yellow
    $filesConfig = $pkgJson.build.files
    $hasElectronGlob = $false
    foreach ($pattern in $filesConfig) {
        if ($pattern -eq "electron/**/*" -or $pattern -eq "electron/**") {
            $hasElectronGlob = $true
            break
        }
    }
    if (-Not $hasElectronGlob) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 17" -ErrorMessage "package.json 'files' does not include electron source tree."
    }
    Write-Host "  OK: Electron packaging configuration verified." -ForegroundColor Green

    # CHECK 18 - Production BrowserWindow configuration
    Write-Host "  [CHECK 18/20] Production BrowserWindow configuration..." -ForegroundColor Yellow
    $electronMain = Get-Content "onprem\electron\main.js" -Raw
    if ($electronMain -notmatch 'sandbox:\s*false') {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 18" -ErrorMessage "onprem/electron/main.js does not have sandbox: false configured."
    }
    Write-Host "  OK: Production BrowserWindow configuration verified." -ForegroundColor Green

    # CHECK 19 - Production frontend loading
    Write-Host "  [CHECK 19/20] Production frontend loading..." -ForegroundColor Yellow
    # BACKEND_PORT is resolved dynamically in main.js (defaults to 8001 or free
    # env var), not a hardcoded literal, so the exact substring '127.0.0.1:8001'
    # never appears in source - match either form.
    if (-Not ($electronMain.Contains('127.0.0.1:8001') -or $electronMain.Contains('127.0.0.1:${BACKEND_PORT}'))) {
        Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 19" -ErrorMessage "onprem/electron/main.js does not load the production URL (127.0.0.1:8001 or 127.0.0.1:`${BACKEND_PORT})."
    }
    Write-Host "  OK: Production frontend loading verified." -ForegroundColor Green

    # CHECK 20 - Fatal preload dependency
    Write-Host "  [CHECK 20/20] Preload dependencies..." -ForegroundColor Yellow
    $requireMatches = [regex]::Matches($preloadJs, 'require\(["'']\./([^"'']+)["'']\)')
    foreach ($req in $requireMatches) {
        $depPath = $req.Groups[1].Value
        $fullDepPath = Join-Path "onprem\electron" "$depPath.js"
        if (-Not (Test-Path $fullDepPath)) {
            Invoke-FailBuild -Stage "Pre-Packaging" -Check "CHECK 20" -ErrorMessage "Preload requires a local file that does not exist: $fullDepPath"
        }
    }
    Write-Host "  OK: No known fatal preload dependency." -ForegroundColor Green
}

function Get-ElectronDistCache {
    $zipPath = "onprem\build-cache\electron-v32.2.6-win32-x64.zip"
    $cacheDir = "$env:LOCALAPPDATA\electron\Cache"
    $targetFile = "$cacheDir\electron-v32.2.6-win32-x64.zip"

    if (Test-Path $zipPath) {
        Write-Host "Step 4.8: Restoring cached electron binary to $cacheDir..." -ForegroundColor Yellow
        if (-Not (Test-Path $cacheDir)) {
            New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
        }
        if (-Not (Test-Path $targetFile)) {
            Copy-Item -Path $zipPath -Destination $targetFile -Force
            Write-Host "  OK: Restored electron zip to cache." -ForegroundColor Green
        } else {
            Write-Host "  OK: Electron zip already present in cache." -ForegroundColor Green
        }
    }
}

function Invoke-ElectronPackage {
    Write-Host "Step 4.9: Packaging Electron App..." -ForegroundColor Yellow

    # Ensure any stale packaged app, electron, or mail client processes are terminated before packaging
    Get-Process -Name "Lab Management System", "electron", "olk" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Clean existing win-unpacked and win-unpacked.tmp folders beforehand to avoid EBUSY / EPERM lock contention
    foreach ($dir in @("onprem\desktop-app-build\win-unpacked", "onprem\desktop-app-build\win-unpacked.tmp")) {
        if (Test-Path $dir) {
            try {
                Remove-Item -Path $dir -Recurse -Force -ErrorAction Stop
            } catch {
                Write-Host "  Note: Waiting for file locks on $dir to clear..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
                Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    # Pre-seed electron cache before running electron-builder
    Get-ElectronDistCache

    # Ensure electron-builder Windows rename resilience patch is applied in node_modules
    $electronGetPath = "onprem\node_modules\app-builder-lib\out\util\electronGet.js"
    if (Test-Path $electronGetPath) {
        $content = [System.IO.File]::ReadAllText($electronGetPath)
        if ($content -notmatch "renameSuccess") {
            $oldCode = "await fs.rm(dir, { recursive: true, force: true });`r`n        await fs.rename(tmpDir, dir);"
            $oldCodeLf = "await fs.rm(dir, { recursive: true, force: true });`n        await fs.rename(tmpDir, dir);"
            $patch = "await fs.rm(dir, { recursive: true, force: true }).catch(() => {});`r`n        let renameSuccess = false;`r`n        for (let i = 0; i < 25; i++) {`r`n            try {`r`n                await fs.rm(dir, { recursive: true, force: true }).catch(() => {});`r`n                await fs.rename(tmpDir, dir);`r`n                renameSuccess = true;`r`n                break;`r`n            } catch (err) {`r`n                if (i < 24 && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {`r`n                    await new Promise(r => setTimeout(r, 400 * (i + 1)));`r`n                } else {`r`n                    try {`r`n                        const fsExtra = require('fs-extra');`r`n                        await fsExtra.copy(tmpDir, dir, { overwrite: true });`r`n                        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});`r`n                        renameSuccess = true;`r`n                        break;`r`n                    } catch (copyErr) {`r`n                        throw err;`r`n                    }`r`n                }`r`n            }`r`n        }"
            if ($content.Contains($oldCode)) {
                $content = $content.Replace($oldCode, $patch)
                [System.IO.File]::WriteAllText($electronGetPath, $content)
            } elseif ($content.Contains($oldCodeLf)) {
                $content = $content.Replace($oldCodeLf, $patch)
                [System.IO.File]::WriteAllText($electronGetPath, $content)
            }
        }
    }

    # Ensure electron-builder Windows asar integrity write resilience patch is applied in node_modules
    $electronWinPath = "onprem\node_modules\app-builder-lib\out\electron\electronWin.js"
    if (Test-Path $electronWinPath) {
        $winContent = [System.IO.File]::ReadAllText($electronWinPath)
        if ($winContent -notmatch "writeSuccess") {
            $oldWinCode = "await (0, promises_1.writeFile)(executablePath, Buffer.from(executable.generate()));"
            $winPatch = "const generatedBuffer = Buffer.from(executable.generate());`r`n    let writeSuccess = false;`r`n    for (let i = 0; i < 25; i++) {`r`n        try {`r`n            await (0, promises_1.writeFile)(executablePath, generatedBuffer);`r`n            writeSuccess = true;`r`n            break;`r`n        } catch (err) {`r`n            if (i < 24 && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {`r`n                await new Promise(r => setTimeout(r, 400 * (i + 1)));`r`n            } else {`r`n                throw err;`r`n            }`r`n        }`r`n    }"
            if ($winContent.Contains($oldWinCode)) {
                $winContent = $winContent.Replace($oldWinCode, $winPatch)
                [System.IO.File]::WriteAllText($electronWinPath, $winContent)
            }
        }
    }

    # [string[]] cast is required - a single-element array literal returned from
    # an if/else expression collapses to a bare string, which @ebArgs would then
    # splat character-by-character instead of as one argument.
    [string[]]$ebArgs = if ($SkipInstaller) { @('--dir') } else { @('--win', 'nsis', '--x64') }
    if ($SkipInstaller) {
        Write-Host "  -SkipInstaller set - packaging win-unpacked only, no Setup.exe." -ForegroundColor Yellow
    }
    Write-Host "  Running: npx electron-builder $($ebArgs -join ' ')" -ForegroundColor Cyan

    # Retry up to 3 times for transient signtool network/lock errors
    $maxAttempts = 3
    $attempt = 0
    $success = $false

    while ($attempt -lt $maxAttempts -and -not $success) {
        $attempt++
        if ($attempt -gt 1) {
            Write-Host "  [Retry $attempt/$maxAttempts] Cleaning staging directories and re-running electron-builder..." -ForegroundColor Yellow
            Get-Process -Name "Lab Management System", "electron", "olk" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            Remove-Item -Path "onprem\desktop-app-build\win-unpacked", "onprem\desktop-app-build\win-unpacked.tmp" -Recurse -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }

        Push-Location onprem
        & npx electron-builder @ebArgs
        $ebExit = $LASTEXITCODE
        Pop-Location
        if ($ebExit -eq 0) {
            $success = $true
        } else {
            Write-Host "  WARNING: electron-builder failed (exit code $ebExit)." -ForegroundColor Yellow
        }
    }

    if (-not $success) {
        Invoke-FailBuild `
            -Stage "Packaging" `
            -Check "electron-builder execution" `
            -ErrorMessage "electron-builder failed after $maxAttempts attempts (exit code $ebExit)." `
            -Command $ebCmd `
            -ActionRequired "Check output log above for signtool or file lock issues."
    }

    # Verify the expected output was generated
    if ($SkipInstaller) {
        $installerProduced = Test-Path "onprem\desktop-app-build\win-unpacked\Lab Management System.exe"
    } else {
        $installerProduced = Test-Path "onprem\desktop-app-build\Lab Management System Setup 1.0.0.exe"
        if (-not $installerProduced) {
            # Check for any .exe produced in output directory
            $anyExe = Get-ChildItem -Path "onprem\desktop-app-build" -Filter "*.exe" -ErrorAction SilentlyContinue
            if ($anyExe) {
                $installerProduced = $true
            }
        }
    }

    if (-Not $installerProduced) {
        Invoke-FailBuild `
            -Stage "Packaging" `
            -Check "electron-builder produced expected output" `
            -ErrorMessage "Expected output not found in onprem\desktop-app-build after $maxAttempts attempts." `
            -FilePath "onprem\desktop-app-build" `
            -RootCause "electron-builder completed with exit 0 but output directory is missing the expected file." `
            -ActionRequired "Check package.json build target configuration."
    }

    Write-Host "OK: Electron app packaged successfully." -ForegroundColor Green
}

function Reset-LocalAppState {
    Write-Host "Step 4b: Resetting local app state (preserving license)..." -ForegroundColor Yellow
    $roamingRoot = Join-Path $env:APPDATA "Lab Management System"
    if (-Not (Test-Path $roamingRoot)) {
        Write-Host "  No local app state found; skipping reset." -ForegroundColor Green
        return
    }

    # Preserve logs for debugging
    $logDir = Join-Path $roamingRoot "logs"
    if (Test-Path $logDir) {
        $archiveDir = "onprem\build-cache\logs-archive\$(Get-Date -Format 'yyyyMMdd_HHmmss')"
        New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
        Copy-Item -Path "$logDir\*" -Destination $archiveDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  OK: Archived previous run's logs to $archiveDir" -ForegroundColor Green
    }

    Get-ChildItem -Path $roamingRoot -Force | Where-Object { $_.Name -ne "license" } | ForEach-Object {
        Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  OK: Cleared logs/cache/settings; license\ left untouched." -ForegroundColor Green
}

# The installer leaves files out (extraResources in package.json): prove the packaged copy still imports.
function Test-PackagedBackend {
    Write-Host "Step 4.95: Importing the backend with the packaged Python..." -ForegroundColor Yellow
    $unpacked = "onprem\desktop-app-build\win-unpacked\resources"
    if (-not (Test-Path $unpacked)) {
        Write-Host "  SKIP: no win-unpacked output to check." -ForegroundColor Yellow
        return
    }
    $backendDir = Join-Path (Resolve-Path $unpacked).Path "backend"
    $py = Join-Path $backendDir "python\python.exe"
    if (-not (Test-Path $py)) {
        Invoke-FailBuild `
            -Stage "Packaged backend" `
            -Check "Packaged Python present" `
            -ErrorMessage "python.exe is missing from the packaged backend." `
            -FilePath $py `
            -ActionRequired "Check the extraResources entries in package.json."
    }
    $code = "import sys; sys.path.insert(0, r'$backendDir'); import app.main; import pandas, numpy, scipy.stats, reportlab, docx, openpyxl, PIL, lxml, httpx, qrcode, pdfplumber, openai, jwt, pyotp, bcrypt, cryptography, psycopg2, yaml, tzlocal, apscheduler, jsonschema, websockets, watchfiles, multipart, dns, email_validator; print('PACKAGED_IMPORT_OK')"
    $outFile = "$env:TEMP\packaged_import_out.log"
    $errFile = "$env:TEMP\packaged_import_err.log"
    Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
    $saved = @{ DATABASE_URL = $env:DATABASE_URL; DEPLOYMENT_MODE = $env:DEPLOYMENT_MODE; PYTHONUTF8 = $env:PYTHONUTF8 }
    $env:DATABASE_URL = "postgresql://u@localhost/x"; $env:DEPLOYMENT_MODE = "onprem"; $env:PYTHONUTF8 = "1"
    try {
        $proc = Start-Process -FilePath $py -ArgumentList @("-c", "`"$code`"") -WorkingDirectory $backendDir -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    } finally {
        foreach ($k in $saved.Keys) {
            if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue } else { Set-Item "Env:$k" $saved[$k] }
        }
    }
    $stdout = if (Test-Path $outFile) { Get-Content $outFile -Raw } else { "" }
    if ($proc.ExitCode -ne 0 -or $stdout -notmatch "PACKAGED_IMPORT_OK") {
        $stderr = if (Test-Path $errFile) { (Get-Content $errFile -Tail 15) -join "`n" } else { "" }
        Invoke-FailBuild `
            -Stage "Packaged backend" `
            -Check "Packaged backend imports" `
            -ErrorMessage "The packaged backend could not import the app or one of its libraries." `
            -RootCause $stderr `
            -ActionRequired "A file the app needs was probably excluded by the extraResources filter in package.json."
    }
    Write-Host "  OK: the packaged backend imports the app and its lazily loaded libraries." -ForegroundColor Green
}

function Test-SecurityAudit {
    Write-Host "Step 5: Post-build secret audit..." -ForegroundColor Yellow
    $buildDir = "onprem\desktop-app-build"
    if (Test-Path $buildDir) {
        $secretFiles = @(Get-ChildItem -Path $buildDir -Recurse -Include "*.env",".env","*.pem","*.key","*.p12","*.pfx" -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -ne "cacert.pem" -and $_.Name -ne "roots.pem" -and
            # Baking is on by default (-SkipEnvBake opts out) - this one is intentional.
            -not ((-not $SkipEnvBake) -and $_.FullName -match '\\resources\\backend\\\.env$')
        })
        if ($secretFiles.Count -gt 0) {
            $fileList = ($secretFiles | ForEach-Object { $_.FullName }) -join "`n"
            Invoke-FailBuild `
                -Stage "Post-build security audit" `
                -Check "No secret files in build output" `
                -ErrorMessage "Secret files found in build output!" `
                -FilePath $fileList `
                -RootCause "Secret files were included in the packaged application." `
                -ActionRequired "Remove these files from the build and verify package.json 'files' exclusion rules."
        }
        Write-Host "OK: No secret files found in build output." -ForegroundColor Green

        # 5b/5c below: ported from bugfix/backend-code-exposure-fixes (commit 8a6b2c6),
        # rescoped for this branch's portable-interpreter packaging (that branch
        # switched to a PyInstaller single-exe, which this branch does not use).
        # 5b: our own app source must be .pyc-only (afterPack.js strips .py there).
        # db_migrations and the portable Python's own site-packages ship .py by design - not scanned here.
        $pySourceFiles = @(Get-ChildItem -Path $buildDir -Recurse -Filter "*.py" -ErrorAction SilentlyContinue | Where-Object {
            $_.FullName -match '\\resources\\backend\\app\\'
        })
        if ($pySourceFiles.Count -gt 0) {
            $pyList = ($pySourceFiles | Select-Object -First 15 | ForEach-Object { $_.FullName }) -join "`n"
            Invoke-FailBuild `
                -Stage "Post-build security audit" `
                -Check "No Python source (.py) under backend/app" `
                -ErrorMessage "$($pySourceFiles.Count) .py file(s) found under backend/app in build output - source code is being shipped to clients!" `
                -FilePath $pyList `
                -RootCause "afterPack.js failed to strip .py source after byte-compiling backend/app." `
                -ActionRequired "Check afterPack.js's compileall/cleanup step for backend/app."
        }
        Write-Host "OK: No Python source files under backend/app. Source code is protected." -ForegroundColor Green

        # 5c: requirements.txt isn't read at runtime by this architecture - it shouldn't ship at all.
        # Companion fix: removed from package.json's extraResources so this check can pass.
        $reqFiles = @(Get-ChildItem -Path $buildDir -Recurse -Filter "requirements.txt" -ErrorAction SilentlyContinue)
        if ($reqFiles.Count -gt 0) {
            $reqList = ($reqFiles | ForEach-Object { $_.FullName }) -join "`n"
            Invoke-FailBuild `
                -Stage "Post-build security audit" `
                -Check "No requirements.txt in build output" `
                -ErrorMessage "requirements.txt found in build output - tech stack is exposed!" `
                -FilePath $reqList `
                -RootCause "package.json extraResources still includes backend/requirements.txt." `
                -ActionRequired "Remove backend/requirements.txt from package.json extraResources."
        }
        Write-Host "OK: No requirements.txt in build output." -ForegroundColor Green
    }
}

# ==========================================
# MAIN EXECUTION
# ==========================================

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   Building AI Digital LMS Desktop Application    " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

$__sw = [System.Diagnostics.Stopwatch]::StartNew()
function Write-TimingLog($label) { Write-Host "[TIMING] $label at $([math]::Round($__sw.Elapsed.TotalSeconds, 1))s" -ForegroundColor DarkGray }

# In case a previous crashed run left this behind.
if (Test-Path "backend\.env.bake") { Remove-Item "backend\.env.bake" -Force -ErrorAction SilentlyContinue }

try {
    Test-Prerequisites
    Write-TimingLog "Prerequisites done"
    Test-Security

    if ($SkipFrontend) {
        Write-Host "Step 2: Skipping Frontend Build..." -ForegroundColor Yellow
    } else {
        Invoke-FrontendBuild
    }
    Write-TimingLog "Frontend build done"

    Test-BackendSource
    Get-PortablePython

    # *** BUILD GATE - must fully pass before electron-builder ***
    Test-Backend
    Write-TimingLog "Backend validation gate done"

    Test-PrePackage
    Write-TimingLog "Pre-packaging gate done"

    Invoke-ElectronPackage
    Write-TimingLog "Electron packaging done"
    Test-PackagedBackend
    Reset-LocalAppState
    Test-SecurityAudit
    Write-TimingLog "Total build"

    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host "BUILD COMPLETE!" -ForegroundColor Green
    if ($SkipInstaller) {
        Write-Host "win-unpacked is available in 'onprem\desktop-app-build\win-unpacked' (no installer built)." -ForegroundColor Cyan
    } else {
        Write-Host "Installer is available in the 'onprem\desktop-app-build' folder." -ForegroundColor Cyan
    }
    Write-Host "==================================================" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: Script failed - $_" -ForegroundColor Red
    exit 1
} finally {
    # Never leave customer secrets sitting in the repo checkout.
    if (Test-Path "backend\.env.bake") { Remove-Item "backend\.env.bake" -Force -ErrorAction SilentlyContinue }
}
