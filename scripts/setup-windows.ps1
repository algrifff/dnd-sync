# The Compendium — Windows Setup
# Right-click this file and choose "Run with PowerShell"
# Or open PowerShell and run: powershell -ExecutionPolicy Bypass -File setup-windows.ps1

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
$ErrorActionPreference = "Stop"

# ── CONFIG (filled in by vault owner) ─────────────────────────────────────────
$RAILWAY_URL       = "FILL_IN"   # e.g. https://compendium.up.railway.app
$RAILWAY_API_KEY   = "FILL_IN"   # Syncthing API key
$RAILWAY_DEVICE_ID = "FILL_IN"   # Railway device ID
$FOLDER_ID         = "the-compendium"
$VAULT_PATH        = "$env:USERPROFILE\Documents\The-Compendium"
# ─────────────────────────────────────────────────────────────────────────────

if ($RAILWAY_URL -eq "FILL_IN") {
    Write-Host "ERROR: This script hasn't been configured yet. Ask the vault owner for an updated version." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

function Write-Step($n, $msg) { Write-Host "[$n/5] $msg" -ForegroundColor Cyan }
function Write-OK($msg)       { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Info($msg)     { Write-Host "  $msg" -ForegroundColor Gray }

Write-Host ""
Write-Host "===============================" -ForegroundColor Magenta
Write-Host "  The Compendium — Sync Setup  " -ForegroundColor Magenta
Write-Host "===============================" -ForegroundColor Magenta
Write-Host ""

# ── 1. Install Obsidian ───────────────────────────────────────────────────────
Write-Step 1 "Checking Obsidian..."
$obsidianExe = "$env:LOCALAPPDATA\Obsidian\Obsidian.exe"
if (-not (Test-Path $obsidianExe)) {
    Write-Info "Downloading Obsidian (this may take a minute)..."
    $installer = "$env:TEMP\ObsidianSetup.exe"
    $latestRelease = Invoke-RestMethod "https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest"
    $asset = $latestRelease.assets | Where-Object { $_.name -like "*Setup*x64*.exe" } | Select-Object -First 1
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

# ── 4. Start Syncthing and configure ─────────────────────────────────────────
Write-Step 4 "Starting Syncthing..."
$running = Get-Process syncthing -ErrorAction SilentlyContinue
if (-not $running) {
    Start-Process -FilePath $stExe -ArgumentList "--no-browser", "--home=`"$stData`"" -WindowStyle Hidden
    Write-Info "Waiting for Syncthing to start..."
    Start-Sleep -Seconds 8
}

$localApi = "http://localhost:8384"
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        Invoke-WebRequest -Uri "$localApi/rest/system/ping" -UseBasicParsing -ErrorAction Stop | Out-Null
        $ready = $true; break
    } catch { Start-Sleep -Seconds 3 }
}
if (-not $ready) {
    Write-Host "ERROR: Syncthing did not start. Try rebooting and running this script again." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

# Read local API key
[xml]$cfg = Get-Content "$stData\config.xml"
$localKey = $cfg.configuration.gui.apikey
$headers  = @{ "X-API-Key" = $localKey }

# Get local device ID
$status = Invoke-RestMethod -Uri "$localApi/rest/system/status" -Headers $headers
$localDeviceId = $status.myID
Write-Info "Your device ID: $localDeviceId"

# Add Railway as a device locally
try {
    Invoke-RestMethod -Uri "$localApi/rest/config/devices" -Method Post -Headers $headers `
        -ContentType "application/json" `
        -Body (@{
            deviceID = $RAILWAY_DEVICE_ID
            name = "The Compendium Server"
            addresses = @("dynamic")
            autoAcceptFolders = $false
        } | ConvertTo-Json) | Out-Null
} catch { }

# Add vault folder locally
try {
    Invoke-RestMethod -Uri "$localApi/rest/config/folders" -Method Post -Headers $headers `
        -ContentType "application/json" `
        -Body (@{
            id = $FOLDER_ID
            label = "The Compendium"
            path = $VAULT_PATH
            type = "sendreceive"
            devices = @(@{ deviceID = $RAILWAY_DEVICE_ID })
            rescanIntervalS = 30
            fsWatcherEnabled = $true
        } | ConvertTo-Json -Depth 5) | Out-Null
} catch { }

# Register with Railway and share folder
$railwayHeaders = @{ "X-API-Key" = $RAILWAY_API_KEY }
try {
    Invoke-RestMethod -Uri "$RAILWAY_URL/rest/config/devices" -Method Post -Headers $railwayHeaders `
        -ContentType "application/json" `
        -Body (@{
            deviceID = $localDeviceId
            name = $env:COMPUTERNAME
            addresses = @("dynamic")
            autoAcceptFolders = $false
        } | ConvertTo-Json) | Out-Null

    $folderCfg = Invoke-RestMethod -Uri "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" -Headers $railwayHeaders
    if ($folderCfg.devices -notcontains @{ deviceID = $localDeviceId }) {
        $folderCfg.devices += @{ deviceID = $localDeviceId; encryptionPassword = "" }
    }
    Invoke-RestMethod -Uri "$RAILWAY_URL/rest/config/folders/$FOLDER_ID" -Method Put -Headers $railwayHeaders `
        -ContentType "application/json" `
        -Body ($folderCfg | ConvertTo-Json -Depth 10) | Out-Null

    Write-OK "Registered with sync server."
} catch {
    Write-Host "  Note: Could not auto-register. The vault owner may need to approve your device manually." -ForegroundColor Yellow
}

# ── 5. Auto-start Syncthing on login ─────────────────────────────────────────
Write-Step 5 "Setting Syncthing to run on startup..."
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$shortcut   = "$startupDir\Syncthing.lnk"
if (-not (Test-Path $shortcut)) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($shortcut)
    $lnk.TargetPath  = $stExe
    $lnk.Arguments   = "--no-browser --home=`"$stData`""
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
Write-Host "Opening Obsidian..." -ForegroundColor Cyan
Start-Sleep -Seconds 4
Start-Process "obsidian://"

Read-Host "Press Enter to close this window"
