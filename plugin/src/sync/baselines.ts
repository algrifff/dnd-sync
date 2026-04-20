// Per-path "baseline" hashes — the SHA-256 of the content the plugin last
// observed as in-sync with the server. Used by reconcileAfterSync to
// distinguish three outcomes when local and server differ at reconnect:
//
//   * baseline matches server  → local changed offline; push it up
//   * baseline matches local   → server changed; pull it down
//   * baseline matches neither → true conflict; CRDT-merge with a marker
//
// Persisted through the plugin's settings (data.json) so baselines survive
// restarts.

export class BaselineStore {
  constructor(
    private readonly read: () => Record<string, string>,
    private readonly persist: () => Promise<void>,
  ) {}

  get(path: string): string | null {
    return this.read()[path] ?? null;
  }

  async set(path: string, hash: string): Promise<void> {
    const map = this.read();
    if (map[path] === hash) return;
    map[path] = hash;
    await this.persist();
  }

  async delete(path: string): Promise<void> {
    const map = this.read();
    if (!(path in map)) return;
    delete map[path];
    await this.persist();
  }
}
