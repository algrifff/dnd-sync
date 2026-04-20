// Syncs the parts of `.obsidian/` that are "the shared vault setup":
// the list of enabled plugins, their bundles, themes, and CSS snippets.
//
// Obsidian doesn't emit vault events for files under `.obsidian/`, so this
// is a small polling reconciler. Every poll:
//   1. Scan local files matching an allowlist; compute their SHA-256.
//   2. Fetch the server inventory (which includes content_hash).
//   3. Push local → server for paths the server doesn't have or where
//      bytes differ AND local is newer.
//   4. Pull server → local for paths we don't have or where bytes differ
//      AND server is newer.
//   5. Matching hashes are a no-op regardless of timestamps. That breaks
//      the previous mtime-based ping-pong where every PULL bumped local
//      mtime, making the next poll push the same bytes back.
//
// We exclude our own plugin's folder (the auto-updater owns main.js /
// manifest.json; data.json contains the friend's token).

import type { App } from 'obsidian';
import { fetchInventory, getBinary, putBinary, type HttpConfig } from './http';

const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 15_000;
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

const INCLUDE_PATTERNS: readonly RegExp[] = [
  /^\.obsidian\/community-plugins\.json$/,
  /^\.obsidian\/core-plugins\.json$/,
  /^\.obsidian\/snippets\/[^/]+\.css$/,
  /^\.obsidian\/themes\/.+/,
  /^\.obsidian\/plugins\/[^/]+\/(main\.js|manifest\.json|styles\.css)$/,
];

const EXCLUDE_PATTERNS: readonly RegExp[] = [/^\.obsidian\/plugins\/compendium\//];

function shouldSync(path: string): boolean {
  for (const re of EXCLUDE_PATTERNS) if (re.test(path)) return false;
  for (const re of INCLUDE_PATTERNS) if (re.test(path)) return true;
  return false;
}

function mimeForPath(path: string): string {
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

/** Sort so community-plugins.json lands last — by the time Obsidian
 *  re-reads the enable list, every referenced plugin has its bytes. */
function pullOrder(path: string): number {
  if (path.endsWith('community-plugins.json')) return 2;
  if (path.endsWith('core-plugins.json')) return 2;
  return 1;
}

type LocalFile = { hash: string; mtime: number; bytes: ArrayBuffer };
type RemoteFile = { updatedAt: number; contentHash: string };

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class VaultConfigSync {
  private running = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly app: App,
    private readonly cfg: HttpConfig,
  ) {}

  start(): void {
    this.timeoutId = setTimeout(() => void this.reconcile(), INITIAL_DELAY_MS);
    this.intervalId = setInterval(() => void this.reconcile(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    if (this.intervalId) clearInterval(this.intervalId);
    this.timeoutId = null;
    this.intervalId = null;
  }

  // ── Core loop ──────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [local, remote] = await Promise.all([this.scanLocal(), this.scanRemote()]);
      const pulls = this.pathsToPull(local, remote).sort((a, b) => pullOrder(a) - pullOrder(b));
      const pushes = this.pathsToPush(local, remote);
      for (const p of pulls) await this.pull(p);
      for (const p of pushes) await this.push(p);
    } catch (err) {
      console.error('[compendium] vault-config reconcile failed', err);
    } finally {
      this.running = false;
    }
  }

  private pathsToPull(
    local: Map<string, LocalFile>,
    remote: Map<string, RemoteFile>,
  ): string[] {
    const pulls: string[] = [];
    for (const [path, rem] of remote) {
      const loc = local.get(path);
      if (!loc) {
        pulls.push(path);
        continue;
      }
      if (loc.hash === rem.contentHash) continue; // identical bytes → skip
      if (rem.updatedAt > loc.mtime + CLOCK_SKEW_TOLERANCE_MS) pulls.push(path);
    }
    return pulls;
  }

  private pathsToPush(
    local: Map<string, LocalFile>,
    remote: Map<string, RemoteFile>,
  ): string[] {
    const pushes: string[] = [];
    for (const [path, loc] of local) {
      const rem = remote.get(path);
      if (!rem) {
        pushes.push(path);
        continue;
      }
      if (loc.hash === rem.contentHash) continue; // identical bytes → skip
      if (loc.mtime > rem.updatedAt + CLOCK_SKEW_TOLERANCE_MS) pushes.push(path);
    }
    return pushes;
  }

  // ── I/O ────────────────────────────────────────────────────────────────

  private async scanLocal(): Promise<Map<string, LocalFile>> {
    const out = new Map<string, LocalFile>();
    await this.scanDir('.obsidian', out);
    return out;
  }

  private async scanDir(dir: string, out: Map<string, LocalFile>): Promise<void> {
    const listing = await this.tryList(dir);
    if (!listing) return;
    for (const filePath of listing.files) {
      if (!shouldSync(filePath)) continue;
      const file = await this.readLocalFile(filePath);
      if (file) out.set(filePath, file);
    }
    for (const sub of listing.folders) {
      await this.scanDir(sub, out);
    }
  }

  private async readLocalFile(path: string): Promise<LocalFile | null> {
    const stat = await this.tryStat(path);
    if (!stat) return null;
    let bytes: ArrayBuffer;
    try {
      bytes = await this.app.vault.adapter.readBinary(path);
    } catch {
      return null;
    }
    const hash = await sha256Hex(bytes);
    return { hash, mtime: stat.mtime, bytes };
  }

  private async scanRemote(): Promise<Map<string, RemoteFile>> {
    const inventory = await fetchInventory(this.cfg);
    const out = new Map<string, RemoteFile>();
    for (const entry of inventory.binaryFiles) {
      if (!shouldSync(entry.path)) continue;
      out.set(entry.path, {
        updatedAt: entry.updatedAt,
        contentHash: entry.contentHash,
      });
    }
    return out;
  }

  private async pull(path: string): Promise<void> {
    try {
      const data = await getBinary(this.cfg, path);
      if (!data) return;
      await this.ensureParent(path);
      await this.app.vault.adapter.writeBinary(path, data);
    } catch (err) {
      console.error('[compendium] vault-config pull failed', path, err);
    }
  }

  private async push(path: string): Promise<void> {
    try {
      const bytes = await this.app.vault.adapter.readBinary(path);
      await putBinary(this.cfg, path, bytes, mimeForPath(path));
    } catch (err) {
      console.error('[compendium] vault-config push failed', path, err);
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return;
    const dir = path.slice(0, lastSlash);
    const exists = await this.app.vault.adapter.exists(dir);
    if (!exists) await this.app.vault.adapter.mkdir(dir);
  }

  private async tryList(
    dir: string,
  ): Promise<{ files: string[]; folders: string[] } | null> {
    try {
      return await this.app.vault.adapter.list(dir);
    } catch {
      return null;
    }
  }

  private async tryStat(path: string): Promise<{ mtime: number; size: number } | null> {
    try {
      const s = await this.app.vault.adapter.stat(path);
      return s ? { mtime: s.mtime, size: s.size } : null;
    } catch {
      return null;
    }
  }
}
