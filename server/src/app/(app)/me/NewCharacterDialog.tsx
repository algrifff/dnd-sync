'use client';

// Modal for creating a new user-level character. Two paths:
//  - Manual: name + kind → empty sheet, edit on /me/characters/[id].
//  - PDF: drop a D&D 5e sheet PDF; AI extracts and pre-populates the
//    new character. Reuses the same pdfImport pipeline as the editor's
//    Import PDF button, but creates the row in one shot.

import { useEffect, useRef, useState } from 'react';
import { Check, FileUp, Loader2, X } from 'lucide-react';

type Kind = 'character' | 'person';

type ProgressLine =
  | { kind: 'stage'; label: string; done: boolean }
  | { kind: 'field'; label: string; value: string };

const STAGE_LABEL: Record<string, string> = {
  reading_text: 'Reading PDF text',
  extracting: 'Extracting character data (this can take 20–30s)',
  building: 'Building sheet',
  saving: 'Saving character',
};

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
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string>('');
  const [kind, setKind] = useState<Kind>('character');
  const [pending, setPending] = useState<boolean>(false);
  const [importing, setImporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || pending || importing) return;
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

  const onPickPdf = (): void => {
    if (importing || pending) return;
    setError(null);
    fileRef.current?.click();
  };

  const markStageDone = (): void => {
    setProgress((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const line = next[i];
        if (line && line.kind === 'stage' && !line.done) {
          next[i] = { ...line, done: true };
          break;
        }
      }
      return next;
    });
  };

  const onPdfFile = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setError(null);
    setProgress([]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/me/characters/import-pdf', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: fd,
      });
      // Non-streaming error path: server replied with a single JSON envelope
      // before the stream started (e.g. CSRF, auth, 503 ai_unavailable).
      const ct = res.headers.get('content-type') ?? '';
      if (!res.body || !ct.includes('ndjson')) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        setError(body.reason ?? body.error ?? `HTTP ${res.status}`);
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let createdId: string | null = null;
      let streamErr: string | null = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
          if (!line) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof evt.stage === 'string') {
            const label = STAGE_LABEL[evt.stage] ?? evt.stage;
            markStageDone();
            setProgress((p) => [...p, { kind: 'stage', label, done: false }]);
          } else if (typeof evt.field === 'string' && typeof evt.value === 'string') {
            const field = evt.field;
            const value = evt.value;
            setProgress((p) => [...p, { kind: 'field', label: field, value }]);
          } else if (
            evt.result &&
            typeof evt.result === 'object' &&
            typeof (evt.result as { id?: unknown }).id === 'string'
          ) {
            createdId = (evt.result as { id: string }).id;
            markStageDone();
          } else if (typeof evt.error === 'string') {
            streamErr =
              (typeof evt.reason === 'string' ? evt.reason : null) ?? evt.error;
          }
        }
      }
      if (streamErr) {
        setError(streamErr);
        return;
      }
      if (createdId) {
        onCreated(createdId);
      } else {
        setError('import ended without a result');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import failed');
    } finally {
      setImporting(false);
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
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => void onPdfFile(e)}
        />
        <button
          type="button"
          onClick={onPickPdf}
          disabled={importing || pending}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--candlelight)]/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {importing ? (
            <Loader2 size={12} className="animate-spin" aria-hidden />
          ) : (
            <FileUp size={12} aria-hidden />
          )}
          {importing ? 'Importing…' : 'Import from PDF'}
        </button>
        {(importing || progress.length > 0) && (
          <ul
            className="mb-3 max-h-56 overflow-y-auto rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] p-2 text-[11px] text-[var(--ink-soft)]"
            aria-live="polite"
          >
            {progress.map((line, i) =>
              line.kind === 'stage' ? (
                <li key={i} className="flex items-center gap-1.5 py-0.5">
                  {line.done ? (
                    <Check
                      size={11}
                      className="shrink-0 text-[var(--moss)]"
                      aria-hidden
                    />
                  ) : (
                    <Loader2
                      size={11}
                      className="shrink-0 animate-spin text-[var(--ink-muted)]"
                      aria-hidden
                    />
                  )}
                  <span className={line.done ? '' : 'text-[var(--ink)]'}>
                    {line.label}
                  </span>
                </li>
              ) : (
                <li key={i} className="flex gap-1.5 py-0.5 pl-[18px]">
                  <span className="text-[var(--ink-muted)]">{line.label}:</span>
                  <span className="font-medium text-[var(--ink)]">{line.value}</span>
                </li>
              ),
            )}
          </ul>
        )}
        <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
          <span className="h-px flex-1 bg-[var(--rule)]" />
          or create blank
          <span className="h-px flex-1 bg-[var(--rule)]" />
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
            disabled={pending || importing || !name.trim()}
            className="rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--ink-soft)] disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
