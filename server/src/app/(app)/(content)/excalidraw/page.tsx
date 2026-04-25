// Excalidraw section landing page — lists every kind:excalidraw note
// under the Excalidraw/ top-level folder, with a button to spawn a
// new drawing. Admins see two sections: GM-only drawings (gm_only=1)
// and shared drawings. Players only see shared drawings.

import type { ReactElement } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { PenTool } from 'lucide-react';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { getWorldFeatures } from '@/lib/groups';
import { NewDrawingButton } from '../../../excalidraw/NewDrawingButton';

export const dynamic = 'force-dynamic';

type Row = { path: string; title: string; updated_at: number; gm_only: number };

export default async function ExcalidrawIndexPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/excalidraw');

  const features = getWorldFeatures(session.currentGroupId);
  if (!features.excalidraw) notFound();

  const isAdmin = session.role === 'admin';
  const rows = getDb()
    .query<Row, [string]>(
      `SELECT path, title, updated_at, gm_only
         FROM notes
        WHERE group_id = ?
          AND path LIKE 'Excalidraw/%'
          AND json_extract(frontmatter_json, '$.kind') = 'excalidraw'
        ORDER BY updated_at DESC`,
    )
    .all(session.currentGroupId);

  const visible = isAdmin ? rows : rows.filter((r) => r.gm_only !== 1);
  const gmOnly = visible.filter((r) => r.gm_only === 1);
  const shared = visible.filter((r) => r.gm_only !== 1);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div>
            <h1
              className="mb-1 text-3xl font-bold"
              style={{ fontFamily: '"Fraunces", Georgia, serif' }}
            >
              Excalidraw
            </h1>
            <p className="text-sm text-[var(--ink-soft)]">
              Drawings and whiteboards for this world.
            </p>
          </div>
          {session.role !== 'viewer' && (
            <NewDrawingButton csrfToken={session.csrfToken} />
          )}
        </header>

        {visible.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--rule)] bg-[var(--parchment-sunk)]/40 p-8 text-center text-sm text-[var(--ink-soft)]">
            No drawings yet. Click <strong>New drawing</strong> to start one.
          </p>
        ) : (
          <div className="flex flex-col gap-8">
            {isAdmin && (
              <Section
                title="GM only"
                blurb="Drawings created in GM mode. Hidden from players."
                drawings={gmOnly}
                emptyHint="No GM-only drawings. Toggle GM mode and create one."
              />
            )}
            <Section
              title={isAdmin ? 'Shared with players' : 'Drawings'}
              blurb={
                isAdmin
                  ? 'Drawings created in player mode. Visible to everyone.'
                  : undefined
              }
              drawings={shared}
              emptyHint="No shared drawings yet."
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  blurb,
  drawings,
  emptyHint,
}: {
  title: string;
  blurb?: string | undefined;
  drawings: Row[];
  emptyHint: string;
}): ReactElement {
  return (
    <section>
      <header className="mb-2">
        <h2
          className="text-lg font-semibold text-[var(--ink)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          {title}
        </h2>
        {blurb && <p className="text-xs text-[var(--ink-soft)]">{blurb}</p>}
      </header>
      {drawings.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--rule)] bg-[var(--parchment-sunk)]/40 p-4 text-center text-xs text-[var(--ink-soft)]">
          {emptyHint}
        </p>
      ) : (
        <ul className="grid gap-2">
          {drawings.map((d) => (
            <li key={d.path}>
              <Link
                href={'/notes/' + d.path.split('/').map(encodeURIComponent).join('/')}
                className="flex items-center gap-3 rounded-md border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 hover:bg-[var(--parchment-sunk)]/50"
              >
                <PenTool size={16} className="shrink-0 text-[var(--ink-soft)]" aria-hidden />
                <span className="flex-1 truncate font-medium text-[var(--ink)]">
                  {d.title || d.path.split('/').pop()}
                </span>
                {d.gm_only === 1 && (
                  <span className="rounded-full bg-[var(--wine)]/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--wine)]">
                    GM
                  </span>
                )}
                <span className="text-[11px] text-[var(--ink-soft)]">
                  {new Date(d.updated_at).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
