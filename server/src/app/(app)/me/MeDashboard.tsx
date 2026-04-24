'use client';

// Client dashboard rendered inside /me. The world grid, character
// grid, and recent activity feed are all server-driven (props come
// from the server page), but creation dialogs and navigation live
// here so they can be interactive without a full page reload.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, UserRound } from 'lucide-react';
import { NewWorldDialog } from '../../NewWorldDialog';
import { NewCharacterDialog } from './NewCharacterDialog';
import { useWorldSwitch } from '../WorldSwitch';
import type { WorldRow } from '@/lib/groups';
import type { UserCharacter } from '@/lib/userCharacters';
import type { RecentForUserRow } from '@/lib/notes';

export function MeDashboard({
  csrfToken,
  displayName,
  worlds,
  characters,
  recent,
}: {
  csrfToken: string;
  displayName: string;
  worlds: WorldRow[];
  characters: UserCharacter[];
  recent: RecentForUserRow[];
}): React.JSX.Element {
  const router = useRouter();
  const { switchTo } = useWorldSwitch();
  const [newWorldOpen, setNewWorldOpen] = useState(false);
  const [newCharOpen, setNewCharOpen] = useState(false);

  const openWorld = async (id: string): Promise<void> => {
    await switchTo(id, '/home');
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--parchment)]">
      <header className="border-b border-[var(--rule)] bg-[var(--vellum)] px-8 py-6">
        <h1 className="font-serif text-2xl text-[var(--ink)]">
          Welcome back, {displayName}
        </h1>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Your worlds, your characters, and what you&rsquo;ve been working on.
        </p>
      </header>

      <main className="flex-1 px-8 py-6">
        <section className="mb-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-serif text-lg text-[var(--ink)]">Worlds</h2>
            <button
              type="button"
              onClick={() => setNewWorldOpen(true)}
              className="flex items-center gap-1 rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--ink-soft)]"
            >
              <Plus size={12} aria-hidden /> New world
            </button>
          </div>
          {worlds.length === 0 ? (
            <EmptyState
              message="You're not in any worlds yet."
              action="Create your first world"
              onAction={() => setNewWorldOpen(true)}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {worlds.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => void openWorld(w.id)}
                  className="flex items-center gap-3 rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] p-3 text-left transition hover:border-[var(--candlelight)]"
                >
                  <WorldChip world={w} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--ink)]">
                      {w.name}
                    </div>
                    <div className="text-[11px] uppercase tracking-wide text-[var(--ink-soft)]">
                      {w.role}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="mb-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-serif text-lg text-[var(--ink)]">
              Your characters
            </h2>
            <button
              type="button"
              onClick={() => setNewCharOpen(true)}
              className="flex items-center gap-1 rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--ink-soft)]"
            >
              <Plus size={12} aria-hidden /> New character
            </button>
          </div>
          {characters.length === 0 ? (
            <EmptyState
              message="No characters yet."
              action="Create your first character"
              onAction={() => setNewCharOpen(true)}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {characters.map((c) => (
                <Link
                  key={c.id}
                  href={`/me/characters/${encodeURIComponent(c.id)}`}
                  className="flex items-center gap-3 rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)] p-3 transition hover:border-[var(--candlelight)]"
                >
                  <CharacterPortrait character={c} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--ink)]">
                      {c.name}
                    </div>
                    <div className="text-[11px] uppercase tracking-wide text-[var(--ink-soft)]">
                      {c.kind}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 font-serif text-lg text-[var(--ink)]">
            Recent activity
          </h2>
          {recent.length === 0 ? (
            <p className="text-sm text-[var(--ink-soft)]">
              Nothing yet. Notes you edit across any world show up here.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--rule)] rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)]">
              {recent.map((r) => (
                <li key={`${r.groupId}:${r.path}`}>
                  <RecentLink row={r} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {newWorldOpen && (
        <NewWorldDialog
          csrfToken={csrfToken}
          onClose={() => setNewWorldOpen(false)}
          onCreated={(id) => {
            setNewWorldOpen(false);
            void openWorld(id);
          }}
        />
      )}
      {newCharOpen && (
        <NewCharacterDialog
          csrfToken={csrfToken}
          onClose={() => setNewCharOpen(false)}
          onCreated={(id) => {
            setNewCharOpen(false);
            router.push(`/me/characters/${encodeURIComponent(id)}`);
          }}
        />
      )}
    </div>
  );
}

function RecentLink({ row }: { row: RecentForUserRow }): React.JSX.Element {
  const { switchTo } = useWorldSwitch();
  return (
    <button
      type="button"
      onClick={() => {
        void switchTo(
          row.groupId,
          `/notes/${row.path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`,
        );
      }}
      className="flex w-full items-baseline justify-between gap-4 px-3 py-2 text-left transition hover:bg-[var(--parchment)]"
    >
      <span className="truncate text-sm text-[var(--ink)]">{row.title || row.path}</span>
      <span className="shrink-0 text-[11px] text-[var(--ink-soft)]">
        {row.groupName} · {formatRelative(row.updatedAt)}
      </span>
    </button>
  );
}

function EmptyState({
  message,
  action,
  onAction,
}: {
  message: string;
  action: string;
  onAction: () => void;
}): React.JSX.Element {
  return (
    <div className="rounded-[10px] border border-dashed border-[var(--rule)] bg-[var(--vellum)] p-6 text-center">
      <p className="mb-3 text-sm text-[var(--ink-soft)]">{message}</p>
      <button
        type="button"
        onClick={onAction}
        className="rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--ink-soft)]"
      >
        {action}
      </button>
    </div>
  );
}

function WorldChip({ world }: { world: WorldRow }): React.JSX.Element {
  const bg = colorFor(world.id);
  const initials = initialsOf(world.name);
  const hasIcon = world.iconVersion > 0;
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-sm font-semibold text-[var(--parchment)]"
      style={{ backgroundColor: hasIcon ? 'var(--ink)' : bg }}
    >
      {hasIcon ? (
        <img
          src={`/api/worlds/${encodeURIComponent(world.id)}/icon?v=${world.iconVersion}`}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        initials
      )}
    </span>
  );
}

function CharacterPortrait({
  character,
}: {
  character: UserCharacter;
}): React.JSX.Element {
  const portrait = character.portraitUrl;
  if (portrait) {
    return (
      <img
        src={portrait}
        alt=""
        className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
      />
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--parchment-sunk)] text-[var(--ink-soft)]">
      <UserRound size={18} aria-hidden />
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function colorFor(id: string): string {
  const palette = [
    'var(--wine)',
    'var(--moss)',
    'var(--sage)',
    'var(--candlelight)',
    'var(--embers)',
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length]!;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
