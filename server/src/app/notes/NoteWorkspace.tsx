'use client';

// Owns the Y.Doc + HocuspocusProvider for a note page and renders the
// Notion-style stack: title (Y.Text) → tags (REST) → body (Y.XmlFragment
// 'default'). Hoisting the provider here means all three views share
// one websocket connection and one CRDT identity.

import { useEffect, useMemo, useState } from 'react';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { TitleEditor } from './TitleEditor';
import { TagEditor } from './TagEditor';
import { NoteSurface, type SurfaceUser } from './NoteSurface';
import { PointerOverlay } from './PointerOverlay';
import { DrawingOverlay } from './DrawingOverlay';
import { CharacterSheet } from './CharacterSheet';
import type { NoteTemplate, TemplateSchema } from '@/lib/templates';

export type CharacterProp = {
  roleLabel: string;
  template: NoteTemplate;
  sheet: Record<string, unknown>;
  displayName: string;
  portraitUrl: string | null;
  canWriteAll: boolean;
};

export function NoteWorkspace({
  path,
  initialContent,
  initialTags,
  user,
  canEdit,
  csrfToken,
  creator,
  createdAt,
  character,
}: {
  path: string;
  initialContent: { type: string } & Record<string, unknown>;
  initialTags: string[];
  user: SurfaceUser;
  canEdit: boolean;
  csrfToken: string;
  creator: { displayName: string; username: string } | null;
  createdAt: number;
  character: CharacterProp | null;
}): React.JSX.Element {
  const ydoc = useMemo(() => new Y.Doc(), [path]);
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: buildCollabUrl(),
        name: path,
        document: ydoc,
      }),
    [path, ydoc],
  );

  const [connected, setConnected] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting',
  );
  const [authFailed, setAuthFailed] = useState<boolean>(false);

  useEffect(() => {
    const onStatus = ({ status }: { status: 'connected' | 'disconnected' | 'connecting' }) => {
      setConnected(status);
    };
    const onAuthFail = () => setAuthFailed(true);
    provider.on('status', onStatus);
    provider.on('authenticationFailed', onAuthFail);
    return () => {
      provider.off('status', onStatus);
      provider.off('authenticationFailed', onAuthFail);
    };
  }, [provider]);

  useEffect(() => {
    const p = provider;
    const d = ydoc;
    return () => {
      p.destroy();
      d.destroy();
    };
  }, [provider, ydoc]);

  const imageLayout = character?.template.schema.imageLayout ?? 'none';
  const quickSummary = character
    ? buildQuickSummary(character.template.schema, character.sheet)
    : [];

  return (
    <div className="relative">
      <div className="absolute right-0 top-0">
        <StatusDot state={authFailed ? 'error' : connected} />
      </div>

      {/* ── Note header ─────────────────────────────────────────── */}
      {imageLayout === 'avatar' && character ? (
        <div className="mb-4 flex items-start gap-5">
          <Avatar
            portraitUrl={character.portraitUrl}
            displayName={character.displayName}
          />
          <div className="min-w-0 flex-1 pt-1">
            <TitleEditor ydoc={ydoc} />
            <NoteMetaRow
              roleLabel={character.roleLabel}
              quickSummary={quickSummary}
              creator={creator}
              createdAt={createdAt}
            />
            <div className="mt-2">
              <TagEditor path={path} initialTags={initialTags} csrfToken={csrfToken} canEdit={canEdit} />
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-4">
          <TitleEditor ydoc={ydoc} />
          {character && (
            <NoteMetaRow
              roleLabel={character.roleLabel}
              quickSummary={quickSummary}
              creator={creator}
              createdAt={createdAt}
            />
          )}
          {!character && creator && createdAt > 0 && (
            <p className="mt-1 text-xs text-[#5A4F42]">
              Created by{' '}
              <span className="font-medium text-[#2A241E]">
                {creator.displayName || creator.username}
              </span>{' '}
              · {formatCreatedAt(createdAt)}
            </p>
          )}
          <div className="mt-2">
            <TagEditor path={path} initialTags={initialTags} csrfToken={csrfToken} canEdit={canEdit} />
          </div>
          {imageLayout === 'hero' && character?.portraitUrl && (
            <div className="mt-4 h-52 w-full overflow-hidden rounded-[12px] border border-[#D4C7AE]">
              <img
                src={character.portraitUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
          )}
        </div>
      )}

      {character && (
        <div className="mt-4">
          <CharacterSheet
            path={path}
            csrfToken={csrfToken}
            template={character.template}
            initialSheet={character.sheet}
            canWriteAll={character.canWriteAll}
            provider={provider}
          />
        </div>
      )}

      <NoteSurface
        path={path}
        ydoc={ydoc}
        provider={provider}
        initialContent={initialContent}
        user={user}
        canEdit={canEdit}
        csrfToken={csrfToken}
      />

      <PointerOverlay
        provider={provider}
        user={{
          userId: user.userId,
          name: user.displayName || 'Anonymous',
          color: user.accentColor,
          cursorMode: user.cursorMode,
          avatarVersion: user.avatarVersion,
        }}
        coordScopeId="note-scroll-body"
        viewportScopeId="note-main"
        virtualWidth={1600}
      />

      <DrawingOverlay provider={provider} user={{ userId: user.userId }} />

      {authFailed && (
        <p className="mt-4 rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-sm text-[#8B4A52]">
          Live collaboration couldn&apos;t authenticate. Sign out and back
          in, then refresh.
        </p>
      )}
    </div>
  );
}

function StatusDot({
  state,
}: {
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
}): React.JSX.Element {
  const map = {
    connecting: { color: '#D4A85A', title: 'Connecting live sync…' },
    connected: { color: '#7B8A5F', title: 'Live' },
    disconnected: { color: '#8B4A52', title: 'Disconnected — reconnecting…' },
    error: { color: '#8B4A52', title: 'Auth failed' },
  } as const;
  const { color, title } = map[state];
  return (
    <span
      title={title}
      aria-label={title}
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function formatCreatedAt(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function buildCollabUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost/collab';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/collab`;
}

function Avatar({
  portraitUrl,
  displayName,
}: {
  portraitUrl: string | null;
  displayName: string;
}): React.JSX.Element {
  return (
    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border-2 border-[#D4C7AE] bg-[#EAE1CF]">
      {portraitUrl ? (
        <img src={portraitUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[#5A4F42]">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}

function NoteMetaRow({
  roleLabel,
  quickSummary,
  creator,
  createdAt,
}: {
  roleLabel: string;
  quickSummary: string[];
  creator: { displayName: string; username: string } | null;
  createdAt: number;
}): React.JSX.Element {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#5A4F42]">
        {roleLabel}
      </span>
      {quickSummary.map((s) => (
        <span
          key={s}
          className="rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-0.5 text-[11px] text-[#2A241E]"
        >
          {s}
        </span>
      ))}
      {creator && createdAt > 0 && (
        <span className="text-[11px] text-[#5A4F42]">
          · {creator.displayName || creator.username} · {formatCreatedAt(createdAt)}
        </span>
      )}
    </div>
  );
}

/** Extract display strings for the fields listed in schema.headerFields. */
function buildQuickSummary(
  schema: TemplateSchema,
  sheet: Record<string, unknown>,
): string[] {
  if (!schema.headerFields?.length) return [];

  const fieldMap = new Map(
    schema.sections.flatMap((s) => s.fields.map((f) => [f.id, f])),
  );

  return schema.headerFields.flatMap((id) => {
    const field = fieldMap.get(id);
    const value = sheet[id];
    if (!field || value === null || value === undefined || value === '') return [];

    if (typeof value === 'number' && Number.isFinite(value)) {
      if (id === 'level') return [`Level ${Math.trunc(value)}`];
      if (id === 'session_number') return [`#${Math.trunc(value)}`];
      if (id === 'ac') return [`AC ${Math.trunc(value)}`];
      return [String(Math.trunc(value))];
    }
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    return [];
  });
}
