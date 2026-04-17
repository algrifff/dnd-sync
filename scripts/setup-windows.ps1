# The Compendium — Windows Setup
# Double-click setup-windows.bat to run this.

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
$ErrorActionPreference = "Stop"

function Write-Step($n, $msg) { Write-Host ""; Write-Host "[$n/5] $msg" -ForegroundColor Cyan }
function Write-OK($msg)       { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Info($msg)     { Write-Host "  $msg" -ForegroundColor Gray }

$FOLDER_ID        = "the-compendium"
$VAULT_PATH       = "$env:USERPROFILE\Documents\The-Compendium"
$LOCAL_ST_API_KEY = "compendium-setup-key"

# ── Wizard ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "===============================" -ForegroundColor Magenta
Write-Host "  The Compendium — Sync Setup  " -ForegroundColor Magenta
Write-Host "===============================" -ForegroundColor Magenta
Write-Host ""
Write-Host "This will install Obsidian and set up the shared vault on your machine."
Write-Host "You'll need two things from your DM before continuing."
Write-Host ""

Write-Host "Step 1 of 2 — Server address" -ForegroundColor Yellow
Write-Host "  This looks like: https://something.up.railway.app"
$RAILWAY_URL = Read-Host "  Enter server address"
$RAILWAY_URL = $RAILWAY_URL.TrimEnd("/")

Write-Host ""
Write-Host "Step 2 of 2 — Join key" -ForegroundColor Yellow
Write-Host "  Your DM should have sent you a join key."
$RAILWAY_API_KEY = Read-Host "  Enter join key"

Write-Host ""
Write-Host "Verifying connection..." -ForegroundColor Gray
try {
    Invoke-RestMethod -Uri "$RAILWAY_URL/rest/system/ping" `
        -Headers @{"X-API-Key" = $RAILWAY_API_KEY} -ErrorAction Stop | Out-Null
} catch {
    Write-Host ""
    Write-Host "ERROR: Could not connect to the sync server." -ForegroundColor Red
    Write-Host "  Check the server address and join key and try again." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

# Get Railway device ID
$railwayStatus = Invoke-RestMethod -Uri "$RAILWAY_URL/rest/system/status" `
    -Headers @{"X-API-Key" = $RAILWAY_API_KEY}
$RAILWAY_DEVICE_ID = $railwayStatus.myID

Write-Host "  Connected!" -ForegroundColor Green
Write-Host ""

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
Write-Step 1 "Checking Obsidian..."
$obsidianExe = "$env:LOCALAPPDATA\Obsidian\Obsidian.exe"
if (-not (Test-Path $obsidianExe)) {
    Write-Info "Downloading Obsidian (this may take a minute)..."
    $installer = "$env:TEMP\ObsidianSetup.exe"
    $latestRelease = Invoke-RestMethod "https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest"
    $asset = $latestRelease.assets | Where-Object { $_.name -like "*Setup*x64*.exe" } | Select-Object -First 1
    if (-not $asset) {
        $asset = $latestRelease.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
    }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
    Start-Process -FilePath $installer -Args "/S" -Wait
    Remove-Item $installer -ErrorAction SilentlyContinue
    Write-OK "Obsidian installed."
} else {
    Write-OK "Obsidian already installed."
}

# ── 2. Install Syncthing ──────────────────────────────────────────────────────
Write-Step 2 "Checking Syncthing..."
$stDir  = "$env:LOCALAPPDATA\Syncthing"
$stExe  = "$stDir\syncthing.exe"
$stData = "$env:APPDATA\Syncthing"

if (-not (Test-Path $stExe)) {
    Write-Info "Downloading Syncthing..."
    $release = Invoke-RestMethod "https://api.github.com/repos/syncthing/syncthing/releases/latest"
    $asset = $release.assets | Where-Object { $_.name -like "*windows-amd64*.zip" } | Select-Object -First 1
    $zip = "$env:TEMP\syncthing.zip"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip
    New-Item -ItemType Directory -Force -Path $stDir | Out-Null
    $extracted = "$env:TEMP\st-extract"
    Remove-Item $extracted -Recurse -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $extracted -Force
    $exeSource = Get-ChildItem -Recurse -Path $extracted -Filter "syncthing.exe" | Select-Object -First 1
    Copy-Item $exeSource.FullName -Destination $stExe
    Remove-Item $zip, $extracted -Recurse -ErrorAction SilentlyContinue
    Write-OK "Syncthing installed."
} else {
    Write-OK "Syncthing already installed."
}

# ── 3. Create vault folder ────────────────────────────────────────────────────
Write-Step 3 "Creating vault folder..."
New-Item -ItemType Directory -Force -Path $VAULT_PATH | Out-Null
Write-OK "Vault folder: $VAULT_PATH"

# ── 4. Start Syncthing with known API key and configure ───────────────────────
Write-Step 4 "Connecting to sync server..."

$running = Get-Process syncthing -ErrorAction SilentlyContinue
if ($running) {
    Write-Info "Stopping existing Syncthing instance..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 3
}

New-Item -ItemType Directory -Force -Path $stData | Out-Null
$env:STGUIAPIKEY = $LOCAL_ST_API_KEY
Start-Process -FilePath $stExe `
    -ArgumentList "--no-browser", "--home=`"$stData`"", "--gui-address=127.0.0.1:8384" `
    -WindowStyle Hidden
Remove-Item Env:\STGUIAPIKEY -ErrorAction SilentlyContinue

Write-Info "Waiting for Syncthing to start..."
$localApi = "http://localhost:8384"
$headers  = @{ "X-API-Key" = $LOCAL_ST_API_KEY }
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        Invoke-RestMethod -Uri "$localApi/rest/system/ping" -Headers $headers -ErrorAction Stop | Out-Null
        $ready = $true; break
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) {
    Write-Host "ERROR: Syncthing did not start. Try rebooting and running this script again." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

$status        = Invoke-RestMethod -Uri "$localApi/rest/system/status" -Headers $headers
$localDeviceId = $status.myID

# Add Railway as a device locally
try {
    Invoke-RestMethod -Uri "$localApi/rest/config/devices" -Method Post -Headers $headers `
        -ContentType "application/json" `
        -Body (@{
            deviceID          = $RAILWAY_DEVICE_ID
            name              = "The Compendium Server"
            addresses         = @("dynamic")
            autoAcceptFolders = $false
        } | ConvertTo-Json) | Out-Null
} catch { }

# Add vault folder locally
try {
    Invoke-RestMethod -Uri "$localApi/rest/config/folders" -Method Post -Headers $headers `
        -ContentType "application/json" `
        -Body (@{
            id               = $FOLDER_ID
            label            = "The Compendium"
            path             = $VAULT_PATH
            type             = "sendreceive"
            devices          = @(@{ deviceID = $RAILWAY_DEVICE_ID })
            rescanIntervalS  = 30
            fsWatcherEnabled = $true
        } | ConvertTo-Json -Depth 5) | Out-Null
} catch { }

# Register this device with Railway
$railwayHeaders = @{ "X-API-Key" = $RAILWAY_API_KEY }
try {
    Invoke-RestMethod -Uri "$RAILWAY_URL/rest/config/devices" -Method Post -Headers $railwayHeaders `
        -ContentType "application/json" `
        -Body (@{
            deviceID          = $localDeviceId
            name              = $env:COMPUTERNAME
            addresses         = @("dynamic")
            autoAcceptFolders = $false
        } | ConvertTo-Json) | Out-Null
} catch { }

# Add this device to Railway's vault folder (duplicate-safe)
try {
    $folderCfg    = Invoke-RestMethod -Uri "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" -Headers $railwayHeaders
    $alreadyAdded = $folderCfg.devices | Where-Object { $_.deviceID -eq $localDeviceId }
    if (-not $alreadyAdded) {
        $folderCfg.devices += [PSCustomObject]@{ deviceID = $localDeviceId; encryptionPassword = "" }
    }
    Invoke-RestMethod -Uri "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" -Method Put `
        -Headers $railwayHeaders `
        -ContentType "application/json" `
        -Body ($folderCfg | ConvertTo-Json -Depth 10) | Out-Null
    Write-OK "Registered with sync server."
} catch {
    Write-Host "  Note: Could not register automatically — $_" -ForegroundColor Yellow
    Write-Host "  Ask your DM to approve your device in the sync dashboard." -ForegroundColor Yellow
}

# ── 5. Auto-start Syncthing on login ─────────────────────────────────────────
Write-Step 5 "Setting Syncthing to run on startup..."
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$shortcut   = "$startupDir\Syncthing.lnk"
if (-not (Test-Path $shortcut)) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($shortcut)
    $lnk.TargetPath  = $stExe
    $lnk.Arguments   = "--no-browser --home=`"$stData`" --gui-address=127.0.0.1:8384"
    $lnk.WindowStyle = 7
    $lnk.Save()
}
Write-OK "Syncthing will start automatically with Windows."

Write-Host ""
Write-Host "===============================" -ForegroundColor Green
Write-Host "  Setup complete!              " -ForegroundColor Green
Write-Host "===============================" -ForegroundColor Green
Write-Host ""
Write-Host "The vault is syncing in the background." -ForegroundColor White
Write-Host "It may take a few minutes to download everything on first run." -ForegroundColor White
Write-Host ""
Write-Host "Your vault will be at:" -ForegroundColor White
Write-Host "  $VAULT_PATH" -ForegroundColor Yellow
Write-Host ""
Write-Host "In Obsidian: File > Open Vault > select the folder above." -ForegroundColor White
Write-Host ""
Write-Host "Opening Obsidian..." -ForegroundColor Cyan
Start-Sleep -Seconds 5
Start-Process "obsidian://"

Read-Host "Press Enter to close this window"
