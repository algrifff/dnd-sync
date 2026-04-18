'use client';

// Left-sidebar folder tree. Server provides the full tree payload;
// this component handles interaction: expand/collapse, active-path
// highlight, localStorage persistence, keyboard nav, and a Notion-
// style hover "+" affordance that creates a new page in the
// matching folder.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus } from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';

const STORAGE_KEY = 'compendium.tree.open';

export function FileTree({
  tree,
  activePath,
  groupId,
  csrfToken,
  canCreate,
}: {
  tree: Tree;
  activePath: string;
  groupId: string;
  csrfToken: string;
  canCreate: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const storageKey = `${STORAGE_KEY}.${groupId}`;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        setOpen(new Set(parsed.filter((x): x is string => typeof x === 'string')));
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);

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

  const startCreate = useCallback(
    (folder: string) => {
      setError(null);
      setCreatingIn(folder);
      // Ensure the target folder is expanded so the inline row is
      // visible immediately.
      if (folder) {
        setOpen((prev) => new Set(prev).add(folder));
      }
    },
    [],
  );

  const cancelCreate = useCallback(() => {
    setCreatingIn(null);
    setError(null);
  }, []);

  const createNote = useCallback(
    async (folder: string, name: string) => {
      if (!name.trim()) return;
      setCreating(true);
      setError(null);
      try {
        const res = await fetch('/api/notes/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ folder, name: name.trim() }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          setError(body.error === 'exists' ? 'A note with that name already exists.' : (body.error ?? `HTTP ${res.status}`));
          return;
        }
        setCreatingIn(null);
        router.push('/notes/' + body.path.split('/').map(encodeURIComponent).join('/'));
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      } finally {
        setCreating(false);
      }
    },
    [csrfToken, router],
  );

  const items = useMemo(() => flatten(tree.root, open, 0), [tree.root, open]);

  return (
    <nav
      aria-label="Note tree"
      className="h-full overflow-y-auto border-r border-[#D4C7AE] bg-[#EAE1CF]/60 py-3 text-sm"
    >
      {canCreate && (
        <div className="mb-1 px-2">
          <button
            type="button"
            onClick={() => startCreate('')}
            className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
          >
            <Plus size={14} aria-hidden />
            <span>New page</span>
          </button>
        </div>
      )}

      {creatingIn === '' && (
        <div className="mb-1 px-2">
          <NewPageRow
            depth={0}
            disabled={creating}
            error={error}
            onCancel={cancelCreate}
            onSubmit={(name) => createNote('', name)}
          />
        </div>
      )}

      <ul role="tree" className="px-2">
        {items.map((item) => (
          <TreeRow
            key={item.key}
            item={item}
            activePath={activePath}
            canCreate={canCreate}
            onToggle={toggle}
            onStartCreate={startCreate}
          >
            {item.kind === 'dir' && creatingIn === item.path ? (
              <NewPageRow
                depth={item.depth + 1}
                disabled={creating}
                error={error}
                onCancel={cancelCreate}
                onSubmit={(name) => createNote(item.path, name)}
              />
            ) : null}
          </TreeRow>
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
  canCreate,
  onToggle,
  onStartCreate,
  children,
}: {
  item: FlatRow;
  activePath: string;
  canCreate: boolean;
  onToggle: (path: string) => void;
  onStartCreate: (folder: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const padding = 8 + item.depth * 14;

  if (item.kind === 'dir') {
    return (
      <li role="treeitem" aria-expanded={item.open} className="list-none">
        <div className="group flex items-center rounded-[6px] transition hover:bg-[#D4A85A]/15">
          <button
            type="button"
            onClick={() => onToggle(item.path)}
            className="flex flex-1 items-center gap-1 px-2 py-1 text-left text-[#5A4F42]"
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
          {canCreate && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStartCreate(item.path);
              }}
              className="mr-1 hidden rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E] group-hover:block"
              title={`New page in ${item.name}`}
              aria-label={`New page in ${item.name}`}
            >
              <Plus size={14} aria-hidden />
            </button>
          )}
        </div>
        {children}
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

function NewPageRow({
  depth,
  disabled,
  error,
  onSubmit,
  onCancel,
}: {
  depth: number;
  disabled: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>('Untitled');

  useEffect(() => {
    // Focus + select the default "Untitled" on mount so the user can
    // start typing immediately.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const padding = 8 + depth * 14;

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="flex items-center gap-1 rounded-[6px] bg-[#FBF5E8] px-2 py-1"
        style={{ paddingLeft: padding + 14 }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          disabled={disabled}
          placeholder="Untitled"
          className="flex-1 border-0 bg-transparent px-0 text-sm text-[#2A241E] outline-none placeholder:text-[#5A4F42]/60 disabled:opacity-60"
        />
      </form>
      {error && (
        <p className="ml-[30px] mt-1 text-xs text-[#8B4A52]">{error}</p>
      )}
    </div>
  );
}
