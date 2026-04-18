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
} from '@/lib/notes';
import { buildTree } from '@/lib/tree';
import { SessionHeader } from '../../SessionHeader';
import { FileTree } from '../FileTree';
import { NoteSurface } from '../NoteSurface';
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

  let contentJson: unknown = null;
  try {
    contentJson = JSON.parse(note.content_json);
  } catch {
    contentJson = { type: 'doc', content: [] };
  }
  const outline = extractOutline(contentJson);

  return (
    <div className="min-h-screen bg-[#F4EDE0] text-[#2A241E]">
      <SessionHeader
        displayName={session.displayName}
        username={session.username}
        role={session.role}
        accentColor={session.accentColor}
      />

      <div className="grid h-[calc(100vh-49px)] grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)_280px]">
        <aside className="hidden md:block">
          <FileTree tree={tree} activePath={path} groupId={session.currentGroupId} />
        </aside>

        <main className="overflow-y-auto px-8 py-10" id="note-main">
          <div className="mx-auto max-w-[720px]">
            <header className="mb-6">
              <h1
                className="text-4xl font-bold text-[#2A241E]"
                style={{ fontFamily: '"Fraunces", Georgia, serif' }}
              >
                {note.title || baseName(path)}
              </h1>
              <p className="mt-1 text-xs text-[#5A4F42]">
                <code>{path}</code>
              </p>
            </header>

            <NoteSurface
              path={path}
              initialContent={contentJson as { type: string } & Record<string, unknown>}
              user={{
                displayName: session.displayName,
                accentColor: session.accentColor,
              }}
              canEdit={session.role !== 'viewer'}
            />
          </div>
        </main>

        <aside className="hidden md:block">
          <NoteSidebar backlinks={backlinks} tags={tags} outline={outline} />
        </aside>
      </div>
    </div>
  );
}

function baseName(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|canvas)$/i, '');
}
