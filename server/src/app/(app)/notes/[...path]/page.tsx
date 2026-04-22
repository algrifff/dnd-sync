import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { readSession } from '@/lib/session';
import {
  decodePath,
  loadBacklinks,
  loadOutgoingLinks,
  loadNote,
  loadTags,
  loadUser,
} from '@/lib/notes';
import { getTemplate, type NoteTemplate, type TemplateKind } from '@/lib/templates';
import { listNoteKinds } from '@/lib/characters';
import { buildTree } from '@/lib/tree';
import { getWorldHeader } from '@/lib/groups';
import { AppHeader } from '../../../AppHeader';
import { NoteTabBar } from '../../../NoteTabBar';
import { SidebarHeader } from '../../../SidebarHeader';
import { SidebarFooter } from '../../../SidebarFooter';
import { FileTree } from '../../../notes/FileTree';
import { NoteMenu } from '../../../notes/NoteMenu';
import { NoteWorkspace } from '../../../notes/NoteWorkspace';
import { TagEditor } from '../../../notes/TagEditor';
import { NoteSidebar, extractOutline } from '../../../notes/NoteSidebar';
import { ChatPane } from '../../../ChatPane';

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
  if (!session) notFound();

  const note = loadNote(session.currentGroupId, path);
  if (!note) notFound();

  const worldHeader = getWorldHeader(session.currentGroupId);
  const accentColor = worldHeader.headerColor;

  const tree = buildTree(session.currentGroupId);
  const kindMap = Object.fromEntries(listNoteKinds(session.currentGroupId));
  const backlinks = loadBacklinks(session.currentGroupId, path);
  const outgoingLinks = loadOutgoingLinks(session.currentGroupId, path);
  const tags = loadTags(session.currentGroupId, path);
  const creator = note.created_by ? loadUser(note.created_by) : null;

  const character = resolveCharacterView({
    frontmatterJson: note.frontmatter_json,
    path,
    sessionRole: session.role,
    sessionUsername: session.username,
    sessionUserId: session.userId,
    createdBy: note.created_by,
  });

  let contentJson: unknown = null;
  try {
    contentJson = JSON.parse(note.content_json);
  } catch {
    contentJson = { type: 'doc', content: [] };
  }
  const outline = extractOutline(contentJson);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <AppHeader
        role={session.role}
        me={{
          userId: session.userId,
          displayName: session.displayName,
          username: session.username,
          accentColor: session.accentColor,
          avatarVersion: session.avatarVersion,
        }}
        csrfToken={session.csrfToken}
        canCreate={session.role !== 'viewer'}
        groupId={session.currentGroupId}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden h-full w-[260px] shrink-0 flex-col bg-[#EAE1CF]/60 md:flex">
          <SidebarHeader role={session.role} />
          <FileTree
            tree={tree}
            activePath={path}
            groupId={session.currentGroupId}
            csrfToken={session.csrfToken}
            canCreate={session.role !== 'viewer'}
            isWorldOwner={session.role === 'admin'}
            kindMap={kindMap}
          />
          <SidebarFooter username={session.username} />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NoteTabBar canCreate={session.role !== 'viewer'} csrfToken={session.csrfToken} />
          <div
            id="note-tools-anchor"
            className="relative grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px]"
          >
            <main
              className="relative flex justify-center overflow-y-auto overflow-x-hidden px-8 py-10"
              id="note-main"
            >
              <div id="note-scroll-body" className="relative w-[1600px] shrink-0 self-start">
                <div className="relative mx-auto max-w-[720px]">
                  <header className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-xs text-[#5A4F42]">
                      <code>{path}</code>
                    </p>
                    {canEditNote({
                      role: session.role,
                      userId: session.userId,
                      createdBy: note.created_by,
                      character,
                    }) && (
                      <div className="flex items-center gap-2">
                        {note.dm_only === 1 && (
                          <span
                            className="rounded-full border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8B4A52]"
                            title="Only admins and editors can see this note"
                          >
                            DM only
                          </span>
                        )}
                        <NoteMenu
                          path={path}
                          csrfToken={session.csrfToken}
                          dmOnly={note.dm_only === 1}
                        />
                      </div>
                    )}
                  </header>

                  <div className="mb-4">
                    {creator && note.created_at > 0 && (
                      <p className="mb-2 text-[11px] text-[#5A4F42]">
                        Created by{' '}
                        <span className="font-medium text-[#2A241E]">
                          {creator.displayName || creator.username}
                        </span>{' '}
                        · {formatCreatedAt(note.created_at)}
                      </p>
                    )}
                    <TagEditor
                      path={path}
                      initialTags={tags}
                      csrfToken={session.csrfToken}
                      canEdit={canEditNote({
                        role: session.role,
                        userId: session.userId,
                        createdBy: note.created_by,
                        character,
                      })}
                    />
                  </div>

                  <NoteWorkspace
                    path={path}
                    initialContent={contentJson as { type: string } & Record<string, unknown>}
                    user={{
                      userId: session.userId,
                      displayName: session.displayName,
                      accentColor: session.accentColor,
                      cursorMode: session.cursorMode,
                      avatarVersion: session.avatarVersion,
                    }}
                    canEdit={canEditNote({
                      role: session.role,
                      userId: session.userId,
                      createdBy: note.created_by,
                      character,
                    })}
                    csrfToken={session.csrfToken}
                    character={character}
                    accentColor={accentColor}
                  />
                </div>
              </div>
            </main>

            <aside className="hidden md:block">
              <NoteSidebar
                path={path}
                backlinks={backlinks}
                outgoingLinks={outgoingLinks}
                tags={tags}
                outline={outline}
                csrfToken={session.csrfToken}
              />
            </aside>
          </div>
        </div>

        <ChatPane
          groupId={session.currentGroupId}
          userId={session.userId}
          role={session.role === 'viewer' ? 'player' : 'dm'}
          {...(campaignSlugFromPath(path) !== undefined
            ? { campaignSlug: campaignSlugFromPath(path) }
            : {})}
        />
      </div>
    </div>
  );
}

function campaignSlugFromPath(path: string): string | undefined {
  return /^Campaigns\/([^/]+)\//.exec(path)?.[1];
}

function formatCreatedAt(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const CHARACTER_KINDS_BY_PATH: Array<[RegExp, TemplateKind]> = [
  [/(^|\/)characters\//i, 'pc'],
  [/(^|\/)enemies\//i, 'villain'],
  [/(^|\/)people\//i, 'npc'],
];

function resolveCharacterView(args: {
  frontmatterJson: string;
  path: string;
  sessionRole: 'admin' | 'editor' | 'viewer';
  sessionUsername: string;
  sessionUserId: string;
  createdBy: string | null;
}): CharacterView | null {
  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(args.frontmatterJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  let templateKind: TemplateKind;
  if (fm.kind === 'character') {
    templateKind = deriveRole(fm, args.path);
  } else if (
    fm.kind === 'item' ||
    fm.kind === 'location' ||
    fm.kind === 'monster' ||
    fm.kind === 'person' ||
    fm.kind === 'creature'
  ) {
    templateKind = fm.kind;
  } else {
    return null;
  }

  const template = getTemplate(templateKind);
  if (!template) return null;

  const sheet =
    fm.sheet && typeof fm.sheet === 'object'
      ? (fm.sheet as Record<string, unknown>)
      : {};

  const displayName = strOr(sheet.name) ?? filenameDisplayName(args.path);

  const portraitVault = strOr(fm.portrait);
  const portraitUrl = portraitVault
    ? `/api/assets/by-path?path=${encodeURIComponent(portraitVault)}`
    : null;

  const isOwner =
    templateKind === 'pc' &&
    typeof fm.player === 'string' &&
    fm.player.trim().toLowerCase() === args.sessionUsername.toLowerCase();
  const canWriteAll =
    args.sessionRole === 'admin' ||
    args.sessionRole === 'editor' ||
    args.createdBy === args.sessionUserId ||
    isOwner;

  return {
    roleLabel: ROLE_LABELS[templateKind],
    template,
    sheet,
    displayName,
    portraitUrl,
    canWriteAll,
    rawKind: typeof fm.kind === 'string' ? fm.kind : undefined,
  };
}

function deriveRole(
  fm: Record<string, unknown>,
  path: string,
): TemplateKind {
  if (typeof fm.role === 'string') {
    const r = fm.role as TemplateKind;
    if (['pc', 'npc', 'ally', 'villain'].includes(r)) return r;
  }
  for (const [re, kind] of CHARACTER_KINDS_BY_PATH) {
    if (re.test(path)) return kind;
  }
  return 'npc';
}

function canEditNote(args: {
  role: 'admin' | 'editor' | 'viewer';
  userId: string;
  createdBy: string | null;
  character: CharacterView | null;
}): boolean {
  if (args.role === 'admin' || args.role === 'editor') return true;
  if (args.createdBy === args.userId) return true;
  if (args.character?.canWriteAll) return true;
  return false;
}

function strOr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function filenameDisplayName(notePath: string): string {
  return (notePath.split('/').pop() ?? notePath).replace(/\.(md|canvas)$/i, '');
}

const ROLE_LABELS: Record<TemplateKind, string> = {
  character: 'Character',
  person: 'Person',
  creature: 'Creature',
  session: 'Session',
  item: 'Item',
  location: 'Location',
  pc: 'Player character',
  npc: 'NPC',
  ally: 'Ally',
  villain: 'Villain',
  monster: 'Monster',
};

export type CharacterView = {
  roleLabel: string;
  template: NoteTemplate;
  sheet: Record<string, unknown>;
  displayName: string;
  portraitUrl: string | null;
  canWriteAll: boolean;
  rawKind: string | undefined;
};
