'use client';

// Full per-row review table for an import job.
//
// One row per note in the plan, with inline controls for accept /
// reject + path + kind / role. Bulk actions on top (Accept all,
// reject-all-plain, invert). Apply button commits the edited plan;
// Cancel deletes the temp zip and flips the row. Edits are flushed
// to the server on blur / toggle via PATCH /api/import/:id so
// refreshing doesn't lose state.

import { useCallback, useMemo, useRef, useState } from 'react';
import posthog from '@/lib/posthog-web';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { ImportJob } from '@/lib/imports';
import type { ImportPlan } from '@/lib/import-parse';
import type {
  AnalyseStats,
  PlannedNote,
} from '@/lib/import-analyse';
import type { ImportClassifyResult } from '@/lib/ai/skills/types';

type Kind = ImportClassifyResult['kind'];
type Role = NonNullable<ImportClassifyResult['role']>;

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'character', label: 'Character' },
  { value: 'session', label: 'Session' },
  { value: 'location', label: 'Location' },
  { value: 'item', label: 'Item' },
  { value: 'lore', label: 'Lore' },
  { value: 'plain', label: 'Plain' },
];

const ROLES: Array<{ value: Role; label: string }> = [
  { value: 'pc', label: 'PC' },
  { value: 'npc', label: 'NPC' },
  { value: 'ally', label: 'Ally' },
  { value: 'villain', label: 'Villain' },
];

// ── Component ──────────────────────────────────────────────────────────

export function ImportJobPanel({
  job,
  plan,
  csrfToken,
}: {
  job: ImportJob;
  plan: ImportPlan | null;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const stats = job.stats as AnalyseStats | null;
  const plannedNotes =
    (plan as (ImportPlan & { plannedNotes?: PlannedNote[] }) | null)
      ?.plannedNotes ?? null;

  const [rows, setRows] = useState<PlannedNote[]>(() =>
    plannedNotes ? plannedNotes.slice() : [],
  );
  const [busy, setBusy] = useState<boolean>(false);
  const [flash, setFlash] = useState<{
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);

  const disabledState =
    job.status === 'applied' || job.status === 'cancelled' || job.status === 'failed';
  const applyable = job.status === 'ready' || job.status === 'uploaded';

  // ── PATCH flush (debounced) ──────────────────────────────────────────

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<
    Map<
      string,
      {
        id: string;
        accepted?: boolean;
        canonicalPath?: string;
        kind?: Kind;
        role?: Role | null;
      }
    >
  >(new Map());

  const flush = useCallback(async () => {
    if (pending.current.size === 0) return;
    const payload = { notes: [...pending.current.values()] };
    pending.current.clear();
    try {
      const res = await fetch(`/api/import/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setFlash({
          kind: 'error',
          message: body.error ?? `save failed (${res.status})`,
        });
      }
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    }
  }, [csrfToken, job.id]);

  const queue = useCallback(
    (
      rowId: string,
      patch: Partial<{
        accepted: boolean;
        canonicalPath: string;
        kind: Kind;
        role: Role | null;
      }>,
    ): void => {
      const current = pending.current.get(rowId) ?? { id: rowId };
      pending.current.set(rowId, { ...current, ...patch });
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        void flush();
      }, 500);
    },
    [flush],
  );

  // ── Row mutators ─────────────────────────────────────────────────────

  const mutate = useCallback(
    (rowId: string, fn: (r: PlannedNote) => PlannedNote): void => {
      setRows((prev) => prev.map((r) => (r.id === rowId ? fn(r) : r)));
    },
    [],
  );

  const setAccepted = (rowId: string, accepted: boolean): void => {
    mutate(rowId, (r) => ({ ...r, accepted }));
    queue(rowId, { accepted });
  };
  const setPath = (rowId: string, canonicalPath: string): void => {
    mutate(rowId, (r) =>
      r.classification
        ? { ...r, classification: { ...r.classification, canonicalPath } }
        : r,
    );
    queue(rowId, { canonicalPath });
  };
  const setKind = (rowId: string, kind: Kind): void => {
    mutate(rowId, (r) =>
      r.classification
        ? { ...r, classification: { ...r.classification, kind } }
        : r,
    );
    queue(rowId, { kind });
  };
  const setRole = (rowId: string, role: Role | null): void => {
    mutate(rowId, (r) =>
      r.classification
        ? { ...r, classification: { ...r.classification, role } }
        : r,
    );
    queue(rowId, { role });
  };

  // ── Bulk actions ─────────────────────────────────────────────────────

  const acceptAll = (): void => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.accepted) return r;
        pending.current.set(r.id, {
          ...(pending.current.get(r.id) ?? { id: r.id }),
          accepted: true,
        });
        return { ...r, accepted: true };
      }),
    );
    if (flushTimer.current) clearTimeout(flushTimer.current);
    void flush();
  };
  const rejectAll = (): void => {
    setRows((prev) =>
      prev.map((r) => {
        if (!r.accepted) return r;
        pending.current.set(r.id, {
          ...(pending.current.get(r.id) ?? { id: r.id }),
          accepted: false,
        });
        return { ...r, accepted: false };
      }),
    );
    if (flushTimer.current) clearTimeout(flushTimer.current);
    void flush();
  };
  const rejectPlain = (): void => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.classification?.kind !== 'plain') return r;
        if (!r.accepted) return r;
        pending.current.set(r.id, {
          ...(pending.current.get(r.id) ?? { id: r.id }),
          accepted: false,
        });
        return { ...r, accepted: false };
      }),
    );
    if (flushTimer.current) clearTimeout(flushTimer.current);
    void flush();
  };

  // ── Actions: Apply / Cancel ──────────────────────────────────────────

  const apply = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFlash(null);
    // Flush any in-flight edits first so the server sees the final
    // state before running.
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    await flush();
    try {
      const res = await fetch(
        `/api/import/${encodeURIComponent(job.id)}/apply`,
        {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        moved?: number;
        merged?: number;
        keptInPlace?: number;
        failed?: number;
        assetsCommitted?: number;
        error?: string;
        message?: string;
      };
      if (!res.ok || !body.ok) {
        setFlash({
          kind: 'error',
          message:
            body.message ?? body.error ?? `apply failed (${res.status})`,
        });
        return;
      }
      setFlash({
        kind: 'ok',
        message: `Applied — ${body.moved ?? 0} moved · ${body.merged ?? 0} merged · ${body.keptInPlace ?? 0} kept · ${body.assetsCommitted ?? 0} assets${
          body.failed ? ` · ${body.failed} failed` : ''
        }`,
      });
      posthog.capture('import_job_applied', {
        job_id: job.id,
        moved: body.moved ?? 0,
        merged: body.merged ?? 0,
        kept_in_place: body.keptInPlace ?? 0,
        assets_committed: body.assetsCommitted ?? 0,
        failed: body.failed ?? 0,
        accepted_count: counts.accepted,
        total_count: counts.total,
      });
      router.refresh();
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (busy) return;
    if (!confirm('Cancel this import job? The uploaded file will be deleted.')) return;
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch(`/api/import/${encodeURIComponent(job.id)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setFlash({
          kind: 'error',
          message: body.error ?? `cancel failed (${res.status})`,
        });
        return;
      }
      posthog.capture('import_job_cancelled', { job_id: job.id, job_status: job.status });
      router.refresh();
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setBusy(false);
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────

  const counts = useMemo(() => {
    let accepted = 0;
    for (const r of rows) {
      if (r.accepted) accepted++;
    }
    return { accepted, total: rows.length };
  }, [rows]);

  return (
    <div className="space-y-5">
      <StatsBar job={job} stats={stats} plan={plan} acceptedCount={counts.accepted} />

      {flash && (
        <div
          className={
            'rounded-[8px] px-3 py-2 text-xs ' +
            (flash.kind === 'ok'
              ? 'bg-[#7B8A5F]/15 text-[#2A241E]'
              : 'bg-[#8B4A52]/15 text-[#8B4A52]')
          }
        >
          {flash.message}
        </div>
      )}

      {!disabledState && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={acceptAll}
            disabled={busy}
            className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF] disabled:opacity-50"
          >
            Accept all
          </button>
          <button
            type="button"
            onClick={rejectPlain}
            disabled={busy}
            className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF] disabled:opacity-50"
          >
            Reject plain
          </button>
          <button
            type="button"
            onClick={rejectAll}
            disabled={busy}
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[#5A4F42] transition hover:text-[#2A241E] disabled:opacity-50"
          >
            Reject all
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={cancel}
              disabled={busy || job.status === 'applied'}
              className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[#8B4A52] transition hover:bg-[#8B4A52]/10 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={busy || !applyable || counts.accepted === 0}
              className="rounded-[8px] bg-[#2A241E] px-4 py-1.5 text-xs font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
            >
              {busy ? 'Applying…' : `Apply ${counts.accepted}`}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-[#5A4F42]">
          No planned notes on this job. {plan ? 'Wait for analyse to finish.' : 'Parse failed — cancel and re-upload.'}
        </p>
      ) : (
        <ul className="divide-y divide-[#D4C7AE]/50 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] text-sm">
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              disabled={disabledState}
              onToggle={(v) => setAccepted(r.id, v)}
              onPath={(v) => setPath(r.id, v)}
              onKind={(v) => setKind(r.id, v)}
              onRole={(v) => setRole(r.id, v)}
            />
          ))}
        </ul>
      )}

      <footer className="flex items-center justify-between text-xs text-[#5A4F42]">
        <span>
          status: <span className="font-medium text-[#2A241E]">{job.status}</span>
        </span>
        <Link href="/" className="text-[#5A4F42] hover:text-[#2A241E] hover:underline">
          Back to home
        </Link>
      </footer>
    </div>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────

function StatsBar({
  job,
  stats,
  plan,
  acceptedCount,
}: {
  job: ImportJob;
  stats: AnalyseStats | null;
  plan: ImportPlan | null;
  acceptedCount: number;
}): React.JSX.Element {
  const totalTokens = stats
    ? stats.inputTokens + stats.outputTokens + stats.reasoningTokens
    : 0;

  return (
    <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] p-3 text-xs md:grid-cols-5">
      <Stat label="Notes" value={plan?.totals.noteCount ?? 0} />
      <Stat label="Assets" value={plan?.totals.assetCount ?? 0} />
      <Stat label="Accepted" value={acceptedCount} />
      <Stat
        label="AI calls"
        value={stats ? `${stats.callCount} · ${totalTokens.toLocaleString()} tok` : '—'}
      />
      <Stat label="Spent" value={stats ? `$${stats.costUsd.toFixed(3)}` : '—'} />
      {job.status === 'analysing' && (
        <div className="col-span-full flex items-center gap-2 text-[#5A4F42]">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          <span>
            {stats?.done ?? 0} / {stats?.total ?? plan?.totals.noteCount ?? 0} done
          </span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[#5A4F42]">
        {label}
      </div>
      <div className="text-sm font-semibold text-[#2A241E]">{value}</div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────

function Row({
  row,
  disabled,
  onToggle,
  onPath,
  onKind,
  onRole,
}: {
  row: PlannedNote;
  disabled: boolean;
  onToggle: (accepted: boolean) => void;
  onPath: (value: string) => void;
  onKind: (value: Kind) => void;
  onRole: (value: Role | null) => void;
}): React.JSX.Element {
  const c = row.classification;
  const [pathDraft, setPathDraft] = useState<string>(c?.canonicalPath ?? row.sourcePath);

  // Re-sync when the server echoes a new path in — e.g. a bulk action
  // mutates it elsewhere.
  const lastUpstream = useRef<string>(c?.canonicalPath ?? row.sourcePath);
  const upstream = c?.canonicalPath ?? row.sourcePath;
  if (lastUpstream.current !== upstream) {
    lastUpstream.current = upstream;
    setPathDraft(upstream);
  }

  const confidenceColor =
    c && c.confidence >= 0.8
      ? 'text-[#7B8A5F]'
      : c && c.confidence >= 0.4
        ? 'text-[#D4A85A]'
        : 'text-[#8B4A52]';

  const tagsLabel =
    c?.tags && c.tags.length > 0
      ? c.tags.slice(0, 4).map((t) => `#${t}`).join(' ')
      : null;

  const linksCount = c?.wikilinks?.length ?? 0;
  const sheetFields = c?.sheet ? Object.keys(c.sheet).length : 0;

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={row.accepted}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
          className="h-4 w-4 shrink-0 accent-[#2A241E]"
        />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] text-[#5A4F42]">
            {row.sourcePath}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="text-[#5A4F42]">→</span>
            <input
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => {
                if (pathDraft !== upstream) onPath(pathDraft);
              }}
              disabled={disabled || !c}
              className="flex-1 rounded-[4px] border border-[#D4C7AE] bg-[#FBF5E8] px-1.5 py-0.5 font-mono text-[11px] text-[#2A241E] outline-none focus:border-[#D4A85A] disabled:cursor-not-allowed disabled:opacity-70"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {c && (
            <>
              <select
                value={c.kind}
                onChange={(e) => onKind(e.target.value as Kind)}
                disabled={disabled}
                className="rounded-[4px] border border-[#D4C7AE] bg-[#FBF5E8] px-1.5 py-0.5 text-[11px] text-[#2A241E]"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              {c.kind === 'character' && (
                <select
                  value={c.role ?? 'npc'}
                  onChange={(e) => onRole(e.target.value as Role)}
                  disabled={disabled}
                  className="rounded-[4px] border border-[#D4C7AE] bg-[#FBF5E8] px-1.5 py-0.5 text-[11px] text-[#2A241E]"
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              )}
              <span
                className={'text-[10px] ' + confidenceColor}
                title={`Model confidence: ${(c.confidence * 100).toFixed(0)}%`}
              >
                {(c.confidence * 100).toFixed(0)}%
              </span>
            </>
          )}
        </div>
      </div>

      {c && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-7 text-[10px] text-[#5A4F42]">
          {sheetFields > 0 && <span>sheet: {sheetFields} field{sheetFields === 1 ? '' : 's'}</span>}
          {tagsLabel && <span>{tagsLabel}</span>}
          {linksCount > 0 && <span>{linksCount} link{linksCount === 1 ? '' : 's'}</span>}
          {c.portraitImage && <span>📷 {c.portraitImage}</span>}
          {c.rationale && <span className="italic truncate max-w-[60%]">{c.rationale}</span>}
        </div>
      )}
      {!c && (
        <div className="mt-1 pl-7 text-[10px] text-[#8B4A52]">
          Not classified yet — run analyse or accept to keep in place.
        </div>
      )}
    </li>
  );
}
