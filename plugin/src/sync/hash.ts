// SHA-256 of UTF-8 text as lower-case hex. Used to record a per-path
// "baseline" — the content we last observed as in-sync with the server —
// so reconnect can distinguish offline local edits from stale local state.

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const out = new Array<string>(32);
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) {
    const byte = view[i] ?? 0;
    out[i] = byte.toString(16).padStart(2, '0');
  }
  return out.join('');
}
