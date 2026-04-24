// Full-width world header. Three-column CSS grid so the search bar
// sits at the exact viewport centre regardless of how long the world
// name is or how many avatars are online.
//
// Left  : settings gear (admin) → world name (Fraunces) → live avatars
// Centre: global search (dead-centred)
// Right : mirrors left — empty except for the user chip on sidebar-less pages

import type { ReactElement } from 'react';
import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { PresenceClient, type Me } from './PresenceClient';
import { WorldSearchBar } from './WorldSearchBar';
import { getWorldHeader } from '@/lib/groups';
import { logoutAction } from './login/actions';

export function AppHeader({
  role,
  me,
  user,
  csrfToken: _csrfToken,
  canCreate: _canCreate,
  groupId,
}: {
  role: 'admin' | 'editor' | 'viewer';
  me: Me;
  user?: { displayName: string; username: string; accentColor: string };
  csrfToken?: string;
  canCreate?: boolean;
  groupId?: string;
}): ReactElement {
  const worldHeader = groupId ? getWorldHeader(groupId) : null;
  const worldName = worldHeader?.name ?? '';
  const headerColor = worldHeader?.headerColor ?? 'var(--ink)';

  return (
    <header className="surface-paper grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--rule)] bg-[var(--parchment-sunk)] px-4">

      {/* ── Left: gear → title → avatars ── */}
      <div className="flex min-w-0 items-center gap-2.5">

        {role === 'admin' && groupId && (
          <Link
            href="/settings/world"
            title="World settings"
            aria-label="World settings"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/20 hover:text-[var(--ink)]"
          >
            <Settings2 size={14} aria-hidden />
          </Link>
        )}

        {worldName && (
          <span
            className="truncate text-xl font-semibold leading-tight tracking-wide"
            style={{
              fontFamily: 'var(--font-fraunces), "Fraunces", Georgia, serif',
              color: headerColor,
            }}
          >
            {worldName}
          </span>
        )}

        {/* Live presence — sits right of the title */}
        {groupId ? <PresenceClient me={me} groupId={groupId} /> : <PresenceClient me={me} />}

        {/* Sidebar-less pages: inline nav */}
        {/* (includeNav is no longer needed — kept for API compat) */}
      </div>

      {/* ── Centre: search (dead-centred by the grid) ── */}
      <WorldSearchBar />

      {/* ── Right: user chip on sidebar-less pages, else empty ── */}
      <div className="flex min-w-0 items-center justify-end gap-2">
        {user && (
          <>
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: user.accentColor }}
            />
            <span className="truncate text-xs text-[var(--ink)]">
              <span className="font-medium">{user.displayName}</span>{' '}
              <span className="text-[var(--ink-soft)]">({user.username})</span>
            </span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="shrink-0 rounded-[6px] border border-[var(--rule)] bg-[var(--vellum)] px-2 py-1 text-xs text-[var(--ink-soft)] transition hover:bg-[var(--parchment)] hover:text-[var(--ink)]"
              >
                Sign out
              </button>
            </form>
          </>
        )}
      </div>
    </header>
  );
}
