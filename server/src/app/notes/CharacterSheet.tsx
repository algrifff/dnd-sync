'use client';

// CharacterSheet — rendered above the prose body on any note whose
// frontmatter declares `kind: character`. The form shape comes from
// the template registered for the note's role (pc / npc / ally /
// villain); values live in frontmatter.sheet and sync to the server
// via PATCH /api/notes/sheet on blur.
//
// Editability is a mix of role + ownership + per-field
// playerEditable. The server applies the same rules and drops any
// unauthorised field writes, so the client is allowed to be a bit
// optimistic here.
//
// Real-time collab for HP / conditions and the like: every local
// change broadcasts the new value on the note's existing hocuspocus
// awareness channel so peers currently viewing the same note get
// an instant visual update, before the PATCH round-trip. Server
// persistence remains authoritative — a refresh shows exactly what
// the server accepted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type {
  NoteTemplate,
  TemplateField,
  TemplateSchema,
} from '@/lib/templates';

export type SheetValues = Record<string, unknown>;

export function CharacterSheet({
  path,
  csrfToken,
  template,
  initialSheet,
  canWriteAll,
  provider,
}: {
  path: string;
  csrfToken: string;
  template: NoteTemplate;
  initialSheet: SheetValues;
  canWriteAll: boolean;
  /** Note's collab provider — used only for awareness broadcasts so
   *  peers see sheet edits before PATCH. All persistence still
   *  flows through /api/notes/sheet. */
  provider: HocuspocusProvider;
}): React.JSX.Element {
  const [sheet, setSheet] = useState<SheetValues>(initialSheet);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);

  const playerEditable = useMemo(
    () => collectPlayerEditable(template.schema),
    [template],
  );

  const fieldEditable = useCallback(
    (field: TemplateField): boolean => {
      if (canWriteAll) return true;
      return !!field.playerEditable;
    },
    [canWriteAll],
  );

  // Coalesce rapid edits into one PATCH; multiple fields may change
  // in a burst (pressing Tab through the ability scores, etc.).
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<Record<string, unknown>>({});

  const commit = useCallback(
    (fieldId: string, value: unknown) => {
      setSheet((prev) => ({ ...prev, [fieldId]: value }));
      pendingPatchRef.current[fieldId] = value;
      setPending((p) => ({ ...p, [fieldId]: true }));
      // Broadcast over awareness so peers' sheets update instantly.
      // Writes are keyed by a monotonic counter so hocuspocus's
      // awareness diff sees every consecutive change (same payload
      // shape twice in a row gets deduped otherwise).
      const aw = provider.awareness;
      if (aw) {
        const seq = Date.now();
        aw.setLocalStateField('sheetEdit', {
          path,
          seq,
          fields: { [fieldId]: value },
        });
      }
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        void flush();
      }, 400);
    },
    // flush is stable — deliberately omitted to avoid re-registering
    // the timer on every render.
    [path, provider],
  );

  // Listen for peer sheet edits on the same note and merge into
  // local state. We ignore our own client's awareness entry so the
  // local commit path doesn't bounce back through the observer.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    const seen = new Map<number, number>(); // clientId → last seen seq
    const onChange = (): void => {
      for (const [clientId, state] of aw.getStates().entries()) {
        if (clientId === aw.clientID) continue;
        const s = state as
          | {
              sheetEdit?: {
                path?: string;
                seq?: number;
                fields?: Record<string, unknown>;
              };
            }
          | undefined;
        const edit = s?.sheetEdit;
        if (!edit || edit.path !== path || typeof edit.seq !== 'number') {
          continue;
        }
        const last = seen.get(clientId);
        if (last === edit.seq) continue;
        seen.set(clientId, edit.seq);
        if (edit.fields && typeof edit.fields === 'object') {
          setSheet((prev) => ({ ...prev, ...edit.fields! }));
        }
      }
    };
    aw.on('change', onChange);
    return () => aw.off('change', onChange);
  }, [provider, path]);

  const flush = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      // Chain — don't fire concurrent requests.
      await savingRef.current;
    }
    const batch = pendingPatchRef.current;
    if (Object.keys(batch).length === 0) return;
    pendingPatchRef.current = {};
    const run = (async () => {
      try {
        const res = await fetch('/api/notes/sheet', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ path, sheet: batch }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sheet?: SheetValues;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !body.ok) {
          setFlash(body.detail ?? body.error ?? `save failed (${res.status})`);
          return;
        }
        if (body.sheet) setSheet(body.sheet);
        setFlash(null);
      } catch (err) {
        setFlash(err instanceof Error ? err.message : 'network error');
      } finally {
        setPending((p) => {
          const next = { ...p };
          for (const k of Object.keys(batch)) delete next[k];
          return next;
        });
      }
    })();
    savingRef.current = run;
    await run;
    savingRef.current = null;
  }, [csrfToken, path]);

  const savingAny = Object.keys(pending).length > 0;

  return (
    <section
      aria-label="Character sheet"
      className="mb-6 rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4"
    >
      <div
        className="mb-3 h-4 text-right text-xs text-[#5A4F42] transition-opacity"
        style={{ opacity: savingAny || flash ? 1 : 0 }}
        aria-live="polite"
      >
        {savingAny ? 'Saving…' : flash ? (
          <span className="text-[#8B4A52]">{flash}</span>
        ) : null}
      </div>

      <div className="space-y-4">
        {template.schema.sections.map((section) => (
          <section key={section.id}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
              {section.label}
            </h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {section.fields.map((field) => (
                <FieldControl
                  key={field.id}
                  field={field}
                  value={sheet[field.id]}
                  onCommit={(v) => commit(field.id, v)}
                  readOnly={!fieldEditable(field)}
                  isPlayerField={playerEditable.has(field.id) && !canWriteAll}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function collectPlayerEditable(schema: TemplateSchema): Set<string> {
  const out = new Set<string>();
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.playerEditable) out.add(field.id);
    }
  }
  return out;
}

function FieldControl({
  field,
  value,
  onCommit,
  readOnly,
  isPlayerField,
}: {
  field: TemplateField;
  value: unknown;
  onCommit: (v: unknown) => void;
  readOnly: boolean;
  isPlayerField: boolean;
}): React.JSX.Element {
  return (
    <label
      className={
        'flex flex-col gap-1 ' + (isPlayerField ? 'ring-offset-[#FBF5E8]' : '')
      }
    >
      <span className="text-[11px] font-medium text-[#5A4F42]">
        {field.label}
        {field.required && (
          <span aria-hidden className="ml-0.5 text-[#8B4A52]">*</span>
        )}
      </span>
      <FieldInput
        field={field}
        value={value}
        onCommit={onCommit}
        readOnly={readOnly}
      />
      {field.hint && (
        <span className="text-[10px] text-[#5A4F42]/80">{field.hint}</span>
      )}
    </label>
  );
}

function FieldInput({
  field,
  value,
  onCommit,
  readOnly,
}: {
  field: TemplateField;
  value: unknown;
  onCommit: (v: unknown) => void;
  readOnly: boolean;
}): React.JSX.Element {
  const base =
    'rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]';
  const ro = readOnly
    ? ' cursor-not-allowed bg-[#EAE1CF]/70 text-[#5A4F42]'
    : '';

  if (field.type === 'longtext') {
    const [local, setLocal] = useControlled(toStr(value) ?? '');
    return (
      <textarea
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onCommit(local)}
        readOnly={readOnly}
        rows={3}
        className={base + ro}
      />
    );
  }
  if (field.type === 'integer' || field.type === 'number') {
    const numeric = toNum(value);
    const [local, setLocal] = useControlled(numeric != null ? String(numeric) : '');
    return (
      <input
        type="number"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local === '') onCommit(null);
          else {
            const n = Number(local);
            if (Number.isFinite(n)) {
              let clamped = field.type === 'integer' ? Math.trunc(n) : n;
              if (field.min != null) clamped = Math.max(field.min, clamped);
              if (field.max != null) clamped = Math.min(field.max, clamped);
              onCommit(clamped);
            }
          }
        }}
        readOnly={readOnly}
        min={field.min}
        max={field.max}
        className={base + ro}
      />
    );
  }
  if (field.type === 'enum') {
    const current = toStr(value) ?? '';
    return (
      <select
        value={current}
        onChange={(e) => onCommit(e.target.value || null)}
        disabled={readOnly}
        className={base + ro}
      >
        <option value="">—</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onCommit(e.target.checked)}
        disabled={readOnly}
        className="h-4 w-4 self-start accent-[#2A241E]"
      />
    );
  }
  if (field.type === 'list<text>') {
    return <ListTextInput value={value} readOnly={readOnly} onCommit={onCommit} />;
  }
  // text (default)
  const [local, setLocal] = useControlled(toStr(value) ?? '');
  return (
    <input
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onCommit(local)}
      readOnly={readOnly}
      className={base + ro}
    />
  );
}

function ListTextInput({
  value,
  readOnly,
  onCommit,
}: {
  value: unknown;
  readOnly: boolean;
  onCommit: (v: string[]) => void;
}): React.JSX.Element {
  const items = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  const [draft, setDraft] = useState<string>('');
  const addItem = (): void => {
    const t = draft.trim();
    if (!t) return;
    onCommit([...items, t]);
    setDraft('');
  };
  const removeAt = (idx: number): void => {
    const next = items.slice();
    next.splice(idx, 1);
    onCommit(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-1.5 py-1">
      {items.map((item, idx) => (
        <span
          key={`${item}:${idx}`}
          className="inline-flex items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-0.5 text-[11px] text-[#2A241E]"
        >
          {item}
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => removeAt(idx)}
              className="text-[#5A4F42] hover:text-[#8B4A52]"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addItem();
            }
          }}
          onBlur={addItem}
          placeholder="add…"
          className="min-w-[60px] flex-1 bg-transparent text-[11px] text-[#2A241E] outline-none"
        />
      )}
    </div>
  );
}

/** Small helper for controlled inputs that resync when the upstream
 *  value changes (e.g. the server echo arrives). Separate from plain
 *  useState so onBlur-commit doesn't trip over a stale local state. */
function useControlled(initial: string): [string, (v: string) => void] {
  const [val, setVal] = useState<string>(initial);
  const lastInitial = useRef<string>(initial);
  if (lastInitial.current !== initial) {
    lastInitial.current = initial;
    setVal(initial);
  }
  return [val, setVal];
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  return null;
}
