'use client';

// How to connect Claude (or Codex) to this Server: the MCP link with a
// copy button, then per-client steps. The link is the same for every
// World; the World is picked when the client signs in.

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { connectTargets, EXAMPLE_PROMPTS, type ConnectTarget } from './connect-claude';

export function ConnectClaude({
  mcpUrl,
  worldName,
}: {
  mcpUrl: string;
  worldName: string;
}): React.JSX.Element {
  const targets = connectTargets(mcpUrl);
  const [activeId, setActiveId] = useState<ConnectTarget['id']>('claude');
  const active = targets.find((t) => t.id === activeId) ?? targets[0]!;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Connector link
        </div>
        <CopyField value={mcpUrl} label="Copy connector link" />
        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
          One link for every World. When you sign in you choose which World to share; it starts on
          the one you are in now{worldName ? ` (${worldName})` : ''}. For a second World, add it
          again under another name, such as compendium-2.
        </p>
      </div>

      <div>
        <div role="tablist" aria-label="Connect from" className="flex gap-1 border-b border-[var(--rule)]">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === activeId}
              onClick={() => setActiveId(t.id)}
              className={
                '-mb-px rounded-t-[8px] px-3 py-1.5 text-sm transition ' +
                (t.id === activeId
                  ? 'border border-b-[var(--vellum)] border-[var(--rule)] bg-[var(--vellum)] font-medium text-[var(--ink)]'
                  : 'text-[var(--ink-soft)] hover:text-[var(--ink)]')
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-2 pt-3 text-sm text-[var(--ink)]">
          <p>{active.intro}</p>
          {active.commands?.map((c) => <CopyField key={c} value={c} label="Copy command" mono />)}
          {active.after.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Then try asking
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-[var(--ink-soft)]">
          {EXAMPLE_PROMPTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
          Claude only reads. A Wrap-up it drafts waits for you under End Session, where you review it
          before anything is written.
        </p>
      </div>
    </div>
  );
}

function CopyField({ value, label, mono }: { value: string; label: string; mono?: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex items-stretch gap-2">
      <code
        className={
          'min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-[8px] border border-[var(--rule)] bg-[var(--parchment-sunk)] px-3 py-2 text-sm text-[var(--ink)] ' +
          (mono ? 'font-mono' : '')
        }
      >
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-[var(--rule)] px-3 text-sm text-[var(--ink-soft)] transition hover:border-[var(--wine)] hover:text-[var(--wine)]"
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
