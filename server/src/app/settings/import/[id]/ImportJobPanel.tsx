'use client';

// Full per-row review table for an import job, plus the Smart Import
// orchestration overlay.
//
// Two distinct flows share this component:
//
//  1. Manual review — Analyse → per-row accept/reject → Apply
//  2. Smart Import  — multi-pass AI orchestrator, possibly pausing to
//     ask the DM questions via a blocking full-screen chat overlay.
//
// The `liveJob` state is initialised from the server-rendered prop and
// kept up-to-date by a 2-second polling loop whenever the job is in an
// orchestrating state. The chat overlay resolves answers by POSTing to
// /api/import/:id/answer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS, track } from '@/lib/analytics/client';
import posthog from '@/lib/posthog-web';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles, Send } from 'lucide-react';
import type { ImportJob, ImportStatus } from '@/lib/imports';
import type { ImportPlan } from '@/lib/import-parse';
import type { AnalyseStats, PlannedNote } from '@/lib/import-analyse';
import type { ImportClassifyResult } from '@/lib/ai/skills/types';

type Kind = ImportClassifyResult['kind'];
type Role = NonNullable<ImportClassifyResult['role']>;

// Defined locally to avoid importing a server module in a client component.
type OrchestrationPhase = 'assets' | 'campaign' | 'entities' | 'quality' | 'done';
type OrchestrationMsg = { role: 'assistant' | 'user'; content: string; timestamp: number };
type OrchestrationState = {
  phase: OrchestrationPhase;
  assetMap: Record<string, string>;
  entityMap: Record<string, string>;
  campaignSlug: string | null;
  conversationHistory: OrchestrationMsg[];
  summary: string | null;
  phaseLog: Array<{ phase: string; completedAt: number; count?: number }>;
};

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

const PHASE_STEPS: Array<{ label: string; phase: OrchestrationPhase }> = [
  { label: 'Assets',   phase: 'assets' },
  { label: 'Campaign', phase: 'campaign' },
  { label: 'Entities', phase: 'entities' },
  { label: 'Quality',  phase: 'quality' },
];

function isOrchestratingStatus(s: ImportStatus): boolean {
  return (
    s === 'orchestrating_assets' ||
    s === 'orchestrating_campaign' ||
    s === 'orchestrating_entities' ||
    s === 'orchestrating_quality' ||
    s === 'waiting_for_answer'
  );
}

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

  // ── Live job state (kept fresh via polling when orchestrating) ────────

  const [liveJob, setLiveJob] = useState<ImportJob>(job);
  const orch = (liveJob.plan as { orchestration?: OrchestrationState } | null)
    ?.orchestration;
  const orchestrating = isOrchestratingStatus(liveJob.status);
  const orchestrationDone = liveJob.status === 'applied' && !!orch;

  // Fire once per panel mount so the funnel shows how many users
  // reach the review screen vs. abandon earlier in the pipeline.
  useEffect(() => {
    track(EVENTS.IMPORT_REVIEW_VIEWED, {
      job_id: job.id,
      status: job.status,
      row_count: plannedNotes?.length ?? 0,
    });
  }, [job.id, job.status, plannedNotes]);

  useEffect(() => {
    if (!orchestrating) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/import/${encodeURIComponent(job.id)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { job?: ImportJob };
        if (data.job) {
          setLiveJob(data.job);
          // Stop polling once terminal.
          if (
            data.job.status === 'applied' ||
            data.job.status === 'cancelled' ||
            data.job.status === 'failed'
          ) {
            clearInterval(id);
          }
        }
      } catch { /* ignore network blips */ }
    }, 2000);
    return () => clearInterval(id);
  }, [orchestrating, job.id]);

  // Warn on page refresh / navigation while orchestrating.
  useEffect(() => {
    if (!orchestrating) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [orchestrating]);

  // ── Derived state (uses liveJob so polling updates feed through) ──────

  const disabledState =
    orchestrating ||
    liveJob.status === 'applied' ||
    liveJob.status === 'cancelled' ||
    liveJob.status === 'failed';

  const applyable = liveJob.status === 'ready' || liveJob.status === 'uploaded';

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

  // ── Actions: Apply / Cancel / Smart Import ────────────────────────────

  const apply = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFlash(null);
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
      posthog.capture('import_job_cancelled', { job_id: job.id, job_status: liveJob.status });
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

  const [smartBusy, setSmartBusy] = useState(false);
  const smartImport = async (): Promise<void> => {
    if (smartBusy) return;
    setSmartBusy(true);
    setFlash(null);
    try {
      const res = await fetch(
        `/api/import/${encodeURIComponent(job.id)}/orchestrate`,
        { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } },
      );
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reason?: string };
      if (!res.ok) {
        setFlash({ kind: 'error', message: body.reason ?? body.error ?? `failed (${res.status})` });
        return;
      }
      posthog.capture('import_smart_import_started', { job_id: job.id });
      // Fetch updated status to trigger polling.
      const statusRes = await fetch(`/api/import/${encodeURIComponent(job.id)}`);
      if (statusRes.ok) {
        const data = (await statusRes.json()) as { job?: ImportJob };
        if (data.job) setLiveJob(data.job);
      }
    } catch (err) {
      setFlash({ kind: 'error', message: err instanceof Error ? err.message : 'network error' });
    } finally {
      setSmartBusy(false);
    }
  };

  // ── Chat answer ───────────────────────────────────────────────────────

  const [answerText, setAnswerText] = useState('');
  const [sendingAnswer, setSendingAnswer] = useState(false);

  const sendAnswer = async (): Promise<void> => {
    const content = answerText.trim();
    if (!content || sendingAnswer) return;
    setSendingAnswer(true);
    // Optimistic local append so the UI feels responsive.
    setLiveJob((prev) => {
      const prevPlan = prev.plan as { orchestration?: OrchestrationState } | null;
      if (!prevPlan?.orchestration) return prev;
      return {
        ...prev,
        plan: {
          ...prevPlan,
          orchestration: {
            ...prevPlan.orchestration,
            conversationHistory: [
              ...prevPlan.orchestration.conversationHistory,
              { role: 'user' as const, content, timestamp: Date.now() },
            ],
          },
        },
      };
    });
    setAnswerText('');
    try {
      const res = await fetch(
        `/api/import/${encodeURIComponent(job.id)}/answer`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ content }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        setFlash({ kind: 'error', message: body.reason ?? body.error ?? `send failed (${res.status})` });
      }
    } catch (err) {
      setFlash({ kind: 'error', message: err instanceof Error ? err.message : 'network error' });
    } finally {
      setSendingAnswer(false);
    }
  };

  // ── Derived counts ────────────────────────────────────────────────────

  const counts = useMemo(() => {
    let accepted = 0;
    for (const r of rows) {
      if (r.accepted) accepted++;
    }
    return { accepted, total: rows.length };
  }, [rows]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <StatsBar job={liveJob} stats={stats} plan={plan} acceptedCount={counts.accepted} />

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

      {/* Orchestration summary card — shown after Smart Import completes */}
      {orchestrationDone && orch?.summary && (
        <div className="rounded-[10px] border border-[#7B8A5F]/40 bg-[#7B8A5F]/10 px-4 py-3 text-sm text-[#2A241E]">
          <div className="mb-1 flex items-center gap-2 font-medium">
            <Sparkles size={13} className="text-[#7B8A5F]" />
            Smart Import complete
          </div>
          <p className="text-xs text-[#5A4F42]">{orch.summary}</p>
        </div>
      )}

      {/* Manual review controls — hidden when orchestrating */}
      {!disabledState && !orchestrating && (
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
              disabled={busy || liveJob.status === 'applied'}
              className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[#8B4A52] transition hover:bg-[#8B4A52]/10 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={smartImport}
              disabled={smartBusy || !applyable}
              className="flex items-center gap-1.5 rounded-[8px] border border-[#D4A85A]/60 bg-[#D4A85A]/10 px-3 py-1.5 text-xs font-medium text-[#2A241E] transition hover:bg-[#D4A85A]/20 disabled:opacity-50"
            >
              {smartBusy
                ? <Loader2 size={11} className="animate-spin" />
                : <Sparkles size={11} />}
              Smart Import
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

      {/* Manual review table — hidden when orchestrating */}
      {!orchestrating && !orchestrationDone && (
        rows.length === 0 ? (
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
        )
      )}

      <footer className="flex items-center justify-between text-xs text-[#5A4F42]">
        <span>
          status: <span className="font-medium text-[#2A241E]">{liveJob.status}</span>
        </span>
        <Link href="/" className="text-[#5A4F42] hover:text-[#2A241E] hover:underline">
          Back to home
        </Link>
      </footer>

      {/* Full-screen orchestration overlay — rendered above everything */}
      {(orchestrating || (orchestrationDone && orch?.conversationHistory && orch.conversationHistory.length > 0)) && orch && (
        <OrchestrationOverlay
          status={liveJob.status}
          orch={orch}
          answerText={answerText}
          onAnswerChange={setAnswerText}
          onSendAnswer={sendAnswer}
          sendingAnswer={sendingAnswer}
          onCancel={cancel}
          cancelDisabled={busy}
        />
      )}
    </div>
  );
}

// ── Orchestration overlay ──────────────────────────────────────────────

const PHASE_ORDER: OrchestrationPhase[] = ['assets', 'campaign', 'entities', 'quality', 'done'];

function OrchestrationOverlay({
  status,
  orch,
  answerText,
  onAnswerChange,
  onSendAnswer,
  sendingAnswer,
  onCancel,
  cancelDisabled,
}: {
  status: ImportStatus;
  orch: OrchestrationState;
  answerText: string;
  onAnswerChange: (v: string) => void;
  onSendAnswer: () => void;
  sendingAnswer: boolean;
  onCancel: () => void;
  cancelDisabled: boolean;
}): React.JSX.Element {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isWaiting = status === 'waiting_for_answer';
  const isDone = status === 'applied';

  // Scroll to latest message.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [orch.conversationHistory.length]);

  // Focus input when question appears.
  useEffect(() => {
    if (isWaiting) inputRef.current?.focus();
  }, [isWaiting]);

  const activePhaseIdx = PHASE_ORDER.indexOf(orch.phase);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendAnswer();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/60 backdrop-blur-sm">
      <div className="flex h-[90vh] w-full max-w-xl flex-col rounded-[14px] border border-[#D4C7AE] bg-[#F4EDE0] shadow-2xl mx-4">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#D4C7AE] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-[#D4A85A]" />
            <span className="text-sm font-semibold text-[#2A241E]">
              {isDone ? 'Smart Import complete' : isWaiting ? 'Your input needed' : 'Smart Import running…'}
            </span>
          </div>
          {!isDone && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelDisabled}
              className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium text-[#8B4A52] transition hover:bg-[#8B4A52]/10 disabled:opacity-40"
            >
              Cancel import
            </button>
          )}
        </div>

        {/* Phase step bar */}
        <div className="flex items-center gap-0 border-b border-[#D4C7AE]/60 px-5 py-2.5">
          {PHASE_STEPS.map((step, i) => {
            const stepIdx = PHASE_ORDER.indexOf(step.phase);
            const done = activePhaseIdx > stepIdx;
            const active = activePhaseIdx === stepIdx && !isDone;
            return (
              <div key={step.phase} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={
                      'h-2 w-2 rounded-full transition-colors ' +
                      (done
                        ? 'bg-[#7B8A5F]'
                        : active
                          ? 'bg-[#D4A85A]'
                          : isDone
                            ? 'bg-[#7B8A5F]'
                            : 'bg-[#D4C7AE]')
                    }
                  />
                  <span
                    className={
                      'text-[10px] font-medium ' +
                      (active ? 'text-[#2A241E]' : 'text-[#8A7E6B]')
                    }
                  >
                    {step.label}
                  </span>
                  {active && !isDone && (
                    <Loader2 size={10} className="animate-spin text-[#D4A85A]" />
                  )}
                </div>
                {i < PHASE_STEPS.length - 1 && (
                  <div className="mx-2 h-px w-4 bg-[#D4C7AE]" />
                )}
              </div>
            );
          })}
        </div>

        {/* Conversation */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {orch.conversationHistory.length === 0 && (
            <p className="text-center text-xs text-[#8A7E6B]">
              Analysing your notes…
            </p>
          )}
          {orch.conversationHistory.map((msg, i) => (
            <ChatBubble key={i} msg={msg} />
          ))}
          {!isWaiting && !isDone && (
            <div className="flex items-center gap-2 text-xs text-[#8A7E6B]">
              <Loader2 size={11} className="animate-spin" />
              <span>Working…</span>
            </div>
          )}
          {isDone && orch.summary && (
            <div className="rounded-[8px] border border-[#7B8A5F]/40 bg-[#7B8A5F]/10 px-3 py-2 text-xs text-[#2A241E]">
              {orch.summary}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        {!isDone && (
          <div className="border-t border-[#D4C7AE] px-4 py-3">
            {isWaiting ? (
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={answerText}
                  onChange={(e) => onAnswerChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your answer… (Enter to send, Shift+Enter for new line)"
                  rows={2}
                  disabled={sendingAnswer}
                  className="flex-1 resize-none rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] px-3 py-2 text-xs text-[#2A241E] outline-none placeholder:text-[#8A7E6B] focus:border-[#D4A85A] disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={onSendAnswer}
                  disabled={sendingAnswer || !answerText.trim()}
                  className="shrink-0 rounded-[8px] bg-[#2A241E] p-2 text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-40"
                >
                  {sendingAnswer
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Send size={14} />}
                </button>
              </div>
            ) : (
              <p className="text-center text-[11px] text-[#8A7E6B]">
                Input will appear when a question needs your answer.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chat bubble ────────────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: OrchestrationMsg }): React.JSX.Element {
  const isAssistant = msg.role === 'assistant';
  // Render newlines; strip markdown bold markers for cleaner display.
  const lines = msg.content
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .split('\n');

  return (
    <div className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      <div
        className={
          'max-w-[85%] rounded-[10px] px-3 py-2 text-xs leading-relaxed ' +
          (isAssistant
            ? 'bg-[#EAE1CF] text-[#2A241E]'
            : 'bg-[#2A241E] text-[#F4EDE0]')
        }
      >
        {lines.map((line, i) => (
          <span key={i}>
            {line}
            {i < lines.length - 1 && <br />}
          </span>
        ))}
      </div>
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
