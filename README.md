# The Compendium — Sync Setup

Syncs the Obsidian vault across all players via Syncthing + Railway.

---

## One-time deployment (vault owner only)

### Step 1 — Deploy to Railway

1. Go to [railway.app](https://railway.app) and create a new project
2. Choose **Deploy from GitHub repo** (or upload this folder directly)
3. Add a **Volume** to the service, mounted at `/var/syncthing`
4. Set these **environment variables** in Railway:
   ```
   STGUIAPIKEY = choose-a-strong-random-key-here
   STNORESTART = yes
   STNODEFAULTFOLDER = yes
   ```
   (The API key is your own — make it random like `zx7q9mK2pLwFbR3n`. Write it down.)
5. Set the **exposed port** to `8384`
6. Deploy — wait for it to go green

### Step 2 — Initialize the vault folder on Railway

Once deployed, run this from your machine (Linux/Mac):
```bash
chmod +x init-railway.sh
./init-railway.sh https://your-app.up.railway.app YOUR_STGUIAPIKEY
```

This will print out three values you'll need in the next step.

### Step 3 — Connect your local machine

Fill in the values printed by `init-railway.sh` at the top of `setup-owner.sh`, then run it:
```bash
chmod +x setup-owner.sh
./setup-owner.sh
```

Your local vault will begin uploading to Railway. First sync may take a few minutes.

### Step 4 — Update friend scripts

Fill in `RAILWAY_URL`, `RAILWAY_API_KEY`, and `RAILWAY_DEVICE_ID` at the top of:
- `scripts/setup-windows.ps1`
- `scripts/setup-mac.sh`
- `scripts/setup-linux.sh`

Then send the correct script to each friend.

---

## Sending scripts to friends

| Platform | Script to send | How they run it |
|----------|---------------|----------------|
| Windows  | `setup-windows.ps1` | Right-click → Run with PowerShell |
| Mac      | `setup-mac.sh` | Open Terminal, type `bash ` then drag the file in, press Enter |
| Linux    | `setup-linux.sh` | `bash setup-linux.sh` in a terminal |

---

## Vault location on friend machines

| Platform | Default path |
|----------|-------------|
| Windows  | `C:\Users\<name>\Documents\The-Compendium` |
| Mac      | `~/Documents/The-Compendium` |
| Linux    | `~/Documents/The-Compendium` |

Friends open Obsidian and select that folder as their vault on first launch.

---

## How sync works

```
Your machine ──► Railway (always on) ◄── Friends
```

- Syncthing runs silently in the background on everyone's machine
- Changes sync within seconds when everyone is online
- Railway acts as the hub — sync works even when your machine is off
- If two people edit the same file simultaneously, Syncthing creates a `.sync-conflict` copy
  so no data is lost — just manually merge the two versions

---

## Troubleshooting

**"Syncthing didn't start"** — reboot and run the script again.

**Files aren't syncing** — check that Syncthing is running (Windows: check Task Manager;
Mac/Linux: `pgrep syncthing`). Restart it with `syncthing --no-browser`.

**Friend's device isn't showing up** — check Railway logs; manually add their device ID
via the Railway Syncthing web UI at `https://your-app.up.railway.app`.

**Railway Syncthing web UI** — accessible at your Railway URL with the API key as password.
