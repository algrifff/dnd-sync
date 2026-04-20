'use client';

// Per-change approve/reject review panel for the session close workflow.
// Rendered inline inside the ChatPane when the AI returns a session_close proposal.

import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { Check, X } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────

export type SessionProposal = {
  sessionPath: string;
  extractedAt: number;
  note: string;
  characterUpdates: Array<{ id: string; path: string; field: string; from: unknown; to: unknown }>;
  inventoryChanges: Array<{ id: string; characterPath: string; action: 'add' | 'remove'; item: string }>;
  newBacklinks: Array<{ id: string; from: string; to: string }>;
};

// ── Panel ──────────────────────────────────────────────────────────────

export function SessionReviewPanel({
  proposal,
  onApply,
}: {
  proposal: SessionProposal;
  onApply: (sessionPath: string, approvedChanges: Array<{ id: string; approved: boolean }>) => void;
}): ReactElement {
  const allIds = [
    ...proposal.characterUpdates.map((c) => c.id),
    ...proposal.inventoryChanges.map((c) => c.id),
    ...proposal.newBacklinks.map((c) => c.id),
  ];

  const [approved, setApproved] = useState<Set<string>>(new Set(allIds));
  const [applied, setApplied] = useState(false);

  const toggle = (id: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleApply = () => {
    const changes = allIds.map((id) => ({ id, approved: approved.has(id) }));
    onApply(proposal.sessionPath, changes);
    setApplied(true);
  };

  const hasChanges = allIds.length > 0;

  return (
    <div className="rounded-[10px] border border-[#D4C7AE] bg-white p-3 text-xs">
      <p className="mb-2 font-semibold text-[#2A241E]">Session Review</p>

      {proposal.note && (
        <p className="mb-2 text-[#5A4F42]">{proposal.note}</p>
      )}

      {!hasChanges && (
        <p className="italic text-[#5A4F42]">No changes detected.</p>
      )}

      {proposal.characterUpdates.length > 0 && (
        <Section title="Character Updates">
          {proposal.characterUpdates.map((c) => (
            <ChangeRow
              key={c.id}
              label={`${baseName(c.path)} · ${c.field}: ${String(c.from)} → ${String(c.to)}`}
              approved={approved.has(c.id)}
              onToggle={() => toggle(c.id)}
              disabled={applied}
            />
          ))}
        </Section>
      )}

      {proposal.inventoryChanges.length > 0 && (
        <Section title="Inventory Changes">
          {proposal.inventoryChanges.map((c) => (
            <ChangeRow
              key={c.id}
              label={`${baseName(c.characterPath)} · ${c.action} ${c.item}`}
              approved={approved.has(c.id)}
              onToggle={() => toggle(c.id)}
              disabled={applied}
            />
          ))}
        </Section>
      )}

      {proposal.newBacklinks.length > 0 && (
        <Section title="New Links">
          {proposal.newBacklinks.map((c) => (
            <ChangeRow
              key={c.id}
              label={`${baseName(c.from)} → ${baseName(c.to)}`}
              approved={approved.has(c.id)}
              onToggle={() => toggle(c.id)}
              disabled={applied}
            />
          ))}
        </Section>
      )}

      {hasChanges && !applied && (
        <button
          onClick={handleApply}
          className="mt-3 w-full rounded-[7px] bg-[#D4A85A] py-1.5 text-xs font-semibold text-white transition hover:bg-[#C49848]"
        >
          Apply Approved Changes
        </button>
      )}

      {applied && (
        <p className="mt-2 text-center text-[#7B8A5F]">Applying changes…</p>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function baseName(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? path;
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="mb-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#5A4F42]">
        {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ChangeRow({
  label,
  approved,
  onToggle,
  disabled,
}: {
  label: string;
  approved: boolean;
  onToggle: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={[
        'flex w-full items-start gap-2 rounded-[5px] px-2 py-1 text-left transition',
        approved
          ? 'bg-[#7B8A5F]/10 text-[#2A241E]'
          : 'bg-[#8B4A52]/10 text-[#5A4F42] line-through',
        'hover:bg-[#D4C7AE]/40 disabled:cursor-default',
      ].join(' ')}
    >
      <span className={`mt-0.5 shrink-0 ${approved ? 'text-[#7B8A5F]' : 'text-[#8B4A52]'}`}>
        {approved ? <Check size={11} /> : <X size={11} />}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
