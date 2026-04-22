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
}): React.JSX.Element {
  return (
    <div className="space-y-8">
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
      <InviteSection worldId={worldId} csrfToken={csrfToken} initialToken={initialToken} />
      <DangerZone worldId={worldId} worldName={worldName} csrfToken={csrfToken} members={members} />
    </div>
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
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-base font-semibold text-[#2A241E]">Server name</h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        This name appears in the world switcher for all members.
      </p>
      <form onSubmit={submit} className="flex items-end gap-3">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-[#5A4F42]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="w-full rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>
        <button
          type="submit"
          disabled={pending || !name.trim() || name.trim() === worldName}
          className="rounded-[6px] bg-[#2A241E] px-4 py-1.5 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-40"
        >
          {pending ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-[#8B4A52]">{error}</p>}
    </section>
  );
}

const HEADER_PRESETS = [
  { label: 'Default (dark)', value: '#2A241E' },
  { label: 'Crimson', value: '#8B4A52' },
  { label: 'Gold', value: '#D4A85A' },
  { label: 'Forest', value: '#7B8A5F' },
  { label: 'Sapphire', value: '#4A6B7B' },
  { label: 'Violet', value: '#6A5D8B' },
  { label: 'Ember', value: '#B5572A' },
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
  const [color, setColor] = useState(initialColor ?? '#2A241E');
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
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-base font-semibold text-[#2A241E]">Header colour</h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        Colour used for the world name in the top bar. Pick a preset or choose any colour.
      </p>

      {/* Preview */}
      <div className="mb-4 flex items-center gap-2 rounded-[8px] border border-[#D4C7AE] bg-[#EAE1CF] px-3 py-2">
        <span className="text-xs text-[#5A4F42]">Preview:</span>
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
              color === p.value ? 'border-[#2A241E] scale-110' : 'border-transparent'
            }`}
            style={{ backgroundColor: p.value }}
            aria-label={p.label}
          />
        ))}
      </div>

      {/* Custom picker */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-[#5A4F42]">
          Custom colour
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            onBlur={(e) => void save(e.target.value)}
            className="h-6 w-10 cursor-pointer rounded border border-[#D4C7AE] bg-transparent p-0"
          />
        </label>
        <button
          type="button"
          onClick={() => void save(color)}
          disabled={pending}
          className="rounded-[6px] bg-[#2A241E] px-3 py-1.5 text-xs font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-40"
        >
          {pending ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-[#8B4A52]">{error}</p>}
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
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-base font-semibold text-[#2A241E]">
        World icon
      </h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        Replaces the initials chip in the worlds sidebar for everyone.
        PNG, JPEG, or WebP — we&rsquo;ll resize to 128&nbsp;px.
      </p>

      <div className="flex items-center gap-4">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[14px] text-base font-semibold text-[#F4EDE0] ring-1 ring-[#D4C7AE]"
          style={{ backgroundColor: '#2A241E' }}
          aria-hidden
        >
          {iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
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
              className="flex items-center gap-1.5 rounded-[6px] bg-[#2A241E] px-3 py-1.5 text-xs font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-40"
            >
              <Upload size={12} aria-hidden />
              {pending ? 'Uploading…' : iconVersion > 0 ? 'Replace icon' : 'Upload icon'}
            </button>
            {iconVersion > 0 && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={pending}
                className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-xs font-medium text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] disabled:opacity-40"
              >
                Remove
              </button>
            )}
            {saved && (
              <span className="self-center text-xs text-[#7B8A5F]">Saved</span>
            )}
          </div>
          {error && <p className="text-xs text-[#8B4A52]">{error}</p>}
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
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-base font-semibold text-[#2A241E]">AI personality</h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        The voice the world's AI uses for its replies. Pick one of your saved
        personalities or craft a new one — the built-in scribe is always
        available as a fallback.
      </p>

      {/* Active preview */}
      <div className="mb-4 rounded-[8px] border border-[#D4C7AE] bg-[#EAE1CF] px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#5A4F42]">
            Active: <span className="text-[#2A241E]">{active.name}</span>
          </span>
          {active.id !== builtin.id && (
            <button
              type="button"
              onClick={() => void activate(builtin.id)}
              className="text-xs text-[#5A4F42] underline-offset-2 hover:text-[#2A241E] hover:underline"
            >
              Reset to default
            </button>
          )}
        </div>
        <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-[#2A241E]">
          {active.prompt}
        </pre>
      </div>

      {/* Personality list */}
      <ul className="mb-3 divide-y divide-[#D4C7AE] overflow-hidden rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0]">
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
                className="h-3.5 w-3.5 accent-[#2A241E]"
                aria-label={`Use ${p.name}`}
              />
              <button
                type="button"
                onClick={() => void activate(p.id)}
                className="flex-1 truncate text-left text-[#2A241E] hover:text-[#5A4F42]"
              >
                {p.name}
                {isBuiltin && (
                  <span className="ml-2 text-xs text-[#8A7E6B]">built-in</span>
                )}
              </button>
              {!isBuiltin && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    title="Edit"
                    className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#D4A85A]/20 hover:text-[#2A241E]"
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(p.id)}
                    title="Delete"
                    className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#8B4A52]/15 hover:text-[#8B4A52]"
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
                  className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#D4A85A]/20 hover:text-[#2A241E]"
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
        className="flex items-center gap-1.5 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-xs font-medium text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E]"
      >
        <Plus size={12} aria-hidden />
        New personality
      </button>

      {error && <p className="mt-2 text-xs text-[#8B4A52]">{error}</p>}

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
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-lg"
      >
        <header className="flex items-center justify-between border-b border-[#D4C7AE] px-5 py-3">
          <h3 className="text-sm font-semibold text-[#2A241E]">
            {isEdit ? 'Edit personality' : 'New personality'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E]"
            aria-label="Close"
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5A4F42]">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="e.g. Cheerful Bard"
              className="w-full rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[#5A4F42]">
              Voice prompt
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={4000}
              rows={14}
              placeholder={PLACEHOLDER_PROMPT}
              className="w-full resize-y rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 font-mono text-xs leading-relaxed text-[#2A241E] outline-none focus:border-[#D4A85A]"
            />
            <span className="mt-1 block text-[11px] text-[#8A7E6B]">
              {prompt.length} / 4000 characters
            </span>
          </label>
          <p className="text-xs text-[#8A7E6B]">
            This is injected under <code className="text-[#2A241E]">## Voice</code> in
            the AI's system prompt. It only affects prose — tool calls,
            paths, and data are never stylised.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[#D4C7AE] px-5 py-3">
          {error && <p className="mr-auto text-xs text-[#8B4A52]">{error}</p>}
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-3 py-1.5 text-xs text-[#5A4F42] transition hover:text-[#2A241E]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !name.trim() || !prompt.trim()}
            className="rounded-[6px] bg-[#2A241E] px-4 py-1.5 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-40"
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
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-base font-semibold text-[#2A241E]">Invite link</h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        Share this link with players. Anyone who clicks it — and is logged in —
        joins this world as an editor. Regenerating the link invalidates the old
        one.
      </p>

      {inviteUrl ? (
        <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-[#2A241E]">
            {inviteUrl}
          </span>
          <button
            type="button"
            onClick={copy}
            title="Copy link"
            className="shrink-0 rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#D4A85A]/20 hover:text-[#2A241E]"
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          </button>
        </div>
      ) : (
        <p className="mb-3 text-xs text-[#5A4F42]">No invite link yet.</p>
      )}

      <button
        type="button"
        onClick={generate}
        disabled={pending}
        className="flex items-center gap-1.5 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-xs font-medium text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] disabled:opacity-40"
      >
        <RefreshCw size={12} aria-hidden />
        {pending ? 'Generating…' : token ? 'Regenerate link' : 'Generate link'}
      </button>
      {error && <p className="mt-2 text-xs text-[#8B4A52]">{error}</p>}
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
      <div className="rounded-[8px] border border-[#D4A85A]/40 bg-[#FBF5E8] p-4">
        <p className="text-xs font-medium text-[#5A4F42]">Transfer ownership</p>
        <p className="mt-1 text-xs text-[#8A7E6B]">
          No other members in this world to transfer to.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-[#D4A85A]/50 bg-[#FBF5E8] p-4">
      <p className="mb-2 text-xs font-medium text-[#5A4F42]">Transfer ownership</p>

      {!confirming ? (
        <div className="flex items-center gap-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="flex-1 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
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
            className="shrink-0 rounded-[6px] border border-[#D4A85A]/60 bg-[#D4A85A]/10 px-3 py-1.5 text-xs font-medium text-[#8A6A2A] transition hover:bg-[#D4A85A]/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Transfer…
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-[6px] border border-[#D4A85A]/50 bg-[#D4A85A]/10 p-3 text-xs text-[#5A4F42]">
            <strong className="text-[#2A241E]">
              Transfer to {selectedMember?.displayName} (@{selectedMember?.username})?
            </strong>
            <p className="mt-1">
              You will be downgraded to editor and immediately lose access to world settings.
              The new owner will have full admin control. This cannot be undone.
            </p>
          </div>
          {error && <p className="text-xs text-[#8B4A52]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-[6px] px-3 py-1.5 text-xs text-[#5A4F42] transition hover:text-[#2A241E] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={doTransfer}
              disabled={pending}
              className="rounded-[6px] bg-[#D4A85A] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#C49840] disabled:opacity-40"
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
    <section className="rounded-[12px] border border-[#8B4A52]/40 bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-base font-semibold text-[#8B4A52]">Danger zone</h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        Deleting this world permanently removes all its notes, characters,
        sessions, and assets. This cannot be undone.
      </p>

      <TransferOwnershipSection worldId={worldId} csrfToken={csrfToken} members={members} />

      <div className="mt-4">
        {!confirming ? (
          <button
            type="button"
            onClick={openConfirm}
            className="rounded-[6px] border border-[#8B4A52]/50 bg-[#8B4A52]/10 px-3 py-1.5 text-sm font-medium text-[#8B4A52] transition hover:bg-[#8B4A52]/20"
          >
            Delete this world…
          </button>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[#5A4F42]">
                Type <strong>{worldName}</strong> to confirm
              </span>
              <input
                ref={inputRef}
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                className="w-full rounded-[6px] border border-[#8B4A52]/50 bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] outline-none focus:border-[#8B4A52]"
                placeholder={worldName}
              />
            </label>
            {error && <p className="text-xs text-[#8B4A52]">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-[6px] px-3 py-1.5 text-xs text-[#5A4F42] transition hover:text-[#2A241E]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteWorld}
                disabled={confirmName !== worldName || pending}
                className="rounded-[6px] bg-[#8B4A52] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#7A3A42] disabled:opacity-40"
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
