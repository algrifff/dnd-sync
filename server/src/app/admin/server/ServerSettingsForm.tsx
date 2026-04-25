'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Copy,
  Check,
  RefreshCw,
  Pencil,
  Trash2,
  Plus,
  X,
  Upload,
} from 'lucide-react';

// Client-side resize config, mirrored from ProfileForm so uploads
// here and avatar uploads produce images of comparable weight.
const ICON_MAX_DIM = 128;
const ICON_MIME = 'image/webp';
const ICON_QUALITY = 0.85;

export type PersonalityItem = {
  id: string;
  name: string;
  prompt: string;
};

export type MemberItem = {
  id: string;
  displayName: string;
  username: string;
};

export type CampaignItem = {
  slug: string;
  name: string;
};

export function ServerSettingsForm({
  worldId,
  worldName,
  headerColor,
  iconVersion,
  csrfToken,
  initialToken,
  personalities,
  activePersonalityId,
  builtinPersonality,
  members,
  campaigns,
  activeCampaignSlug,
  features,
}: {
  worldId: string;
  worldName: string;
  headerColor: string | null;
  iconVersion: number;
  csrfToken: string;
  initialToken: string | null;
  personalities: PersonalityItem[];
  activePersonalityId: string;
  builtinPersonality: PersonalityItem;
  members: MemberItem[];
  campaigns: CampaignItem[];
  activeCampaignSlug: string | null;
  features: { excalidraw: boolean };
}): React.JSX.Element {
  return (
    <div className="space-y-8">
      {campaigns.length > 0 && (
        <ActiveCampaignSection
          worldId={worldId}
          csrfToken={csrfToken}
          campaigns={campaigns}
          initialActiveCampaignSlug={activeCampaignSlug}
        />
      )}
      <RenameSection worldId={worldId} worldName={worldName} csrfToken={csrfToken} />
      <WorldIconSection
        worldId={worldId}
        worldName={worldName}
        initialIconVersion={iconVersion}
        csrfToken={csrfToken}
      />
      <HeaderColorSection worldId={worldId} initialColor={headerColor} csrfToken={csrfToken} />
      <AIPersonalitySection
        worldId={worldId}
        csrfToken={csrfToken}
        initialPersonalities={personalities}
        initialActiveId={activePersonalityId}
        builtin={builtinPersonality}
      />
      <FeaturesSection
        worldId={worldId}
        csrfToken={csrfToken}
        initialFeatures={features}
      />
      <InviteSection worldId={worldId} csrfToken={csrfToken} initialToken={initialToken} />
      <DangerZone worldId={worldId} worldName={worldName} csrfToken={csrfToken} members={members} />
    </div>
  );
}

function FeaturesSection({
  worldId,
  csrfToken,
  initialFeatures,
}: {
  worldId: string;
  csrfToken: string;
  initialFeatures: { excalidraw: boolean };
}): React.JSX.Element {
  const router = useRouter();
  const [excalidraw, setExcalidraw] = useState(initialFeatures.excalidraw);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean): Promise<void> => {
    setExcalidraw(next);
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ features: { excalidraw: next } }),
      });
      if (!res.ok) {
        setExcalidraw(!next);
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not update features.');
        return;
      }
      router.refresh();
    } catch {
      setExcalidraw(!next);
      setError('Network error.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-lg font-semibold text-[var(--ink)]">Features</h2>
        <p className="text-sm text-[var(--ink-soft)]">
          Optional tools that can be turned on per world.
        </p>
      </header>
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--rule)] bg-[var(--parchment)] p-3">
        <input
          type="checkbox"
          checked={excalidraw}
          disabled={pending}
          onChange={(e) => void toggle(e.currentTarget.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block font-medium text-[var(--ink)]">Excalidraw</span>
          <span className="block text-xs text-[var(--ink-soft)]">
            Adds a drawing tool tab to the sidebar. New drawings live under
            the top-level <code>Excalidraw</code> section.
          </span>
        </span>
      </label>
      {error && <p className="text-xs text-[var(--wine)]">{error}</p>}
    </section>
  );
}

function ActiveCampaignSection({
  worldId,
  csrfToken,
  campaigns,
  initialActiveCampaignSlug,
}: {
  worldId: string;
  csrfToken: string;
  campaigns: CampaignItem[];
  initialActiveCampaignSlug: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [selected, setSelected] = useState<string>(initialActiveCampaignSlug ?? '');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ activeCampaignSlug: selected || null }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--ink)]">Active campaign</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        The pinned campaign is the target for the{' '}
        <span className="font-medium text-[var(--ink)]">+ New Session</span> button in the sidebar.
        You can also toggle it directly from the file tree using the crown icon on any campaign
        folder.
      </p>
      <form onSubmit={submit} className="flex items-end gap-3">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Campaign</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          >
            <option value="">— none (use most recent) —</option>
            {campaigns.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-[6px] bg-[var(--ink)] px-4 py-1.5 text-sm font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
        >
          {pending ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-[var(--wine)]">{error}</p>}
    </section>
  );
}

function RenameSection({
  worldId,
  worldName,
  csrfToken,
}: {
  worldId: string;
  worldName: string;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState(worldName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || pending || clean === worldName) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ name: clean }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      // Re-render server components (AppHeader, etc.) so the new title
      // shows up immediately. router.refresh() patches the RSC tree in
      // place, preserving this form's input state — no flicker, no remount.
      router.refresh();
      // Nudge the worlds sidebar (client-fetched) to re-pull so its
      // tooltip / aria-label reflect the new name too.
      window.dispatchEvent(new Event('world-updated'));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--ink)]">Server name</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        This name appears in the world switcher for all members.
      </p>
      <form onSubmit={submit} className="flex items-end gap-3">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>
        <button
          type="submit"
          disabled={pending || !name.trim() || name.trim() === worldName}
          className="rounded-[6px] bg-[var(--ink)] px-4 py-1.5 text-sm font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
        >
          {pending ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-[var(--wine)]">{error}</p>}
    </section>
  );
}

const HEADER_PRESETS = [
  { label: 'Default (dark)', value: 'var(--ink)' },
  { label: 'Crimson', value: 'var(--wine)' },
  { label: 'Gold', value: 'var(--candlelight)' },
  { label: 'Forest', value: 'var(--moss)' },
  { label: 'Sapphire', value: '#4A6B7B' },
  { label: 'Violet', value: '#6A5D8B' },
  { label: 'Ember', value: 'var(--embers)' },
];

function HeaderColorSection({
  worldId,
  initialColor,
  csrfToken,
}: {
  worldId: string;
  initialColor: string | null;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [color, setColor] = useState(initialColor ?? 'var(--ink)');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (val: string): Promise<void> => {
    setColor(val);
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ headerColor: val }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      // Push the new colour to the AppHeader (server component) without
      // a full navigation or flicker.
      router.refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--ink)]">Header colour</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        Colour used for the world name in the top bar. Pick a preset or choose any colour.
      </p>

      {/* Preview */}
      <div className="mb-4 flex items-center gap-2 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment-sunk)] px-3 py-2">
        <span className="text-xs text-[var(--ink-soft)]">Preview:</span>
        <span className="text-sm font-bold" style={{ color }}>World Name</span>
      </div>

      {/* Presets */}
      <div className="mb-3 flex flex-wrap gap-2">
        {HEADER_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            title={p.label}
            onClick={() => void save(p.value)}
            disabled={pending}
            className={`h-6 w-6 rounded-full border-2 transition hover:scale-110 disabled:opacity-40 ${
              color === p.value ? 'border-[var(--ink)] scale-110' : 'border-transparent'
            }`}
            style={{ backgroundColor: p.value }}
            aria-label={p.label}
          />
        ))}
      </div>

      {/* Custom picker */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-[var(--ink-soft)]">
          Custom colour
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            onBlur={(e) => void save(e.target.value)}
            className="h-6 w-10 cursor-pointer rounded border border-[var(--rule)] bg-transparent p-0"
          />
        </label>
        <button
          type="button"
          onClick={() => void save(color)}
          disabled={pending}
          className="rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
        >
          {pending ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--wine)]">{error}</p>}
    </section>
  );
}

// ── World icon section ─────────────────────────────────────────────────
//
// Admin-only upload of a per-world icon that replaces the
// initials-on-colour chip in the leftmost Discord-style sidebar. The
// client resizes to ≤ 128 px WebP before upload so the server stays
// out of the image-tooling business. On save we refresh the RSC tree
// (router.refresh) AND fire `world-updated` so the already-mounted
// WorldsSidebar re-pulls its list (the ?v= cache-buster comes with
// the new iconVersion).

function WorldIconSection({
  worldId,
  worldName,
  initialIconVersion,
  csrfToken,
}: {
  worldId: string;
  worldName: string;
  initialIconVersion: number;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [iconVersion, setIconVersion] = useState<number>(initialIconVersion);
  // Local preview URL shown instantly while the upload round-trips —
  // avoids a brief "no icon" flash between save and the new cache-
  // busted GET resolving.
  const [preview, setPreview] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const iconUrl = preview
    ? preview
    : iconVersion > 0
      ? `/api/worlds/${encodeURIComponent(worldId)}/icon?v=${iconVersion}`
      : null;

  const notifyChanged = (): void => {
    router.refresh();
    window.dispatchEvent(new Event('world-updated'));
  };

  const onPick = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please pick an image file.');
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const blob = await resizeImage(file, ICON_MAX_DIM);
      // Optimistic preview from the resized blob so admins see the
      // change instantly; replaced by the server URL on the next render.
      const objectUrl = URL.createObjectURL(blob);
      setPreview(objectUrl);

      const res = await fetch(
        `/api/worlds/${encodeURIComponent(worldId)}/icon`,
        {
          method: 'POST',
          headers: {
            'Content-Type': blob.type,
            'X-CSRF-Token': csrfToken,
          },
          body: blob,
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        iconVersion?: number;
        detail?: string;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        URL.revokeObjectURL(objectUrl);
        setPreview(null);
        setError(body.detail ?? body.error ?? `HTTP ${res.status}`);
        return;
      }
      setIconVersion(
        typeof body.iconVersion === 'number' ? body.iconVersion : Date.now(),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      notifyChanged();
      // Drop the object URL on the next tick — by then the browser has
      // the server response cached and the <img> below renders from it.
      setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        setPreview(null);
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
      setPreview(null);
    } finally {
      setPending(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (): Promise<void> => {
    if (!iconVersion || pending) return;
    if (!confirm('Remove the world icon?')) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/worlds/${encodeURIComponent(worldId)}/icon`,
        { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        detail?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      setIconVersion(0);
      notifyChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--ink)]">
        World icon
      </h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        Replaces the initials chip in the worlds sidebar for everyone.
        PNG, JPEG, or WebP — we&rsquo;ll resize to 128&nbsp;px.
      </p>

      <div className="flex items-center gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[14px] text-base font-semibold text-[var(--parchment)] ring-1 ring-[var(--rule)]"
          style={{ backgroundColor: 'var(--ink)' }}
          aria-hidden
        >
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <span>{initialsOf(worldName)}</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={pending}
              className="flex items-center gap-1.5 rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
            >
              <Upload size={12} aria-hidden />
              {pending ? 'Uploading…' : iconVersion > 0 ? 'Replace icon' : 'Upload icon'}
            </button>
            {iconVersion > 0 && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={pending}
                className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)] disabled:opacity-40"
              >
                Remove
              </button>
            )}
            {saved && (
              <span className="self-center text-xs text-[var(--moss)]">Saved</span>
            )}
          </div>
          {error && <p className="text-xs text-[var(--wine)]">{error}</p>}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => void onPick(e)}
      />
    </section>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

async function resizeImage(file: File, maxDim: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
      ICON_MIME,
      ICON_QUALITY,
    );
  });
}

// ── AI personality section ─────────────────────────────────────────────
//
// Admins can pick an active voice for the world's AI, edit/delete the
// ones they've authored, and save new named personalities. The built-in
// "Grizzled Scribe" is always present as a fallback and can't be
// deleted; it lives in code (DEFAULT_PERSONALITY) and is surfaced here
// as a non-editable row.

const PLACEHOLDER_PROMPT = `Describe how the AI should speak.

Example:
You speak as a cheerful tavern bard — warm, a little dramatic, always ready with a pun. Short and friendly. You celebrate the players' victories and tease them kindly when things go sideways.

Good: "A new hero joins the tale! Fenwick the rogue, three levels of mischief."
Good: "Sword inscribed. Someone's going to regret that."
Bad: "I have successfully created the entity with the following fields..." (too clinical)`;

function AIPersonalitySection({
  worldId,
  csrfToken,
  initialPersonalities,
  initialActiveId,
  builtin,
}: {
  worldId: string;
  csrfToken: string;
  initialPersonalities: PersonalityItem[];
  initialActiveId: string;
  builtin: PersonalityItem;
}): React.JSX.Element {
  const [items, setItems] = useState<PersonalityItem[]>(initialPersonalities);
  const [activeId, setActiveId] = useState<string>(initialActiveId);
  const [editing, setEditing] = useState<PersonalityItem | 'new' | null>(null);
  const [pendingActivate, setPendingActivate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = useMemo<PersonalityItem[]>(
    () => [builtin, ...items],
    [builtin, items],
  );

  const active = useMemo(
    () => all.find((p) => p.id === activeId) ?? builtin,
    [all, activeId, builtin],
  );

  const activate = async (id: string): Promise<void> => {
    if (id === activeId) return;
    setPendingActivate(id);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        // The built-in sentinel and explicit null both mean "default".
        body: JSON.stringify({
          activePersonalityId: id === builtin.id ? null : id,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      setActiveId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPendingActivate(null);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!confirm('Delete this personality? This cannot be undone.')) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/worlds/${encodeURIComponent(worldId)}/personalities/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } },
      );
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      setItems((prev) => prev.filter((p) => p.id !== id));
      if (activeId === id) setActiveId(builtin.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    }
  };

  const onSaved = (saved: PersonalityItem, isNew: boolean): void => {
    setItems((prev) =>
      isNew
        ? [...prev, saved].sort((a, b) => a.name.localeCompare(b.name))
        : prev
            .map((p) => (p.id === saved.id ? saved : p))
            .sort((a, b) => a.name.localeCompare(b.name)),
    );
    setEditing(null);
  };

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--ink)]">AI personality</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        The voice the world's AI uses for its replies. Pick one of your saved
        personalities or craft a new one — the built-in scribe is always
        available as a fallback.
      </p>

      {/* Active preview */}
      <div className="mb-4 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment-sunk)] px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[var(--ink-soft)]">
            Active: <span className="text-[var(--ink)]">{active.name}</span>
          </span>
          {active.id !== builtin.id && (
            <button
              type="button"
              onClick={() => void activate(builtin.id)}
              className="text-xs text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
            >
              Reset to default
            </button>
          )}
        </div>
        <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-[var(--ink)]">
          {active.prompt}
        </pre>
      </div>

      {/* Personality list */}
      <ul className="mb-3 divide-y divide-[var(--rule)] overflow-hidden rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)]">
        {all.map((p) => {
          const isActive = p.id === activeId;
          const isBuiltin = p.id === builtin.id;
          return (
            <li
              key={p.id}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name={`personality-${worldId}`}
                checked={isActive}
                onChange={() => void activate(p.id)}
                disabled={pendingActivate !== null}
                className="h-3.5 w-3.5 accent-[var(--ink)]"
                aria-label={`Use ${p.name}`}
              />
              <button
                type="button"
                onClick={() => void activate(p.id)}
                className="flex-1 truncate text-left text-[var(--ink)] hover:text-[var(--ink-soft)]"
              >
                {p.name}
                {isBuiltin && (
                  <span className="ml-2 text-xs text-[var(--ink-muted)]">built-in</span>
                )}
              </button>
              {!isBuiltin && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    title="Edit"
                    className="rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/20 hover:text-[var(--ink)]"
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(p.id)}
                    title="Delete"
                    className="rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--wine)]/15 hover:text-[var(--wine)]"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </>
              )}
              {isBuiltin && (
                <button
                  type="button"
                  onClick={() =>
                    setEditing({
                      id: '',
                      name: `${builtin.name.replace(/ \(default\)$/, '')} (copy)`,
                      prompt: builtin.prompt,
                    })
                  }
                  title="Duplicate to edit"
                  className="rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/20 hover:text-[var(--ink)]"
                >
                  <Copy size={13} aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => setEditing('new')}
        className="flex items-center gap-1.5 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
      >
        <Plus size={12} aria-hidden />
        New personality
      </button>

      {error && <p className="mt-2 text-xs text-[var(--wine)]">{error}</p>}

      {editing && (
        <PersonalityEditor
          worldId={worldId}
          csrfToken={csrfToken}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}

function PersonalityEditor({
  worldId,
  csrfToken,
  initial,
  onClose,
  onSaved,
}: {
  worldId: string;
  csrfToken: string;
  /** null = creating new. When cloning the built-in, pass { id: '', ... }. */
  initial: PersonalityItem | null;
  onClose: () => void;
  onSaved: (saved: PersonalityItem, isNew: boolean) => void;
}): React.JSX.Element {
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanName || !cleanPrompt || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        isEdit
          ? `/api/worlds/${encodeURIComponent(worldId)}/personalities/${encodeURIComponent(initial!.id)}`
          : `/api/worlds/${encodeURIComponent(worldId)}/personalities`,
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ name: cleanName, prompt: cleanPrompt }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        detail?: string;
        personality?: PersonalityItem;
      };
      if (!res.ok || !body.ok || !body.personality) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      onSaved(body.personality, !isEdit);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'Edit personality' : 'New personality'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={save}
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] shadow-lg"
      >
        <header className="flex items-center justify-between border-b border-[var(--rule)] px-5 py-3">
          <h3 className="text-sm font-semibold text-[var(--ink)]">
            {isEdit ? 'Edit personality' : 'New personality'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)]"
            aria-label="Close"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="e.g. Cheerful Bard"
              className="w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
              Voice prompt
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={4000}
              rows={14}
              placeholder={PLACEHOLDER_PROMPT}
              className="w-full resize-y rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
            />
            <span className="mt-1 block text-[11px] text-[var(--ink-muted)]">
              {prompt.length} / 4000 characters
            </span>
          </label>
          <p className="text-xs text-[var(--ink-muted)]">
            This is injected under <code className="text-[var(--ink)]">## Voice</code> in
            the AI's system prompt. It only affects prose — tool calls,
            paths, and data are never stylised.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--rule)] px-5 py-3">
          {error && <p className="mr-auto text-xs text-[var(--wine)]">{error}</p>}
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs text-[var(--ink-soft)] transition hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim() || !prompt.trim()}
            className="rounded-[6px] bg-[var(--ink)] px-4 py-1.5 text-sm font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-40"
          >
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create personality'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function InviteSection({
  worldId,
  csrfToken,
  initialToken,
}: {
  worldId: string;
  csrfToken: string;
  initialToken: string | null;
}): React.JSX.Element {
  const [token, setToken] = useState<string | null>(initialToken);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inviteUrl =
    token != null && typeof window !== 'undefined'
      ? `${window.location.origin}/join/${token}`
      : token != null
        ? `/join/${token}`
        : null;

  const generate = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}/invite`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; detail?: string };
      if (!res.ok || !body.token) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      setToken(body.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--ink)]">Invite link</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        Share this link with players. Anyone who clicks it — and is logged in —
        joins this world as an editor. Regenerating the link invalidates the old
        one.
      </p>

      {inviteUrl ? (
        <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-[var(--ink)]">
            {inviteUrl}
          </span>
          <button
            type="button"
            onClick={copy}
            title="Copy link"
            className="shrink-0 rounded-[4px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--candlelight)]/20 hover:text-[var(--ink)]"
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          </button>
        </div>
      ) : (
        <p className="mb-3 text-xs text-[var(--ink-soft)]">No invite link yet.</p>
      )}

      <button
        type="button"
        onClick={generate}
        disabled={pending}
        className="flex items-center gap-1.5 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)] transition hover:bg-[var(--parchment-sunk)] hover:text-[var(--ink)] disabled:opacity-40"
      >
        <RefreshCw size={12} aria-hidden />
        {pending ? 'Generating…' : token ? 'Regenerate link' : 'Generate link'}
      </button>
      {error && <p className="mt-2 text-xs text-[var(--wine)]">{error}</p>}
    </section>
  );
}

function TransferOwnershipSection({
  worldId,
  csrfToken,
  members,
}: {
  worldId: string;
  csrfToken: string;
  members: MemberItem[];
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedMember = members.find((m) => m.id === selectedId) ?? null;

  const openConfirm = (): void => {
    if (!selectedId) return;
    setConfirming(true);
    setError(null);
  };

  const doTransfer = async (): Promise<void> => {
    if (!selectedId || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ newOwnerId: selectedId }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (!res.ok || !body.ok) {
        setError(body.reason ?? `HTTP ${res.status}`);
        setPending(false);
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
      setPending(false);
    }
  };

  if (members.length === 0) {
    return (
      <div className="rounded-[8px] border border-[var(--candlelight)]/40 bg-[var(--vellum)] p-4">
        <p className="text-xs font-medium text-[var(--ink-soft)]">Transfer ownership</p>
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          No other members in this world to transfer to.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-[var(--candlelight)]/50 bg-[var(--vellum)] p-4">
      <p className="mb-2 text-xs font-medium text-[var(--ink-soft)]">Transfer ownership</p>

      {!confirming ? (
        <div className="flex items-center gap-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="flex-1 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          >
            <option value="">Select a member…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} ({m.username})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={openConfirm}
            disabled={!selectedId}
            className="shrink-0 rounded-[6px] border border-[var(--candlelight)]/60 bg-[var(--candlelight)]/10 px-3 py-1.5 text-xs font-medium text-[#8A6A2A] transition hover:bg-[var(--candlelight)]/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Transfer…
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-[6px] border border-[var(--candlelight)]/50 bg-[var(--candlelight)]/10 p-3 text-xs text-[var(--ink-soft)]">
            <strong className="text-[var(--ink)]">
              Transfer to {selectedMember?.displayName} (@{selectedMember?.username})?
            </strong>
            <p className="mt-1">
              You will be downgraded to editor and immediately lose access to world settings.
              The new owner will have full admin control. This cannot be undone.
            </p>
          </div>
          {error && <p className="text-xs text-[var(--wine)]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-[6px] px-3 py-1.5 text-xs text-[var(--ink-soft)] transition hover:text-[var(--ink)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={doTransfer}
              disabled={pending}
              className="rounded-[6px] bg-[var(--candlelight)] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#C49840] disabled:opacity-40"
            >
              {pending ? 'Transferring…' : 'Yes, transfer ownership'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DangerZone({
  worldId,
  worldName,
  csrfToken,
  members,
}: {
  worldId: string;
  worldName: string;
  csrfToken: string;
  members: MemberItem[];
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openConfirm = (): void => {
    setConfirming(true);
    setConfirmName('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const deleteWorld = async (): Promise<void> => {
    if (confirmName !== worldName || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        detail?: string;
        switchToId?: string | null;
      };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        return;
      }
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="rounded-[12px] border border-[var(--wine)]/40 bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-base font-semibold text-[var(--wine)]">Danger zone</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        Deleting this world permanently removes all its notes, characters,
        sessions, and assets. This cannot be undone.
      </p>

      <TransferOwnershipSection worldId={worldId} csrfToken={csrfToken} members={members} />

      <div className="mt-4">
        {!confirming ? (
          <button
            type="button"
            onClick={openConfirm}
            className="rounded-[6px] border border-[var(--wine)]/50 bg-[var(--wine)]/10 px-3 py-1.5 text-sm font-medium text-[var(--wine)] transition hover:bg-[var(--wine)]/20"
          >
            Delete this world…
          </button>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--ink-soft)]">
                Type <strong>{worldName}</strong> to confirm
              </span>
              <input
                ref={inputRef}
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                className="w-full rounded-[6px] border border-[var(--wine)]/50 bg-[var(--parchment)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--wine)]"
                placeholder={worldName}
              />
            </label>
            {error && <p className="text-xs text-[var(--wine)]">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-[6px] px-3 py-1.5 text-xs text-[var(--ink-soft)] transition hover:text-[var(--ink)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteWorld}
                disabled={confirmName !== worldName || pending}
                className="rounded-[6px] bg-[var(--wine)] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#7A3A42] disabled:opacity-40"
              >
                {pending ? 'Deleting…' : 'Delete world'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
