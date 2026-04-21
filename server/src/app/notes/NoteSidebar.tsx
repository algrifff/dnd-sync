// Right-rail sidebar: backlinks (flat list), tags, outline, mini-graph.
// Server component for everything data-driven; the Add-link affordance
// + mini-graph are tiny client islands.

import type { ReactElement } from 'react';
import Link from 'next/link';
import type { BacklinkRow, OutgoingLinkRow } from '@/lib/notes';
import { MiniGraph } from './MiniGraph';
import { AddBacklink } from './AddBacklink';

export type OutlineItem = { level: number; text: string };

export function NoteSidebar({
  path,
  backlinks,
  outgoingLinks,
  tags,
  outline,
  csrfToken,
}: {
  path: string;
  backlinks: BacklinkRow[];
  outgoingLinks: OutgoingLinkRow[];
  tags: string[];
  outline: OutlineItem[];
  csrfToken: string;
}): ReactElement {
  return (
    <aside className="h-full overflow-y-auto border-l border-[#D4C7AE] bg-[#EAE1CF]/40 px-4 py-4 text-sm">
      <Section
        title="Backlinks"
        empty="No backlinks yet."
        actions={<AddBacklink currentPath={path} csrfToken={csrfToken} />}
      >
        {backlinks.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {backlinks.map((b) => (
              <li key={b.from_path}>
                <Link
                  href={'/notes/' + encodePath(b.from_path)}
                  title={b.from_path}
                  className="inline-block max-w-full truncate rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2.5 py-0.5 text-xs text-[#2A241E] transition hover:-translate-y-px hover:border-[#D4A85A] hover:bg-[#F4EDE0]"
                >
                  {b.title || baseName(b.from_path)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Links to" empty="No outgoing links.">
        {outgoingLinks.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {outgoingLinks.map((l) => (
              <li key={l.to_path}>
                <Link
                  href={'/notes/' + encodePath(l.to_path)}
                  title={l.to_path}
                  className="inline-block max-w-full truncate rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2.5 py-0.5 text-xs text-[#2A241E] transition hover:-translate-y-px hover:border-[#D4A85A] hover:bg-[#F4EDE0]"
                >
                  {l.title || baseName(l.to_path)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Tags" empty="No tags.">
        {tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <li key={t}>
                <Link
                  href={'/tags/' + encodeURIComponent(t)}
                  className="inline-block rounded-full border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-2.5 py-0.5 text-xs font-medium text-[#5E3A3F] transition hover:-translate-y-px hover:bg-[#8B4A52]/20 hover:text-[#4A2E32]"
                >
                  #{t}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Outline" empty="No headings.">
        {outline.length > 0 && (
          <ul className="space-y-0.5">
            {outline.map((h, i) => (
              <li
                key={i}
                className="truncate text-[#5A4F42]"
                style={{ paddingLeft: `${(h.level - 1) * 10}px` }}
              >
                {h.text}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Graph">
        <MiniGraph path={path} />
        <p className="mt-2 text-xs text-[#5A4F42]">
          Full graph →{' '}
          <Link href="/graph" className="underline">
            /graph
          </Link>
        </p>
      </Section>
    </aside>
  );
}

function Section({
  title,
  empty,
  actions,
  children,
}: {
  title: string;
  empty?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}): ReactElement {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
          {title}
        </h3>
        {actions}
      </div>
      {children ?? (empty ? <p className="text-xs text-[#5A4F42]/80">{empty}</p> : null)}
    </section>
  );
}

function baseName(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|canvas)$/i, '');
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

// Extract H1/H2/H3 outline from a stored ProseMirror JSON tree.
export function extractOutline(content: unknown): OutlineItem[] {
  const items: OutlineItem[] = [];
  walk(content, items);
  return items;
}

function walk(node: unknown, out: OutlineItem[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: unknown; content?: unknown; attrs?: { level?: unknown } };
  if (n.type === 'heading' && Array.isArray(n.content)) {
    const level = Number((n.attrs?.level as number | undefined) ?? 1);
    const text = plain(n.content).trim();
    if (text) out.push({ level, text });
    return;
  }
  if (Array.isArray(n.content)) {
    for (const c of n.content) walk(c, out);
  }
}

function plain(nodes: unknown[]): string {
  let s = '';
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const x = n as { type?: unknown; text?: unknown; content?: unknown };
    if (x.type === 'text' && typeof x.text === 'string') s += x.text;
    else if (Array.isArray(x.content)) s += plain(x.content);
  }
  return s;
}
