'use client';

// Modal dialog that lets a world owner (GM) assign a PC note to a world
// member. Fetches the member list from GET /api/worlds/[id]/members, then
// POSTs to /api/notes/assign-player on confirm.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, UserRound, X } from 'lucide-react';

type Member = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

export function TransferCharacterDialog({
  notePath,
  groupId,
  csrfToken,
  onClose,
  onTransferred,
}: {
  notePath: string;
  groupId: string;
  csrfToken: string;
  onClose: () => void;
  onTransferred: () => void;
}): React.JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/worlds/${encodeURIComponent(groupId)}/members`, {
      credentials: 'same-origin',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { members: Member[] };
        if (alive) setMembers(data.members ?? []);
      })
      .catch((err: unknown) => {
        if (alive)
          setError(err instanceof Error ? err.message : 'Failed to load members');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [groupId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/notes/assign-player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ path: notePath, targetUserId: selectedId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        reason?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.reason ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      onTransferred();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setSubmitting(false);
    }
  }, [csrfToken, notePath, selectedId, onTransferred]);

  const charName = notePath.includes('/')
    ? notePath.slice(notePath.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    : notePath;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-[0_16px_48px_rgb(var(--ink-rgb)/0.3)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3">
          <div className="min-w-0">
            <h3
              id="transfer-dialog-title"
              className="text-sm font-semibold text-[var(--ink)]"
            >
              Transfer character
            </h3>
            <p
              className="mt-0.5 truncate text-xs text-[var(--ink-soft)]"
              title={notePath}
            >
              {charName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        {/* Member list */}
        <div className="max-h-72 overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--ink-soft)]">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Loading members…
            </div>
          ) : members.length === 0 ? (
            <p className="py-6 text-center text-xs text-[var(--ink-soft)]">
              No members found.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5" role="listbox" aria-label="Select player">
              {members.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedId === m.id}
                    onClick={() => setSelectedId(m.id)}
                    className={
                      'flex w-full items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-sm transition ' +
                      (selectedId === m.id
                        ? 'bg-[var(--candlelight)]/30 text-[var(--ink)]'
                        : 'text-[var(--ink-soft)] hover:bg-[var(--candlelight)]/15 hover:text-[var(--ink)]')
                    }
                  >
                    <UserRound size={14} className="shrink-0 text-[var(--ink-muted)]" aria-hidden />
                    <span className="font-medium">{m.displayName}</span>
                    <span className="text-xs text-[var(--ink-muted)]">@{m.username}</span>
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-[var(--ink-muted)]">
                      {m.role}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="border-t border-[var(--rule)] bg-[rgb(var(--wine-rgb)/0.08)] px-4 py-2 text-xs text-[var(--wine)]">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--rule)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!selectedId || submitting}
            className="flex items-center gap-1.5 rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:opacity-80 disabled:opacity-35"
          >
            {submitting && <Loader2 size={12} className="animate-spin" aria-hidden />}
            Transfer
          </button>
        </div>
      </div>
    </div>
  );
}
