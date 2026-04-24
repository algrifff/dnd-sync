'use client';

// Display name, accent colour, avatar, and cursor-mode form. Saves
// via PATCH /api/profile for scalar fields and POST /api/profile/avatar
// for the image upload. router.refresh() after each successful save
// so the header chip + sidebar footer pick up the new values on the
// next RSC render.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type CursorMode = 'color' | 'image';
type Theme = 'day' | 'night';

const AVATAR_MAX_DIM = 128; // post-resize longest edge in px
const AVATAR_MIME = 'image/webp'; // smallest modern encode
const AVATAR_QUALITY = 0.85;

export function ProfileForm({
  userId,
  initialDisplayName,
  initialAccentColor,
  initialCursorMode,
  initialAvatarVersion,
  initialTheme,
  username,
  csrfToken,
  palette,
}: {
  userId: string;
  initialDisplayName: string;
  initialAccentColor: string;
  initialCursorMode: CursorMode;
  initialAvatarVersion: number;
  initialTheme: Theme;
  username: string;
  csrfToken: string;
  palette: string[];
}): React.JSX.Element {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string>(initialDisplayName);
  const [accentColor, setAccentColor] = useState<string>(initialAccentColor);
  const [cursorMode, setCursorMode] = useState<CursorMode>(initialCursorMode);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [avatarVersion, setAvatarVersion] = useState<number>(initialAvatarVersion);
  const [pending, setPending] = useState<boolean>(false);
  const [avatarPending, setAvatarPending] = useState<boolean>(false);
  const [flash, setFlash] = useState<
    { kind: 'ok' | 'error'; message: string } | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const themeChanged = theme !== initialTheme;
  const dirty =
    displayName.trim() !== initialDisplayName ||
    accentColor !== initialAccentColor ||
    cursorMode !== initialCursorMode ||
    themeChanged;

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!dirty || pending) return;
    setPending(true);
    setFlash(null);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          displayName: displayName.trim(),
          accentColor,
          cursorMode,
          theme,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setFlash({
          kind: 'error',
          message: body.detail ?? body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setFlash({ kind: 'ok', message: 'Profile updated.' });
      // `data-theme` lives on <html>, set by the root layout from the
      // theme cookie. `router.refresh()` re-runs the RSC tree but reuses
      // the existing HTML document, so the attribute won't update. Do a
      // full reload when the theme changed so the new palette actually
      // takes effect.
      if (themeChanged) {
        window.location.reload();
        return;
      }
      router.refresh();
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setPending(false);
    }
  };

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarPending(true);
    setFlash(null);
    try {
      const blob = await resizeImage(file, AVATAR_MAX_DIM);
      const res = await fetch('/api/profile/avatar', {
        method: 'POST',
        headers: {
          'Content-Type': blob.type,
          'X-CSRF-Token': csrfToken,
        },
        body: blob,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setFlash({
          kind: 'error',
          message: body.detail ?? body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setAvatarVersion(typeof body.avatarVersion === 'number' ? body.avatarVersion : Date.now());
      setFlash({ kind: 'ok', message: 'Avatar updated.' });
      router.refresh();
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'upload failed',
      });
    } finally {
      setAvatarPending(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAvatar = async (): Promise<void> => {
    if (!avatarVersion) return;
    if (!confirm('Remove your profile image?')) return;
    setAvatarPending(true);
    setFlash(null);
    try {
      const res = await fetch('/api/profile/avatar', {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFlash({
          kind: 'error',
          message: body.detail ?? body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setAvatarVersion(0);
      // Avatar gone — if the user had cursor mode set to image, flip
      // it back to colour so their peers don't keep chasing a 404.
      if (cursorMode === 'image') setCursorMode('color');
      setFlash({ kind: 'ok', message: 'Avatar removed.' });
      router.refresh();
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setAvatarPending(false);
    }
  };

  const avatarUrl =
    avatarVersion > 0 ? `/api/users/${userId}/avatar?v=${avatarVersion}` : null;

  return (
    <form onSubmit={submit} className="space-y-5">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-[var(--ink-soft)]">
          Username
        </span>
        <input
          type="text"
          value={username}
          disabled
          className="w-full cursor-not-allowed rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-sm text-[var(--ink-soft)]"
        />
        <span className="mt-1 block text-xs text-[var(--ink-soft)]">
          Usernames are fixed — ask an admin if you need it changed.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-[var(--ink-soft)]">
          Display name
        </span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={80}
          className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
        />
      </label>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--ink-soft)]">
          Accent colour
        </legend>
        <div className="flex flex-wrap items-center gap-2">
          {palette.map((c) => {
            const selected = c === accentColor;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setAccentColor(c)}
                aria-pressed={selected}
                title={c}
                className={
                  'h-8 w-8 rounded-full border-2 transition ' +
                  (selected
                    ? 'scale-110 shadow-[0_0_0_2px_var(--vellum),0_0_0_4px_var(--ink)]'
                    : 'border-transparent hover:scale-105')
                }
                style={{ backgroundColor: c, borderColor: c }}
              />
            );
          })}
          <label
            className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-[var(--ink-soft)] bg-[var(--parchment)] text-[10px] font-medium text-[var(--ink-soft)] transition hover:scale-105"
            title="Custom colour"
          >
            <span aria-hidden>+</span>
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent p-0 opacity-0"
              aria-label="Custom accent colour"
            />
          </label>
          <span className="font-mono text-xs text-[var(--ink-soft)]">{accentColor}</span>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--ink-soft)]">
          Profile image
        </legend>
        <div className="flex items-center gap-3">
          <div
            className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-[var(--rule)] bg-[var(--parchment)]"
            style={avatarUrl ? undefined : { backgroundColor: accentColor }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Your avatar"
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center text-lg font-semibold text-[var(--parchment)]"
                aria-hidden
              >
                {(displayName || username).slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarPending}
                className="rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--parchment-sunk)] disabled:opacity-50"
              >
                {avatarPending ? 'Uploading…' : avatarUrl ? 'Change' : 'Upload'}
              </button>
              {avatarUrl && (
                <button
                  type="button"
                  onClick={removeAvatar}
                  disabled={avatarPending}
                  className="rounded-[8px] px-3 py-1.5 text-xs font-medium text-[var(--wine)] transition hover:bg-[var(--wine)]/10 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onPickAvatar}
                className="hidden"
              />
            </div>
            <span className="text-xs text-[var(--ink-soft)]">
              Shrunk to {AVATAR_MAX_DIM}px in your browser before upload.
            </span>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--ink-soft)]">
          Live cursor
        </legend>
        <div className="flex flex-wrap items-center gap-2">
          <CursorChoice
            label="Accent colour"
            value="color"
            current={cursorMode}
            onSelect={setCursorMode}
          />
          <CursorChoice
            label="Profile image"
            value="image"
            current={cursorMode}
            onSelect={setCursorMode}
            disabled={!avatarUrl}
            disabledHint="Upload an image first"
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--ink-soft)]">
          Appearance
        </legend>
        <div className="inline-flex overflow-hidden rounded-[8px] border border-[var(--rule)]">
          <ThemeChoice label="Daytime" value="day" current={theme} onSelect={setTheme} />
          <ThemeChoice label="Nighttime" value="night" current={theme} onSelect={setTheme} />
        </div>
        <p className="mt-1 text-xs text-[var(--ink-soft)]">
          Switches the whole app to a warm dark palette. Affects only your account.
        </p>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || pending}
          className="rounded-[8px] bg-[var(--ink)] px-4 py-2 text-sm font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-50 disabled:hover:scale-100"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {flash && (
          <span
            className={
              'text-sm ' +
              (flash.kind === 'ok' ? 'text-[var(--moss)]' : 'text-[var(--wine)]')
            }
          >
            {flash.message}
          </span>
        )}
      </div>
    </form>
  );
}

function CursorChoice({
  label,
  value,
  current,
  onSelect,
  disabled = false,
  disabledHint,
}: {
  label: string;
  value: CursorMode;
  current: CursorMode;
  onSelect: (v: CursorMode) => void;
  disabled?: boolean;
  disabledHint?: string;
}): React.JSX.Element {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect(value)}
      disabled={disabled}
      title={disabled ? disabledHint : label}
      aria-pressed={selected}
      className={
        'rounded-[8px] border px-3 py-1.5 text-xs font-medium transition ' +
        (selected
          ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--parchment)]'
          : 'border-[var(--rule)] bg-[var(--parchment)] text-[var(--ink)] hover:bg-[var(--parchment-sunk)]') +
        (disabled ? ' cursor-not-allowed opacity-50 hover:bg-[var(--parchment)]' : '')
      }
    >
      {label}
    </button>
  );
}

function ThemeChoice({
  label,
  value,
  current,
  onSelect,
}: {
  label: string;
  value: Theme;
  current: Theme;
  onSelect: (v: Theme) => void;
}): React.JSX.Element {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={
        'px-4 py-1.5 text-xs font-medium transition ' +
        (selected
          ? 'bg-[var(--ink)] text-[var(--parchment)]'
          : 'bg-[var(--parchment)] text-[var(--ink)] hover:bg-[var(--parchment-sunk)]')
      }
    >
      {label}
    </button>
  );
}

/** Resize a user-picked image to fit inside `maxDim` px on its
 *  longest edge, re-encoding as WebP at fixed quality. The result is
 *  a Blob the caller POSTs as the raw request body. Square crop
 *  isn't applied — we preserve aspect so users can upload wider/
 *  taller portraits; the cursor renderer will cover-fit. */
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
      AVATAR_MIME,
      AVATAR_QUALITY,
    );
  });
}
