'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2, X, Send, CheckCircle } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────

type OrchMsg = { role: 'assistant' | 'user'; content: string; timestamp: number };
type OrchState = {
  phase: string;
  currentActivity: string | null;
  conversationHistory: OrchMsg[];
  summary: string | null;
};
type LiveJob = {
  id: string;
  status: string;
  plan?: { orchestration?: OrchState };
};

type ModalPhase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'starting'; jobId: string }
  | { kind: 'running'; jobId: string; liveJob: LiveJob }
  | { kind: 'done'; jobId: string; summary: string | null };

const ORCHESTRATING = new Set([
  'orchestrating_assets',
  'orchestrating_campaign',
  'orchestrating_entities',
  'orchestrating_quality',
  'waiting_for_answer',
]);

const PHASE_STEPS = [
  { label: 'Assets',   statuses: ['orchestrating_assets'] },
  { label: 'Campaign', statuses: ['orchestrating_campaign'] },
  { label: 'Entities', statuses: ['orchestrating_entities'] },
  { label: 'Quality',  statuses: ['orchestrating_quality'] },
];

// ── Component ──────────────────────────────────────────────────────────

export function ImportLauncher({ csrfToken }: { csrfToken: string }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ModalPhase>({ kind: 'idle' });
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [sendingAnswer, setSendingAnswer] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setMounted(true); }, []);

  // ── Polling ────────────────────────────────────────────────────────

  const startPolling = (jobId: string): void => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/import/${encodeURIComponent(jobId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { job?: LiveJob };
        const job = data.job;
        if (!job) return;
        if (job.status === 'applied') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setPhase({ kind: 'done', jobId, summary: job.plan?.orchestration?.summary ?? null });
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setUploadError(`Import ${job.status}. You can resume it from the in-progress list.`);
          setPhase({ kind: 'idle' });
        } else {
          setPhase({ kind: 'running', jobId, liveJob: job });
        }
      } catch { /* ignore network blips */ }
    }, 1500);
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Scroll chat to bottom when new messages arrive.
  useEffect(() => {
    if (phase.kind === 'running') chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [
    phase.kind === 'running' ? phase.liveJob.plan?.orchestration?.conversationHistory.length : 0,
    phase.kind,
  ]);

  // Focus answer box when question is pending.
  useEffect(() => {
    if (phase.kind === 'running' && phase.liveJob.status === 'waiting_for_answer') {
      setTimeout(() => answerRef.current?.focus(), 50);
    }
  }, [phase.kind === 'running' && phase.liveJob.status === 'waiting_for_answer', phase.kind]);

  // ── Upload + orchestrate ───────────────────────────────────────────

  const start = (): void => {
    if (!file || phase.kind === 'uploading') return;
    setUploadError(null);
    setPhase({ kind: 'uploading', progress: 0 });

    const fd = new FormData();
    fd.set('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);

    xhr.upload.onprogress = (e): void => {
      if (e.lengthComputable)
        setPhase({ kind: 'uploading', progress: Math.round((e.loaded / e.total) * 100) });
    };

    xhr.onload = (): void => {
      try {
        const body = JSON.parse(xhr.responseText) as { ok?: boolean; job?: { id: string }; error?: string; message?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.ok && body.job) {
          const jobId = body.job.id;
          setPhase({ kind: 'starting', jobId });
          void kickOff(jobId);
        } else {
          setUploadError(body.message ?? body.error ?? `Upload failed (${xhr.status})`);
          setPhase({ kind: 'idle' });
        }
      } catch {
        setUploadError(`Upload failed (${xhr.status})`);
        setPhase({ kind: 'idle' });
      }
    };

    xhr.onerror = (): void => {
      setUploadError('Network error — check your connection and try again.');
      setPhase({ kind: 'idle' });
    };

    xhr.send(fd);
  };

  const kickOff = async (jobId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/import/${encodeURIComponent(jobId)}/orchestrate`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
        setUploadError(body.reason ?? body.error ?? 'Failed to start import.');
        setPhase({ kind: 'idle' });
        return;
      }
    } catch {
      setUploadError('Network error starting import.');
      setPhase({ kind: 'idle' });
      return;
    }
    // Fetch initial status then begin polling.
    try {
      const res = await fetch(`/api/import/${encodeURIComponent(jobId)}`);
      const data = res.ok ? ((await res.json()) as { job?: LiveJob }) : {};
      setPhase({ kind: 'running', jobId, liveJob: data.job ?? { id: jobId, status: 'orchestrating_assets' } });
    } catch {
      setPhase({ kind: 'running', jobId, liveJob: { id: jobId, status: 'orchestrating_assets' } });
    }
    startPolling(jobId);
  };

  // ── Q&A answer ─────────────────────────────────────────────────────

  const sendAnswer = async (): Promise<void> => {
    const content = answerText.trim();
    if (!content || sendingAnswer || phase.kind !== 'running') return;
    const jobId = phase.jobId;
    setSendingAnswer(true);
    setAnswerText('');
    try {
      const res = await fetch(`/api/import/${encodeURIComponent(jobId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        // Restore so the user can retry.
        setAnswerText(content);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { reconnecting?: boolean };
      if (body.reconnecting) {
        // Worker was dead — it's restarting and will re-ask the question.
        // Don't optimistic-append; the re-asked message will appear in the next poll.
        return;
      }
      // Optimistic append to reduce perceived latency.
      setPhase((prev) => {
        if (prev.kind !== 'running') return prev;
        const orch = prev.liveJob.plan?.orchestration;
        if (!orch) return prev;
        return {
          ...prev,
          liveJob: {
            ...prev.liveJob,
            plan: {
              ...prev.liveJob.plan,
              orchestration: {
                ...orch,
                conversationHistory: [...orch.conversationHistory, { role: 'user' as const, content, timestamp: Date.now() }],
              },
            },
          },
        };
      });
    } catch {
      setAnswerText(content);
    } finally {
      setSendingAnswer(false);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────

  const close = (): void => {
    if (phase.kind === 'uploading' || phase.kind === 'starting') return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setOpen(false);
    setPhase({ kind: 'idle' });
    setFile(null);
    setUploadError(null);
    setAnswerText('');
    router.refresh();
  };

  // ── Render ─────────────────────────────────────────────────────────

  const isRunning = phase.kind === 'running' || phase.kind === 'starting';
  const isWaiting = phase.kind === 'running' && phase.liveJob.status === 'waiting_for_answer';

  const orch = phase.kind === 'running' ? phase.liveJob.plan?.orchestration : null;
  const activity = orch?.currentActivity ?? null;
  const history = orch?.conversationHistory ?? [];
  const liveStatus = phase.kind === 'running' ? phase.liveJob.status : '';

  const activeStepIdx = PHASE_STEPS.findIndex((s) => s.statuses.includes(liveStatus));
  const completedStepIdx = phase.kind === 'done' ? PHASE_STEPS.length : activeStepIdx;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-[#2A241E] px-4 py-3 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E]"
      >
        <Sparkles size={14} aria-hidden />
        Import Notes
      </button>

      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#2A241E]/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !isRunning) close(); }}
        >
          <div className="relative mx-4 flex h-[90vh] max-h-[640px] w-full max-w-md flex-col rounded-[14px] border border-[#D4C7AE] bg-[#F4EDE0] shadow-2xl">

            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[#D4C7AE] px-5 py-3.5">
              <div className="flex items-center gap-2">
                {phase.kind === 'done'
                  ? <CheckCircle size={14} className="text-[#7B8A5F]" aria-hidden />
                  : <Sparkles size={14} className="text-[#D4A85A]" aria-hidden />}
                <span className="text-sm font-semibold text-[#2A241E]">
                  {phase.kind === 'done' ? 'Import complete' : isRunning ? (isWaiting ? 'Your input needed' : 'Smart Import running…') : 'Import Notes'}
                </span>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={phase.kind === 'uploading' || phase.kind === 'starting'}
                aria-label="Close"
                className="rounded-full p-1 text-[#5A4F42] transition hover:bg-[#D4C7AE]/60 hover:text-[#2A241E] disabled:opacity-40"
              >
                <X size={15} aria-hidden />
              </button>
            </div>

            {/* Phase bar — shown while running or done */}
            {(isRunning || phase.kind === 'done') && (
              <div className="flex shrink-0 items-center gap-0 border-b border-[#D4C7AE]/50 px-5 py-2.5">
                {PHASE_STEPS.map((step, i) => {
                  const done = i < completedStepIdx || phase.kind === 'done';
                  const active = i === activeStepIdx && phase.kind !== 'done';
                  return (
                    <div key={step.label} className="flex items-center">
                      <div className="flex items-center gap-1.5">
                        <div className={
                          'h-2 w-2 rounded-full transition-colors ' +
                          (done ? 'bg-[#7B8A5F]' : active ? 'bg-[#D4A85A]' : 'bg-[#D4C7AE]')
                        } />
                        <span className={'text-[10px] font-medium ' + (active ? 'text-[#2A241E]' : 'text-[#8A7E6B]')}>
                          {step.label}
                        </span>
                        {active && <Loader2 size={10} className="animate-spin text-[#D4A85A]" aria-hidden />}
                      </div>
                      {i < PHASE_STEPS.length - 1 && <div className="mx-2 h-px w-4 bg-[#D4C7AE]" />}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Body */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

              {/* ── Idle: file picker ── */}
              {(phase.kind === 'idle') && (
                <div className="space-y-4 overflow-y-auto px-5 py-5">
                  <p className="text-sm text-[#5A4F42]">
                    Drop in a ZIP of your notes. The AI will classify characters, locations, items,
                    sessions, and lore — pausing to ask you only when something is genuinely ambiguous.
                  </p>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-[#5A4F42]">Notes ZIP</span>
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      onChange={(e) => { setUploadError(null); setFile(e.target.files?.[0] ?? null); }}
                      className="w-full rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8] px-3 py-5 text-center text-sm text-[#5A4F42] file:mr-3 file:rounded-[6px] file:border-0 file:bg-[#2A241E] file:px-3 file:py-1.5 file:text-xs file:text-[#F4EDE0]"
                    />
                    {file && <span className="mt-1 block text-xs text-[#5A4F42]">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>}
                  </label>
                  {uploadError && <p className="rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-xs text-[#8B4A52]">{uploadError}</p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={close} className="rounded-[8px] px-3 py-2 text-sm text-[#5A4F42] transition hover:text-[#2A241E]">Cancel</button>
                    <button
                      type="button"
                      onClick={start}
                      disabled={!file}
                      className="flex items-center gap-2 rounded-[10px] bg-[#2A241E] px-4 py-2 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
                    >
                      <Sparkles size={13} aria-hidden />
                      Start Smart Import
                    </button>
                  </div>
                </div>
              )}

              {/* ── Uploading ── */}
              {phase.kind === 'uploading' && (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 py-8">
                  <p className="text-sm font-medium text-[#2A241E]">Uploading {file?.name}…</p>
                  <div className="w-full">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#EAE1CF]">
                      <div className="h-full bg-[#D4A85A] transition-[width] duration-200" style={{ width: `${phase.progress}%` }} />
                    </div>
                    <p className="mt-1.5 text-center text-xs text-[#5A4F42]">{phase.progress}%</p>
                  </div>
                </div>
              )}

              {/* ── Starting ── */}
              {phase.kind === 'starting' && (
                <div className="flex flex-1 items-center justify-center gap-3 px-5 py-8">
                  <Loader2 size={16} className="animate-spin text-[#D4A85A]" aria-hidden />
                  <span className="text-sm text-[#5A4F42]">Starting Smart Import…</span>
                </div>
              )}

              {/* ── Running / waiting for answer ── */}
              {phase.kind === 'running' && (
                <>
                  {/* Conversation */}
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-3">
                    {history.length === 0 && !activity && (
                      <div className="flex items-center gap-2 text-xs text-[#8A7E6B]">
                        <Loader2 size={11} className="animate-spin" aria-hidden />
                        <span>Analysing your notes…</span>
                      </div>
                    )}
                    {history.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === 'assistant' ? 'justify-start' : 'justify-end'}`}>
                        <div className={
                          'max-w-[88%] rounded-[10px] px-3 py-2 text-xs leading-relaxed ' +
                          (msg.role === 'assistant' ? 'bg-[#EAE1CF] text-[#2A241E]' : 'bg-[#2A241E] text-[#F4EDE0]')
                        }>
                          {msg.content.replace(/\*\*(.+?)\*\*/g, '$1').split('\n').map((line, j, arr) => (
                            <span key={j}>{line}{j < arr.length - 1 && <br />}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                    {!isWaiting && (
                      <div className="flex items-center gap-2 text-xs text-[#8A7E6B]">
                        <Loader2 size={11} className="animate-spin" aria-hidden />
                        <span>Working…</span>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {/* Activity ticker — single cycling line */}
                  {activity && (
                    <div className="shrink-0 border-t border-[#D4C7AE]/40 px-5 py-2">
                      <p className="truncate font-mono text-[10px] text-[#8A7E6B]/70">{activity}</p>
                    </div>
                  )}

                  {/* Answer input */}
                  {isWaiting && (
                    <div className="shrink-0 border-t border-[#D4C7AE] px-4 py-3">
                      <div className="flex items-end gap-2">
                        <textarea
                          ref={answerRef}
                          value={answerText}
                          onChange={(e) => setAnswerText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendAnswer(); } }}
                          placeholder="Type your answer… (Enter to send)"
                          rows={2}
                          disabled={sendingAnswer}
                          className="flex-1 resize-none rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] px-3 py-2 text-xs text-[#2A241E] outline-none placeholder:text-[#8A7E6B] focus:border-[#D4A85A] disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => void sendAnswer()}
                          disabled={sendingAnswer || !answerText.trim()}
                          className="shrink-0 rounded-[8px] bg-[#2A241E] p-2 text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-40"
                        >
                          {sendingAnswer ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── Done ── */}
              {phase.kind === 'done' && (
                <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
                  {phase.summary && (
                    <div className="rounded-[10px] border border-[#7B8A5F]/40 bg-[#7B8A5F]/10 px-4 py-3 text-sm text-[#2A241E]">
                      {phase.summary}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={close}
                      className="flex-1 rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] py-2.5 text-sm font-medium text-[#2A241E] transition hover:bg-[#EAE1CF]"
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      onClick={() => { close(); router.push('/'); }}
                      className="flex-1 rounded-[10px] bg-[#2A241E] py-2.5 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E]"
                    >
                      View notes →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
