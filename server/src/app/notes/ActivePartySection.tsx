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
import {
  ChevronDown,
  ChevronRight,
  Heart,
  Shield,
  UserRound,
} from 'lucide-react';
import { portraitUrl } from './sheet-header/util';
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
  full: 'bg-[#7B8A5F]/20 text-[#556049] border-[#7B8A5F]/40',
  injured: 'bg-[#D4A85A]/25 text-[#6b5120] border-[#D4A85A]/50',
  down: 'bg-[#8B4A52]/20 text-[#8B4A52] border-[#8B4A52]/50',
  unknown: 'bg-[#D4C7AE]/30 text-[#8A7E6B] border-[#D4C7AE]',
};

type HpPatch = { current?: number; temporary?: number };

export function ActivePartySection({
  activeCampaignSlug,
  csrfToken,
  activePath,
}: {
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
      className="mb-2 border-b border-[#D4C7AE] pb-2"
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="group flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-[#5A4F42] hover:text-[#2A241E]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
        <Heart className="h-3.5 w-3.5 text-[#8B4A52]" aria-hidden />
        <span className="flex-1">Active Party</span>
        {characters.length > 0 && (
          <span className="text-[10px] font-normal text-[#8A7E6B]">
            {characters.length}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 px-1">
          {!activeCampaignSlug ? (
            <p className="px-2 py-1 text-xs italic text-[#8A7E6B]">
              Pin a campaign to see the active party.
            </p>
          ) : loading && characters.length === 0 ? (
            <p className="px-2 py-1 text-xs italic text-[#8A7E6B]">Loading…</p>
          ) : error && characters.length === 0 ? (
            <p className="px-2 py-1 text-xs text-[#8B4A52]">{error}</p>
          ) : characters.length === 0 ? (
            <p className="px-2 py-1 text-xs italic text-[#8A7E6B]">
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
                />
              ))}
            </ul>
          )}
          {error && characters.length > 0 && (
            <p className="mt-1 px-2 text-[11px] text-[#8B4A52]">{error}</p>
          )}
        </div>
      )}
    </section>
  );
}

function PartyRow({
  character,
  isActive,
  onApplyHp,
}: {
  character: CharacterListRow;
  isActive: boolean;
  onApplyHp: (patch: HpPatch) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

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
          'group relative flex items-center gap-2 rounded-[6px] px-1.5 py-1 transition hover:bg-[#D4A85A]/15 ' +
          (isActive ? 'bg-[#D4A85A]/25' : '')
        }
      >
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#D4C7AE] bg-[#EAE1CF]">
            {portrait ? (
              <img
                src={portrait}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="flex items-center justify-center text-[10px] font-semibold text-[#8A7E6B]">
                {character.displayName ? (
                  initials(character.displayName)
                ) : (
                  <UserRound className="h-3.5 w-3.5" aria-hidden />
                )}
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate font-serif text-[13px] text-[#2A241E]">
              {character.displayName}
            </span>
            {levelClass && (
              <span className="truncate text-[10px] text-[#5A4F42]">
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
            'shrink-0 rounded-full border px-1.5 py-px font-serif text-[11px] tabular-nums transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--world-accent,#D4A85A)] ' +
            pillClass
          }
          title={
            character.hpCurrent != null && character.hpMax != null
              ? `${character.hpCurrent} / ${character.hpMax} HP — click to adjust`
              : 'Adjust HP'
          }
        >
          {character.hpCurrent ?? '—'}
          <span className="text-[#8A7E6B]">/</span>
          {character.hpMax ?? '—'}
        </button>
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
      className="fixed z-[1000] w-52 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] p-2 shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between px-0.5">
        <span className="font-serif text-[11px] text-[#5A4F42]">
          {cur}
          <span className="text-[#8A7E6B]">/</span>
          {hardMax || '—'} HP
          {curTemp > 0 && (
            <span className="ml-1 text-[#3e5770]">+{curTemp} temp</span>
          )}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-[10px] text-[#8A7E6B] hover:text-[#2A241E]"
        >
          ✕
        </button>
      </div>
      <HpInputRow
        buttonLabel="Damage"
        buttonTone="#8B4A52"
        value={damage}
        onChange={setDamage}
        onApply={applyDamage}
      />
      <HpInputRow
        buttonLabel="Heal"
        buttonTone="#7B8A5F"
        value={heal}
        onChange={setHeal}
        onApply={applyHeal}
      />
      <HpInputRow
        buttonLabel="Set"
        buttonTone="#5A4F42"
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
        className="w-14 rounded-[4px] border border-[#D4C7AE] bg-white/60 px-1 py-0.5 text-right text-xs tabular-nums text-[#2A241E] outline-none focus:border-[var(--world-accent,#D4A85A)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
