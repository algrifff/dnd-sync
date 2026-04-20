'use client';

// Home-page chat — the primary ingress for AI-assisted imports.
//
// Accepts a ZIP via drag-and-drop or file-picker, posts it to
// /api/import, kicks the analyse worker, and polls for progress.
// Shows each phase as a chat message: upload, parsing summary, live
// progress bar + running cost, the proposed plan, and (once the
// apply path lands in 1e) the apply summary.
//
// Text-input is scaffolded but only echoes a polite stub reply today.
// The shape is in place so free-form vault commands can plug into the
// same thread later.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  Package,
  Send,
  Sparkles,
  UploadCloud,
} from 'lucide-react';
import type { ImportJob } from '@/lib/imports';
import type { ImportPlan } from '@/lib/import-parse';
import type {
  AnalyseStats,
  PlannedNote,
} from '@/lib/import-analyse';

// ── Types ──────────────────────────────────────────────────────────────

type ChatMessage =
  | { id: string; role: 'user'; kind: 'text'; body: string }
  | {
      id: string;
      role: 'user';
      kind: 'upload';
      filename: string;
      size: number;
    }
  | { id: string; role: 'assistant'; kind: 'text'; body: string }
  | {
      id: string;
      role: 'assistant';
      kind: 'parsed';
      jobId: string;
      totals: ImportPlan['totals'];
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'progress';
      jobId: string;
      stats: AnalyseStats;
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'plan';
      jobId: string;
      summary: PlanSummary;
    }
  | {
      id: string;
      role: 'assistant';
      kind: 'applied';
      jobId: string;
      text: string;
    };

type PlanSummary = {
  characters: { pcs: number; npcs: number; allies: number; villains: number };
  sessions: number;
  locations: number;
  items: number;
  lore: number;
  plain: number;
  conflicts: number;
  unclassified: number;
  totals: ImportPlan['totals'];
  costUsd: number;
};

// ── Component ──────────────────────────────────────────────────────────

export function HomeChat({
  csrfToken,
  canImport,
  initialOpenJobs,
}: {
  csrfToken: string;
  canImport: boolean;
  initialOpenJobs: ImportJob[];
}): React.JSX.Element {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial greeting + auto-resume any in-flight imports so the DM
  // picks up right where they left off when they refresh / navigate
  // back to the home page mid-job.
  useEffect(() => {
    const boot: ChatMessage = {
      id: 'boot',
      role: 'assistant',
      kind: 'text',
      body: canImport
        ? "Drop a zip of notes or a vault export and I'll organize it — classify every file, move it into the right folder, and link everything up. Check the plan before I apply."
        : 'Your account doesn\u2019t have import rights. Ask a DM to upload new content.',
    };
    const hydrated: ChatMessage[] = [boot];

    // Prefer the most recently updated open job to drive live polling
    // in the thread; surface older ones as quiet "resume" banners via
    // the existing resumable-jobs section above the chat.
    const sorted = [...initialOpenJobs].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const primary = sorted.find(
      (j) => j.status === 'analysing' || j.status === 'ready',
    );

    if (primary) {
      const plan = primary.plan as ImportPlan | null;
      const stats = primary.stats as AnalyseStats | null;
      hydrated.push({
        id: `resume:${primary.id}`,
        role: 'user',
        kind: 'upload',
        filename: 'earlier import',
        size: plan?.totals.totalBytes ?? 0,
      });
      hydrated.push({
        id: `parsed:${primary.id}`,
        role: 'assistant',
        kind: 'parsed',
        jobId: primary.id,
        totals: plan?.totals ?? {
          noteCount: 0,
          assetCount: 0,
          skippedCount: 0,
          totalBytes: 0,
        },
      });
      if (primary.status === 'analysing' && stats) {
        hydrated.push({
          id: `progress:${primary.id}`,
          role: 'assistant',
          kind: 'progress',
          jobId: primary.id,
          stats,
        });
      }
      if (
        primary.status === 'ready' &&
        plan &&
        (plan as ImportPlan & { plannedNotes?: PlannedNote[] }).plannedNotes
      ) {
        hydrated.push({
          id: `plan:${primary.id}`,
          role: 'assistant',
          kind: 'plan',
          jobId: primary.id,
          summary: summarise(
            plan as ImportPlan & { plannedNotes?: PlannedNote[] },
            stats,
          ),
        });
      }
      // Only drive polling when the job's still moving; ready plans
      // stay static until the DM clicks Accept all.
      if (primary.status === 'analysing') {
        setActiveJobId(primary.id);
      }
    }

    setMessages(hydrated);
    // Intentional single run on mount — we want the initial snapshot
    // of open jobs, not live refetches.
  }, [canImport, initialOpenJobs]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  // Poll the active job every 1.5s while it's running.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/import/${encodeURIComponent(activeJobId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { job: ImportJob };
        if (cancelled) return;
        applyJobPoll(body.job);
        if (
          body.job.status === 'ready' ||
          body.job.status === 'applied' ||
          body.job.status === 'failed' ||
          body.job.status === 'cancelled'
        ) {
          setActiveJobId(null);
        }
      } catch {
        /* swallow; next tick will retry */
      }
    };
    void tick();
    const handle = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [activeJobId]);

  const applyJobPoll = useCallback((job: ImportJob) => {
    setMessages((prev) => {
      let next = prev.slice();
      const stats = job.stats as AnalyseStats | null;
      const plan = job.plan as (ImportPlan & { plannedNotes?: PlannedNote[] }) | null;

      if (stats && job.status === 'analysing') {
        const existing = next.find(
          (m) => m.kind === 'progress' && m.jobId === job.id,
        );
        if (existing && existing.kind === 'progress') {
          existing.stats = stats;
        } else {
          next.push({
            id: `progress:${job.id}`,
            role: 'assistant',
            kind: 'progress',
            jobId: job.id,
            stats,
          });
        }
      }

      if (job.status === 'ready' && plan && plan.plannedNotes) {
        // Drop the progress row once ready.
        next = next.filter(
          (m) => !(m.kind === 'progress' && m.jobId === job.id),
        );
        const summary = summarise(plan, stats);
        const existing = next.find(
          (m) => m.kind === 'plan' && m.jobId === job.id,
        );
        if (!existing) {
          next.push({
            id: `plan:${job.id}`,
            role: 'assistant',
            kind: 'plan',
            jobId: job.id,
            summary,
          });
        }
      }

      if (job.status === 'failed') {
        next.push({
          id: `failed:${job.id}:${Date.now()}`,
          role: 'assistant',
          kind: 'text',
          body: `Job failed: ${(stats as { fatalError?: string } | null)?.fatalError ?? 'unknown error'}`,
        });
      }
      if (job.status === 'cancelled') {
        next.push({
          id: `cancelled:${job.id}:${Date.now()}`,
          role: 'assistant',
          kind: 'text',
          body: 'Import cancelled.',
        });
      }

      return next;
    });
  }, []);

  // ── Upload flow ──────────────────────────────────────────────────────

  const uploadFile = useCallback(
    async (file: File): Promise<void> => {
      if (!canImport) return;
      // User "upload" message in the thread.
      setMessages((prev) => [
        ...prev,
        {
          id: `upload:${Date.now()}`,
          role: 'user',
          kind: 'upload',
          filename: file.name,
          size: file.size,
        },
      ]);

      // Upload + parse (synchronous on the server).
      const form = new FormData();
      form.append('file', file);
      let uploadedJob: ImportJob | null = null;
      try {
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
          body: form,
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          job?: ImportJob;
          error?: string;
          message?: string;
        };
        if (!res.ok || !body.ok || !body.job) {
          setMessages((prev) => [
            ...prev,
            assistantText(
              body.error === 'forbidden'
                ? "You don't have import rights in this world."
                : body.message ??
                    body.error ??
                    `Upload failed (HTTP ${res.status})`,
            ),
          ]);
          return;
        }
        uploadedJob = body.job;
        const plan = uploadedJob.plan as ImportPlan | null;
        setMessages((prev) => [
          ...prev,
          {
            id: `parsed:${uploadedJob!.id}`,
            role: 'assistant',
            kind: 'parsed',
            jobId: uploadedJob!.id,
            totals: plan?.totals ?? {
              noteCount: 0,
              assetCount: 0,
              skippedCount: 0,
              totalBytes: 0,
            },
          },
        ]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          assistantText(err instanceof Error ? err.message : 'network error'),
        ]);
        return;
      }

      // Kick the async AI pass.
      try {
        const res = await fetch(
          `/api/import/${encodeURIComponent(uploadedJob.id)}/analyse`,
          {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
          },
        );
        if (res.status === 503) {
          setMessages((prev) => [
            ...prev,
            assistantText(
              "OpenAI isn't configured on this server — set OPENAI_API_KEY to enable classification. Your file is saved; open the full review to apply it as-is.",
            ),
          ]);
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setMessages((prev) => [
            ...prev,
            assistantText(
              body.error
                ? `Analyse failed: ${body.error}`
                : `Analyse failed (HTTP ${res.status})`,
            ),
          ]);
          return;
        }
        setActiveJobId(uploadedJob.id);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          assistantText(err instanceof Error ? err.message : 'network error'),
        ]);
      }
    },
    [canImport, csrfToken],
  );

  // Drag-and-drop on the whole chat surface.
  const onDropFiles = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (!canImport) return;
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        /\.zip$/i.test(f.name),
      );
      if (files.length === 0) {
        setMessages((prev) => [
          ...prev,
          assistantText('Only `.zip` drops are supported for now.'),
        ]);
        return;
      }
      void uploadFile(files[0]!);
    },
    [canImport, uploadFile],
  );

  // ── Plan actions ─────────────────────────────────────────────────────

  const acceptAll = useCallback(
    async (jobId: string): Promise<void> => {
      try {
        const res = await fetch(
          `/api/import/${encodeURIComponent(jobId)}/apply`,
          {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          moved?: number;
          merged?: number;
          failed?: number;
        };
        if (res.status === 501 || res.status === 404) {
          setMessages((prev) => [
            ...prev,
            assistantText(
              'Apply isn\u2019t wired yet — the classification is ready but the server-side commit lands in the next phase. Use "Open full review" to inspect in the meantime.',
            ),
          ]);
          return;
        }
        if (!res.ok || !body.ok) {
          setMessages((prev) => [
            ...prev,
            assistantText(
              body.error ?? `Apply failed (HTTP ${res.status})`,
            ),
          ]);
          return;
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `applied:${jobId}:${Date.now()}`,
            role: 'assistant',
            kind: 'applied',
            jobId,
            text: `Applied ${body.moved ?? 0} moves · ${body.merged ?? 0} merges${body.failed ? ` · ${body.failed} failed` : ''}`,
          },
        ]);
        router.refresh();
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          assistantText(err instanceof Error ? err.message : 'network error'),
        ]);
      }
    },
    [csrfToken, router],
  );

  const cancelJob = useCallback(
    async (jobId: string): Promise<void> => {
      try {
        await fetch(`/api/import/${encodeURIComponent(jobId)}`, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': csrfToken },
        });
      } catch {
        /* ignore; polling will pick up terminal status */
      }
    },
    [csrfToken],
  );

  // Resumable-jobs banner — surfaces in-flight imports from a prior
  // session so the DM can jump back in.
  const resumable = initialOpenJobs.filter(
    (j) => j.status === 'analysing' || j.status === 'ready',
  );

  return (
    <section
      className={
        'relative flex flex-col rounded-[14px] border border-[#D4C7AE] bg-[#FBF5E8] transition ' +
        (dragging ? 'ring-2 ring-[#D4A85A]' : '')
      }
      onDragOver={(e) => {
        if (!canImport) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={onDropFiles}
    >
      <header className="flex items-center gap-2 border-b border-[#D4C7AE] px-4 py-2">
        <Sparkles size={14} className="text-[#D4A85A]" aria-hidden />
        <h2 className="text-sm font-semibold text-[#2A241E]">
          Compendium assistant
        </h2>
        <span className="ml-auto text-[11px] text-[#5A4F42]">
          drop a .zip to import
        </span>
      </header>

      {resumable.length > 0 && (
        <div className="border-b border-[#D4C7AE] bg-[#F4EDE0] px-4 py-2 text-xs text-[#5A4F42]">
          {resumable.map((j) => (
            <div key={j.id} className="flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              <span>Import in progress from an earlier session.</span>
              <Link
                href={`/settings/import/${j.id}`}
                className="ml-auto font-medium text-[#2A241E] hover:underline"
              >
                Open
              </Link>
            </div>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        className="max-h-[420px] min-h-[240px] flex-1 overflow-y-auto px-4 py-3"
      >
        <ol className="space-y-2">
          {messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              onAcceptAll={acceptAll}
              onCancel={cancelJob}
            />
          ))}
        </ol>
      </div>

      <footer className="flex items-center gap-2 border-t border-[#D4C7AE] px-3 py-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canImport}
          title="Upload a zip"
          aria-label="Upload a zip"
          className="rounded-[8px] p-2 text-[#5A4F42] transition hover:bg-[#F4EDE0] hover:text-[#2A241E] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <UploadCloud size={16} aria-hidden />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
            e.currentTarget.value = '';
          }}
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="drop a .zip or describe what you want"
          disabled={!canImport}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              const body = draft.trim();
              setDraft('');
              setMessages((prev) => [
                ...prev,
                { id: `user:${Date.now()}`, role: 'user', kind: 'text', body },
                assistantText(
                  "I can import zips and folders today — free-text vault commands are on the roadmap. Drop a .zip to start, or ask me to clarify anything about the assistant.",
                ),
              ]);
            }
          }}
          className="flex-1 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A] disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => {
            if (!draft.trim()) return;
            // Same path as Enter key.
            const body = draft.trim();
            setDraft('');
            setMessages((prev) => [
              ...prev,
              { id: `user:${Date.now()}`, role: 'user', kind: 'text', body },
              assistantText(
                "I can import zips and folders today — free-text vault commands are on the roadmap.",
              ),
            ]);
          }}
          disabled={!canImport || !draft.trim()}
          className="rounded-[8px] bg-[#2A241E] p-2 text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
          aria-label="Send"
        >
          <Send size={14} aria-hidden />
        </button>
      </footer>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[14px] bg-[#D4A85A]/10">
          <span className="rounded-[10px] border border-dashed border-[#D4A85A] bg-[#FBF5E8] px-3 py-1.5 text-sm font-medium text-[#2A241E]">
            Drop to upload
          </span>
        </div>
      )}
    </section>
  );
}

// ── Message rendering ──────────────────────────────────────────────────

function MessageRow({
  message: m,
  onAcceptAll,
  onCancel,
}: {
  message: ChatMessage;
  onAcceptAll: (jobId: string) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
}): React.JSX.Element {
  if (m.role === 'user') {
    if (m.kind === 'upload') {
      return (
        <li className="flex justify-end">
          <div className="flex items-center gap-2 rounded-[10px] bg-[#2A241E] px-3 py-1.5 text-xs text-[#F4EDE0]">
            <Package size={12} aria-hidden />
            <span className="truncate">{m.filename}</span>
            <span className="text-[#F4EDE0]/60">{fmtBytes(m.size)}</span>
          </div>
        </li>
      );
    }
    return (
      <li className="flex justify-end">
        <div className="max-w-[75%] rounded-[10px] bg-[#2A241E] px-3 py-1.5 text-sm text-[#F4EDE0]">
          {m.body}
        </div>
      </li>
    );
  }
  // Assistant messages.
  if (m.kind === 'text') {
    return (
      <li className="flex">
        <div className="max-w-[85%] rounded-[10px] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E]">
          {m.body}
        </div>
      </li>
    );
  }
  if (m.kind === 'parsed') {
    return (
      <li className="flex">
        <div className="max-w-[85%] rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-sm text-[#2A241E]">
          Parsed your zip: {m.totals.noteCount} note
          {m.totals.noteCount === 1 ? '' : 's'}, {m.totals.assetCount} asset
          {m.totals.assetCount === 1 ? '' : 's'}
          {m.totals.skippedCount > 0
            ? `, ${m.totals.skippedCount} skipped`
            : ''}
          . Running the classifier…
        </div>
      </li>
    );
  }
  if (m.kind === 'progress') {
    const { done, total, callCount, inputTokens, outputTokens, reasoningTokens, costUsd, capHit } = m.stats;
    const tokens = inputTokens + outputTokens + reasoningTokens;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
      <li className="flex">
        <div className="max-w-[85%] w-full rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-sm text-[#2A241E]">
          <div className="mb-1 flex items-center gap-2 text-xs text-[#5A4F42]">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            <span>
              {done} / {total} · {callCount} calls · {tokens.toLocaleString()} tok · ${costUsd.toFixed(3)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#D4C7AE]">
            <div
              className="h-full bg-[#D4A85A] transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          {capHit && (
            <div className="mt-1 text-[11px] text-[#8B4A52]">
              Hit the per-job cap — remaining notes will ship as unclassified.
            </div>
          )}
        </div>
      </li>
    );
  }
  if (m.kind === 'plan') {
    return (
      <li className="flex">
        <div className="max-w-[90%] w-full rounded-[10px] bg-[#F4EDE0] px-3 py-2 text-sm text-[#2A241E]">
          <div className="mb-2">Here&rsquo;s what I&rsquo;d do:</div>
          <ul className="mb-2 space-y-0.5 text-xs text-[#5A4F42]">
            <PlanLine
              label="Characters"
              value={`${m.summary.characters.pcs + m.summary.characters.npcs + m.summary.characters.allies + m.summary.characters.villains}`}
              detail={detailCharacters(m.summary.characters)}
            />
            {m.summary.sessions > 0 && (
              <PlanLine label="Sessions" value={m.summary.sessions} />
            )}
            {m.summary.locations > 0 && (
              <PlanLine label="Locations" value={m.summary.locations} />
            )}
            {m.summary.items > 0 && (
              <PlanLine label="Items" value={m.summary.items} />
            )}
            {m.summary.lore > 0 && (
              <PlanLine label="Lore" value={m.summary.lore} />
            )}
            {m.summary.plain > 0 && (
              <PlanLine label="Plain notes" value={m.summary.plain} />
            )}
            {m.summary.conflicts > 0 && (
              <PlanLine
                label="Will merge"
                value={m.summary.conflicts}
                detail="existing notes at the proposed paths"
                warn
              />
            )}
            {m.summary.unclassified > 0 && (
              <PlanLine
                label="Unclassified"
                value={m.summary.unclassified}
                detail="will stay in place"
                warn
              />
            )}
            <PlanLine
              label="Total cost"
              value={`$${m.summary.costUsd.toFixed(3)}`}
            />
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onAcceptAll(m.jobId)}
              className="rounded-[6px] bg-[#2A241E] px-3 py-1 text-xs font-medium text-[#F4EDE0] transition hover:bg-[#3A342E]"
            >
              Accept all
            </button>
            <Link
              href={`/settings/import/${m.jobId}`}
              className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF]"
            >
              Open full review
            </Link>
            <button
              type="button"
              onClick={() => void onCancel(m.jobId)}
              className="rounded-[6px] px-3 py-1 text-xs font-medium text-[#8B4A52] transition hover:bg-[#8B4A52]/10"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }
  if (m.kind === 'applied') {
    return (
      <li className="flex">
        <div className="max-w-[85%] rounded-[10px] bg-[#7B8A5F]/15 px-3 py-2 text-sm text-[#2A241E]">
          ✓ {m.text}
        </div>
      </li>
    );
  }
  return <li />;
}

function PlanLine({
  label,
  value,
  detail,
  warn,
}: {
  label: string;
  value: string | number;
  detail?: string;
  warn?: boolean;
}): React.JSX.Element {
  return (
    <li className="flex items-baseline gap-2">
      <span className="text-[#5A4F42]">{label}</span>
      <span className={warn ? 'text-[#8B4A52]' : 'text-[#2A241E]'}>
        {value}
      </span>
      {detail && <span className="text-[#5A4F42]/80">· {detail}</span>}
    </li>
  );
}

function detailCharacters(c: PlanSummary['characters']): string {
  const parts: string[] = [];
  if (c.pcs) parts.push(`${c.pcs} PC`);
  if (c.npcs) parts.push(`${c.npcs} NPC`);
  if (c.allies) parts.push(`${c.allies} ally`);
  if (c.villains) parts.push(`${c.villains} villain`);
  return parts.join(' · ');
}

// ── Helpers ────────────────────────────────────────────────────────────

function assistantText(body: string): ChatMessage {
  return {
    id: `assistant:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    kind: 'text',
    body,
  };
}

function summarise(
  plan: ImportPlan & { plannedNotes?: PlannedNote[] },
  stats: AnalyseStats | null,
): PlanSummary {
  const chars = { pcs: 0, npcs: 0, allies: 0, villains: 0 };
  let sessions = 0;
  let locations = 0;
  let items = 0;
  let lore = 0;
  let plain = 0;
  const conflicts = 0;
  let unclassified = 0;
  for (const n of plan.plannedNotes ?? []) {
    if (n.analyseStatus === 'unclassified' || n.analyseStatus === 'failed') {
      unclassified++;
      continue;
    }
    const c = n.classification;
    if (!c) {
      plain++;
      continue;
    }
    switch (c.kind) {
      case 'character':
        if (c.role === 'pc') chars.pcs++;
        else if (c.role === 'ally') chars.allies++;
        else if (c.role === 'villain') chars.villains++;
        else chars.npcs++;
        break;
      case 'session':
        sessions++;
        break;
      case 'location':
        locations++;
        break;
      case 'item':
        items++;
        break;
      case 'lore':
        lore++;
        break;
      default:
        plain++;
    }
    // Conflicts are detected on apply; for now we can't know from
    // the plan alone, so leave at 0 and let the review page surface
    // them. The shape is in place for 1e to populate.
  }
  return {
    characters: chars,
    sessions,
    locations,
    items,
    lore,
    plain,
    conflicts,
    unclassified,
    totals: plan.totals,
    costUsd: stats?.costUsd ?? 0,
  };
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Silence TS for a parameter we otherwise don't need but that is
// used exclusively via the tagged-union narrowing above.
export type { ChatMessage };
