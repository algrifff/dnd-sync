'use client';

// Active-character block — the first thing in the left sidebar,
// above the file tree. Shows your currently-pinned PC (portrait +
// name + level/class tagline) and a dropdown to switch among the
// PCs you own across every campaign. Selecting a new one persists
// via PATCH /api/profile (activeCharacterPath) so the pin survives
// restarts; clicking the block opens that character's sheet.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, UserRound } from 'lucide-react';

type Character = {
  notePath: string;
  displayName: string;
  portraitPath: string | null;
  level: number | null;
  class: string | null;
  campaigns: string[];
};

export function ActiveCharacterBlock({
  csrfToken,
  initialActivePath,
}: {
  csrfToken: string;
  initialActivePath: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(initialActivePath);
  const [open, setOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/characters?mine=1', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { characters?: Character[] };
        if (cancelled) return;
        setCharacters(body.characters ?? []);
      } catch {
        if (!cancelled) setCharacters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const active = characters?.find((c) => c.notePath === activePath) ?? null;

  const setActive = async (path: string | null): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const previous = activePath;
    setActivePath(path);
    setOpen(false);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ activeCharacterPath: path }),
      });
      if (!res.ok) {
        setActivePath(previous);
      } else {
        router.refresh();
      }
    } catch {
      setActivePath(previous);
    } finally {
      setSaving(false);
    }
  };

  const portraitUrl =
    active?.portraitPath
      ? `/api/assets/by-path?path=${encodeURIComponent(active.portraitPath)}`
      : null;

  const tagline = active
    ? [active.level != null ? `Lv ${active.level}` : null, active.class]
        .filter((p): p is string => !!p)
        .join(' · ')
    : null;

  return (
    <div
      ref={menuRef}
      className="relative shrink-0 border-b border-[#D4C7AE] bg-[#EAE1CF]/70 p-2"
    >
      <div className="flex items-center gap-2">
        {/* Character tile — clicks through to the sheet */}
        {active ? (
          <Link
            href={`/notes/${active.notePath
              .split('/')
              .map(encodeURIComponent)
              .join('/')}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] bg-[#FBF5E8] px-2 py-1.5 text-left transition hover:bg-[#F4EDE0]"
          >
            <CharacterAvatar
              portraitUrl={portraitUrl}
              displayName={active.displayName}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-[#2A241E]">
                {active.displayName}
              </div>
              {tagline && (
                <div className="truncate text-[10px] text-[#5A4F42]">
                  {tagline}
                </div>
              )}
            </div>
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] bg-[#FBF5E8]/60 px-2 py-1.5 text-xs text-[#5A4F42]">
            <CharacterAvatar portraitUrl={null} displayName="?" />
            <span className="flex-1 truncate">No active character</span>
          </div>
        )}
        {/* Switcher button */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label="Switch active character"
          aria-expanded={open}
          className="shrink-0 rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] p-1.5 text-[#5A4F42] transition hover:bg-[#F4EDE0]"
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>

      {open && (
        <div className="absolute left-2 right-2 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-[8px] border border-[#D4C7AE] bg-[#FBF5E8] shadow-[0_6px_16px_rgba(42,36,30,0.14)]">
          <MenuItem
            onClick={() => setActive(null)}
            selected={activePath == null}
          >
            <span className="text-[#5A4F42]">None</span>
          </MenuItem>
          {characters == null ? (
            <div className="px-3 py-2 text-xs text-[#5A4F42]">Loading…</div>
          ) : characters.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[#5A4F42]">
              You don&rsquo;t own any characters yet. Mark a character with
              your username in <code>player:</code> frontmatter.
            </div>
          ) : (
            characters.map((c) => (
              <MenuItem
                key={c.notePath}
                onClick={() => setActive(c.notePath)}
                selected={activePath === c.notePath}
              >
                <CharacterAvatar
                  portraitUrl={
                    c.portraitPath
                      ? `/api/assets/by-path?path=${encodeURIComponent(c.portraitPath)}`
                      : null
                  }
                  displayName={c.displayName}
                  small
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-[#2A241E]">
                    {c.displayName}
                  </div>
                  {c.campaigns.length > 0 && (
                    <div className="truncate text-[10px] text-[#5A4F42]">
                      {c.campaigns.join(', ')}
                    </div>
                  )}
                </div>
              </MenuItem>
            ))
          )}
          <div className="border-t border-[#D4C7AE]">
            <Link
              href="/characters"
              className="flex items-center gap-2 px-3 py-2 text-xs text-[#2A241E] transition hover:bg-[#F4EDE0]"
              onClick={() => setOpen(false)}
            >
              <UserRound size={12} aria-hidden />
              All characters
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-[#F4EDE0] ' +
        (selected ? 'bg-[#F4EDE0]' : '')
      }
    >
      {children}
    </button>
  );
}

function CharacterAvatar({
  portraitUrl,
  displayName,
  small = false,
}: {
  portraitUrl: string | null;
  displayName: string;
  small?: boolean;
}): React.JSX.Element {
  const size = small ? 'h-6 w-6' : 'h-8 w-8';
  return (
    <div
      className={
        size +
        ' shrink-0 overflow-hidden rounded-full border border-[#D4C7AE] bg-[#F4EDE0]'
      }
    >
      {portraitUrl ? (
        <img
          src={portraitUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-[#5A4F42]">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}
