'use client';

// "Open sessions": one card per World with a Session still open, the
// newest one, linking into that World's Session note. Renders nothing
// when no World has one.

import { ScrollText } from 'lucide-react';
import { useWorldSwitch } from '../WorldSwitch';
import { WorldChip, type ChipWorld } from './WorldChip';
import { noteHref } from './note-href';
import type { OpenSession } from '@/lib/home';

export function OpenSessionsStrip({
  sessions,
  worlds,
}: {
  sessions: OpenSession[];
  worlds: ChipWorld[];
}): React.JSX.Element | null {
  const { switchTo } = useWorldSwitch();
  if (sessions.length === 0) return null;

  return (
    <section aria-labelledby="open-sessions-heading" className="mb-10">
      <h2 id="open-sessions-heading" className="mb-3 font-serif text-lg text-[var(--ink)]">
        Open sessions
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sessions.map((s) => {
          const world = worlds.find((w) => w.id === s.worldId) ?? { id: s.worldId, name: s.worldName, iconVersion: 0 };
          return (
            <li key={s.worldId}>
              <button
                type="button"
                onClick={() => void switchTo(s.worldId, noteHref(s.path))}
                className="flex w-full items-center gap-3 rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] p-3 text-left transition hover:border-[var(--candlelight)]"
              >
                <WorldChip world={world} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--ink)]">
                    <ScrollText size={13} aria-hidden className="shrink-0 text-[var(--candlelight)]" />
                    <span className="truncate">{s.title}</span>
                  </div>
                  <div className="truncate text-[11px] text-[var(--ink-soft)]">
                    {s.worldName}
                    {s.openCount > 1 && ` · ${s.openCount} open`}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
