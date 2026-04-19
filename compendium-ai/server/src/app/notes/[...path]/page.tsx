// /notes/<path...> — the main reader surface. Three-pane layout:
// folder tree · note body · side rail. Mobile collapses the tree and
// side rail under the note body.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import {
  decodePath,
  loadBacklinks,
  loadNote,
  loadTags,
  loadUser,
} from '@/lib/notes';
import { buildTree } from '@/lib/tree';
import { AppHeader } from '../../AppHeader';
import { SidebarHeader } from '../../SidebarHeader';
import { SidebarFooter } from '../../SidebarFooter';
import { FileTree } from '../FileTree';
import { NoteMenu } from '../NoteMenu';
import { NoteWorkspace } from '../NoteWorkspace';
import { NoteSidebar, extractOutline } from '../NoteSidebar';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

export default async function NotePage({ params }: Ctx): Promise<ReactElement> {
  const { path: segments } = await params;
  const path = decodePath(segments);
  if (!path) notFound();

  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) notFound(); // middleware would normally redirect; defence-in-depth

  const note = loadNote(session.currentGroupId, path);
  if (!note) notFound();

  const tree = buildTree(session.currentGroupId);
  const backlinks = loadBacklinks(session.currentGroupId, path);
  const tags = loadTags(session.currentGroupId, path);
  const creator = note.created_by ? loadUser(note.created_by) : null;

  let contentJson: unknown = null;
  try {
    contentJson = JSON.parse(note.content_json);
  } catch {
    contentJson = { type: 'doc', content: [] };
  }
  const outline = extractOutline(contentJson);

  return (
    <div className="flex h-screen bg-[#F4EDE0] text-[#2A241E]">
      <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
        <SidebarHeader role={session.role} />
        <FileTree
          tree={tree}
          activePath={path}
          groupId={session.currentGroupId}
          csrfToken={session.csrfToken}
          canCreate={session.role !== 'viewer'}
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

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px]">
          <main className="relative overflow-auto px-8 py-10" id="note-main">
          <div id="note-scroll-body" className="relative mx-auto w-[720px]">
            <header className="mb-4 flex items-center justify-between gap-3">
              <p className="text-xs text-[#5A4F42]">
                <code>{path}</code>
              </p>
              {session.role !== 'viewer' && (
                <NoteMenu path={path} csrfToken={session.csrfToken} />
              )}
            </header>

            <NoteWorkspace
              path={path}
              initialContent={contentJson as { type: string } & Record<string, unknown>}
              initialTags={tags}
              user={{
                userId: session.userId,
                displayName: session.displayName,
                accentColor: session.accentColor,
              }}
              canEdit={session.role !== 'viewer'}
              csrfToken={session.csrfToken}
              creator={
                creator
                  ? {
                      displayName: creator.displayName,
                      username: creator.username,
                    }
                  : null
              }
              createdAt={note.created_at}
            />
          </div>
        </main>

          <aside className="hidden md:block">
            <NoteSidebar
              path={path}
              backlinks={backlinks}
              tags={tags}
              outline={outline}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

