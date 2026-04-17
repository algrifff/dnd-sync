# Compendium one-click installer for Windows.
# Pre-baked with your DM's server URL and player token. No prompts.

Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
$ErrorActionPreference = "Stop"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

$ESC   = [char]27
$R     = "$ESC[0m"
$BOLD  = "$ESC[1m"
$DIM   = "$ESC[2m"
$GOLD  = "$ESC[38;5;220m"
$GREEN = "$ESC[38;5;46m"
$SKY   = "$ESC[38;5;51m"
$RED   = "$ESC[38;5;196m"
$GREY  = "$ESC[38;5;244m"

$SERVER_URL   = "__SERVER_URL__"
$PLAYER_TOKEN = "__PLAYER_TOKEN__"
$VAULT_PATH   = if ($env:COMPENDIUM_VAULT) { $env:COMPENDIUM_VAULT } else { "$env:USERPROFILE\Documents\The-Compendium" }

function Step($msg) { Write-Host ""; Write-Host "  $BOLD$GOLD" "> $msg$R" }
function Ok($msg)   { Write-Host "    $GREEN" "OK$R $msg" }
function Info($msg) { Write-Host "    $SKY" "->$R $DIM$msg$R" }

Clear-Host
Write-Host ""
Write-Host "  $BOLD$GOLD" "T H E   C O M P E N D I U M$R"
Write-Host "  $GREY" "Installing the real-time vault plugin...$R"

# --- Install Obsidian if missing --------------------------------------------
Step "Installing Obsidian"
$obsidianExe = "$env:LOCALAPPDATA\Obsidian\Obsidian.exe"
if (-not (Test-Path $obsidianExe)) {
    Info "Downloading Obsidian..."
    $installer     = "$env:TEMP\ObsidianSetup.exe"
    $latestRelease = Invoke-RestMethod "https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest"
    $asset = $latestRelease.assets | Where-Object { $_.name -like "*Setup*x64*.exe" } | Select-Object -First 1
    if (-not $asset) {
        $asset = $latestRelease.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
    }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
    Start-Process -FilePath $installer -Args "/S" -Wait
    Remove-Item $installer -ErrorAction SilentlyContinue
    Ok "Obsidian installed."
} else {
    Ok "Obsidian already installed."
}

# --- Prepare vault + plugin folder ------------------------------------------
Step "Preparing vault"
$pluginDir = Join-Path $VAULT_PATH ".obsidian\plugins\compendium"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Ok "Vault: $VAULT_PATH"

# --- Drop the plugin in -----------------------------------------------------
Step "Installing the Compendium plugin"

$mainJsB64 = @'
__MAIN_JS_BASE64__
'@
$manifestB64 = @'
__MANIFEST_BASE64__
'@

[System.IO.File]::WriteAllBytes(
    (Join-Path $pluginDir "main.js"),
    [Convert]::FromBase64String($mainJsB64)
)
[System.IO.File]::WriteAllBytes(
    (Join-Path $pluginDir "manifest.json"),
    [Convert]::FromBase64String($manifestB64)
)

$data = @{
    serverUrl = $SERVER_URL
    authToken = $PLAYER_TOKEN
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $pluginDir "data.json") -Value $data -Encoding UTF8

$communityPluginsPath = Join-Path $VAULT_PATH ".obsidian\community-plugins.json"
Set-Content -Path $communityPluginsPath -Value '["compendium"]' -Encoding UTF8

Ok "Plugin configured with your DM's server."

# --- Verify the server is reachable -----------------------------------------
Step "Pinging the server"
try {
    Invoke-RestMethod -Uri "$SERVER_URL/api/health" -ErrorAction Stop | Out-Null
    Ok "Server responding."
} catch {
    Write-Host "    $RED" "!$R Could not reach $SERVER_URL -- sync will retry when you are connected."
}

Write-Host ""
Write-Host "  $BOLD$GREEN" "Setup complete.$R"
Write-Host "  $GREEN" "->$R Vault: $BOLD$VAULT_PATH$R"
Write-Host "  $GREEN" "->$R In Obsidian: $BOLD" "Settings -> Community plugins$R -> turn on + trust this vault."
Write-Host ""
Start-Sleep -Seconds 2
Start-Process "obsidian://open?vault=$([System.Uri]::EscapeDataString((Split-Path $VAULT_PATH -Leaf)))"

Read-Host "Press Enter to close"
