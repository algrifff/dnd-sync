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
  formatModifier,
  readAbilityScores,
  readArmorClass,
  readHitPoints,
  readSpeed,
} from '@/app/notes/sheet-header/util';
import type { TemplateField, TemplateSection } from '@/lib/templates';
import type { UserCharacter } from '@/lib/userCharacters';
import { UserCharacterBody } from './UserCharacterBody';

const PATCH_DEBOUNCE_MS = 400;
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type AbilityKey = (typeof ABILITY_KEYS)[number];

// Fields the hero strip already owns — skip them when rendering the
// template sections below so we don't render the same field twice.
const HERO_FIELD_IDS = new Set<string>([
  'name',
  'hp_current',
  'hp_max',
  'ac',
  'speed',
  'initiative_bonus',
  ...ABILITY_KEYS,
]);

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
  sections,
}: {
  csrfToken: string;
  character: UserCharacter;
  sections: TemplateSection[];
}): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState<string>(character.name);
  const [portraitUrl, setPortraitUrl] = useState<string>(character.portraitUrl ?? '');
  const [sheet, setSheet] = useState<Record<string, unknown>>(character.sheet);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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

  const commitPortrait = (): void => {
    const trimmed = portraitUrl.trim();
    if (trimmed === (character.portraitUrl ?? '')) return;
    schedule({ portraitUrl: trimmed || null });
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
  const setInitiativeBonus = (value: number | null): void => {
    patchSheet({ initiative_bonus: value ?? 0 });
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
        {/* Hero strip — PartyHoverCard styling. */}
        <div className="mb-6 rounded-[10px] border border-[var(--rule)] bg-[var(--vellum)]/60 p-4">
          <div className="flex items-start gap-4">
            <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--rule)] bg-[var(--parchment-sunk)]">
              {portraitUrl ? (
                <img src={portraitUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserRound size={32} aria-hidden className="text-[var(--ink-muted)]" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                className="w-full bg-transparent font-serif text-3xl leading-tight text-[var(--ink)] outline-none"
                placeholder="Character name"
              />
              <span className="mt-0.5 text-[11px] uppercase tracking-wider text-[var(--ink-soft)]">
                {character.kind}
              </span>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1.5">
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

          <div className="mt-2 grid grid-cols-6 gap-1">
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

        {/* Remaining template sections. */}
        {sections.map((section) => {
          const fields = section.fields.filter((f) => !HERO_FIELD_IDS.has(f.id));
          if (fields.length === 0) return null;
          return (
            <section key={section.id} className="mb-6">
              <h2 className="mb-3 font-serif text-base text-[var(--ink)]">
                {section.label}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {fields.map((f) => (
                  <FieldEditor
                    key={f.id}
                    field={f}
                    value={sheet[f.id]}
                    onChange={(v) => patchSheet({ [f.id]: v })}
                  />
                ))}
              </div>
            </section>
          );
        })}

        <section className="mb-6">
          <h2 className="mb-3 font-serif text-base text-[var(--ink)]">Initiative bonus</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Initiative bonus">
              <NumberInput value={initiativeBonus} onChange={setInitiativeBonus} />
            </Field>
            <Field label="Portrait URL">
              <input
                type="url"
                value={portraitUrl}
                onChange={(e) => setPortraitUrl(e.target.value)}
                onBlur={commitPortrait}
                placeholder="https://…"
                className={fieldCls}
              />
            </Field>
          </div>
        </section>

        <UserCharacterBody
          characterId={character.id}
          csrfToken={csrfToken}
          initialBody={character.bodyJson}
        />

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
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-serif text-[12px] tabular-nums ' +
        HP_PILL_CLASS[tone]
      }
      title="Hit points"
    >
      <Heart className="h-3 w-3" aria-hidden />
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
      className="inline-flex items-center gap-1 rounded-full border border-[#6B8AA8]/50 bg-[#6B8AA8]/15 px-2 py-0.5 font-serif text-[12px] tabular-nums text-[#3e5770]"
      title="Temporary HP"
    >
      <Shield className="h-3 w-3" aria-hidden />
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
      className="w-8 bg-transparent text-center font-serif tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
    <div className="flex flex-col items-center rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/60 px-1 py-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        {label}
      </span>
      <div className="flex items-baseline gap-0.5">
        <input
          type="number"
          inputMode="numeric"
          value={value ?? ''}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : Number(e.target.value))
          }
          placeholder="—"
          className="w-12 bg-transparent text-center font-serif text-base leading-none text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {suffix && (
          <span className="font-serif text-[10px] text-[var(--ink-soft)]">
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
      className="flex flex-col items-center rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/60 px-1 py-1.5"
      title={hint}
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
        {label}
      </span>
      <span className="font-serif text-base leading-none text-[var(--ink)]">
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
    <div className="flex flex-col items-center rounded-[6px] border border-[var(--rule)] bg-[var(--parchment-sunk)]/60 px-1 py-1.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]">
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
        className="w-10 bg-transparent text-center font-serif text-base leading-none text-[var(--ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="mt-0.5 font-serif text-[10px] text-[var(--ink-soft)]">
        {formatModifier(mod)}
      </span>
    </div>
  );
}

// ── Generic field editor (for the template sections below the hero) ────

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: TemplateField;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.JSX.Element {
  return (
    <Field label={field.label} hint={field.hint}>
      {renderControl(field, value, onChange)}
    </Field>
  );
}

function renderControl(
  field: TemplateField,
  value: unknown,
  onChange: (v: unknown) => void,
): React.JSX.Element {
  switch (field.type) {
    case 'integer':
    case 'number':
      return (
        <NumberInput
          value={typeof value === 'number' ? value : null}
          onChange={(v) => onChange(v)}
          min={field.min}
          max={field.max}
        />
      );
    case 'boolean':
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-[var(--rule)] text-[var(--candlelight)]"
        />
      );
    case 'enum':
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={fieldCls}
        >
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case 'longtext':
      return (
        <textarea
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          rows={3}
          className={fieldCls + ' resize-y'}
        />
      );
    case 'list<text>':
      return (
        <input
          type="text"
          value={Array.isArray(value) ? value.join(', ') : ''}
          onChange={(e) => {
            const raw = e.target.value;
            const arr = raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            onChange(arr);
          }}
          placeholder="comma, separated"
          className={fieldCls}
        />
      );
    case 'text':
    default:
      // Tolerate legacy nested { ref: { name } } shapes for race / background.
      return (
        <input
          type="text"
          value={readTextLike(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={fieldCls}
        />
      );
  }
}

function readTextLike(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const ref = obj.ref as Record<string, unknown> | undefined;
    if (typeof ref?.name === 'string') return ref.name;
    if (typeof obj.name === 'string') return obj.name;
  }
  return '';
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number | undefined;
  max?: number | undefined;
}): React.JSX.Element {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value ?? ''}
      onChange={(e) =>
        onChange(e.target.value === '' ? null : Number(e.target.value))
      }
      className={numCls}
    />
  );
}

const fieldCls =
  'w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]';

const numCls =
  'w-24 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[10px] italic text-[var(--ink-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}
