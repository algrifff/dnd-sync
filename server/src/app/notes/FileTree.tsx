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
import { usePathname, useRouter } from 'next/navigation';
import {
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Crown,
  FileText,
  FolderPlus,
  Ghost,
  Globe,
  Loader2,
  Lock,
  Map as MapIcon,
  MapPin,
  Package,
  PenTool,
  Plus,
  ScrollText,
  Shield,
  Skull,
  Sword,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import type { Tree, TreeDir } from '@/lib/tree';
import { broadcastTreeChange } from '@/lib/tree-sync';
import { canDropOn, isDraggableSource, isCampaignRoot, campaignRootSlug } from '@/lib/move-policy';
import { RowMenu } from './RowMenu';
import { CampaignRowMenu } from './CampaignRowMenu';
import { PeerStack } from './PeerStack';

export type FileTreeKind = 'pc' | 'npc' | 'ally' | 'villain' | 'session';
type KindMap = Record<string, FileTreeKind>;
const KindMapContext = createContext<KindMap>({});

/** Every kind the tree-level "+ New" dropdown can seed. Folder and
 *  page are handled inline; the rest go through /api/notes/create
 *  with a matching `kind` so frontmatter is pre-filled from the
 *  template. */
type CreateKind =
  | 'page'
  | 'folder'
  | 'campaign'
  | 'pc'
  | 'npc'
  | 'ally'
  | 'villain'
  | 'item'
  | 'location'
  | 'session'
  | 'monster'
  | 'quest'
  | 'excalidraw';

const NEW_ENTRY_OPTIONS: Array<{
  kind: CreateKind;
  label: string;
  icon: typeof FileText;
  placeholder: string;
}> = [
  { kind: 'session', label: 'Adventure log', icon: CalendarDays, placeholder: 'Session notes' },
  { kind: 'npc', label: 'Person', icon: UserRound, placeholder: 'New person' },
  { kind: 'villain', label: 'Enemy', icon: Skull, placeholder: 'New enemy' },
  { kind: 'item', label: 'Loot', icon: Package, placeholder: 'New item' },
  { kind: 'location', label: 'Place', icon: MapIcon, placeholder: 'New place' },
  { kind: 'monster', label: 'Creature', icon: Ghost, placeholder: 'New creature' },
  // kept for canonical subfolder + rename flows; not surfaced in general menus
  { kind: 'quest', label: 'Quest', icon: ScrollText, placeholder: 'Untitled quest' },
  { kind: 'page', label: 'Page', icon: FileText, placeholder: 'Untitled' },
  { kind: 'folder', label: 'Folder', icon: FolderPlus, placeholder: 'New folder' },
  { kind: 'campaign', label: 'New campaign', icon: Shield, placeholder: 'Campaign name' },
  { kind: 'pc', label: 'Player character', icon: Sword, placeholder: 'New PC' },
  { kind: 'ally', label: 'Ally', icon: UserRound, placeholder: 'New ally' },
  { kind: 'excalidraw', label: 'Drawing', icon: PenTool, placeholder: 'New drawing' },
];

/** Returns the subset of CreateKinds appropriate for a given folder path,
 *  plus optional label overrides. 'upload' is a special marker for the
 *  Assets section, handled via file input rather than a note kind. */
function getContextualOptions(folderPath: string | undefined, isWorldOwner: boolean): {
  kinds: CreateKind[];
  isUpload: boolean;
  labelOverrides: Partial<Record<CreateKind, string>>;
} {
  if (!folderPath) {
    return { kinds: ['session', 'npc', 'villain', 'item', 'location', 'monster'], isUpload: false, labelOverrides: {} };
  }

  // Assets section — file upload only
  if (folderPath === 'Assets' || folderPath.startsWith('Assets/')) {
    return { kinds: [], isUpload: true, labelOverrides: {} };
  }

  // Top-level Campaigns — only the world owner can spawn a new campaign.
  if (folderPath === 'Campaigns') {
    return {
      kinds: isWorldOwner ? ['campaign'] : [],
      isUpload: false,
      labelOverrides: {},
    };
  }

  // Campaign root (Campaigns/<slug>) — entity kinds only, no folder creation
  if (/^Campaigns\/[^/]+$/.test(folderPath)) {
    return { kinds: ['session', 'npc', 'villain', 'item', 'location', 'monster', 'quest'], isUpload: false, labelOverrides: {} };
  }

  // Per-campaign canonical sub-folders (and any depth within them)
  if (/^Campaigns\/[^/]+\/Characters(\/|$)/.test(folderPath))    return { kinds: ['pc', 'folder'],      isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/People(\/|$)/.test(folderPath))        return { kinds: ['npc', 'folder'],     isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/Enemies(\/|$)/.test(folderPath))       return { kinds: ['villain', 'folder'], isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/Loot(\/|$)/.test(folderPath))          return { kinds: ['item', 'folder'],    isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/Adventure Log(\/|$)/.test(folderPath)) return { kinds: ['session', 'folder'], isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/Places(\/|$)/.test(folderPath))        return { kinds: ['location', 'folder'],isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/Creatures(\/|$)/.test(folderPath))     return { kinds: ['monster', 'folder'], isUpload: false, labelOverrides: {} };
  if (/^Campaigns\/[^/]+\/Quests(\/|$)/.test(folderPath))        return { kinds: ['quest', 'folder'],   isUpload: false, labelOverrides: {} };

  // Excalidraw section — drawings + sub-folders
  if (folderPath === 'Excalidraw' || folderPath.startsWith('Excalidraw/')) {
    return { kinds: ['excalidraw', 'folder'], isUpload: false, labelOverrides: {} };
  }

  // World Lore section
  if (folderPath === 'World Lore') {
    return { kinds: ['page', 'folder'], isUpload: false, labelOverrides: {} };
  }
  if (folderPath === 'World Lore/World Info') {
    return { kinds: ['page', 'folder'], isUpload: false, labelOverrides: {} };
  }

  // Default
  return { kinds: ['session', 'npc', 'villain', 'item', 'location', 'monster'], isUpload: false, labelOverrides: {} };
}

type LucideIcon = typeof Sword;
type FolderIconDef = { Icon: LucideIcon; color: string };

function getFolderIcon(path: string): FolderIconDef | null {
  if (path === 'Assets') return { Icon: MapIcon, color: '#8B7355' };
  if (path === 'Excalidraw') return { Icon: PenTool, color: '#6A7A8B' };
  if (path === 'Campaigns') return { Icon: Shield, color: '#5A7A6A' };
  if (path === 'World Lore') return { Icon: BookOpen, color: '#7B5A8B' };
  if (path === 'World Lore/World Info') return { Icon: Globe, color: '#4A7A8B' };
  if (/^Campaigns\/[^/]+$/.test(path)) return { Icon: MapIcon, color: '#4A7A6A' };
  if (/^Campaigns\/[^/]+\/Characters$/.test(path))    return { Icon: Sword, color: 'var(--moss)' };
  if (/^Campaigns\/[^/]+\/People$/.test(path))        return { Icon: UserRound, color: 'var(--sage)' };
  if (/^Campaigns\/[^/]+\/Enemies$/.test(path))       return { Icon: Skull, color: 'var(--wine)' };
  if (/^Campaigns\/[^/]+\/Loot$/.test(path))          return { Icon: Package, color: '#7B6A5A' };
  if (/^Campaigns\/[^/]+\/Adventure Log$/.test(path)) return { Icon: CalendarDays, color: '#6A5D8B' };
  if (/^Campaigns\/[^/]+\/Places$/.test(path))        return { Icon: MapPin, color: '#5A7A6A' };
  if (/^Campaigns\/[^/]+\/Creatures$/.test(path))     return { Icon: Ghost, color: '#6B5A8E' };
  if (/^Campaigns\/[^/]+\/Quests$/.test(path))        return { Icon: ScrollText, color: '#8B7A45' };
  return null;
}

const STORAGE_KEY = 'compendium.tree.open';

export function FileTree({
  tree,
  activePath: activePathProp,
  groupId,
  csrfToken,
  canCreate,
  isWorldOwner,
  kindMap,
  activeCampaignSlug: activeCampaignSlugProp,
  sectionTone,
  storageNamespace,
}: {
  tree: Tree;
  /** Optional override. When omitted, the active path is derived from
   *  `usePathname()` so the tree can live in a persistent layout and
   *  still keep its row highlight in sync with the URL without
   *  re-mounting on every navigation. */
  activePath?: string;
  groupId: string;
  csrfToken: string;
  canCreate: boolean;
  /** True when the current user is the group admin. Gates actions
   *  reserved to the world owner (e.g. creating a new campaign). */
  isWorldOwner: boolean;
  /** Path → note kind. Rows with a kind get a small icon so the
   *  sidebar reads like a roster at a glance. */
  kindMap?: KindMap;
  /** Slug of the campaign pinned as the default for new sessions. */
  activeCampaignSlug?: string | null;
  /** Header chip + accent style. 'gm' = wine, 'players' = neutral.
   *  Omit when only one tree is visible (no chip). */
  sectionTone?: 'gm' | 'players';
  /** Suffix appended to localStorage open-state key so two trees
   *  visible at once don't share an open-set. */
  storageNamespace?: string;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  // Derive the active path from the URL when the caller hasn't passed
  // one explicitly. Keeps the tree's highlight + auto-expand in sync
  // with the current route even though the tree lives in a layout
  // that never unmounts across navigations.
  const activePath = activePathProp ?? decodeActiveNotePath(pathname);
  const storageKey = `${STORAGE_KEY}.${groupId}${storageNamespace ? '.' + storageNamespace : ''}`;

  // Optimistic local state for the pinned campaign — updated immediately
  // on crown click, synced to the server in the background.
  const [activeCampaignSlug, setActiveCampaignSlug] = useState<string | null>(
    activeCampaignSlugProp ?? null,
  );
  // Re-sync local optimistic state when the server-rendered prop
  // changes (e.g. another tab pinned a different campaign, or this
  // tab just renamed the active campaign and the slug rotated). The
  // useState seed only runs on mount so without this, the Crown
  // button appears unlit on the renamed-campaign row even though the
  // server has it pinned, and clicking it silently no-ops to itself.
  useEffect(() => {
    setActiveCampaignSlug(activeCampaignSlugProp ?? null);
  }, [activeCampaignSlugProp]);

  const toggleActiveCampaign = useCallback(
    async (slug: string): Promise<void> => {
      const next = activeCampaignSlug === slug ? null : slug;
      setActiveCampaignSlug(next);
      try {
        const res = await fetch(`/api/worlds/${encodeURIComponent(groupId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ activeCampaignSlug: next }),
        });
        if (!res.ok) {
          // Revert on failure.
          setActiveCampaignSlug(activeCampaignSlug);
        } else {
          router.refresh();
        }
      } catch {
        setActiveCampaignSlug(activeCampaignSlug);
      }
    },
    [activeCampaignSlug, groupId, csrfToken, router],
  );

  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [creatingIn, setCreatingIn] = useState<
    { parent: string; kind: CreateKind } | null
  >(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showCampaignDialog, setShowCampaignDialog] = useState<boolean>(false);

  // HTML5 DnD. dragging = the source row; dragOver = the folder path
  // currently being hovered, or '' for the implicit root drop zone.
  const [dragging, setDragging] = useState<
    { kind: 'file' | 'folder'; path: string } | null
  >(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Active reorder drop-gap. '' = trailing gap (drop at end), or the
  // slug whose row sits immediately *below* the gap. Only populated
  // while a campaign-root drag is in flight.
  const [dragOverGap, setDragOverGap] = useState<string | null>(null);
  // The path currently in flight from /api/notes/move or /api/folders/move.
  // Folder moves can take a couple of seconds when the subtree is large
  // (every nested note's path gets rewritten + the FTS row rebuilt) — show
  // a spinner on the source row so the drop doesn't feel like a no-op.
  // movingPath/movingTo drive the in-flight UI: the source row stays
  // EXACTLY where it was, gets a spinner overlay, and the rest of the
  // tree freezes in place until the refreshed tree (with the row at
  // its new home) arrives. This avoids the row disappearing → popping
  // back → relocating sequence the optimistic-filter approach caused.
  // moveBaselineAt is the tree.updatedAt observed at the moment the
  // move started; the effect below clears the spinner once tree.updatedAt
  // advances past it (i.e. the server's bumped value lands).
  const [movingPath, setMovingPath] = useState<string | null>(null);
  const [movingTo, setMovingTo] = useState<string | null>(null);
  const [moveBaselineAt, setMoveBaselineAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        setOpen(new Set(parsed.filter((x): x is string => typeof x === 'string')));
        return;
      }
    } catch {
      /* ignore */
    }
    // First visit for this world — seed the persisted open-set with
    // every campaign subfolder so the whole Campaigns tree is visible
    // by default. After this, toggles from the user are respected.
    const defaults = new Set<string>();
    const walk = (dir: TreeDir): void => {
      for (const child of dir.children) {
        if (child.kind !== 'dir') continue;
        if (child.path.startsWith('Campaigns/')) defaults.add(child.path);
        walk(child);
      }
    };
    walk(tree.root);
    if (defaults.size > 0) setOpen(defaults);
  }, [storageKey, tree.root]);

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
    async (parent: string, kind: CreateKind) => {
      if (kind === 'campaign') {
        setShowCampaignDialog(true);
        return;
      }
      setError(null);
      // When creating an entity from the campaign root, auto-route to the
      // correct canonical subfolder so the note lands in the right place.
      const KIND_SUBFOLDER: Partial<Record<CreateKind, string>> = {
        pc: 'Characters', npc: 'People', ally: 'People', villain: 'Enemies',
        item: 'Loot', session: 'Adventure Log', location: 'Places', monster: 'Creatures',
        quest: 'Quests',
      };
      let resolvedParent = parent;
      let autoSubfolder: string | null = null;
      if (/^Campaigns\/[^/]+$/.test(parent) && kind in KIND_SUBFOLDER) {
        autoSubfolder = KIND_SUBFOLDER[kind as keyof typeof KIND_SUBFOLDER]!;
        resolvedParent = `${parent}/${autoSubfolder}`;
      }
      // The canonical subfolder may not have been seeded during campaign
      // creation (the dialog only creates ticked ones). Ensure it exists
      // before we anchor the inline row to it — otherwise the tree has
      // no node for it and the click silently no-ops.
      if (autoSubfolder) {
        try {
          const res = await fetch('/api/folders/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ parent, name: autoSubfolder }),
          });
          if (!res.ok && res.status !== 409) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setError(body.error ?? `HTTP ${res.status}`);
            return;
          }
          if (res.status === 201) {
            router.refresh();
            broadcastTreeChange();
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'network error');
          return;
        }
      }
      setCreatingIn({ parent: resolvedParent, kind });
      // Ensure the target folder is expanded so the inline row is visible.
      if (resolvedParent) {
        setOpen((prev) => {
          const next = new Set(prev);
          resolvedParent.split('/').reduce((acc, seg) => {
            const p = acc ? `${acc}/${seg}` : seg;
            next.add(p);
            return p;
          }, '');
          return next;
        });
      }
    },
    [csrfToken, router],
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
          folder,
          name: name.trim(),
        };
        // 'quest' is a UI routing hint only — notes land as plain pages.
        // API treats missing kind as "page"; omitting keeps the log clean.
        if (kind !== 'page' && kind !== 'quest') payload.kind = kind;
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
        // Defer router.refresh() so the navigation we just kicked off
        // settles before the RSC tree is invalidated. Without the
        // delay, refresh races the in-flight push: the new row appears
        // in the tree but its activePath highlight (driven by the
        // previous render) hasn't caught up, leaving the row visually
        // present but unresponsive to the first click.
        setTimeout(() => {
          router.refresh();
          broadcastTreeChange();
        }, 120);
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
        // Campaign roots are locked by the standard folder-move
        // policy. Route their renames through the index endpoint
        // which knows how to follow the slug + active-campaign pin.
        const isCampaignRootRename =
          kind === 'folder' && isCampaignRoot(from);
        const url = isCampaignRootRename
          ? '/api/notes/rename-folder-from-index'
          : kind === 'file'
            ? '/api/notes/move'
            : '/api/folders/move';
        const payload = isCampaignRootRename
          ? { indexPath: `${from}/index.md`, newTitle: clean }
          : { from, to };
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(payload),
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
        } else if (isCampaignRootRename && activePath?.startsWith(from + '/')) {
          // Active note lives under the renamed campaign; rewrite
          // its prefix and navigate so the page doesn't 404.
          const next =
            (typeof body.toFolder === 'string' ? body.toFolder : to) +
            activePath.slice(from.length);
          router.push('/notes/' + next.split('/').map(encodeURIComponent).join('/'));
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
      // Hold the row in place with a spinner. Open the destination so
      // when the refreshed tree lands, the row is visible at its new
      // home rather than collapsed inside a closed folder.
      if (destFolder) {
        setOpen((prev) => new Set(prev).add(destFolder));
      }
      setMovingPath(src.path);
      setMovingTo(to);
      setMoveBaselineAt(tree.updatedAt);
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
          // Server failed — clear immediately, no tree change is coming.
          setMovingPath(null);
          setMovingTo(null);
          setMoveBaselineAt(null);
          return;
        }
        if (src.kind === 'file' && activePath === src.path) {
          router.push('/notes/' + to.split('/').map(encodeURIComponent).join('/'));
        }
        router.refresh();
        broadcastTreeChange();
        // Spinner stays on until the effect below sees tree.updatedAt
        // advance past the baseline we captured. That's what gives us
        // a single clean reflow instead of the disappear/popback/jump
        // sequence.
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
        setMovingPath(null);
        setMovingTo(null);
        setMoveBaselineAt(null);
      }
    },
    [activePath, csrfToken, router, tree.updatedAt],
  );

  const reorderCampaign = useCallback(
    async (slug: string, beforeSlug: string | null): Promise<void> => {
      try {
        const res = await fetch('/api/campaigns/reorder', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ slug, beforeSlug }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          alert(body.error ?? `Reorder failed (HTTP ${res.status})`);
          return;
        }
        router.refresh();
        broadcastTreeChange();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'network error');
      }
    },
    [csrfToken, router],
  );

  // Clear the spinner once the refreshed tree (with the moved row at
  // its new path) actually lands. tree.updatedAt is bumped by both
  // /api/notes/move and /api/folders/move on every moved note, so a
  // strict-greater check is reliable. The 3s safety timeout exists
  // only to recover from the impossible case where the server returns
  // 200 but the SSR re-render never bumps the prop.
  useEffect(() => {
    if (movingPath === null || moveBaselineAt === null) return;
    if (tree.updatedAt > moveBaselineAt) {
      setMovingPath(null);
      setMovingTo(null);
      setMoveBaselineAt(null);
      return;
    }
    const timer = setTimeout(() => {
      setMovingPath(null);
      setMovingTo(null);
      setMoveBaselineAt(null);
    }, 3000);
    return () => clearTimeout(timer);
  }, [tree.updatedAt, movingPath, moveBaselineAt]);

  const uploadAsset = useCallback(
    async (files: FileList, folder: string) => {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        try {
          const res = await fetch('/api/assets/upload', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: form,
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setError(body.error ?? `Upload failed (HTTP ${res.status})`);
            return;
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'network error');
          return;
        }
      }
      // Expand the target folder and refresh so any asset-derived
      // entries become visible.
      if (folder) setOpen((prev) => new Set(prev).add(folder));
      router.refresh();
      broadcastTreeChange();
    },
    [csrfToken, router],
  );

  // Top-level vault sections (Campaigns, World Lore, …) are always
  // expanded — they act as section headings, not collapsible folders.
  // Everything deeper stays toggleable (campaign subfolders are seeded
  // open on first visit via the effect above, then user-controlled).
  const items = useMemo(() => {
    const effective = new Set(open);
    for (const child of tree.root.children) {
      if (child.kind === 'dir') effective.add(child.path);
    }
    return flatten(tree.root, effective, 0);
    // No optimistic filter: the source row stays visible at its old
    // position with a spinner overlay until the refreshed tree arrives.
    // That gives us a single clean reflow instead of disappear → popback
    // → relocate.
  }, [tree.root, open]);

  // Pretty label for the "Moving X → Y…" pill. Truncated so a deep path
  // doesn't blow up the sidebar width.
  const moveLabel = useMemo(() => {
    if (!movingPath || !movingTo) return null;
    const fromName = movingPath.split('/').pop() ?? movingPath;
    const toFolder =
      movingTo.includes('/') ? movingTo.slice(0, movingTo.lastIndexOf('/')) : '';
    const toName = toFolder.split('/').pop() ?? toFolder;
    return { fromName, toName };
  }, [movingPath, movingTo]);

  return (
    <KindMapContext.Provider value={kindMap ?? EMPTY_KIND_MAP}>
    <div
      className={`flex min-h-0 flex-1 flex-col border-r border-[var(--rule)]${
        sectionTone === 'gm' ? ' border-l-2 border-l-[rgb(var(--wine-rgb)/0.4)]' : ''
      }`}
    >
      {sectionTone === 'gm' && (
        <div className="shrink-0 border-b border-[var(--rule)] bg-[rgb(var(--wine-rgb)/0.06)] px-3 py-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--wine)] bg-[rgb(var(--wine-rgb)/0.12)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--wine)]"
            title="GM-only notes — not visible to players until promoted"
          >
            <Lock size={10} aria-hidden /> GM Notes
          </span>
        </div>
      )}
      {sectionTone === 'players' && (
        <div className="shrink-0 border-b border-[var(--rule)] bg-[var(--parchment-sunk)]/40 px-3 py-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--rule)] bg-[var(--vellum)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]"
            title="Player-visible notes"
          >
            <Globe size={10} aria-hidden /> Players
          </span>
        </div>
      )}
      {showCampaignDialog && (
        <CampaignCreateDialog
          csrfToken={csrfToken}
          onClose={() => setShowCampaignDialog(false)}
          onCreated={(campaignPath) => {
            setShowCampaignDialog(false);
            setOpen((prev) => new Set(prev).add('Campaigns').add(campaignPath));
            router.refresh();
            broadcastTreeChange();
          }}
        />
      )}
    <nav
      aria-label="Note tree"
      className="min-h-0 flex-1 overflow-y-auto pb-3 text-sm"
    >
      {moveLabel && (
        <div
          role="status"
          aria-live="polite"
          className="mx-2 mb-2 flex items-center gap-2 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/70 px-2 py-1.5 text-xs text-[var(--ink-soft)]"
        >
          <Loader2 size={12} className="animate-spin text-[var(--wine)]" aria-hidden />
          <span className="truncate">
            Moving <span className="font-medium">{moveLabel.fromName}</span>
            {moveLabel.toName ? (
              <>
                {' '}→ <span className="font-medium">{moveLabel.toName}</span>
              </>
            ) : null}
            …
          </span>
        </div>
      )}
      <ul
        role="tree"
        className="px-2"
        onDragLeave={(e) => {
          // Only clear when leaving the ul entirely.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOver(null);
            setDragOverGap(null);
          }
        }}
      >
        {items.map((item) => {
          if (item.kind === 'gap') {
            const isCampaignDrag =
              !!dragging && dragging.kind === 'folder' && isCampaignRoot(dragging.path);
            const gapKey = item.beforeSlug ?? '';
            const isActive = isCampaignDrag && dragOverGap === gapKey;
            // Suppress the gap above/below the dragged campaign — those
            // positions are no-ops and the indicator there is misleading.
            const ownSlug = isCampaignDrag ? campaignRootSlug(dragging!.path) : null;
            const allItems = items;
            const idx = allItems.indexOf(item);
            const next = allItems[idx + 1];
            const prev = allItems[idx - 1];
            const isOwnEdge =
              isCampaignDrag &&
              ownSlug !== null &&
              ((next?.kind === 'dir' && next.path === `Campaigns/${ownSlug}`) ||
                (prev?.kind === 'dir' && prev.path === `Campaigns/${ownSlug}`));
            const accept = isCampaignDrag && !isOwnEdge;
            return (
              <li
                key={item.key}
                role="presentation"
                className="list-none"
                style={{ paddingLeft: 8 + item.depth * 14 }}
                onDragOver={(e) => {
                  if (!accept) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragOverGap !== gapKey) setDragOverGap(gapKey);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragOverGap((g) => (g === gapKey ? null : g));
                  }
                }}
                onDrop={(e) => {
                  if (!accept || !dragging || ownSlug === null) return;
                  e.preventDefault();
                  e.stopPropagation();
                  void reorderCampaign(ownSlug, item.beforeSlug);
                  setDragging(null);
                  setDragOver(null);
                  setDragOverGap(null);
                }}
              >
                <div className={isCampaignDrag ? 'h-[10px] -my-[3px] relative' : 'h-0'}>
                  {isActive && (
                    <div className="pointer-events-none absolute inset-x-2 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-[var(--wine)]" />
                  )}
                </div>
              </li>
            );
          }
          return (
          <TreeRow
            key={item.key}
            item={item}
            activePath={activePath}
            canCreate={canCreate}
            isWorldOwner={isWorldOwner}
            {...(sectionTone !== undefined ? { sectionTone } : {})}
            csrfToken={csrfToken}
            groupId={groupId}
            activeCampaignSlug={activeCampaignSlug}
            onToggleActiveCampaign={toggleActiveCampaign}
            isRenaming={renamingPath === item.path}
            renameDisabled={renaming}
            renameError={renamingPath === item.path ? error : null}
            dragging={dragging}
            isDropTarget={item.kind === 'dir' && dragOver === item.path}
            isMoving={movingPath === item.path}
            onDragStartRow={(src) => setDragging(src)}
            onDragEndRow={() => {
              setDragging(null);
              setDragOver(null);
              setDragOverGap(null);
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
            onUpload={(files, folder) => void uploadAsset(files, folder)}
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
          );
        })}
      </ul>
    </nav>
    </div>
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
  pc: { icon: Sword, color: 'var(--moss)', label: 'Character' },
  ally: { icon: UserRound, color: 'var(--candlelight)', label: 'Ally' },
  villain: { icon: Skull, color: 'var(--wine)', label: 'Enemy' },
  npc: { icon: UserRound, color: 'var(--sage)', label: 'Person' },
  session: { icon: CalendarDays, color: '#6A5D8B', label: 'Session' },
};

type FlatRow =
  | { kind: 'dir'; key: string; name: string; path: string; depth: number; open: boolean; hasChildren: boolean; system: boolean; indexPath: string | null }
  | { kind: 'file'; key: string; name: string; path: string; title: string; depth: number }
  // Sibling-reorder drop zone, rendered between (and after) campaign
  // roots inside the always-open Campaigns section. beforeSlug = the
  // slug this gap is *above* (null = the trailing gap, drop = end).
  | { kind: 'gap'; key: string; beforeSlug: string | null; depth: number };

function flatten(dir: TreeDir, openSet: Set<string>, depth: number): FlatRow[] {
  const out: FlatRow[] = [];
  const isCampaignsRoot = dir.path === 'Campaigns';
  for (const child of dir.children) {
    if (child.kind === 'dir' && (child.path === 'Assets' || child.path.startsWith('Assets/'))) continue;
    if (isCampaignsRoot && child.kind === 'dir') {
      out.push({
        kind: 'gap',
        key: 'gap:before:' + child.path,
        beforeSlug: child.name,
        depth,
      });
    }
    if (child.kind === 'dir') {
      const isOpen = openSet.has(child.path);
      // Find a child index.md — it's the folder's "page" in Notion-style
      // folder-as-page UX. Hidden from the child list when present.
      const indexChild = child.children.find(
        (c) => c.kind === 'file' && /^index\.(md|canvas)$/i.test(c.name),
      );
      const indexPath = indexChild?.kind === 'file' ? indexChild.path : null;
      const visibleChildCount = child.children.filter(
        (c) => !(c.kind === 'file' && /^index\.(md|canvas)$/i.test(c.name)),
      ).length;
      out.push({
        kind: 'dir',
        key: 'dir:' + child.path,
        name: child.name,
        path: child.path,
        depth,
        open: isOpen,
        hasChildren: visibleChildCount > 0,
        system: child.system,
        indexPath,
      });
      if (isOpen) out.push(...flatten(child, openSet, depth + 1));
    } else {
      // Hide the folder's own index.md from the child list — it's reached
      // by clicking the parent folder row instead.
      if (/^index\.(md|canvas)$/i.test(child.name)) continue;
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
  if (isCampaignsRoot) {
    // Trailing gap so users can drop a campaign at the end of the list.
    out.push({ kind: 'gap', key: 'gap:end:Campaigns', beforeSlug: null, depth });
  }
  return out;
}

// URL pathname → decoded note path. Returns '' for any non-note
// route so that tree highlights clear automatically when the user
// navigates to /graph, /tags, /settings, etc. Mirrors the decoder in
// NoteTabs so the two stay in step if either is ever changed.
function decodeActiveNotePath(pathname: string): string {
  if (!pathname.startsWith('/notes/')) return '';
  const rest = pathname.slice('/notes/'.length);
  return rest
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

function prettyName(fileName: string): string {
  return fileName.replace(/\.(md|canvas)$/i, '');
}

function TreeRow({
  item,
  activePath,
  canCreate,
  isWorldOwner,
  sectionTone,
  csrfToken,
  groupId,
  isRenaming,
  renameDisabled,
  renameError,
  dragging,
  isDropTarget,
  isMoving,
  activeCampaignSlug,
  onToggleActiveCampaign,
  onDragStartRow,
  onDragEndRow,
  onDragOverDir,
  onDropDir,
  onToggle,
  onStartCreate,
  onUpload,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  children,
}: {
  item: Exclude<FlatRow, { kind: 'gap' }>;
  activePath: string;
  canCreate: boolean;
  isWorldOwner: boolean;
  sectionTone?: 'gm' | 'players';
  csrfToken: string;
  groupId: string;
  isRenaming: boolean;
  renameDisabled: boolean;
  renameError: string | null;
  dragging: { kind: 'file' | 'folder'; path: string } | null;
  isDropTarget: boolean;
  isMoving: boolean;
  activeCampaignSlug: string | null;
  onToggleActiveCampaign: (slug: string) => void;
  onDragStartRow: (src: { kind: 'file' | 'folder'; path: string }) => void;
  onDragEndRow: () => void;
  onDragOverDir: (dirPath: string) => void;
  onDropDir: (dirPath: string) => void;
  onToggle: (path: string) => void;
  onStartCreate: (folder: string, kind: CreateKind) => void;
  onUpload: (files: FileList, folder: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: (name: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const kindMap = useContext(KindMapContext);
  const isSystem = item.kind === 'dir' && item.system;

  // Source policy: locked entities (PCs, campaign roots, canonical
  // subfolders, top-level headings) don't initiate a drag at all so the
  // cursor stays default and no ghost spawns.
  const sourceKind: 'file' | 'folder' = item.kind === 'dir' ? 'folder' : 'file';
  const canDragThisRow =
    canCreate && isDraggableSource({ kind: sourceKind, path: item.path });

  const rowDragProps = canDragThisRow
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.effectAllowed = 'move';
          // Some browsers require setData to initiate a drag.
          e.dataTransfer.setData('text/plain', item.path);
          onDragStartRow({ kind: sourceKind, path: item.path });
        },
        onDragEnd: () => onDragEndRow(),
      }
    : {};

  // Destination policy: ask the shared move-policy whether this drop is
  // structurally legal (cross-section rules, session confinement, etc.).
  // Server enforces the same matrix — this is purely a UX hint.
  const canAcceptDrop =
    !!dragging &&
    item.kind === 'dir' &&
    canDropOn(dragging, item.path).ok;
  const dirDropProps =
    item.kind === 'dir'
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!canAcceptDrop) return;
            e.preventDefault();
            e.stopPropagation();
            onDragOverDir(item.path);
          },
          onDrop: (e: React.DragEvent) => {
            if (!canAcceptDrop) return;
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
    const indexHref = item.indexPath
      ? '/notes/' + item.indexPath.split('/').map(encodeURIComponent).join('/')
      : null;
    const isIndexActive = item.indexPath === activePath;
    const isTopLevel = item.depth === 0;
    // Second-level folders under the always-open section headings
    // (Campaign-1, World Info, …). Slightly larger + bolder than
    // deeper nested rows so each section reads as a real roster.
    const isPromoted = item.depth === 1;
    const isActiveCampaign =
      /^Campaigns\/[^/]+$/.test(item.path) &&
      activeCampaignSlug === item.path.slice('Campaigns/'.length);
    const folderIcon = (() => {
      const fi = getFolderIcon(item.path);
      return fi ? (
        <fi.Icon size={isPromoted ? 14 : 13} aria-hidden className="shrink-0" style={{ color: fi.color }} />
      ) : null;
    })();
    const nameLabel = (
      <span
        title={item.name}
        className={`truncate ${
          isPromoted
            ? `font-medium text-[13.5px] ${isActiveCampaign ? 'text-[var(--wine)]' : 'text-[var(--ink-soft)]'}`
            : `font-medium ${isSystem ? 'tracking-wide text-xs uppercase text-[var(--ink-soft)]/70' : ''}`
        } ${!isPromoted && isIndexActive ? 'text-[var(--ink)]' : ''}`}
      >
        {item.name}
      </span>
    );
    return (
      <li role="treeitem" aria-expanded={item.open} className="list-none">
        <div
          {...rowDragProps}
          {...dirDropProps}
          className={
            'group flex items-center rounded-[6px] transition ' +
            (isTopLevel ? 'mt-2 first:mt-0 ' : '') +
            (isMoving ? 'opacity-60 pointer-events-none ' : '') +
            (isDropTarget
              ? 'bg-[var(--wine)]/15 ring-1 ring-[var(--wine)]/40'
              : isIndexActive
                ? 'bg-[var(--candlelight)]/25'
                : isTopLevel
                  ? 'hover:bg-[var(--candlelight)]/10'
                  : 'hover:bg-[var(--candlelight)]/15')
          }
        >
          {!isTopLevel && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggle(item.path); }}
              aria-label={item.open ? 'Collapse' : 'Expand'}
              className="flex items-center px-1 py-1 text-[var(--ink-soft)]"
              style={{ paddingLeft: padding }}
            >
              <ChevronRight
                size={14}
                className="transition"
                style={{ transform: item.open ? 'rotate(90deg)' : 'none' }}
                aria-hidden
              />
            </button>
          )}
          {indexHref ? (
            <Link
              href={indexHref}
              onClick={() => { if (!item.open) onToggle(item.path); }}
              className="folder-row-link flex min-w-0 flex-1 items-center gap-1 py-1 pr-2 text-left text-[var(--ink-soft)] hover:text-[var(--ink)]"
              style={isTopLevel ? { paddingLeft: padding } : undefined}
            >
              {folderIcon}
              {nameLabel}
            </Link>
          ) : isTopLevel ? (
            <div
              className="flex min-w-0 flex-1 cursor-default items-center gap-1 py-1 pr-2 text-[var(--ink-soft)]"
              style={{ paddingLeft: padding }}
            >
              {folderIcon}
              {nameLabel}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onToggle(item.path)}
              className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2 text-left text-[var(--ink-soft)]"
            >
              {folderIcon}
              {nameLabel}
            </button>
          )}
          {isMoving && (
            <span
              className="mr-1 flex items-center text-[var(--wine)]"
              aria-label="Moving folder"
              title="Moving…"
            >
              <Loader2 size={12} className="animate-spin" aria-hidden />
            </span>
          )}
          {(() => {
            if (!/^Campaigns\/[^/]+$/.test(item.path)) return null;
            const slug = item.path.slice('Campaigns/'.length);
            const isActive = activeCampaignSlug === slug;
            if (isWorldOwner) {
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleActiveCampaign(slug); }}
                  title={isActive ? 'Unpin active campaign' : 'Pin as active campaign'}
                  aria-label={isActive ? 'Unpin active campaign' : 'Pin as active campaign'}
                  className={
                    'mr-1 rounded p-1 transition ' +
                    (isActive
                      ? 'text-[var(--candlelight)]'
                      : 'text-[var(--ink-soft)]/0 hover:text-[var(--ink-soft)]/50 group-hover:text-[var(--ink-soft)]/50')
                  }
                >
                  <Crown size={12} aria-hidden fill={isActive ? 'currentColor' : 'none'} />
                </button>
              );
            }
            if (isActive) {
              return (
                <span className="mr-1 p-1 text-[var(--candlelight)]" title="Active campaign">
                  <Crown size={12} aria-hidden fill="currentColor" />
                </span>
              );
            }
            return null;
          })()}
          {canCreate && (
            <div className="mr-1 hidden items-center gap-0.5 group-hover:flex">
              <NewEntryDropdown
                onPick={(kind) => onStartCreate(item.path, kind)}
                onUpload={(files) => onUpload(files, item.path)}
                variant="compact"
                folderName={item.name}
                folderPath={item.path}
                isWorldOwner={isWorldOwner}
              />
              {/^Campaigns\/[^/]+$/.test(item.path) ? (
                // Campaign roots are system folders, but world owners
                // need a way to delete a whole campaign — render a
                // dedicated menu that drives the are-you-sure dialog.
                isWorldOwner && sectionTone !== 'players' ? (
                  <CampaignRowMenu
                    slug={item.path.slice('Campaigns/'.length)}
                    name={item.name}
                    csrfToken={csrfToken}
                    activePath={activePath}
                    onStartRename={onStartRename}
                  />
                ) : (
                  <span
                    className="p-1 text-[var(--ink-soft)]/35"
                    title="System folder — cannot be deleted or renamed"
                  >
                    <Lock size={11} aria-hidden />
                  </span>
                )
              ) : isSystem ? (
                <span
                  className="p-1 text-[var(--ink-soft)]/35"
                  title="System folder — cannot be deleted or renamed"
                >
                  <Lock size={11} aria-hidden />
                </span>
              ) : (
                <RowMenu
                  kind="folder"
                  path={item.path}
                  csrfToken={csrfToken}
                  onStartRename={onStartRename}
                  activePath={activePath}
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
          (isMoving ? 'opacity-60 pointer-events-none ' : '') +
          (isActive ? 'bg-[var(--candlelight)]/25' : 'hover:bg-[var(--candlelight)]/10')
        }
      >
        <Link
          href={href}
          className={
            'flex min-w-0 flex-1 items-center gap-1 px-2 py-1 ' +
            (isActive ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]')
          }
          style={{ paddingLeft: padding + 14 }}
        >
          <KindIcon path={item.path} />
          <span className="truncate" title={item.title || item.name}>{item.title || item.name}</span>
          <PeerStack notePath={item.path} />
        </Link>
        {isMoving && (
          <span
            className="mr-2 flex items-center text-[var(--wine)]"
            aria-label="Moving note"
            title="Moving…"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden />
          </span>
        )}
        {canCreate && (
          <div className="mr-1 hidden items-center group-hover:flex">
            <RowMenu
              kind="file"
              path={item.path}
              csrfToken={csrfToken}
              onStartRename={onStartRename}
              isWorldOwner={isWorldOwner}
              groupId={groupId}
              activePath={activePath}
              {...(kindMap[item.path] !== undefined ? { noteKind: kindMap[item.path] } : {})}
            />
          </div>
        )}
      </div>
    </li>
  );
}

function NewEntryDropdown({
  onPick,
  onUpload,
  variant,
  folderName,
  folderPath,
  isWorldOwner,
}: {
  onPick: (kind: CreateKind) => void;
  onUpload?: (files: FileList) => void;
  variant: 'wide' | 'compact';
  folderName?: string;
  folderPath?: string;
  isWorldOwner: boolean;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<boolean>(false);
  const [dropUp, setDropUp] = useState<boolean>(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { kinds, isUpload, labelOverrides } = getContextualOptions(folderPath, isWorldOwner);

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

  const openMenu = (): void => {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      // Use a conservative max height; real menu won't exceed this
      setDropUp(rect.bottom + 320 > window.innerHeight - 8);
    }
    setOpen(true);
  };

  // Assets section: single upload button, no dropdown
  if (isUpload) {
    return (
      <div ref={wrapRef} className="relative">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,.pdf,.doc,.docx"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onUpload?.(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
          title={folderName ? `Upload to ${folderName}` : 'Upload file'}
          aria-label={folderName ? `Upload to ${folderName}` : 'Upload file'}
          className={
            variant === 'wide'
              ? 'flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/15 hover:text-[var(--ink)]'
              : 'flex items-center gap-0.5 rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)]'
          }
        >
          <Upload size={14} aria-hidden />
          {variant === 'wide' && <span className="flex-1">Upload</span>}
        </button>
      </div>
    );
  }

  const visibleOptions = NEW_ENTRY_OPTIONS.filter((o) => kinds.includes(o.kind));

  // Nothing to offer here (e.g. non-owner hovering the Campaigns folder) —
  // hide the "+" affordance entirely rather than render a dead button.
  if (visibleOptions.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          // If there's only one option, skip the dropdown and pick immediately.
          if (visibleOptions.length === 1 && visibleOptions[0]) {
            onPick(visibleOptions[0].kind);
            return;
          }
          if (open) { setOpen(false); } else { openMenu(); }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={folderName ? `New in ${folderName}` : 'New entry'}
        aria-label={folderName ? `New in ${folderName}` : 'New entry'}
        className={
          variant === 'wide'
            ? 'flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/15 hover:text-[var(--ink)]'
            : 'flex items-center gap-0.5 rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--ink)]/10 hover:text-[var(--ink)]'
        }
      >
        <Plus size={14} aria-hidden />
        {variant === 'wide' && <span className="flex-1">New</span>}
        {visibleOptions.length !== 1 && <ChevronDown size={12} aria-hidden className="opacity-70" />}
      </button>
      {open && (
        // pt-1 creates an invisible bridge over the gap so the cursor
        // stays inside wrapRef while moving from button to menu.
        <div
          className={
            'absolute z-30 ' +
            (dropUp
              ? (variant === 'wide' ? 'left-0 bottom-full pb-1' : 'right-0 bottom-full pb-1')
              : (variant === 'wide' ? 'left-0 top-full pt-1' : 'right-0 top-full pt-1'))
          }
        >
          <ul
            role="menu"
            className="w-44 overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)] py-0.5 shadow-[0_8px_24px_rgb(var(--ink-rgb) / 0.12)]"
          >
            {visibleOptions.map(({ kind, label, icon: Icon }) => (
              <li key={kind}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onPick(kind);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink)] transition hover:bg-[var(--candlelight)]/15"
                >
                  <Icon size={12} aria-hidden className="text-[var(--ink-soft)]" />
                  <span>{labelOverrides[kind] ?? label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
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
        className="flex items-center gap-1 rounded-[6px] bg-[var(--vellum)] px-2 py-1"
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
          onBlur={() => {
            // Click-away commits the current name (or the placeholder
            // default if the user never typed). Empty string falls back
            // to cancellation. Tracked via initialValue check so the
            // submit-and-rerender cycle doesn't re-fire blur.
            if (disabled) return;
            const trimmed = value.trim();
            if (trimmed) onSubmit(trimmed);
            else onCancel();
          }}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 border-0 bg-transparent px-0 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]/60 disabled:opacity-60"
        />
      </form>
      {error && (
        <p className="ml-[30px] mt-1 text-xs text-[var(--wine)]">{error}</p>
      )}
    </div>
  );
}

const CAMPAIGN_SUBFOLDERS = [
  'Characters', 'People', 'Enemies', 'Loot', 'Adventure Log', 'Places', 'Creatures', 'Quests',
] as const;
type CampaignSubfolder = typeof CAMPAIGN_SUBFOLDERS[number];

function CampaignCreateDialog({
  csrfToken,
  onClose,
  onCreated,
}: {
  csrfToken: string;
  onClose: () => void;
  onCreated: (campaignPath: string) => void;
}): React.JSX.Element {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string>('');
  const [selected, setSelected] = useState<Set<CampaignSubfolder>>(
    () => new Set(CAMPAIGN_SUBFOLDERS),
  );
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const allSelected = selected.size === CAMPAIGN_SUBFOLDERS.length;

  const toggleSubfolder = (sf: CampaignSubfolder): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sf)) next.delete(sf);
      else next.add(sf);
      return next;
    });
  };

  const postFolder = async (parent: string, folderName: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch('/api/folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ parent, name: folderName }),
    });
    return res.json().catch(() => ({ ok: false })) as Promise<{ ok: boolean; error?: string }>;
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || pending) return;
    setPending(true);
    setError(null);
    try {
      const root = await postFolder('Campaigns', clean);
      if (!root.ok) {
        setError(
          root.error === 'exists'
            ? 'A campaign with that name already exists.'
            : (root.error ?? 'Failed to create campaign folder.'),
        );
        return;
      }
      const campaignPath = 'Campaigns/' + clean;
      for (const sf of CAMPAIGN_SUBFOLDERS) {
        if (selected.has(sf)) await postFolder(campaignPath, sf);
      }
      onCreated(campaignPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-4 shadow-[0_16px_48px_rgb(var(--ink-rgb) / 0.3)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id="campaign-dialog-title" className="text-sm font-semibold text-[var(--ink)]">
            New campaign
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
          >
            <X size={14} aria-hidden />
          </button>
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Name</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Sunken Crown"
            maxLength={200}
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>

        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--ink-soft)]">Subfolders</span>
            <button
              type="button"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(CAMPAIGN_SUBFOLDERS))
              }
              className="text-[11px] text-[var(--ink-soft)] underline-offset-2 hover:underline"
            >
              {allSelected ? 'None' : 'All'}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {CAMPAIGN_SUBFOLDERS.map((sf) => (
              <label key={sf} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={selected.has(sf)}
                  onChange={() => toggleSubfolder(sf)}
                  className="h-3.5 w-3.5 accent-[var(--candlelight)]"
                />
                <span className="text-xs text-[var(--ink)]">{sf}</span>
              </label>
            ))}
          </div>
        </div>

        {error && <p className="mb-3 text-xs text-[var(--wine)]">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] transition hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            className="rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-50"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
