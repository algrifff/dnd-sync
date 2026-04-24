'use client';

// Modal for creating a new user-level character. Minimal v1: name +
// kind. Full sheet editing happens on /me/characters/[id] after the
// row is created.

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

type Kind = 'character' | 'person';

export function NewCharacterDialog({
  csrfToken,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string>('');
  const [kind, setKind] = useState<Kind>('character');
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/me/characters', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ name: clean, kind }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        character?: { id: string };
        error?: string;
        reason?: string;
      };
      if (!res.ok || !body.ok || !body.character) {
        setError(body.reason ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated(body.character.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--ink)]">New character</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
            Name
          </span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Thorn Windwhisper"
            maxLength={120}
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
            Kind
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          >
            <option value="character">Character (PC)</option>
            <option value="person">Person (NPC-style)</option>
          </select>
        </label>
        <p className="mb-3 text-[11px] text-[var(--ink-soft)]">
          User-level characters live outside any world. Bring them into a
          campaign from that world&rsquo;s party panel.
        </p>
        {error && <p className="mb-3 text-xs text-[var(--wine)]">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] transition hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--ink-soft)] disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
