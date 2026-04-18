'use client';

// Left-sidebar folder tree. Server provides the full tree payload;
// this component handles interaction: expand/collapse, active-path
// highlight, localStorage persistence, keyboard nav.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';

const STORAGE_KEY = 'compendium.tree.open';

export function FileTree({
  tree,
  activePath,
  groupId,
}: {
  tree: Tree;
  activePath: string;
  groupId: string;
}): React.JSX.Element {
  const storageKey = `${STORAGE_KEY}.${groupId}`;
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // Rehydrate from localStorage on mount only; SSR doesn't have window.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) setOpen(new Set(parsed.filter((x): x is string => typeof x === 'string')));
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  // Always expand ancestors of the active path so navigating a link
  // never hides the current row.
  useEffect(() => {
    if (!activePath) return;
    setOpen((prev) => {
      const next = new Set(prev);
      const parts = activePath.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        next.add(parts.slice(0, i + 1).join('/'));
      }
      return next;
    });
  }, [activePath]);

  const toggle = useCallback(
    (path: string) => {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* quota / private-mode; ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const items = useMemo(() => flatten(tree.root, open, 0), [tree.root, open]);

  return (
    <nav
      aria-label="Note tree"
      className="h-full overflow-y-auto border-r border-[#D4C7AE] bg-[#EAE1CF]/60 py-3 text-sm"
    >
      <ul role="tree" className="px-2">
        {items.map((item) => (
          <TreeRow
            key={item.key}
            item={item}
            activePath={activePath}
            onToggle={toggle}
          />
        ))}
      </ul>
    </nav>
  );
}

type FlatRow =
  | { kind: 'dir'; key: string; name: string; path: string; depth: number; open: boolean; hasChildren: boolean }
  | { kind: 'file'; key: string; name: string; path: string; title: string; depth: number };

function flatten(dir: TreeDir, openSet: Set<string>, depth: number): FlatRow[] {
  const out: FlatRow[] = [];
  for (const child of dir.children) {
    if (child.kind === 'dir') {
      const isOpen = openSet.has(child.path);
      out.push({
        kind: 'dir',
        key: 'dir:' + child.path,
        name: child.name,
        path: child.path,
        depth,
        open: isOpen,
        hasChildren: child.children.length > 0,
      });
      if (isOpen) out.push(...flatten(child, openSet, depth + 1));
    } else {
      out.push({
        kind: 'file',
        key: 'file:' + child.path,
        name: prettyName(child.name),
        path: child.path,
        title: child.title,
        depth,
      });
    }
  }
  return out;
}

function prettyName(fileName: string): string {
  return fileName.replace(/\.(md|canvas)$/i, '');
}

function TreeRow({
  item,
  activePath,
  onToggle,
}: {
  item: FlatRow;
  activePath: string;
  onToggle: (path: string) => void;
}): React.JSX.Element {
  const padding = 8 + item.depth * 14;

  if (item.kind === 'dir') {
    return (
      <li role="treeitem" aria-expanded={item.open} className="list-none">
        <button
          type="button"
          onClick={() => onToggle(item.path)}
          className="flex w-full items-center gap-1 rounded-[6px] px-2 py-1 text-left text-[#5A4F42] transition hover:bg-[#D4A85A]/15"
          style={{ paddingLeft: padding }}
        >
          <ChevronRight
            size={14}
            className="transition"
            style={{ transform: item.open ? 'rotate(90deg)' : 'none' }}
            aria-hidden
          />
          <span className="truncate font-medium">{item.name}</span>
        </button>
      </li>
    );
  }
  const isActive = item.path === activePath;
  const href = '/notes/' + item.path.split('/').map(encodeURIComponent).join('/');
  return (
    <li role="treeitem" className="list-none">
      <Link
        href={href}
        className={
          'flex items-center gap-1 rounded-[6px] px-2 py-1 transition ' +
          (isActive
            ? 'bg-[#D4A85A]/25 text-[#2A241E]'
            : 'text-[#5A4F42] hover:bg-[#D4A85A]/10')
        }
        style={{ paddingLeft: padding + 14 }}
      >
        <span className="truncate">{item.title || item.name}</span>
      </Link>
    </li>
  );
}
