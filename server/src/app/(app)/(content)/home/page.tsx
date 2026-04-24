// Home landing. Shows a lightweight welcome + recent notes + top-level
// folders. The legacy admin-token dashboard is still reachable at
// /admin/legacy (wired in Phase 8 cleanup).
//
// Shell chrome (header, sidebar, tab bar) is owned by the parent
// `(content)/layout.tsx` so navigating between content pages doesn't
// re-mount them. This page only renders its main-column content.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { recentlyUpdated } from '@/lib/notes';
import { buildTree } from '@/lib/tree';
import { HomeChat } from '../../../HomeChat';

export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/home');

  const counts = getDb()
    .query<{ notes: number; assets: number }, [string, string]>(
      `SELECT
         (SELECT COUNT(*) FROM notes  WHERE group_id = ?) AS notes,
         (SELECT COUNT(*) FROM assets WHERE group_id = ?) AS assets`,
    )
    .get(session.currentGroupId, session.currentGroupId) ?? { notes: 0, assets: 0 };

  const activeCampaignSlug = getDb()
    .query<{ active_campaign_slug: string | null }, [string]>(
      'SELECT active_campaign_slug FROM groups WHERE id = ?',
    )
    .get(session.currentGroupId)?.active_campaign_slug ?? null;

  const recent = recentlyUpdated(session.currentGroupId, 12);
  // Tree is also fetched by the parent layout, but the snapshot-
  // keyed cache in buildTree makes this a ~1ms lookup rather than a
  // second full SELECT. Kept here because topFolders/countFiles are
  // home-specific derived data.
  const tree = buildTree(session.currentGroupId);
  const topFolders = tree.root.children.filter((c) => c.kind === 'dir').slice(0, 6);

  return (
    <div className="flex-1 overflow-y-auto">
      <main className="surface-paper mx-auto w-full max-w-4xl px-6 py-10">
        <section className="mb-6">
          <div>
            <h1
              className="text-4xl font-bold tracking-tight text-[var(--ink)]"
              style={{ fontFamily: '"Fraunces", Georgia, serif' }}
            >
              Welcome, {session.displayName}.
            </h1>
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              {counts.notes} note{counts.notes === 1 ? '' : 's'} · {counts.assets} asset
              {counts.assets === 1 ? '' : 's'} · signed in as <code>{session.username}</code>
            </p>
          </div>
        </section>

        <section className="mb-10">
          <HomeChat
            groupId={session.currentGroupId}
            userId={session.userId}
            campaignSlug={activeCampaignSlug ?? undefined}
          />
        </section>

        {topFolders.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              Browse
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              {topFolders.map((f) => {
                if (f.kind !== 'dir') return null;
                const first = findFirstNote(f);
                return (
                  <Link
                    key={f.path}
                    href={first ? '/notes/' + encodePath(first) : '#'}
                    className="block rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-4 transition hover:scale-[1.015] hover:border-[var(--candlelight)]/60 hover:bg-[var(--vellum)]/80"
                  >
                    <div className="text-sm font-semibold text-[var(--ink)]">{f.name}</div>
                    <div className="mt-1 text-xs text-[var(--ink-soft)]">
                      {countFiles(f)} note{countFiles(f) === 1 ? '' : 's'}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
              Recently updated
            </h2>
            <ul className="divide-y divide-[var(--rule)]/60 overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)]">
              {recent.map((n) => (
                <li key={n.path}>
                  <Link
                    href={'/notes/' + encodePath(n.path)}
                    className="flex items-center justify-between px-4 py-3 transition hover:bg-[var(--parchment)]"
                  >
                    <span className="truncate">
                      <span className="font-medium text-[var(--ink)]">
                        {n.title || baseName(n.path)}
                      </span>
                      <span className="ml-2 text-xs text-[var(--ink-soft)]">{n.path}</span>
                    </span>
                    <span className="ml-4 shrink-0 text-xs text-[var(--ink-soft)]">
                      {fmtAgo(n.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

function findFirstNote(dir: { kind: 'dir'; children: Array<unknown> }): string | null {
  for (const child of dir.children) {
    const c = child as { kind: 'dir' | 'file'; path?: string; children?: unknown[] };
    if (c.kind === 'file' && c.path) return c.path;
    if (c.kind === 'dir' && c.children) {
      const nested = findFirstNote({ kind: 'dir', children: c.children });
      if (nested) return nested;
    }
  }
  return null;
}

function countFiles(dir: { kind: 'dir'; children: Array<unknown> }): number {
  let n = 0;
  for (const child of dir.children) {
    const c = child as { kind: 'dir' | 'file'; children?: unknown[] };
    if (c.kind === 'file') n++;
    else if (c.kind === 'dir' && c.children) n += countFiles({ kind: 'dir', children: c.children });
  }
  return n;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function baseName(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|canvas)$/i, '');
}

function fmtAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return Math.round(d / 1000) + 's ago';
  if (d < 3_600_000) return Math.round(d / 60_000) + 'm ago';
  if (d < 86_400_000) return Math.round(d / 3_600_000) + 'h ago';
  return Math.round(d / 86_400_000) + 'd ago';
}
