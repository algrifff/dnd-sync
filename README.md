# The Compendium — Sync Setup

Live-synced Obsidian vault for D&D notes. Powered by Syncthing + Railway.

---

## How it works

```
Your machine ──► Railway (always-on hub) ◄── Friends' machines
```

Syncthing runs silently in the background on everyone's machine and syncs through Railway. Changes appear on all machines within seconds. Railway stays up even when your machine is off, so friends can sync any time.

---

## For friends — Getting started

**[⬇ Download the latest installer from the Releases page](../../releases/latest)**

| OS | Download | How to run |
|----|----------|-----------|
| Windows | `setup-windows.bat` | Double-click it |
| Mac | `setup-mac.command` | Double-click it (if blocked: right-click → Open) |
| Linux | `setup-linux.sh` | `bash setup-linux.sh` in a terminal |

Wait ~5 minutes for the initial sync, then open Obsidian and select your vault:
- **Windows:** `Documents\The-Compendium`
- **Mac / Linux:** `~/Documents/The-Compendium`

### After setup

- Syncthing runs in the background automatically — you don't need to do anything
- Every time you save a file in Obsidian it syncs within seconds
- Check sync status at any time: open a browser and go to `http://localhost:8384`

---

## For the vault owner — Initial deployment

### Prerequisites

- A [Railway](https://railway.app) account
- Git
- `bash`, `curl`, `python3` available (standard on Mac/Linux; use WSL on Windows)

### Step 1 — Deploy to Railway

1. Push this repo to GitHub (already done if you're reading this there)
2. In Railway: **New Project → Deploy from GitHub repo** → select this repo
3. Add a **Volume** to the service, mounted at `/var/syncthing`
4. Under **Variables**, add:
   ```
   STGUIAPIKEY   = <choose a strong random string, e.g. zx7q9mK2pLwFbR3n>
   STNORESTART   = yes
   STNODEFAULTFOLDER = yes
   ```
5. Under **Settings → Networking**, generate a public domain and set the port to `8384`
6. Deploy and wait for it to go green

### Step 2 — Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` and fill in `RAILWAY_URL` and `RAILWAY_API_KEY` (the `STGUIAPIKEY` value you chose).

### Step 3 — Initialise the vault folder on Railway

```bash
chmod +x init-railway.sh
./init-railway.sh
```

This creates the vault folder on Railway and prints your `RAILWAY_DEVICE_ID`. Add that to `.env`:

```
RAILWAY_DEVICE_ID = <printed by init-railway.sh>
```

### Step 4 — Connect your local machine

```bash
chmod +x setup-owner.sh
./setup-owner.sh
```

This starts Syncthing locally, connects it to Railway, and begins uploading your vault. The first sync may take several minutes depending on vault size.

### Step 5 — Prepare and share friend scripts

Fill in the three values at the top of each friend script:

```
RAILWAY_URL       = https://your-app.up.railway.app
RAILWAY_API_KEY   = your-stguiapikey
RAILWAY_DEVICE_ID = from-init-railway-output
```

These are in `scripts/setup-windows.ps1`, `scripts/setup-mac.sh`, and `scripts/setup-linux.sh`.

Send the right script to each friend. They run it once and are done.

---

## File locations after setup

| Platform | Vault path |
|----------|-----------|
| Windows  | `C:\Users\<name>\Documents\The-Compendium` |
| Mac      | `~/Documents/The-Compendium` |
| Linux    | `~/Documents/The-Compendium` |

---

## Troubleshooting

**Sync stopped / files not updating**
Check Syncthing is running: open `http://localhost:8384` in a browser. If it doesn't load, restart it:
- Windows: find `syncthing.exe` in `AppData\Local\Syncthing` and run it
- Mac: `brew services restart syncthing` or run `syncthing --no-browser`
- Linux: `systemctl --user restart syncthing`

**"Device not connected" in Syncthing UI**
Railway may have restarted. Wait a minute and it should reconnect automatically.

**Conflict files appearing (`.sync-conflict` in filename)**
Two people edited the same file at the same time. Open both versions, merge the changes manually, and delete the conflict copy.

**Script was blocked by Windows / Mac security**
- Windows: open PowerShell as Administrator and run `Set-ExecutionPolicy RemoteSigned`
- Mac: go to **System Settings → Privacy & Security** and click **Allow Anyway**

**A friend's device isn't syncing after running the script**
Their device ID may not have registered with Railway. Go to your Railway Syncthing UI at `https://your-app.up.railway.app`, find the pending device, and click **Add**.

---

## Railway costs

| Item | Cost |
|------|------|
| Syncthing compute | ~$5/mo (Railway hobby plan) |
| Persistent volume (per GB) | $0.25/GB/month |
| **Friends' machines** | **Free** |