'use client';

// Minimal detail panel for an import job. Phase 1b only renders the
// classical parse output and the cancel button; analyse + apply
// land in later phases.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ImportJob } from '@/lib/imports';
import type { ImportPlan } from '@/lib/import-parse';

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
  const [cancelling, setCancelling] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (): Promise<void> => {
    if (cancelling) return;
    if (!confirm('Cancel this import job? The uploaded file will be deleted.')) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/${encodeURIComponent(job.id)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setCancelling(false);
    }
  };

  const cancellable =
    job.status !== 'applied' && job.status !== 'cancelled' && job.status !== 'failed';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] p-3 text-sm md:grid-cols-4">
        <Stat label="Notes" value={plan?.totals.noteCount ?? 0} />
        <Stat label="Assets" value={plan?.totals.assetCount ?? 0} />
        <Stat label="Skipped" value={plan?.totals.skippedCount ?? 0} />
        <Stat label="Bytes" value={formatBytes(plan?.totals.totalBytes ?? 0)} />
      </div>

      {error && <p className="text-xs text-[#8B4A52]">{error}</p>}

      {plan && plan.notes.length > 0 && (
        <Section title="Notes">
          <ul className="divide-y divide-[#D4C7AE]/50 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] text-xs">
            {plan.notes.slice(0, 50).map((n) => (
              <li key={n.id} className="px-3 py-2">
                <div className="font-mono text-[#2A241E]">{n.sourcePath}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[#5A4F42]">
                  <span>{formatBytes(n.bytes)}</span>
                  {n.existingTags.length > 0 && (
                    <span>· {n.existingTags.length} tag{n.existingTags.length === 1 ? '' : 's'}</span>
                  )}
                  {n.existingWikilinks.length > 0 && (
                    <span>· {n.existingWikilinks.length} link{n.existingWikilinks.length === 1 ? '' : 's'}</span>
                  )}
                  {Object.keys(n.existingFrontmatter).length > 0 && (
                    <span>· frontmatter</span>
                  )}
                </div>
              </li>
            ))}
            {plan.notes.length > 50 && (
              <li className="px-3 py-2 text-[#5A4F42]">
                … and {plan.notes.length - 50} more
              </li>
            )}
          </ul>
        </Section>
      )}

      {plan && plan.assets.length > 0 && (
        <Section title="Assets">
          <ul className="divide-y divide-[#D4C7AE]/50 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] text-xs">
            {plan.assets.slice(0, 40).map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                <div className="flex-1 font-mono text-[#2A241E]">{a.sourcePath}</div>
                <div className="shrink-0 text-[#5A4F42]">
                  {a.mime} · {formatBytes(a.size)}
                </div>
              </li>
            ))}
            {plan.assets.length > 40 && (
              <li className="px-3 py-2 text-[#5A4F42]">
                … and {plan.assets.length - 40} more
              </li>
            )}
          </ul>
        </Section>
      )}

      {plan && plan.skipped.length > 0 && (
        <Section title="Skipped">
          <ul className="divide-y divide-[#D4C7AE]/50 overflow-hidden rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] text-xs">
            {plan.skipped.slice(0, 30).map((s) => (
              <li key={s.sourcePath} className="px-3 py-2">
                <div className="font-mono text-[#2A241E]">{s.sourcePath}</div>
                <div className="text-[#8B4A52]">{s.reason}</div>
              </li>
            ))}
            {plan.skipped.length > 30 && (
              <li className="px-3 py-2 text-[#5A4F42]">
                … and {plan.skipped.length - 30} more
              </li>
            )}
          </ul>
        </Section>
      )}

      <div className="flex items-center gap-2">
        {cancellable && (
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling}
            className="rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-1.5 text-xs font-medium text-[#8B4A52] transition hover:bg-[#8B4A52]/20 disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel import'}
          </button>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}): React.JSX.Element {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#5A4F42]">
        {label}
      </div>
      <div className="text-lg font-semibold text-[#2A241E]">{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
