'use client';

// One "Connections" panel for the note sidebar: typed Relationships, then
// plain Links (one list with a direction arrow). Replaces the separate
// Backlinks and Links-to panels (docs/adr/0003-connections-panel-and-
// manual-relationships.md). Sections with no rows are hidden. The x on a
// link row removes the plain link edge(s) and drops the row at once;
// router.refresh() then lets the server state catch up.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { BacklinkRow, OutgoingLinkRow } from '@/lib/notes';
import { AddBacklink } from './AddBacklink';
import { AddOutgoingLink } from './AddOutgoingLink';
import {
  ARROWS,
  baseName,
  encodePath,
  groupRelations,
  mergeLinks,
  relationProvenance,
  type LinkRow,
  type RelationRow,
} from './connections';

const LINK_CLASS = 'text-[var(--ink)] hover:text-[var(--candlelight)] hover:underline';

const ARROW_TITLES = {
  out: 'This note links to it',
  in: 'It links here',
  both: 'Linked both ways',
} as const;

export function ConnectionsPanel({
  relations,
  backlinks,
  outgoingLinks,
  currentPath,
  csrfToken,
}: {
  relations: RelationRow[];
  backlinks: BacklinkRow[];
  outgoingLinks: OutgoingLinkRow[];
  currentPath: string;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const groups = useMemo(() => groupRelations(relations), [relations]);
  const serverLinks = useMemo(
    () =>
      mergeLinks({
        currentPath,
        backlinks,
        outgoing: outgoingLinks,
        exclude: new Set(relations.map((r) => r.path)),
      }),
    [currentPath, backlinks, outgoingLinks, relations],
  );
  const [links, setLinks] = useState<LinkRow[]>(serverLinks);

  // Sync with the server after router.refresh() re-renders the parent.
  useEffect(() => {
    setLinks(serverLinks);
  }, [serverLinks]);

  const removeLink = useCallback(
    (row: LinkRow): void => {
      setLinks((prev) => prev.filter((l) => l.path !== row.path));
      void Promise.all(
        row.edges.map((edge) =>
          fetch('/api/notes/backlink', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify(edge),
          }),
        ),
      ).finally(() => {
        router.refresh();
      });
    },
    [csrfToken, router],
  );

  const empty = groups.length === 0 && links.length === 0;

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Connections
        </h3>
        <span className="flex items-center gap-1">
          <AddOutgoingLink currentPath={currentPath} csrfToken={csrfToken} />
          <AddBacklink currentPath={currentPath} csrfToken={csrfToken} />
        </span>
      </div>

      {empty && <p className="text-xs text-[var(--ink-soft)]/80">No connections yet.</p>}

      {groups.length > 0 && (
        <div className="mb-3">
          <SubHeading>Relationships</SubHeading>
          <div className="space-y-2">
            {groups.map((g) => (
              <div key={g.label}>
                <p className="text-xs font-medium text-[var(--ink-soft)]">{g.label}</p>
                <ul className="mt-0.5 space-y-1">
                  {g.rows.map((r) => (
                    <RelationItem key={r.relation + r.path} row={r} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {links.length > 0 && (
        <div className="mb-3">
          <SubHeading>Links</SubHeading>
          <ul className="space-y-0.5">
            {links.map((l) => (
              <li key={l.path} className="group flex items-center gap-1.5 text-xs">
                <span
                  className="w-3 shrink-0 text-center text-[var(--ink-soft)]"
                  title={ARROW_TITLES[l.direction]}
                >
                  {ARROWS[l.direction]}
                </span>
                <Link
                  href={'/notes/' + encodePath(l.path)}
                  title={l.path}
                  className={'min-w-0 truncate ' + LINK_CLASS}
                >
                  {l.title || baseName(l.path)}
                </Link>
                <button
                  type="button"
                  onClick={() => removeLink(l)}
                  title={`Remove link with ${baseName(l.path)}`}
                  aria-label={`Remove link with ${baseName(l.path)}`}
                  className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--ink-soft)] opacity-0 transition hover:bg-[var(--wine)]/15 hover:text-[var(--wine)] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X size={10} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-soft)]/70">
      {children}
    </h4>
  );
}

function RelationItem({ row }: { row: RelationRow }): React.JSX.Element {
  const provenance = relationProvenance(row);
  return (
    <li className="text-xs">
      <Link href={'/notes/' + encodePath(row.path)} title={row.path} className={LINK_CLASS}>
        {row.title || baseName(row.path)}
      </Link>
      {provenance && (
        <p className="text-[11px] text-[var(--ink-muted)]">
          {provenance.kind === 'session' ? (
            <>
              since{' '}
              <Link href={'/notes/' + encodePath(provenance.path)} className="underline">
                {provenance.title}
              </Link>
            </>
          ) : provenance.kind === 'hidden-session' ? (
            <>from a Session</>
          ) : (
            <>added by {provenance.name}</>
          )}
        </p>
      )}
    </li>
  );
}
