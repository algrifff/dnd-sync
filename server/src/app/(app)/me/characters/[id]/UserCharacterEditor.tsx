'use client';

// Master-record editor for a user-level character. Hero strip mirrors the
// in-world PartyHoverCard look (HP pill, temp HP shield, AC/Initiative/
// Speed tiles, 6-up ability grid). Remaining template sections render as
// a typed form below. All writes PATCH /api/me/characters/[id] with a
// 400ms debounce; the master-→-notes sync engine fans changes out to any
// bound campaign notes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Heart, Shield, Trash2, UserRound } from 'lucide-react';
import {
  abilityModifier,
  formatClassList,
  formatModifier,
  parseClassList,
  readAbilityScores,
  readArmorClass,
  readHitPoints,
  readSpeed,
  refName,
} from '@/app/notes/sheet-header/util';
import { uploadImageAsset } from '@/lib/image-upload';
import type { UserCharacter } from '@/lib/userCharacters';
import { UserCharacterBody } from './UserCharacterBody';
import { SkillsList } from './SkillsList';
import { ImportPdfButton } from './ImportPdfButton';

type BodyTab = 'notes' | 'skills';

const PATCH_DEBOUNCE_MS = 400;
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type AbilityKey = (typeof ABILITY_KEYS)[number];

type HpTone = 'full' | 'injured' | 'down' | 'unknown';
function hpTone(current: number | null, max: number | null): HpTone {
  if (current == null || max == null) return 'unknown';
  if (current <= 0) return 'down';
  if (current >= max) return 'full';
  return 'injured';
}
const HP_PILL_CLASS: Record<HpTone, string> = {
  full: 'bg-[rgb(var(--moss-rgb)/0.2)] text-[var(--moss)] border-[rgb(var(--moss-rgb)/0.5)]',
  injured: 'bg-[rgb(var(--candlelight-rgb)/0.25)] text-[var(--candlelight)] border-[rgb(var(--candlelight-rgb)/0.55)]',
  down: 'bg-[rgb(var(--wine-rgb)/0.2)] text-[var(--wine)] border-[rgb(var(--wine-rgb)/0.55)]',
  unknown: 'bg-[var(--rule)]/30 text-[var(--ink-muted)] border-[var(--rule)]',
};

function abilityScoresWithLegacy(
  sheet: Record<string, unknown>,
): Record<AbilityKey, number> {
  const nested = readAbilityScores(sheet);
  if (nested) return nested;
  const out = {} as Record<AbilityKey, number>;
  for (const k of ABILITY_KEYS) {
    const v = sheet[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : 10;
  }
  return out;
}

export function UserCharacterEditor({
  csrfToken,
  character,
}: {
  csrfToken: string;
  character: UserCharacter;
}): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState<string>(character.name);
  const [portraitUrl, setPortraitUrl] = useState<string>(character.portraitUrl ?? '');
  const [sheet, setSheet] = useState<Record<string, unknown>>(character.sheet);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [bodyTab, setBodyTab] = useState<BodyTab>('notes');

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Record<string, unknown>>({});
  const pendingSheetPatch = useRef<Record<string, unknown>>({});

  const flush = useCallback(async (): Promise<void> => {
    const patch: Record<string, unknown> = { ...pendingPatch.current };
    if (Object.keys(pendingSheetPatch.current).length > 0) {
      patch.sheet = pendingSheetPatch.current;
    }
    if (Object.keys(patch).length === 0) return;
    pendingPatch.current = {};
    pendingSheetPatch.current = {};
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/me/characters/${encodeURIComponent(character.id)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        setError(body.reason ?? body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setSaving(false);
    }
  }, [character.id, csrfToken]);

  const schedule = useCallback(
    (top: Record<string, unknown>, sheetPart?: Record<string, unknown>): void => {
      pendingPatch.current = { ...pendingPatch.current, ...top };
      if (sheetPart) {
        pendingSheetPatch.current = { ...pendingSheetPatch.current, ...sheetPart };
      }
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        void flush();
      }, PATCH_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      void flush();
    };
  }, [flush]);

  const patchSheet = useCallback(
    (partial: Record<string, unknown>): void => {
      setSheet((prev) => ({ ...prev, ...partial }));
      schedule({}, partial);
    },
    [schedule],
  );

  const commitName = (): void => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === character.name) return;
    schedule({ name: trimmed });
  };

  const onDelete = async (): Promise<void> => {
    if (!window.confirm(`Delete ${character.name}? This cannot be undone.`))
      return;
    const res = await fetch(
      `/api/me/characters/${encodeURIComponent(character.id)}`,
      { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } },
    );
    if (res.ok) router.push('/me');
  };

  const hp = readHitPoints(sheet);
  const ac = readArmorClass(sheet);
  const speed = readSpeed(sheet);
  const scores = abilityScoresWithLegacy(sheet);
  const initiativeBonus =
    typeof sheet.initiative_bonus === 'number' ? sheet.initiative_bonus : 0;
  const initiative = abilityModifier(scores.dex) + initiativeBonus;

  const tone = hpTone(hp.current, hp.max);
  const tempHp = hp.temporary ?? 0;

  // ── Hero patch helpers — write nested + legacy mirror in one go. ──
  const setHp = (next: { current?: number | null; max?: number | null; temporary?: number | null }): void => {
    const merged = {
      current: next.current !== undefined ? next.current : hp.current,
      max: next.max !== undefined ? next.max : hp.max,
      temporary: next.temporary !== undefined ? next.temporary : hp.temporary,
    };
    patchSheet({
      hit_points: {
        current: merged.current ?? 0,
        max: merged.max ?? 0,
        temporary: merged.temporary ?? 0,
      },
      hp_current: merged.current ?? null,
      hp_max: merged.max ?? null,
      hp_temporary: merged.temporary ?? null,
    });
  };
  const setAc = (value: number | null): void => {
    patchSheet({
      armor_class: { value: value ?? 0 },
      ac: value,
    });
  };
  const setSpeed = (walk: number | null): void => {
    patchSheet({
      speed: walk == null ? undefined : { walk },
    });
  };
  const setAbility = (k: AbilityKey, value: number | null): void => {
    const next = { ...scores, [k]: value ?? 10 };
    patchSheet({
      ability_scores: next,
      [k]: value,
    });
  };
  const statusLabel = useMemo<string>(() => {
    if (error) return `Error: ${error}`;
    if (saving) return 'Saving…';
    return 'Saved';
  }, [error, saving]);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--parchment)]">
      <header className="flex items-center justify-between border-b border-[var(--rule)] bg-[var(--vellum)] px-6 py-3">
        <button
          type="button"
          onClick={() => router.push('/me')}
          className="flex items-center gap-1 text-xs font-medium text-[var(--ink-soft)] transition hover:text-[var(--ink)]"
        >
          <ArrowLeft size={14} aria-hidden /> Back to overview
        </button>
        <div className="flex items-center gap-3">
          <span
            className={
              'text-[11px] ' +
              (error ? 'text-[var(--wine)]' : 'text-[var(--ink-soft)]')
            }
          >
            {statusLabel}
          </span>
          <ImportPdfButton characterId={character.id} csrfToken={csrfToken} />
          <button
            type="button"
            onClick={() => router.push('/me')}
            className="rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--candlelight)]/20"
          >
            Done
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        {/* Hero strip — sized to match the in-world character note header. */}
        <div className="mb-6">
          <div className="flex items-start gap-5">
            <PortraitButton
              url={portraitUrl}
              csrfToken={csrfToken}
              onUpload={(url) => {
                setPortraitUrl(url);
                schedule({ portraitUrl: url });
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                className="w-full bg-transparent font-serif text-4xl font-semibold leading-tight text-[var(--ink)] outline-none"
                placeholder="Character name"
              />
              <SubtitleRow sheet={sheet} onPatch={patchSheet} />

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <HpPill
                  tone={tone}
                  current={hp.current}
                  max={hp.max}
                  onCurrent={(v) => setHp({ current: v })}
                  onMax={(v) => setHp({ max: v })}
                />
                <TempHpPill
                  value={tempHp}
                  onChange={(v) => setHp({ temporary: v })}
                />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                <EditableTile
                  label="AC"
                  value={ac}
                  onChange={setAc}
                />
                <ReadOnlyTile
                  label="Initiative"
                  value={formatModifier(initiative)}
                  hint="DEX mod + bonus"
                />
                <EditableTile
                  label="Speed"
                  value={speed}
                  suffix="ft"
                  onChange={setSpeed}
                />
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-6 gap-2 border-t border-[var(--rule)] pt-4">
            {ABILITY_KEYS.map((k) => (
              <AbilityTile
                key={k}
                ability={k}
                score={scores[k]}
                onChange={(v) => setAbility(k, v)}
              />
            ))}
          </div>
        </div>



        <section className="mb-6">
          <div
            role="tablist"
            aria-label="Notes and skills"
            className="mb-3 flex items-center gap-4 border-b border-[var(--rule)]"
          >
            <TabButton
              active={bodyTab === 'notes'}
              onClick={() => setBodyTab('notes')}
            >
              Notes
            </TabButton>
            <TabButton
              active={bodyTab === 'skills'}
              onClick={() => setBodyTab('skills')}
            >
              Skills
            </TabButton>
          </div>
          {/* Both kept mounted so the TipTap editor preserves state. */}
          <div className={bodyTab === 'notes' ? 'block' : 'hidden'}>
            <UserCharacterBody
              characterId={character.id}
              csrfToken={csrfToken}
              initialBody={character.bodyJson}
            />
          </div>
          <div className={bodyTab === 'skills' ? 'block' : 'hidden'}>
            <SkillsList sheet={sheet} onPatch={patchSheet} />
          </div>
        </section>

        <div className="mt-8 flex items-center justify-between border-t border-[var(--rule)] pt-6">
          <span className="text-[11px] text-[var(--ink-soft)]">
            Created {new Date(character.createdAt).toLocaleDateString()}
          </span>
          <button
            type="button"
            onClick={() => void onDelete()}
            className="flex items-center gap-1 rounded-[6px] border border-[var(--wine)] px-3 py-1.5 text-xs font-medium text-[var(--wine)] transition hover:bg-[var(--wine)] hover:text-[var(--parchment)]"
          >
            <Trash2 size={12} aria-hidden /> Delete character
          </button>
        </div>
      </main>
    </div>
  );
}

// ── Tab strip ──────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        'relative -mb-px border-b-2 px-1 py-2 font-serif text-base transition ' +
        (active
          ? 'border-[var(--ink)] text-[var(--ink)]'
          : 'border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]')
      }
    >
      {children}
    </button>
  );
}

// ── Hero pieces ────────────────────────────────────────────────────────

function HpPill({
  tone,
  current,
  max,
  onCurrent,
  onMax,
}: {
  tone: HpTone;
  current: number | null;
  max: number | null;
  onCurrent: (v: number | null) => void;
  onMax: (v: number | null) => void;
}): React.JSX.Element {
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-serif text-base font-semibold tabular-nums ' +
        HP_PILL_CLASS[tone]
      }
      title="Hit points"
    >
      <Heart className="h-4 w-4" aria-hidden />
      <PillNumber value={current} onChange={onCurrent} />
      <span className="text-[var(--ink-muted)]">/</span>
      <PillNumber value={max} onChange={onMax} />
    </span>
  );
}

function TempHpPill({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number | null) => void;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(var(--sage-rgb)/0.55)] bg-[rgb(var(--sage-rgb)/0.18)] px-3 py-1 font-serif text-base font-semibold tabular-nums text-[var(--sage)]"
      title="Temporary HP"
    >
      <Shield className="h-4 w-4" aria-hidden />
      <PillNumber value={value || null} onChange={onChange} placeholder="0" />
    </span>
  );
}

function PillNumber({
  value,
  onChange,
  placeholder = '—',
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) =>
        onChange(e.target.value === '' ? null : Number(e.target.value))
      }
      className="w-10 bg-transparent text-center font-serif tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

function EditableTile({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  onChange: (v: number | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center rounded-[10px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        <input
          type="number"
          inputMode="numeric"
          value={value ?? ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : Number(e.target.value))
          }
          placeholder="—"
          className="w-14 bg-transparent text-center font-serif text-lg font-semibold leading-tight text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {suffix && (
          <span className="font-serif text-xs text-[var(--ink-soft)]">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function ReadOnlyTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div
      className="flex flex-col items-center rounded-[10px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2"
      title={hint}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        {label}
      </span>
      <span className="font-serif text-lg font-semibold leading-tight text-[var(--ink)]">
        {value}
      </span>
    </div>
  );
}

function AbilityTile({
  ability,
  score,
  onChange,
}: {
  ability: AbilityKey;
  score: number;
  onChange: (v: number | null) => void;
}): React.JSX.Element {
  const mod = abilityModifier(score);
  return (
    <div className="flex aspect-square w-full flex-col items-center justify-center rounded-[10px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        {ability}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={30}
        value={score}
        onChange={(e) =>
          onChange(e.target.value === '' ? null : Number(e.target.value))
        }
        className="w-16 bg-transparent text-center font-serif text-3xl font-normal leading-tight text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="mt-0.5 text-sm font-medium text-[var(--ink-soft)]">
        {formatModifier(mod)}
      </span>
    </div>
  );
}

// ── Portrait (click to upload) ─────────────────────────────────────────

function PortraitButton({
  url,
  csrfToken,
  onUpload,
}: {
  url: string;
  csrfToken: string;
  onUpload: (url: string) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onPick = async (file: File): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const asset = await uploadImageAsset(file, csrfToken);
      onUpload(`/api/assets/${asset.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label="Change portrait"
        disabled={busy}
        className="group relative h-44 w-44 shrink-0 overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--parchment-sunk)] transition hover:border-[var(--ink)]"
      >
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[var(--ink-soft)]">
            <UserRound size={48} aria-hidden />
            <span className="text-[11px] font-medium uppercase tracking-wide">
              Upload portrait
            </span>
          </div>
        )}
        {url && (
          <span className="absolute inset-x-0 bottom-0 bg-[rgb(0_0_0/0.55)] py-1 text-center text-[11px] font-medium uppercase tracking-wide text-[var(--parchment)] opacity-0 transition group-hover:opacity-100">
            {busy ? 'Uploading…' : 'Change'}
          </span>
        )}
      </button>
      {err && (
        <span className="mt-1 block text-[10px] text-[var(--wine)]">{err}</span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onPick(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ── Race · Class · Background subtitle ─────────────────────────────────

function SubtitleRow({
  sheet,
  onPatch,
}: {
  sheet: Record<string, unknown>;
  onPatch: (partial: Record<string, unknown>) => void;
}): React.JSX.Element {
  const race = refName(sheet.race) ?? '';
  const classes = formatClassList(sheet.classes);
  const background = refName(sheet.background) ?? '';
  return (
    <div className="mt-1 flex flex-nowrap items-baseline gap-x-2 overflow-hidden font-serif text-base text-[var(--ink-soft)]">
      <SubtitleInput
        value={race}
        placeholder="Race"
        ariaLabel="Race"
        onCommit={(next) =>
          onPatch({ race: next ? { ref: { name: next } } : null })
        }
      />
      <span aria-hidden className="text-[var(--ink-muted)]">·</span>
      <SubtitleInput
        value={classes}
        placeholder="Class"
        ariaLabel="Classes"
        onCommit={(next) =>
          onPatch({ classes: next ? parseClassList(next) : [] })
        }
      />
      <span aria-hidden className="text-[var(--ink-muted)]">·</span>
      <SubtitleInput
        value={background}
        placeholder="Background"
        ariaLabel="Background"
        onCommit={(next) =>
          onPatch({ background: next ? { ref: { name: next } } : null })
        }
      />
    </div>
  );
}

function SubtitleInput({
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed !== value.trim()) onCommit(trimmed);
      }}
      className="min-w-[4ch] border-0 border-b-2 border-transparent bg-transparent p-0 font-serif text-base text-[var(--ink-soft)] outline-none placeholder:text-[var(--ink-muted)] hover:border-[var(--world-accent,#8A7E6B)] focus:border-[var(--world-accent,#8A7E6B)] focus:outline-0 focus:ring-0 focus-visible:outline-0"
    />
  );
}

