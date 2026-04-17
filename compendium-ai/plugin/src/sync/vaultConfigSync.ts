// Syncs the parts of `.obsidian/` that are "the shared vault setup":
// the list of enabled plugins, their bundles, themes, and CSS snippets.
//
// Obsidian doesn't emit vault events for files under `.obsidian/` (they
// aren't TFiles), so this is a small polling reconciler. Every poll:
//   1. Scan local files under .obsidian/ that match an allowlist.
//   2. Fetch the server inventory.
//   3. For each path in either set, pick the newer side (mtime vs
//      updated_at) and push/pull the delta.
//
// We deliberately EXCLUDE our own plugin's folder (the auto-updater owns
// main.js / manifest.json and data.json contains the friend's token).

import type { App } from 'obsidian';
import { fetchInventory, getBinary, putBinary, type HttpConfig } from './http';

const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 15_000;
/** Treat timestamps within this window as "same" to avoid ping-ponging. */
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

const INCLUDE_PATTERNS: readonly RegExp[] = [
  /^\.obsidian\/community-plugins\.json$/,
  /^\.obsidian\/core-plugins\.json$/,
  /^\.obsidian\/snippets\/[^/]+\.css$/,
  /^\.obsidian\/themes\/.+/,
  /^\.obsidian\/plugins\/[^/]+\/(main\.js|manifest\.json|styles\.css)$/,
];

const EXCLUDE_PATTERNS: readonly RegExp[] = [
  /^\.obsidian\/plugins\/compendium\//,
];

function shouldSync(path: string): boolean {
  for (const re of EXCLUDE_PATTERNS) if (re.test(path)) return false;
  for (const re of INCLUDE_PATTERNS) if (re.test(path)) return true;
  return false;
}

function guessMime(path: string): string {
  if (path.endsWith('.js')) return 'application/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

/** Sort paths so that "enable" manifests are applied last — by the time
 *  Obsidian re-reads community-plugins.json, every plugin it references
 *  already has its bytes on disk. */
function writeOrderScore(path: string): number {
  if (path.endsWith('community-plugins.json')) return 2;
  if (path.endsWith('core-plugins.json')) return 2;
  return 1;
}

type LocalStat = { mtime: number; size: number };

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
    if (this.running) return; // skip overlapping ticks
    this.running = true;
    try {
      const [local, remote] = await Promise.all([this.scanLocal(), this.scanRemote()]);
      const pulls = this.pathsToPull(local, remote).sort(
        (a, b) => writeOrderScore(a) - writeOrderScore(b),
      );
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
    local: Map<string, LocalStat>,
    remote: Map<string, { updatedAt: number }>,
  ): string[] {
    const pulls: string[] = [];
    for (const [path, info] of remote) {
      const loc = local.get(path);
      if (!loc || info.updatedAt > loc.mtime + CLOCK_SKEW_TOLERANCE_MS) {
        pulls.push(path);
      }
    }
    return pulls;
  }

  private pathsToPush(
    local: Map<string, LocalStat>,
    remote: Map<string, { updatedAt: number }>,
  ): string[] {
    const pushes: string[] = [];
    for (const [path, info] of local) {
      const rem = remote.get(path);
      if (!rem || info.mtime > rem.updatedAt + CLOCK_SKEW_TOLERANCE_MS) {
        pushes.push(path);
      }
    }
    return pushes;
  }

  // ── I/O ────────────────────────────────────────────────────────────────

  private async scanLocal(): Promise<Map<string, LocalStat>> {
    const out = new Map<string, LocalStat>();
    await this.scanDir('.obsidian', out);
    return out;
  }

  private async scanDir(dir: string, out: Map<string, LocalStat>): Promise<void> {
    const listing = await this.tryList(dir);
    if (!listing) return;
    for (const filePath of listing.files) {
      if (!shouldSync(filePath)) continue;
      const stat = await this.tryStat(filePath);
      if (stat) out.set(filePath, { mtime: stat.mtime, size: stat.size });
    }
    for (const sub of listing.folders) {
      await this.scanDir(sub, out);
    }
  }

  private async scanRemote(): Promise<Map<string, { updatedAt: number }>> {
    const inventory = await fetchInventory(this.cfg);
    const out = new Map<string, { updatedAt: number }>();
    for (const entry of inventory.binaryFiles) {
      if (shouldSync(entry.path)) out.set(entry.path, { updatedAt: entry.updatedAt });
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
      await putBinary(this.cfg, path, bytes, guessMime(path));
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

  // adapter.list / stat throw when the target doesn't exist; swallow for
  // optional paths so a fresh vault doesn't noisy-log missing .obsidian/snippets.

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
      if (!s) return null;
      return { mtime: s.mtime, size: s.size };
    } catch {
      return null;
    }
  }
}
