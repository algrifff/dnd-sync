'use client';

// Left-sidebar folder tree. Server provides the full tree payload;
// this component handles interaction: expand/collapse, active-path
// highlight, localStorage persistence, keyboard nav, and a Notion-
// style hover "+" affordance that creates a new page in the
// matching folder.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, Plus, FolderPlus } from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';
import { RowMenu } from './RowMenu';

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
  const [creatingIn, setCreatingIn] = useState<
    { parent: string; kind: 'page' | 'folder' } | null
  >(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // HTML5 DnD. dragging = the source row; dragOver = the folder path
  // currently being hovered, or '' for the implicit root drop zone.
  const [dragging, setDragging] = useState<
    { kind: 'file' | 'folder'; path: string } | null
  >(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

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
    (parent: string, kind: 'page' | 'folder') => {
      setError(null);
      setCreatingIn({ parent, kind });
      // Ensure the target folder is expanded so the inline row is
      // visible immediately.
      if (parent) {
        setOpen((prev) => new Set(prev).add(parent));
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

  const createFolder = useCallback(
    async (parent: string, name: string) => {
      if (!name.trim()) return;
      setCreating(true);
      setError(null);
      try {
        const res = await fetch('/api/folders/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ parent, name: name.trim() }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          setError(
            body.error === 'exists'
              ? 'A folder with that name already exists.'
              : (body.error ?? `HTTP ${res.status}`),
          );
          return;
        }
        setCreatingIn(null);
        setOpen((prev) => new Set(prev).add(body.path));
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      } finally {
        setCreating(false);
      }
    },
    [csrfToken, router],
  );

  const submitRename = useCallback(
    async (kind: 'file' | 'folder', from: string, newName: string) => {
      const clean = newName.trim();
      if (!clean) return;
      const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      const to =
        kind === 'file'
          ? (parent ? parent + '/' : '') +
            clean.replace(/\.(md|canvas)$/i, '') +
            '.md'
          : (parent ? parent + '/' : '') + clean;
      if (to === from) {
        setRenamingPath(null);
        return;
      }
      setRenaming(true);
      setError(null);
      try {
        const url = kind === 'file' ? '/api/notes/move' : '/api/folders/move';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ from, to }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          setError(
            body.error === 'exists'
              ? 'That name is already taken.'
              : (body.error ?? `HTTP ${res.status}`),
          );
          return;
        }
        setRenamingPath(null);
        // If the rename targeted the currently-open note, route there.
        if (kind === 'file' && activePath === from) {
          router.push('/notes/' + to.split('/').map(encodeURIComponent).join('/'));
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      } finally {
        setRenaming(false);
      }
    },
    [activePath, csrfToken, router],
  );

  const moveEntry = useCallback(
    async (
      src: { kind: 'file' | 'folder'; path: string },
      destFolder: string,
    ): Promise<void> => {
      const basename = src.path.includes('/')
        ? src.path.slice(src.path.lastIndexOf('/') + 1)
        : src.path;
      const to = (destFolder ? destFolder + '/' : '') + basename;
      if (to === src.path) return;

      // Can't move a folder into itself or one of its own descendants.
      if (src.kind === 'folder') {
        if (destFolder === src.path) return;
        if (destFolder.startsWith(src.path + '/')) return;
      }

      const url = src.kind === 'file' ? '/api/notes/move' : '/api/folders/move';
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ from: src.path, to }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          alert(
            body.error === 'exists'
              ? `"${basename}" already exists in that folder.`
              : (body.error ?? `Move failed (HTTP ${res.status})`),
          );
          return;
        }
        // Expand the destination so the user sees where things landed.
        if (destFolder) {
          setOpen((prev) => new Set(prev).add(destFolder));
        }
        if (src.kind === 'file' && activePath === src.path) {
          router.push('/notes/' + to.split('/').map(encodeURIComponent).join('/'));
        }
        router.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    },
    [activePath, csrfToken, router],
  );

  const items = useMemo(() => flatten(tree.root, open, 0), [tree.root, open]);

  return (
    <nav
      aria-label="Note tree"
      className="min-h-0 flex-1 overflow-y-auto py-3 text-sm"
    >
      {canCreate && (
        <div className="mb-1 flex items-center gap-1 px-2">
          <button
            type="button"
            onClick={() => startCreate('', 'page')}
            className="flex flex-1 items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
          >
            <Plus size={14} aria-hidden />
            <span>New page</span>
          </button>
          <button
            type="button"
            onClick={() => startCreate('', 'folder')}
            title="New folder"
            aria-label="New folder"
            className="rounded-[6px] p-1.5 text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]"
          >
            <FolderPlus size={14} aria-hidden />
          </button>
        </div>
      )}

      {creatingIn?.parent === '' && (
        <div className="mb-1 px-2">
          <NewEntryRow
            kind={creatingIn.kind}
            depth={0}
            disabled={creating}
            error={error}
            onCancel={cancelCreate}
            onSubmit={(name) =>
              creatingIn.kind === 'page'
                ? createNote('', name)
                : createFolder('', name)
            }
          />
        </div>
      )}

      <ul
        role="tree"
        className={
          'px-2 ' +
          (dragging && dragOver === '' ? 'rounded-[6px] bg-[#D4A85A]/10' : '')
        }
        onDragOver={(e) => {
          if (!dragging) return;
          // A child (folder row) may have already set a more-specific
          // target; only claim root when no one's consumed it yet.
          if (e.defaultPrevented) return;
          e.preventDefault();
          setDragOver('');
        }}
        onDragLeave={(e) => {
          // Only clear when leaving the ul entirely.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOver(null);
          }
        }}
        onDrop={(e) => {
          if (!dragging) return;
          if (e.defaultPrevented) return;
          e.preventDefault();
          void moveEntry(dragging, '');
          setDragging(null);
          setDragOver(null);
        }}
      >
        {items.map((item) => (
          <TreeRow
            key={item.key}
            item={item}
            activePath={activePath}
            canCreate={canCreate}
            csrfToken={csrfToken}
            isRenaming={renamingPath === item.path}
            renameDisabled={renaming}
            renameError={renamingPath === item.path ? error : null}
            dragging={dragging}
            isDropTarget={item.kind === 'dir' && dragOver === item.path}
            onDragStartRow={(src) => setDragging(src)}
            onDragEndRow={() => {
              setDragging(null);
              setDragOver(null);
            }}
            onDragOverDir={(dirPath) => setDragOver(dirPath)}
            onDropDir={(dirPath) => {
              if (!dragging) return;
              void moveEntry(dragging, dirPath);
              setDragging(null);
              setDragOver(null);
            }}
            onToggle={toggle}
            onStartCreate={startCreate}
            onStartRename={() => {
              setError(null);
              setRenamingPath(item.path);
            }}
            onCancelRename={() => {
              setRenamingPath(null);
              setError(null);
            }}
            onSubmitRename={(name) =>
              submitRename(item.kind === 'dir' ? 'folder' : 'file', item.path, name)
            }
          >
            {item.kind === 'dir' && creatingIn?.parent === item.path ? (
              <NewEntryRow
                kind={creatingIn.kind}
                depth={item.depth + 1}
                disabled={creating}
                error={error}
                onCancel={cancelCreate}
                onSubmit={(name) =>
                  creatingIn.kind === 'page'
                    ? createNote(item.path, name)
                    : createFolder(item.path, name)
                }
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
  csrfToken,
  isRenaming,
  renameDisabled,
  renameError,
  dragging,
  isDropTarget,
  onDragStartRow,
  onDragEndRow,
  onDragOverDir,
  onDropDir,
  onToggle,
  onStartCreate,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  children,
}: {
  item: FlatRow;
  activePath: string;
  canCreate: boolean;
  csrfToken: string;
  isRenaming: boolean;
  renameDisabled: boolean;
  renameError: string | null;
  dragging: { kind: 'file' | 'folder'; path: string } | null;
  isDropTarget: boolean;
  onDragStartRow: (src: { kind: 'file' | 'folder'; path: string }) => void;
  onDragEndRow: () => void;
  onDragOverDir: (dirPath: string) => void;
  onDropDir: (dirPath: string) => void;
  onToggle: (path: string) => void;
  onStartCreate: (folder: string, kind: 'page' | 'folder') => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: (name: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const rowDragProps = canCreate
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.effectAllowed = 'move';
          // Some browsers require setData to initiate a drag.
          e.dataTransfer.setData('text/plain', item.path);
          onDragStartRow({
            kind: item.kind === 'dir' ? 'folder' : 'file',
            path: item.path,
          });
        },
        onDragEnd: () => onDragEndRow(),
      }
    : {};

  const isInvalidDrop =
    !dragging ||
    item.kind !== 'dir' ||
    (dragging.kind === 'folder' &&
      (dragging.path === item.path ||
        item.path.startsWith(dragging.path + '/') ||
        dragging.path === item.path));
  const dirDropProps =
    item.kind === 'dir'
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (isInvalidDrop) return;
            e.preventDefault();
            e.stopPropagation();
            onDragOverDir(item.path);
          },
          onDrop: (e: React.DragEvent) => {
            if (isInvalidDrop) return;
            e.preventDefault();
            e.stopPropagation();
            onDropDir(item.path);
          },
        }
      : {};
  const padding = 8 + item.depth * 14;

  if (item.kind === 'dir') {
    if (isRenaming) {
      return (
        <li role="treeitem" className="list-none">
          <NewEntryRow
            kind="folder"
            depth={item.depth}
            disabled={renameDisabled}
            error={renameError}
            initialValue={item.name}
            onCancel={onCancelRename}
            onSubmit={onSubmitRename}
          />
          {children}
        </li>
      );
    }
    return (
      <li role="treeitem" aria-expanded={item.open} className="list-none">
        <div
          {...rowDragProps}
          {...dirDropProps}
          className={
            'group flex items-center rounded-[6px] transition ' +
            (isDropTarget
              ? 'bg-[#8B4A52]/15 ring-1 ring-[#8B4A52]/40'
              : 'hover:bg-[#D4A85A]/15')
          }
        >
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
            <div className="mr-1 hidden items-center gap-0.5 group-hover:flex">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartCreate(item.path, 'page');
                }}
                className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E]"
                title={`New page in ${item.name}`}
                aria-label={`New page in ${item.name}`}
              >
                <Plus size={14} aria-hidden />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onStartCreate(item.path, 'folder');
                }}
                className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E]"
                title={`New folder in ${item.name}`}
                aria-label={`New folder in ${item.name}`}
              >
                <FolderPlus size={14} aria-hidden />
              </button>
              <RowMenu
                kind="folder"
                path={item.path}
                csrfToken={csrfToken}
                onStartRename={onStartRename}
              />
            </div>
          )}
        </div>
        {children}
      </li>
    );
  }
  if (isRenaming) {
    return (
      <li role="treeitem" className="list-none">
        <NewEntryRow
          kind="page"
          depth={item.depth}
          disabled={renameDisabled}
          error={renameError}
          initialValue={item.title || item.name}
          onCancel={onCancelRename}
          onSubmit={onSubmitRename}
        />
      </li>
    );
  }
  const isActive = item.path === activePath;
  const href = '/notes/' + item.path.split('/').map(encodeURIComponent).join('/');
  return (
    <li role="treeitem" className="list-none">
      <div
        {...rowDragProps}
        className={
          'group flex items-center rounded-[6px] transition ' +
          (isActive ? 'bg-[#D4A85A]/25' : 'hover:bg-[#D4A85A]/10')
        }
      >
        <Link
          href={href}
          className={
            'flex min-w-0 flex-1 items-center gap-1 px-2 py-1 ' +
            (isActive ? 'text-[#2A241E]' : 'text-[#5A4F42]')
          }
          style={{ paddingLeft: padding + 14 }}
        >
          <span className="truncate">{item.title || item.name}</span>
        </Link>
        {canCreate && (
          <div className="mr-1 hidden items-center group-hover:flex">
            <RowMenu
              kind="file"
              path={item.path}
              csrfToken={csrfToken}
              onStartRename={onStartRename}
            />
          </div>
        )}
      </div>
    </li>
  );
}

function NewEntryRow({
  kind,
  depth,
  disabled,
  error,
  initialValue,
  onSubmit,
  onCancel,
}: {
  kind: 'page' | 'folder';
  depth: number;
  disabled: boolean;
  error: string | null;
  initialValue?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>(
    initialValue ?? (kind === 'page' ? 'Untitled' : 'New folder'),
  );

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
          placeholder={kind === 'page' ? 'Untitled' : 'New folder'}
          className="flex-1 border-0 bg-transparent px-0 text-sm text-[#2A241E] outline-none placeholder:text-[#5A4F42]/60 disabled:opacity-60"
        />
      </form>
      {error && (
        <p className="ml-[30px] mt-1 text-xs text-[#8B4A52]">{error}</p>
      )}
    </div>
  );
}
