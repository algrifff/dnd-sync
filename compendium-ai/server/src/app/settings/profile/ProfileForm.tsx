'use client';

// Display-name + accent-colour form. Saves via PATCH /api/profile and
// triggers router.refresh() so the header chip + sidebar footer pick
// up the new values on the next RSC render.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ProfileForm({
  initialDisplayName,
  initialAccentColor,
  username,
  csrfToken,
  palette,
}: {
  initialDisplayName: string;
  initialAccentColor: string;
  username: string;
  csrfToken: string;
  palette: string[];
}): React.JSX.Element {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string>(initialDisplayName);
  const [accentColor, setAccentColor] = useState<string>(initialAccentColor);
  const [pending, setPending] = useState<boolean>(false);
  const [flash, setFlash] = useState<
    { kind: 'ok' | 'error'; message: string } | null
  >(null);

  const dirty =
    displayName.trim() !== initialDisplayName ||
    accentColor !== initialAccentColor;

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

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-[#5A4F42]">
          Username
        </span>
        <input
          type="text"
          value={username}
          disabled
          className="w-full cursor-not-allowed rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-sm text-[#5A4F42]"
        />
        <span className="mt-1 block text-xs text-[#5A4F42]">
          Usernames are fixed — ask an admin if you need it changed.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-[#5A4F42]">
          Display name
        </span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={80}
          className="w-full rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] px-3 py-2 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
        />
      </label>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[#5A4F42]">
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
                    ? 'scale-110 shadow-[0_0_0_2px_#FBF5E8,0_0_0_4px_#2A241E]'
                    : 'border-transparent hover:scale-105')
                }
                style={{ backgroundColor: c, borderColor: c }}
              />
            );
          })}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!dirty || pending}
          className="rounded-[8px] bg-[#2A241E] px-4 py-2 text-sm font-medium text-[#F4EDE0] transition hover:scale-[1.015] hover:bg-[#3A342E] disabled:opacity-50 disabled:hover:scale-100"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {flash && (
          <span
            className={
              'text-sm ' +
              (flash.kind === 'ok' ? 'text-[#7B8A5F]' : 'text-[#8B4A52]')
            }
          >
            {flash.message}
          </span>
        )}
      </div>
    </form>
  );
}
