'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Check, RefreshCw } from 'lucide-react';

export function ServerSettingsForm({
  worldId,
  worldName,
  headerColor,
  csrfToken,
  initialToken,
}: {
  worldId: string;
  worldName: string;
  headerColor: string | null;
  csrfToken: string;
  initialToken: string | null;
}): React.JSX.Element {
  return (
    <div className="space-y-8">
      <RenameSection worldId={worldId} worldName={worldName} csrfToken={csrfToken} />
      <HeaderColorSection worldId={worldId} initialColor={headerColor} csrfToken={csrfToken} />
      <InviteSection worldId={worldId} csrfToken={csrfToken} initialToken={initialToken} />
      <DangerZone worldId={worldId} worldName={worldName} csrfToken={csrfToken} />
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

function DangerZone({
  worldId,
  worldName,
  csrfToken,
}: {
  worldId: string;
  worldName: string;
  csrfToken: string;
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
    </section>
  );
}
