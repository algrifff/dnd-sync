// Home landing. Shows a lightweight welcome + recent notes + top-level
// folders. The legacy admin-token dashboard is still reachable at
// /admin/legacy (wired in Phase 8 cleanup).

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { recentlyUpdated } from '@/lib/notes';
import { buildTree } from '@/lib/tree';
import { listNoteKinds } from '@/lib/characters';
import { listOpenJobsForUser } from '@/lib/imports';
import { AppHeader } from './AppHeader';
import { WorldsSidebar } from './WorldsSidebar';
import { SidebarHeader } from './SidebarHeader';
import { HomeChat } from './HomeChat';
import { SidebarFooter } from './SidebarFooter';
import { FileTree } from './notes/FileTree';
import { ActiveCharacterBlock } from './notes/ActiveCharacterBlock';

export const dynamic = 'force-dynamic';

export default async function HomePage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/');

  const counts = getDb()
    .query<{ notes: number; assets: number }, [string, string]>(
      `SELECT
         (SELECT COUNT(*) FROM notes  WHERE group_id = ?) AS notes,
         (SELECT COUNT(*) FROM assets WHERE group_id = ?) AS assets`,
    )
    .get(session.currentGroupId, session.currentGroupId) ?? { notes: 0, assets: 0 };

  const recent = recentlyUpdated(session.currentGroupId, 12);
  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const openJobs = listOpenJobsForUser(session.currentGroupId, session.userId);
  const topFolders = tree.root.children.filter((c) => c.kind === 'dir').slice(0, 6);

  return (
    <div className="flex h-screen bg-[#F4EDE0] text-[#2A241E]">
      <WorldsSidebar csrfToken={session.csrfToken} />
      <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
        <ActiveCharacterBlock
          csrfToken={session.csrfToken}
          initialActivePath={session.activeCharacterPath}
        />
        <SidebarHeader role={session.role} />
        <FileTree
          tree={tree}
          activePath=""
          groupId={session.currentGroupId}
          csrfToken={session.csrfToken}
          canCreate={session.role !== 'viewer'}
          kindMap={kindMap}
        />
        <SidebarFooter
          displayName={session.displayName}
          username={session.username}
          role={session.role}
          accentColor={session.accentColor}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          role={session.role}
          me={{
            userId: session.userId,
            displayName: session.displayName,
            username: session.username,
            accentColor: session.accentColor,
          }}
          csrfToken={session.csrfToken}
          canCreate={session.role !== 'viewer'}
        />
        <div className="flex-1 overflow-y-auto">
        <main className="surface-paper mx-auto w-full max-w-4xl px-6 py-10">
        <section className="mb-6">
          <h1
            className="text-4xl font-bold tracking-tight text-[#2A241E]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            Welcome, {session.displayName}.
          </h1>
          <p className="mt-2 text-sm text-[#5A4F42]">
            {counts.notes} note{counts.notes === 1 ? '' : 's'} · {counts.assets} asset
            {counts.assets === 1 ? '' : 's'} · signed in as <code>{session.username}</code>
          </p>
          {counts.notes === 0 && (
            <p className="mt-4 rounded-[10px] border border-[#D4A85A]/40 bg-[#D4A85A]/10 px-4 py-3 text-sm text-[#5A4F42]">
              {session.role === 'admin' ? (
                <>
                  The vault is empty. Head to{' '}
                  <Link href="/settings/vault" className="underline">
                    /settings/vault
                  </Link>{' '}
                  and upload a ZIP to get started.
                </>
              ) : (
                'The vault is empty. Ask your DM to upload.'
              )}
            </p>
          )}
        </section>

        <section className="mb-10">
          <HomeChat
            csrfToken={session.csrfToken}
            canImport={session.role !== 'viewer'}
            initialOpenJobs={openJobs}
          />
        </section>

        {topFolders.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#5A4F42]">
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
                    className="block rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4 transition hover:scale-[1.015] hover:border-[#D4A85A]/60 hover:bg-[#FBF5E8]/80"
                  >
                    <div className="text-sm font-semibold text-[#2A241E]">{f.name}</div>
                    <div className="mt-1 text-xs text-[#5A4F42]">
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
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#5A4F42]">
              Recently updated
            </h2>
            <ul className="divide-y divide-[#D4C7AE]/60 overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8]">
              {recent.map((n) => (
                <li key={n.path}>
                  <Link
                    href={'/notes/' + encodePath(n.path)}
                    className="flex items-center justify-between px-4 py-3 transition hover:bg-[#F4EDE0]"
                  >
                    <span className="truncate">
                      <span className="font-medium text-[#2A241E]">{n.title || baseName(n.path)}</span>
                      <span className="ml-2 text-xs text-[#5A4F42]">{n.path}</span>
                    </span>
                    <span className="ml-4 shrink-0 text-xs text-[#5A4F42]">{fmtAgo(n.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
        </div>
      </div>
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
