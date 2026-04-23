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
import { getWorldHeader } from '@/lib/groups';
import { NoteMenu } from '../../../../notes/NoteMenu';
import { NoteWorkspace } from '../../../../notes/NoteWorkspace';
import { TagEditor } from '../../../../notes/TagEditor';
import { NoteSidebar, extractOutline } from '../../../../notes/NoteSidebar';
import { ChatPane } from '../../../../ChatPane';
import { EndSessionButton } from '../../../../notes/EndSessionButton';
import { getSessionStatus } from '@/lib/sessions';
import { CollapsibleRightPanel } from '../../../../CollapsibleRightPanel';

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

  const rightPanelOpen = jar.get('compendium_rightpanel_open')?.value !== 'false';

  // Fan out the independent reads. bun:sqlite / better-sqlite3 are
  // synchronous, but Promise.all still lets the engine interleave
  // work (await microtask yields) and keeps us from blocking on a
  // slow query before a fast one can start. Tree + kindMap are owned
  // by the parent (content)/layout so this page only fetches the
  // note-specific payloads.
  const [worldHeader, backlinks, outgoingLinks, tags, creator] =
    await Promise.all([
      Promise.resolve(getWorldHeader(session.currentGroupId)),
      Promise.resolve(loadBacklinks(session.currentGroupId, path)),
      Promise.resolve(loadOutgoingLinks(session.currentGroupId, path)),
      Promise.resolve(loadTags(session.currentGroupId, path)),
      note.created_by
        ? Promise.resolve(loadUser(note.created_by))
        : Promise.resolve(null),
    ]);

  const accentColor = worldHeader.headerColor;

  // Parse frontmatter ONCE — character resolution, session detection,
  // and campaign-slug extraction all used to re-parse the same JSON.
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = JSON.parse(note.frontmatter_json) as Record<string, unknown>;
  } catch {
    /* corrupt frontmatter → treat as empty object */
  }

  const character = resolveCharacterView({
    frontmatter,
    path,
    sessionRole: session.role,
    sessionUsername: session.username,
    sessionUserId: session.userId,
    createdBy: note.created_by,
  });

  // Session-kind metadata — drives the End of Session button
  const noteKind: string | null =
    typeof frontmatter.kind === 'string' ? frontmatter.kind : null;
  const isSessionNote = noteKind === 'session';
  const canEdit = canEditNote({
    role: session.role,
    userId: session.userId,
    createdBy: note.created_by,
    character,
  });

  // Campaign slug for session end — from frontmatter.campaigns[0] or path
  let sessionCampaignSlug: string | undefined;
  let sessionStatus: 'open' | 'review' | 'closed' = 'open';
  if (isSessionNote) {
    const camps = Array.isArray(frontmatter.campaigns)
      ? frontmatter.campaigns
      : [];
    sessionCampaignSlug =
      typeof camps[0] === 'string'
        ? camps[0]
        : /^Campaigns\/([^/]+)\//.exec(path)?.[1];
    sessionStatus = getSessionStatus(session.currentGroupId, path);
  }

  let contentJson: unknown = null;
  try {
    contentJson = JSON.parse(note.content_json);
  } catch {
    contentJson = { type: 'doc', content: [] };
  }
  const outline = extractOutline(contentJson);

  return (
    <>
      <div
        id="note-tools-anchor"
        className="relative flex min-h-0 flex-1"
      >
        <main
          className="relative flex min-w-0 flex-1 justify-center overflow-y-auto overflow-x-hidden px-8 pt-10 pb-32"
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

                  {isSessionNote && canEdit && (
                    <EndSessionButton
                      sessionPath={path}
                      csrfToken={session.csrfToken}
                      isAlreadyClosed={sessionStatus === 'closed'}
                      campaignSlug={sessionCampaignSlug}
                    />
                  )}

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

        <CollapsibleRightPanel initialOpen={rightPanelOpen}>
          <NoteSidebar
            path={path}
            backlinks={backlinks}
            outgoingLinks={outgoingLinks}
            tags={tags}
            outline={outline}
            csrfToken={session.csrfToken}
          />
        </CollapsibleRightPanel>
      </div>

      {/* Fixed-position overlay — DOM location doesn't matter. Kept
           inside the page so props tied to the current note (activePath,
           campaignSlug, role) flow through cleanly without a client-side
           pathname derivation. */}
      <ChatPane
        groupId={session.currentGroupId}
        userId={session.userId}
        role={session.role === 'viewer' ? 'player' : 'dm'}
        activePath={path}
        {...(campaignSlugFromPath(path) !== undefined
          ? { campaignSlug: campaignSlugFromPath(path) }
          : {})}
      />
    </>
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
  frontmatter: Record<string, unknown>;
  path: string;
  sessionRole: 'admin' | 'editor' | 'viewer';
  sessionUsername: string;
  sessionUserId: string;
  createdBy: string | null;
}): CharacterView | null {
  const fm = args.frontmatter;

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
