'use client';

// Left-sidebar folder tree. Server provides the full tree payload;
// this component handles interaction: expand/collapse, active-path
// highlight, localStorage persistence, keyboard nav, and a Notion-
// style hover "+" affordance that creates a new page in the
// matching folder.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderPlus,
  Heart,
  Map as MapIcon,
  Package,
  Plus,
  Skull,
  Sword,
  UserRound,
} from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';
import { WORLD_ROOT_PATH } from '@/lib/tree-constants';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { RowMenu } from './RowMenu';
import { PeerStack } from './PeerStack';

export type FileTreeKind = 'pc' | 'npc' | 'ally' | 'villain' | 'session';
type KindMap = Record<string, FileTreeKind>;
const KindMapContext = createContext<KindMap>({});

/** The synthetic World wrapper stands in for the vault root at the
 *  UI layer; any API that expects a folder path needs to see the
 *  real empty-string root instead of the sentinel. */
function resolveRealPath(p: string): string {
  return p === WORLD_ROOT_PATH ? '' : p;
}

/** Every kind the tree-level "+ New" dropdown can seed. Folder and
 *  page are handled inline; the rest go through /api/notes/create
 *  with a matching `kind` so frontmatter is pre-filled from the
 *  template. */
type CreateKind =
  | 'page'
  | 'folder'
  | 'pc'
  | 'npc'
  | 'ally'
  | 'villain'
  | 'item'
  | 'location';

const NEW_ENTRY_OPTIONS: Array<{
  kind: CreateKind;
  label: string;
  icon: typeof FileText;
  placeholder: string;
}> = [
  { kind: 'page', label: 'Page', icon: FileText, placeholder: 'Untitled' },
  { kind: 'folder', label: 'Folder', icon: FolderPlus, placeholder: 'New folder' },
  { kind: 'pc', label: 'Player character', icon: Sword, placeholder: 'New PC' },
  { kind: 'npc', label: 'NPC', icon: UserRound, placeholder: 'New NPC' },
  { kind: 'ally', label: 'Ally', icon: Heart, placeholder: 'New ally' },
  { kind: 'villain', label: 'Villain', icon: Skull, placeholder: 'New villain' },
  { kind: 'item', label: 'Item', icon: Package, placeholder: 'New item' },
  { kind: 'location', label: 'Location', icon: MapIcon, placeholder: 'New location' },
];

const STORAGE_KEY = 'compendium.tree.open';

export function FileTree({
  tree,
  activePath,
  groupId,
  csrfToken,
  canCreate,
  kindMap,
}: {
  tree: Tree;
  activePath: string;
  groupId: string;
  csrfToken: string;
  canCreate: boolean;
  /** Path → note kind. Rows with a kind get a small icon so the
   *  sidebar reads like a roster at a glance. */
  kindMap?: KindMap;
}): React.JSX.Element {
  const router = useRouter();
  const storageKey = `${STORAGE_KEY}.${groupId}`;
  // Seed the open set with the synthetic World node so the tree
  // starts expanded on first render. Restored sets from localStorage
  // may or may not carry it — we always re-add below after hydrating.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set([WORLD_ROOT_PATH]),
  );
  const [creatingIn, setCreatingIn] = useState<
    { parent: string; kind: CreateKind } | null
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
    (parent: string, kind: CreateKind) => {
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
    async (folder: string, name: string, kind: CreateKind = 'page') => {
      if (!name.trim()) return;
      setCreating(true);
      setError(null);
      try {
        const payload: Record<string, unknown> = {
          folder: resolveRealPath(folder),
          name: name.trim(),
        };
        // API treats missing kind as "page"; omitting keeps the log
        // clean for the common case.
        if (kind !== 'page') payload.kind = kind;
        const res = await fetch('/api/notes/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          path?: string;
          error?: string;
        };
        if (!res.ok || !body.ok || !body.path) {
          setError(
            body.error === 'exists'
              ? 'A note with that name already exists.'
              : body.error ?? `HTTP ${res.status}`,
          );
          return;
        }
        setCreatingIn(null);
        router.push(
          '/notes/' + body.path.split('/').map(encodeURIComponent).join('/'),
        );
        router.refresh();
        broadcastTreeChange();
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
          body: JSON.stringify({ parent: resolveRealPath(parent), name: name.trim() }),
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
        broadcastTreeChange();
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
        broadcastTreeChange();
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
      // The synthetic World node is a visual wrapper — dropping onto
      // it is a drop onto the real vault root.
      destFolder = resolveRealPath(destFolder);
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
        broadcastTreeChange();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    },
    [activePath, csrfToken, router],
  );

  const items = useMemo(() => flatten(tree.root, open, 0), [tree.root, open]);

  return (
    <KindMapContext.Provider value={kindMap ?? EMPTY_KIND_MAP}>
    <nav
      aria-label="Note tree"
      className="min-h-0 flex-1 overflow-y-auto border-r border-[#D4C7AE] py-3 text-sm"
    >
      {canCreate && (
        <div className="mb-1 px-2">
          <NewEntryDropdown
            onPick={(kind) => startCreate(WORLD_ROOT_PATH, kind)}
            variant="wide"
          />
        </div>
      )}

      {(creatingIn?.parent === '' ||
        creatingIn?.parent === WORLD_ROOT_PATH) && (
        <div className="mb-1 px-2">
          <NewEntryRow
            kind={creatingIn.kind}
            depth={0}
            disabled={creating}
            error={error}
            onCancel={cancelCreate}
            onSubmit={(name) => {
              if (creatingIn.kind === 'folder') createFolder('', name);
              else createNote('', name, creatingIn.kind);
            }}
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
                onSubmit={(name) => {
                  if (creatingIn.kind === 'folder') {
                    createFolder(item.path, name);
                  } else {
                    createNote(item.path, name, creatingIn.kind);
                  }
                }}
              />
            ) : null}
          </TreeRow>
        ))}
      </ul>
    </nav>
    </KindMapContext.Provider>
  );
}

const EMPTY_KIND_MAP: KindMap = {};

function KindIcon({ path }: { path: string }): React.JSX.Element | null {
  const kindMap = useContext(KindMapContext);
  const kind = kindMap[path];
  if (!kind) return null;
  const { icon: Icon, color, label } = KIND_META[kind];
  return (
    <span
      className="shrink-0"
      style={{ color }}
      aria-label={label}
      title={label}
    >
      <Icon size={12} aria-hidden />
    </span>
  );
}

const KIND_META: Record<
  FileTreeKind,
  { icon: typeof Sword; color: string; label: string }
> = {
  pc: { icon: Sword, color: '#7B8A5F', label: 'Player character' },
  ally: { icon: Heart, color: '#D4A85A', label: 'Ally' },
  villain: { icon: Skull, color: '#8B4A52', label: 'Villain' },
  npc: { icon: UserRound, color: '#6B7F8E', label: 'NPC' },
  session: { icon: CalendarDays, color: '#6A5D8B', label: 'Session' },
};

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
  onStartCreate: (folder: string, kind: CreateKind) => void;
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

  const isWorldRow = item.kind === 'dir' && item.path === WORLD_ROOT_PATH;

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
    // The World row is the synthetic vault anchor — not draggable,
    // no rename/delete, but still a drop target + a place to
    // create new top-level entries.
    const effectiveRowDragProps = isWorldRow ? {} : rowDragProps;
    return (
      <li role="treeitem" aria-expanded={item.open} className="list-none">
        <div
          {...effectiveRowDragProps}
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
              <NewEntryDropdown
                onPick={(kind) => onStartCreate(item.path, kind)}
                variant="compact"
                folderName={item.name}
              />
              {!isWorldRow && (
                <RowMenu
                  kind="folder"
                  path={item.path}
                  csrfToken={csrfToken}
                  onStartRename={onStartRename}
                />
              )}
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
          <KindIcon path={item.path} />
          <span className="truncate">{item.title || item.name}</span>
          <PeerStack notePath={item.path} />
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

function NewEntryDropdown({
  onPick,
  variant,
  folderName,
}: {
  onPick: (kind: CreateKind) => void;
  variant: 'wide' | 'compact';
  folderName?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={folderName ? `New in ${folderName}` : 'New entry'}
        aria-label={folderName ? `New in ${folderName}` : 'New entry'}
        className={
          variant === 'wide'
            ? 'flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E]'
            : 'flex items-center gap-0.5 rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#2A241E]/10 hover:text-[#2A241E]'
        }
      >
        <Plus size={14} aria-hidden />
        {variant === 'wide' && <span className="flex-1">New</span>}
        <ChevronDown size={12} aria-hidden className="opacity-70" />
      </button>
      {open && (
        <ul
          role="menu"
          className={
            'absolute z-30 w-44 overflow-hidden rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] py-0.5 shadow-[0_8px_24px_rgba(42,36,30,0.12)] ' +
            (variant === 'wide' ? 'left-0 top-full mt-1' : 'right-0 top-full mt-1')
          }
        >
          {NEW_ENTRY_OPTIONS.map(({ kind, label, icon: Icon }) => (
            <li key={kind}>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onPick(kind);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[#2A241E] transition hover:bg-[#D4A85A]/15"
              >
                <Icon size={12} aria-hidden className="text-[#5A4F42]" />
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  kind: CreateKind;
  depth: number;
  disabled: boolean;
  error: string | null;
  initialValue?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const placeholder =
    NEW_ENTRY_OPTIONS.find((o) => o.kind === kind)?.placeholder ?? 'Untitled';
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState<string>(initialValue ?? placeholder);

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
          placeholder={placeholder}
          className="flex-1 border-0 bg-transparent px-0 text-sm text-[#2A241E] outline-none placeholder:text-[#5A4F42]/60 disabled:opacity-60"
        />
      </form>
      {error && (
        <p className="ml-[30px] mt-1 text-xs text-[#8B4A52]">{error}</p>
      )}
    </div>
  );
}
