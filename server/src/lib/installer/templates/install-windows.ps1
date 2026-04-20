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
function Find-Obsidian {
    $candidates = @(
        "$env:LOCALAPPDATA\Obsidian\Obsidian.exe",
        "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe",
        "${env:ProgramFiles}\Obsidian\Obsidian.exe",
        "${env:ProgramFiles(x86)}\Obsidian\Obsidian.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }

    foreach ($root in @("HKCU:\Software\Classes\obsidian\shell\open\command",
                        "HKLM:\Software\Classes\obsidian\shell\open\command")) {
        try {
            $v = (Get-ItemProperty $root -ErrorAction Stop).'(default)'
            if ($v -match '"([^"]+Obsidian\.exe)"') {
                if (Test-Path $matches[1]) { return $matches[1] }
            }
        } catch {}
    }
    return $null
}

Step "Installing Obsidian"
$obsidianExe = Find-Obsidian
if ($obsidianExe) {
    Ok "Obsidian already installed ($obsidianExe)."
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Info "Installing Obsidian via winget..."
    winget install --id Obsidian.Obsidian --silent --accept-source-agreements --accept-package-agreements | Out-Null
    Ok "Obsidian installed."
} else {
    Info "Downloading Obsidian..."
    $installer     = "$env:TEMP\ObsidianSetup.exe"
    $latestRelease = Invoke-RestMethod "https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest"
    $asset = $latestRelease.assets | Where-Object { $_.name -like "*Setup*x64*.exe" } | Select-Object -First 1
    if (-not $asset) {
        $asset = $latestRelease.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1
    }
    if (-not $asset) {
        Write-Host "    $RED" "!$R Could not find an Obsidian installer in the latest release."
        Write-Host "      Install Obsidian manually from https://obsidian.md and rerun this script."
        exit 1
    }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
    Start-Process -FilePath $installer -Args "/S" -Wait
    Remove-Item $installer -ErrorAction SilentlyContinue
    Ok "Obsidian installed."
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

# PowerShell 5.1's Set-Content -Encoding UTF8 writes a byte-order mark.
# Obsidian reads these files with JSON.parse which chokes on a BOM, so write
# them via WriteAllText with an explicit no-BOM UTF-8 encoding.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$data = @{
    serverUrl = $SERVER_URL
    authToken = $PLAYER_TOKEN
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $pluginDir "data.json"), $data, $utf8NoBom)

$communityPluginsPath = Join-Path $VAULT_PATH ".obsidian\community-plugins.json"
[System.IO.File]::WriteAllText($communityPluginsPath, '["compendium"]', $utf8NoBom)

Ok "Plugin configured with your DM's server."

# --- Register the vault with Obsidian --------------------------------------
# Obsidian remembers vaults in %APPDATA%\obsidian\obsidian.json. If we don't
# register our folder there, obsidian://open?vault=... on a fresh install
# either does nothing or opens the wrong vault. This writes an entry so the
# vault shows up in Obsidian's vault picker and open-by-path works.
Step "Registering the vault with Obsidian"
try {
    $obsidianConfigDir = Join-Path $env:APPDATA "obsidian"
    if (-not (Test-Path $obsidianConfigDir)) {
        New-Item -ItemType Directory -Force -Path $obsidianConfigDir | Out-Null
    }
    $obsidianConfigPath = Join-Path $obsidianConfigDir "obsidian.json"

    if (Test-Path $obsidianConfigPath) {
        $raw = (Get-Content $obsidianConfigPath -Raw -Encoding UTF8).TrimStart([char]0xFEFF)
        $obsidianConfig = $raw | ConvertFrom-Json
    } else {
        $obsidianConfig = [PSCustomObject]@{ vaults = [PSCustomObject]@{} }
    }
    if (-not $obsidianConfig.vaults) {
        $obsidianConfig | Add-Member -MemberType NoteProperty -Name vaults -Value ([PSCustomObject]@{}) -Force
    }

    $alreadyRegistered = $false
    foreach ($entry in $obsidianConfig.vaults.PSObject.Properties) {
        if ($entry.Value.path -eq $VAULT_PATH) {
            $alreadyRegistered = $true
            break
        }
    }

    if (-not $alreadyRegistered) {
        $vaultId = [Guid]::NewGuid().ToString('N').Substring(0, 16)
        $vaultEntry = [PSCustomObject]@{
            path = $VAULT_PATH
            ts = [int64](([DateTimeOffset](Get-Date)).ToUnixTimeMilliseconds())
        }
        $obsidianConfig.vaults | Add-Member -MemberType NoteProperty -Name $vaultId -Value $vaultEntry
        $json = $obsidianConfig | ConvertTo-Json -Depth 6 -Compress
        [System.IO.File]::WriteAllText($obsidianConfigPath, $json, $utf8NoBom)
        Ok "Vault registered with Obsidian."
    } else {
        Ok "Vault already registered with Obsidian."
    }
} catch {
    Write-Host "    $RED" "!$R Couldn't register the vault automatically: $_"
    Write-Host "      You may need to click 'Open folder as vault' in Obsidian and pick $VAULT_PATH."
}

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
