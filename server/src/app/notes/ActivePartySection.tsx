'use client';

// Sidebar widget that surfaces the PCs in the currently pinned campaign
// with quick damage / heal / set-HP / temp-HP controls. Renders above the
// folder tree inside FileTree.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  ChevronRight,
  Heart,
  Shield,
  UserRound,
} from 'lucide-react';
import {
  abilityModifier,
  formatModifier,
  portraitUrl,
  readAbilityScores,
  readArmorClass,
  readSpeed,
} from './sheet-header/util';
import type { CharacterListRow } from '@/lib/characters';

const OPEN_STORAGE_KEY = 'compendium.party.open';

function encodeNotePath(path: string): string {
  return '/notes/' + path.split('/').map(encodeURIComponent).join('/');
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

type HpTone = 'full' | 'injured' | 'down' | 'unknown';

function hpTone(current: number | null, max: number | null): HpTone {
  if (current == null || max == null) return 'unknown';
  if (current <= 0) return 'down';
  if (current >= max) return 'full';
  return 'injured';
}

const HP_PILL_CLASS: Record<HpTone, string> = {
  full: 'bg-[var(--moss)]/20 text-[#556049] border-[var(--moss)]/40',
  injured: 'bg-[var(--candlelight)]/25 text-[#6b5120] border-[var(--candlelight)]/50',
  down: 'bg-[var(--wine)]/20 text-[var(--wine)] border-[var(--wine)]/50',
  unknown: 'bg-[var(--rule)]/30 text-[var(--ink-muted)] border-[var(--rule)]',
};

type HpPatch = { current?: number; temporary?: number };

/** readAbilityScores only reads the nested `ability_scores` shape; many
 *  sheets still carry legacy flat `str/dex/con/int/wis/cha`. Try the new
 *  shape first, then fall back. */
function abilityScoresWithLegacy(
  sheet: Record<string, unknown>,
): { str: number; dex: number; con: number; int: number; wis: number; cha: number } | null {
  const nested = readAbilityScores(sheet);
  if (nested) return nested;
  const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
  const out = {} as Record<(typeof keys)[number], number>;
  let any = false;
  for (const k of keys) {
    const v = sheet[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    } else {
      out[k] = 10;
    }
  }
  return any ? out : null;
}

type SheetCacheValue =
  | { state: 'loading' }
  | { state: 'ready'; sheet: Record<string, unknown> }
  | { state: 'error' };

export function ActivePartySection({
  groupId,
  activeCampaignSlug,
  csrfToken,
  activePath,
}: {
  groupId: string;
  activeCampaignSlug: string | null;
  csrfToken: string;
  activePath: string;
}): React.JSX.Element {
  const [open, setOpen] = useState<boolean>(true);
  const [characters, setCharacters] = useState<CharacterListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_STORAGE_KEY);
      if (raw === '0') setOpen(false);
      else if (raw === '1') setOpen(true);
    } catch {
      // ignore storage errors (private mode, etc.)
    }
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(OPEN_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeCampaignSlug) {
      setCharacters([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const url =
      '/api/characters?kind=pc&campaign=' +
      encodeURIComponent(activeCampaignSlug);
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`failed (${res.status})`);
        const body = (await res.json()) as { characters: CharacterListRow[] };
        setCharacters(body.characters ?? []);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'failed to load');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [activeCampaignSlug]);

  // Optimistic HP + temp HP overrides keyed by notePath.
  const [hpOverride, setHpOverride] = useState<
    Record<string, { current: number | null; temporary: number | null }>
  >({});

  // Lazy-fetched sheet blobs for the hover card. Keyed by notePath.
  const [sheetCache, setSheetCache] = useState<Record<string, SheetCacheValue>>(
    {},
  );

  const ensureSheet = useCallback(
    (notePath: string): void => {
      if (sheetCache[notePath]) return;
      setSheetCache((m) => ({ ...m, [notePath]: { state: 'loading' } }));
      const url =
        '/api/notes/' +
        notePath.split('/').map(encodeURIComponent).join('/');
      fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error(`failed (${res.status})`);
          const body = (await res.json()) as {
            frontmatter?: { sheet?: Record<string, unknown> };
          };
          const sheet = body.frontmatter?.sheet ?? {};
          setSheetCache((m) => ({
            ...m,
            [notePath]: { state: 'ready', sheet },
          }));
        })
        .catch(() => {
          setSheetCache((m) => ({ ...m, [notePath]: { state: 'error' } }));
        });
    },
    [sheetCache],
  );

  const applyHp = useCallback(
    async (character: CharacterListRow, patch: HpPatch): Promise<void> => {
      const prevCurrent =
        hpOverride[character.notePath]?.current ?? character.hpCurrent;
      const prevTemporary =
        hpOverride[character.notePath]?.temporary ?? character.hpTemporary;
      const nextCurrent =
        patch.current !== undefined ? patch.current : (prevCurrent ?? 0);
      const nextTemporary =
        patch.temporary !== undefined ? patch.temporary : (prevTemporary ?? 0);

      setHpOverride((m) => ({
        ...m,
        [character.notePath]: { current: nextCurrent, temporary: nextTemporary },
      }));

      try {
        const res = await fetch('/api/notes/sheet', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            path: character.notePath,
            sheet: {
              hit_points: {
                current: nextCurrent,
                max: character.hpMax ?? 0,
                temporary: nextTemporary,
              },
              hp_current: nextCurrent,
              hp_temporary: nextTemporary,
            },
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sheet?: Record<string, unknown>;
          error?: string;
          reason?: string;
        };
        if (!res.ok || !body.ok) {
          setHpOverride((m) => ({
            ...m,
            [character.notePath]: {
              current: prevCurrent,
              temporary: prevTemporary,
            },
          }));
          setError(body.reason ?? body.error ?? `save failed (${res.status})`);
          return;
        }
        const sheet = body.sheet ?? {};
        const hp = (
          sheet as {
            hit_points?: { current?: unknown; temporary?: unknown };
          }
        ).hit_points;
        const confirmedCurrent =
          typeof hp?.current === 'number'
            ? hp.current
            : typeof (sheet as { hp_current?: unknown }).hp_current === 'number'
              ? (sheet as { hp_current: number }).hp_current
              : nextCurrent;
        const confirmedTemporary =
          typeof hp?.temporary === 'number'
            ? hp.temporary
            : typeof (sheet as { hp_temporary?: unknown }).hp_temporary ===
                'number'
              ? (sheet as { hp_temporary: number }).hp_temporary
              : nextTemporary;
        setHpOverride((m) => ({
          ...m,
          [character.notePath]: {
            current: confirmedCurrent,
            temporary: confirmedTemporary,
          },
        }));
        setError(null);
      } catch (err) {
        setHpOverride((m) => ({
          ...m,
          [character.notePath]: {
            current: prevCurrent,
            temporary: prevTemporary,
          },
        }));
        setError(err instanceof Error ? err.message : 'network error');
      }
    },
    [csrfToken, hpOverride],
  );

  const rows = useMemo(() => {
    return characters.map((c) => {
      const ov = hpOverride[c.notePath];
      return {
        ...c,
        hpCurrent: ov?.current ?? c.hpCurrent,
        hpTemporary: ov?.temporary ?? c.hpTemporary,
      };
    });
  }, [characters, hpOverride]);

  return (
    <section
      aria-label="Active party"
      className="mb-2 border-b border-[var(--rule)] pb-2"
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="group flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-soft)] hover:text-[var(--ink)]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        <Heart className="h-3.5 w-3.5 text-[var(--wine)]" aria-hidden />
        <span className="flex-1">Active Party</span>
        {characters.length > 0 && (
          <span className="text-[10px] font-normal text-[var(--ink-muted)]">
            {characters.length}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 px-1">
          {!activeCampaignSlug ? (
            <p className="px-2 py-1 text-xs italic text-[var(--ink-muted)]">
              Pin a campaign to see the active party.
            </p>
          ) : loading && characters.length === 0 ? (
            <p className="px-2 py-1 text-xs italic text-[var(--ink-muted)]">Loading…</p>
          ) : error && characters.length === 0 ? (
            <p className="px-2 py-1 text-xs text-[var(--wine)]">{error}</p>
          ) : characters.length === 0 ? (
            <p className="px-2 py-1 text-xs italic text-[var(--ink-muted)]">
              No party members yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {rows.map((c) => (
                <PartyRow
                  key={c.notePath}
                  character={c}
                  isActive={activePath === c.notePath}
                  onApplyHp={(patch) => void applyHp(c, patch)}
                  sheetCache={sheetCache[c.notePath]}
                  onHoverStart={() => ensureSheet(c.notePath)}
                />
              ))}
            </ul>
          )}
          {error && characters.length > 0 && (
            <p className="mt-1 px-2 text-[11px] text-[var(--wine)]">{error}</p>
          )}
          {activeCampaignSlug && (
            <JoinCampaignButton
              groupId={groupId}
              campaignSlug={activeCampaignSlug}
              csrfToken={csrfToken}
            />
          )}
        </div>
      )}
    </section>
  );
}

type MeCharacter = {
  id: string;
  name: string;
  kind: 'character' | 'person';
  portraitUrl: string | null;
};

function JoinCampaignButton({
  groupId,
  campaignSlug,
  csrfToken,
}: {
  groupId: string;
  campaignSlug: string;
  csrfToken: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [characters, setCharacters] = useState<MeCharacter[] | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    if (characters !== null) return;
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/me/characters', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`failed (${res.status})`);
        const body = (await res.json()) as { characters: MeCharacter[] };
        setCharacters(body.characters ?? []);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'failed to load');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [open, characters]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const join = useCallback(
    async (characterId: string): Promise<void> => {
      setError(null);
      try {
        const res = await fetch(
          `/api/worlds/${encodeURIComponent(groupId)}/campaigns/${encodeURIComponent(
            campaignSlug,
          )}/join`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ userCharacterId: characterId }),
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          reason?: string;
          detail?: string;
        };
        if (!res.ok || !body.ok) {
          setError(body.reason ?? body.detail ?? body.error ?? `join failed (${res.status})`);
          return;
        }
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      }
    },
    [groupId, campaignSlug, csrfToken, router],
  );

  return (
    <div ref={wrapperRef} className="relative mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full rounded-[6px] border border-dashed border-[var(--rule)] px-2 py-1 text-left text-[11px] font-medium text-[var(--ink-soft)] hover:bg-[var(--candlelight)]/15 hover:text-[var(--ink)]"
      >
        + Join with a character
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] p-1 shadow-lg">
          {loading && (
            <p className="px-2 py-1 text-[11px] italic text-[var(--ink-muted)]">
              Loading…
            </p>
          )}
          {error && (
            <p className="px-2 py-1 text-[11px] text-[var(--wine)]">{error}</p>
          )}
          {!loading && characters && characters.length === 0 && (
            <p className="px-2 py-1 text-[11px] italic text-[var(--ink-muted)]">
              You have no characters yet.{' '}
              <Link href="/me" className="underline">
                Create one
              </Link>
              .
            </p>
          )}
          {characters?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => void join(c.id)}
              className="flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left text-[12px] text-[var(--ink)] hover:bg-[var(--candlelight)]/20"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--rule)] bg-[var(--parchment-sunk)]">
                {c.portraitUrl ? (
                  <img src={c.portraitUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[9px] font-semibold text-[var(--ink-muted)]">
                    {initials(c.name)}
                  </span>
                )}
              </span>
              <span className="truncate font-serif">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PartyRow({
  character,
  isActive,
  onApplyHp,
  sheetCache,
  onHoverStart,
}: {
  character: CharacterListRow;
  isActive: boolean;
  onApplyHp: (patch: HpPatch) => void;
  sheetCache: SheetCacheValue | undefined;
  onHoverStart: () => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [hoverOpen, setHoverOpen] = useState(false);
  const [hoverAnchor, setHoverAnchor] = useState<
    { top: number; left: number } | null
  >(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLAnchorElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginHover = useCallback((): void => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (!nameRef.current) return;
      const r = nameRef.current.getBoundingClientRect();
      // Anchor against the whole row wrapper so the card floats off the
      // right edge of the sidebar, not off the name span.
      const rowRect =
        wrapperRef.current?.getBoundingClientRect() ?? r;
      setHoverAnchor({ top: r.top, left: rowRect.right + 8 });
      setHoverOpen(true);
      onHoverStart();
    }, 220);
  }, [onHoverStart]);

  const endHover = useCallback((): void => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setHoverOpen(false);
    }, 120);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hoverOpen) return;
    const onScrollOrResize = (): void => {
      if (!nameRef.current) return;
      const r = nameRef.current.getBoundingClientRect();
      const rowRect =
        wrapperRef.current?.getBoundingClientRect() ?? r;
      setHoverAnchor({ top: r.top, left: rowRect.right + 8 });
    };
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [hoverOpen]);

  const openMenu = useCallback(() => {
    if (!pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    setAnchor({ top: r.top, left: r.right + 8 });
    setMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (wrapperRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onScrollOrResize = (): void => {
      if (!pillRef.current) return;
      const r = pillRef.current.getBoundingClientRect();
      setAnchor({ top: r.top, left: r.right + 8 });
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [menuOpen]);

  const href = encodeNotePath(character.notePath);
  const portrait = portraitUrl(character.portraitPath);
  const tone = hpTone(character.hpCurrent, character.hpMax);
  const pillClass = HP_PILL_CLASS[tone];
  const levelClass = [
    character.level ? `Lv${character.level}` : null,
    character.class ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  const tempHp = character.hpTemporary ?? 0;

  return (
    <li className="list-none">
      <div
        ref={wrapperRef}
        className={
          'group relative flex items-center gap-2 rounded-[6px] px-1.5 py-1 transition hover:bg-[var(--candlelight)]/15 ' +
          (isActive ? 'bg-[var(--candlelight)]/25' : '')
        }
      >
        <Link
          ref={nameRef}
          href={href}
          onMouseEnter={beginHover}
          onMouseLeave={endHover}
          onFocus={beginHover}
          onBlur={endHover}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--rule)] bg-[var(--parchment-sunk)]">
            {portrait ? (
              <img
                src={portrait}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex items-center justify-center text-[10px] font-semibold text-[var(--ink-muted)]">
                {character.displayName ? (
                  initials(character.displayName)
                ) : (
                  <UserRound className="h-3.5 w-3.5" aria-hidden />
                )}
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate font-serif text-[13px] text-[var(--ink)]">
              {character.displayName}
            </span>
            {levelClass && (
              <span className="truncate text-[10px] text-[var(--ink-soft)]">
                {levelClass}
              </span>
            )}
          </span>
        </Link>
        {tempHp > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-[#6B8AA8]/50 bg-[#6B8AA8]/15 px-1.5 py-px font-serif text-[11px] tabular-nums text-[#3e5770]"
            title={`${tempHp} temporary HP`}
          >
            <Shield className="h-2.5 w-2.5" aria-hidden />
            {tempHp}
          </span>
        )}
        <button
          ref={pillRef}
          type="button"
          aria-label="Adjust HP"
          aria-expanded={menuOpen}
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          className={
            'shrink-0 rounded-full border px-1.5 py-px font-serif text-[11px] tabular-nums transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--world-accent,var(--candlelight))] ' +
            pillClass
          }
          title={
            character.hpCurrent != null && character.hpMax != null
              ? `${character.hpCurrent} / ${character.hpMax} HP — click to adjust`
              : 'Adjust HP'
          }
        >
          {character.hpCurrent ?? '—'}
          <span className="text-[var(--ink-muted)]">/</span>
          {character.hpMax ?? '—'}
        </button>
        {hoverOpen && hoverAnchor && (
          <PartyHoverCard
            anchor={hoverAnchor}
            character={character}
            cache={sheetCache}
            onMouseEnter={() => {
              if (closeTimerRef.current) {
                clearTimeout(closeTimerRef.current);
                closeTimerRef.current = null;
              }
            }}
            onMouseLeave={endHover}
          />
        )}
        {menuOpen && anchor && (
          <HpAdjustMenu
            ref={menuRef}
            anchor={anchor}
            current={character.hpCurrent}
            max={character.hpMax}
            temporary={character.hpTemporary}
            onApply={(patch) => {
              onApplyHp(patch);
              setMenuOpen(false);
            }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </li>
  );
}

function PartyHoverCard({
  anchor,
  character,
  cache,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor: { top: number; left: number };
  character: CharacterListRow;
  cache: SheetCacheValue | undefined;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}): React.JSX.Element {
  if (typeof document === 'undefined') return <></>;

  const portrait = portraitUrl(character.portraitPath);
  const sheet = cache?.state === 'ready' ? cache.sheet : null;
  const scores = sheet ? abilityScoresWithLegacy(sheet) : null;
  const ac = sheet ? readArmorClass(sheet) : null;
  const speed = sheet ? readSpeed(sheet) : null;
  const initiative = scores
    ? abilityModifier(scores.dex) +
      (typeof sheet?.initiative_bonus === 'number' ? sheet.initiative_bonus : 0)
    : null;
  const tone = hpTone(character.hpCurrent, character.hpMax);
  const pillClass = HP_PILL_CLASS[tone];
  const tempHp = character.hpTemporary ?? 0;

  const subtitleParts = [
    character.race ?? null,
    character.class ?? null,
    character.level ? `Level ${character.level}` : null,
  ].filter(Boolean) as string[];

  return createPortal(
    <div
      role="tooltip"
      aria-label={`${character.displayName} details`}
      style={{ top: anchor.top, left: anchor.left }}
      className="fixed z-[1000] w-72 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] p-3 shadow-lg"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--rule)] bg-[var(--parchment-sunk)]">
          {portrait ? (
            <img
              src={portrait}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="font-serif text-lg text-[var(--ink-muted)]">
              {character.displayName ? initials(character.displayName) : '?'}
            </span>
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-serif text-lg leading-tight text-[var(--ink)]">
            {character.displayName}
          </span>
          {subtitleParts.length > 0 && (
            <span className="truncate text-[11px] text-[var(--ink-soft)]">
              {subtitleParts.join(' · ')}
            </span>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              className={
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-serif text-[12px] tabular-nums ' +
                pillClass
              }
              title={
                character.hpCurrent != null && character.hpMax != null
                  ? `${character.hpCurrent} / ${character.hpMax} HP`
                  : 'HP'
              }
            >
              <Heart className="h-3 w-3" aria-hidden />
              {character.hpCurrent ?? '—'}
              <span className="text-[var(--ink-muted)]">/</span>
              {character.hpMax ?? '—'}
            </span>
            {tempHp > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-[#6B8AA8]/50 bg-[#6B8AA8]/15 px-2 py-0.5 font-serif text-[12px] tabular-nums text-[#3e5770]"
                title={`${tempHp} temporary HP`}
              >
                <Shield className="h-3 w-3" aria-hidden />
                {tempHp}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <StatTile label="AC" value={ac != null ? String(ac) : '—'} />
        <StatTile
          label="Initiative"
          value={initiative != null ? formatModifier(initiative) : '—'}
        />
        <StatTile label="Speed" value={speed != null ? `${speed} ft` : '—'} />
      </div>

      <div className="mt-2 grid grid-cols-6 gap-1">
        {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).map((k) => {
          const score = scores ? scores[k] : null;
          const mod = score != null ? abilityModifier(score) : null;
          return (
            <div
              key={k}
              className="flex flex-col items-center rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/60 px-1 py-1.5"
            >
              <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
                {k}
              </span>
              <span className="font-serif text-base leading-none text-[var(--ink)]">
                {score != null ? score : '—'}
              </span>
              <span className="mt-0.5 font-serif text-[10px] text-[var(--ink-soft)]">
                {mod != null ? formatModifier(mod) : ''}
              </span>
            </div>
          );
        })}
      </div>

      {cache?.state === 'loading' && !scores && (
        <p className="mt-2 text-center text-[10px] italic text-[var(--ink-muted)]">
          Loading sheet…
        </p>
      )}
      {cache?.state === 'error' && (
        <p className="mt-2 text-center text-[10px] text-[var(--wine)]">
          Failed to load sheet
        </p>
      )}
    </div>,
    document.body,
  );
}

function StatTile({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/60 px-1 py-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        {label}
      </span>
      <span className="font-serif text-base leading-none text-[var(--ink)]">
        {value}
      </span>
    </div>
  );
}

const HpAdjustMenu = function HpAdjustMenu({
  ref,
  anchor,
  current,
  max,
  temporary,
  onApply,
  onClose,
}: {
  ref: React.Ref<HTMLDivElement>;
  anchor: { top: number; left: number };
  current: number | null;
  max: number | null;
  temporary: number | null;
  onApply: (patch: HpPatch) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [damage, setDamage] = useState('');
  const [heal, setHeal] = useState('');
  const [set, setSet] = useState('');
  const [temp, setTemp] = useState('');

  const cur = current ?? 0;
  const hardMax = max ?? 0;
  const curTemp = temporary ?? 0;

  // D&D 5e rule: damage drains temp HP first, then real HP.
  const applyDamage = (): void => {
    const n = Math.abs(parseInt(damage, 10));
    if (!Number.isFinite(n) || n === 0) return;
    const tempAbsorbed = Math.min(curTemp, n);
    const nextTemp = curTemp - tempAbsorbed;
    const nextCurrent = cur - (n - tempAbsorbed);
    onApply({ current: nextCurrent, temporary: nextTemp });
    setDamage('');
  };
  const applyHeal = (): void => {
    const n = Math.abs(parseInt(heal, 10));
    if (!Number.isFinite(n) || n === 0) return;
    const next = hardMax > 0 ? Math.min(cur + n, hardMax) : cur + n;
    onApply({ current: next });
    setHeal('');
  };
  const applySet = (): void => {
    const n = parseInt(set, 10);
    if (!Number.isFinite(n)) return;
    onApply({ current: n });
    setSet('');
  };
  // Temp HP doesn't stack — taking the larger value is the 5e rule,
  // but players often want to overwrite explicitly; honour the input.
  const applyTemp = (): void => {
    const raw = temp.trim();
    if (raw === '') return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    onApply({ temporary: Math.max(0, n) });
    setTemp('');
  };

  if (typeof document === 'undefined') return <></>;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Adjust hit points"
      style={{ top: anchor.top, left: anchor.left }}
      className="fixed z-[1000] w-52 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] p-2 shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="font-serif text-[11px] text-[var(--ink-soft)]">
          {cur}
          <span className="text-[var(--ink-muted)]">/</span>
          {hardMax || '—'} HP
          {curTemp > 0 && (
            <span className="ml-1 text-[#3e5770]">+{curTemp} temp</span>
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-[10px] text-[var(--ink-muted)] hover:text-[var(--ink)]"
        >
          ✕
        </button>
      </div>
      <HpInputRow
        buttonLabel="Damage"
        buttonTone="var(--wine)"
        value={damage}
        onChange={setDamage}
        onApply={applyDamage}
      />
      <HpInputRow
        buttonLabel="Heal"
        buttonTone="var(--moss)"
        value={heal}
        onChange={setHeal}
        onApply={applyHeal}
      />
      <HpInputRow
        buttonLabel="Set"
        buttonTone="var(--ink-soft)"
        value={set}
        onChange={setSet}
        onApply={applySet}
      />
      <HpInputRow
        buttonLabel="Temp"
        buttonTone="#3e5770"
        value={temp}
        onChange={setTemp}
        onApply={applyTemp}
      />
    </div>,
    document.body,
  );
};

function HpInputRow({
  buttonLabel,
  buttonTone,
  value,
  onChange,
  onApply,
}: {
  buttonLabel: string;
  buttonTone: string;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
}): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-1 last:mb-0">
      <input
        type="number"
        inputMode="numeric"
        aria-label={buttonLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onApply();
          }
        }}
        className="w-14 rounded-[4px] border border-[var(--rule)] bg-white/60 px-1 py-0.5 text-right text-xs tabular-nums text-[var(--ink)] outline-none focus:border-[var(--world-accent,var(--candlelight))] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={onApply}
        className="flex-1 rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition hover:brightness-95"
        style={{
          color: buttonTone,
          borderColor: buttonTone + '55',
          backgroundColor: buttonTone + '15',
        }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
