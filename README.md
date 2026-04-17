# The Compendium — Sync Setup

Live-synced Obsidian vault for D&D notes. Powered by Syncthing + Railway.

> 🧪 **Testing a replacement backend on this branch.** See [`LIVESYNC_BETA.md`](LIVESYNC_BETA.md) for CouchDB + Obsidian LiveSync setup and the speed-test protocol. Everything below still describes the main-branch Syncthing flow.

---

## How it works

```
Your machine ──► Railway (always-on hub) ◄── Friends' machines
```

Syncthing runs silently in the background on everyone's machine and syncs through Railway. Changes appear on all machines within seconds. Railway stays up even when your machine is off, so friends can sync any time.

---

## For friends — Getting started (LiveSync / CouchDB branch)

You'll need **four things** from your DM before you start:
1. **CouchDB URL** — looks like `https://xxx.up.railway.app`
2. **Username**
3. **Password**
4. **Database name** — usually `vault`

Then follow the steps for your OS below. The installer greets you with a dragon, installs Obsidian, drops the LiveSync plugin into your vault, and opens Obsidian.

### 🍎 Mac

1. Open **Terminal** (`Cmd+Space` → type `Terminal` → Enter)
2. Paste this and hit Enter:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/setup-livesync-mac.sh | bash
   ```
3. Type in the four values when asked

### 🐧 Linux

1. Open a terminal
2. Paste this and hit Enter:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/algrifff/dnd-sync/livesync-couchdb/scripts/setup-livesync-linux.sh | bash
   ```
3. Type in the four values when asked

### 🪟 Windows

Not wired up on this branch yet — Windows friends should hold off until we merge, or use WSL for now.

---

### After setup (in Obsidian)

One-time:
1. **Settings → Community plugins → Turn on community plugins**
2. Enable **Self-hosted LiveSync** in the list
3. LiveSync tab → **Fetch everything from remote** (first sync pulls the vault down)
4. Toggle **LiveSync mode** on — watch the 🔄 indicator appear in the status bar

After that, every save syncs to everyone else within a second or two.

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