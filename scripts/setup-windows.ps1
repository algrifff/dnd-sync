# The Compendium - Windows Setup
# Double-click setup-windows.bat to run this.

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
$ErrorActionPreference = "Stop"

# Force UTF-8 so Unicode in the banner renders correctly on older consoles.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

# ANSI colour helpers (Windows Terminal supports 256-colour; legacy conhost will
# degrade but remain legible).
$ESC     = [char]27
$R       = "$ESC[0m"
$BOLD    = "$ESC[1m"
$DIM     = "$ESC[2m"
$GOLD    = "$ESC[38;5;220m"
$AMBER   = "$ESC[38;5;214m"
$EMBER   = "$ESC[38;5;208m"
$FLAME   = "$ESC[38;5;202m"
$BLAZE   = "$ESC[38;5;196m"
$SPARK   = "$ESC[38;5;226m"
$GREEN   = "$ESC[38;5;46m"
$SCALE   = "$ESC[38;5;34m"
$SCALE_L = "$ESC[38;5;40m"
$SCALE_D = "$ESC[38;5;22m"
$EYE     = "$ESC[38;5;208m"
$SKY     = "$ESC[38;5;51m"
$GREY    = "$ESC[38;5;244m"
$DGREY   = "$ESC[38;5;238m"
$RED     = "$ESC[38;5;196m"

$UI_TOTAL_STEPS = 5

function Show-Banner {
    Clear-Host
    $fire = " $BLAZE>$FLAME==$EMBER==$AMBER~~$GOLD*$SPARK~$GOLD*$SPARK~$R"
    Write-Host ""
    Write-Host "    $SCALE_D       ▄▄▄▄▄▄▄▄▄▄$R"
    Write-Host "    $SCALE_D    ▄▟$SCALE█████████$SCALE_D█▙▄$R"
    Write-Host "    $SCALE_D  ▗▟$SCALE████$SCALE_L▀▀$EYE◉$SCALE_L▀▀$SCALE█████$SCALE_D▙▖$R"
    Write-Host "    $SCALE_D ▟$SCALE███████$SCALE_L▄▄▄$SCALE████████$SCALE_D▙$R    $DGREY▄▄$R"
    Write-Host "    $SCALE▟████████████████████$SCALE_D▙$R$fire"
    Write-Host "    $SCALE▜████████████████████$SCALE_D▛$R$fire"
    Write-Host "    $SCALE_D ▜$SCALE███████$SCALE_L▀▀▀$SCALE████████$SCALE_D▛$R    $DGREY▀▀$R"
    Write-Host "    $SCALE_D  ▝▜$SCALE█████████████$SCALE_D▛▘$R"
    Write-Host "    $SCALE_D     ▜$SCALE█▛$SCALE_D▘  ▝$SCALE█▛$SCALE_D▘$R"
    Write-Host ""
    Write-Host "  $BOLD$GOLD╔════════════════════════════════════════════╗$R"
    Write-Host "  $BOLD$GOLD║$R    $BOLD" "T H E   C O M P E N D I U M$R             $BOLD$GOLD║$R"
    Write-Host "  $BOLD$GOLD╠════════════════════════════════════════════╣$R"
    Write-Host "  $BOLD$GOLD║$R    $GREY" "Vault Sync -- First-time Setup$R           $BOLD$GOLD║$R"
    Write-Host "  $BOLD$GOLD╚════════════════════════════════════════════╝$R"
    Write-Host ""
}

function Get-ProgressBar($n, $total) {
    $bar = ""
    for ($i = 1; $i -le $total; $i++) {
        if ($i -le $n) { $bar += "$GOLD▰$R" } else { $bar += "$DGREY▱$R" }
    }
    return $bar
}

function Write-Step($n, $msg) {
    $bar = Get-ProgressBar $n $UI_TOTAL_STEPS
    Write-Host ""
    Write-Host "  $bar  $BOLD$GOLD" "STEP $n / $UI_TOTAL_STEPS$R  $DIM$GREY--$R  $BOLD$msg$R"
}
function Write-OK   ($msg) { Write-Host "     $GREEN✓$R $msg" }
function Write-Info ($msg) { Write-Host "     $SKY›$R $DIM$msg$R" }
function Write-Warn ($msg) { Write-Host "     $AMBER!$R $msg" }
function Write-Err  ($msg) { Write-Host "     $RED$BOLD✗$R $BOLD$msg$R" }

$FOLDER_ID        = "the-compendium"
$VAULT_PATH       = "$env:USERPROFILE\Documents\The-Compendium"
$LOCAL_ST_API_KEY = "compendium-setup-key"

# ---------------------------------------------------------------------------
# Wizard
# ---------------------------------------------------------------------------
Show-Banner

Write-Host "  $BOLD$GOLD🐉  Welcome, adventurer.$R"
Write-Host ""
Write-Host "  This installer will:"
Write-Host "     $GREEN•$R Install Obsidian (the vault reader)"
Write-Host "     $GREEN•$R Install Syncthing (the sync engine)"
Write-Host "     $GREEN•$R Connect you to the shared vault"
Write-Host ""
Write-Host "  You need $BOLD" "two things$R from your DM before you begin:"
Write-Host "     $GOLD①$R Server address   $DIM$GREY-- like https://xxx.up.railway.app$R"
Write-Host "     $GOLD②$R Join key         $DIM$GREY-- a secret string$R"
Write-Host ""

Write-Host -NoNewline "  $BOLD$GOLD①$R $BOLD" "Server address:$R "
$RAILWAY_URL = Read-Host
$RAILWAY_URL = $RAILWAY_URL.TrimEnd("/")

Write-Host -NoNewline "  $BOLD$GOLD②$R $BOLD" "Join key:$R "
$sec = Read-Host -AsSecureString
$RAILWAY_API_KEY = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

Write-Host ""
Write-Info "Verifying connection to the sync server..."
try {
    Invoke-RestMethod -Uri "$RAILWAY_URL/rest/system/ping" `
        -Headers @{"X-API-Key" = $RAILWAY_API_KEY} -ErrorAction Stop | Out-Null
} catch {
    Write-Err "Could not reach the sync server."
    Write-Host "     $DIM$GREY" "Check the server address and join key, then run the installer again.$R"
    Read-Host "Press Enter to exit"
    exit 1
}

$railwayStatus     = Invoke-RestMethod -Uri "$RAILWAY_URL/rest/system/status" `
    -Headers @{"X-API-Key" = $RAILWAY_API_KEY}
$RAILWAY_DEVICE_ID = $railwayStatus.myID
Write-OK "Connected to the sync server."

# ---------------------------------------------------------------------------
# 1. Install Obsidian
# ---------------------------------------------------------------------------
Write-Step 1 "Installing Obsidian"
$obsidianExe = "$env:LOCALAPPDATA\Obsidian\Obsidian.exe"
if (-not (Test-Path $obsidianExe)) {
    Write-Info "Downloading Obsidian (this may take a minute)..."
    $installer     = "$env:TEMP\ObsidianSetup.exe"
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

# ---------------------------------------------------------------------------
# 2. Install Syncthing
# ---------------------------------------------------------------------------
Write-Step 2 "Installing Syncthing"
$stDir  = "$env:LOCALAPPDATA\Syncthing"
$stExe  = "$stDir\syncthing.exe"
$stData = "$env:APPDATA\Syncthing"

if (-not (Test-Path $stExe)) {
    Write-Info "Downloading Syncthing..."
    $release = Invoke-RestMethod "https://api.github.com/repos/syncthing/syncthing/releases/latest"
    $asset   = $release.assets | Where-Object { $_.name -like "*windows-amd64*.zip" } | Select-Object -First 1
    $zip     = "$env:TEMP\syncthing.zip"
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

# ---------------------------------------------------------------------------
# 3. Create vault folder
# ---------------------------------------------------------------------------
Write-Step 3 "Preparing vault folder"
New-Item -ItemType Directory -Force -Path $VAULT_PATH | Out-Null
Write-OK "Vault folder ready: $VAULT_PATH"

# ---------------------------------------------------------------------------
# 4. Start Syncthing and wire everything up
# ---------------------------------------------------------------------------
Write-Step 4 "Connecting to the sync server"

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
$ready    = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        Invoke-RestMethod -Uri "$localApi/rest/system/ping" -Headers $headers -ErrorAction Stop | Out-Null
        $ready = $true
        break
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) {
    Write-Err "Syncthing did not start. Try rebooting and running this script again."
    Read-Host "Press Enter to exit"
    exit 1
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
    Write-OK "Registered with the sync server."
} catch {
    Write-Warn "Could not auto-register. Ask your DM to approve your device in the Syncthing UI."
}

# ---------------------------------------------------------------------------
# 5. Auto-start Syncthing on login
# ---------------------------------------------------------------------------
Write-Step 5 "Enabling auto-start on login"
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
Write-Host "  $BOLD$GOLD╔════════════════════════════════════════════╗$R"
Write-Host "  $BOLD$GOLD║$R         $BOLD$GREEN" "Setup complete!$R                    $BOLD$GOLD║$R"
Write-Host "  $BOLD$GOLD╚════════════════════════════════════════════╝$R"
Write-Host ""
Write-Host "  $GREEN›$R Your vault: $BOLD$VAULT_PATH$R"
Write-Host "  $GREEN›$R In Obsidian: $BOLD" "File -> Open Vault$R -> select that folder."
Write-Host "  $GREEN›$R Status dashboard: $BOLD" "http://localhost:8384$R"
Write-Host ""
Write-Host "  $DIM$GREY" "First sync can take a few minutes. Opening Obsidian...$R"
Start-Sleep -Seconds 4
Start-Process "obsidian://"

Read-Host "Press Enter to close this window"
