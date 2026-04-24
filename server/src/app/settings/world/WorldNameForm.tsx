'use client';

import { useRef, useState } from 'react';

export function WorldNameForm({
  worldId,
  initialName,
  csrfToken,
}: {
  worldId: string;
  initialName: string;
  csrfToken: string;
}): React.JSX.Element {
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || pending) return;
    if (clean === initialName) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ name: clean }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Reload so the sidebar reflects the new name
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
          World name
        </span>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          className="w-full max-w-sm rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
        />
      </label>
      {error && <p className="text-xs text-[var(--wine)]">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="rounded-[6px] bg-[var(--ink)] px-4 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {saved && (
          <span className="text-xs text-[var(--moss)]">Saved</span>
        )}
      </div>
    </form>
  );
}
