'use client';

// Minimal editor for a user-level character. Fields patch back to
// /api/me/characters/[id] with a short debounce. Shape matches the
// nested sheet the existing SheetHeader reads so switching editors
// later does not force a data migration.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Trash2, UserRound } from 'lucide-react';
import type { UserCharacter } from '@/lib/userCharacters';

const PATCH_DEBOUNCE_MS = 400;
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type AbilityKey = (typeof ABILITY_KEYS)[number];

type HitPoints = {
  current?: number | undefined;
  max?: number | undefined;
  temporary?: number | undefined;
};
type AbilityScores = Partial<Record<AbilityKey, number | undefined>>;
type ArmorClass = { value?: number | undefined };

type LocalSheet = {
  class?: string | undefined;
  level?: number | undefined;
  hit_points?: HitPoints | undefined;
  armor_class?: ArmorClass | undefined;
  ability_scores?: AbilityScores | undefined;
};

function readSheet(sheet: Record<string, unknown>): LocalSheet {
  const hp = (sheet.hit_points ?? {}) as HitPoints;
  const ac = (sheet.armor_class ?? {}) as ArmorClass;
  const abil = (sheet.ability_scores ?? {}) as AbilityScores;
  return {
    class: typeof sheet.class === 'string' ? (sheet.class as string) : undefined,
    level: typeof sheet.level === 'number' ? (sheet.level as number) : undefined,
    hit_points: hp,
    armor_class: ac,
    ability_scores: abil,
  };
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
  const [portraitUrl, setPortraitUrl] = useState<string>(
    character.portraitUrl ?? '',
  );
  const [sheet, setSheet] = useState<LocalSheet>(readSheet(character.sheet));
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Record<string, unknown>>({});

  const flush = useCallback(async (): Promise<void> => {
    const patch = pendingPatch.current;
    if (Object.keys(patch).length === 0) return;
    pendingPatch.current = {};
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
    (partial: Record<string, unknown>): void => {
      pendingPatch.current = { ...pendingPatch.current, ...partial };
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

  const patchSheet = (partial: LocalSheet): void => {
    setSheet((prev) => {
      const next = { ...prev, ...partial };
      schedule({ sheet: partial });
      return next;
    });
  };

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
    if (!window.confirm(`Delete ${character.name}? This cannot be undone.`)) return;
    const res = await fetch(
      `/api/me/characters/${encodeURIComponent(character.id)}`,
      {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      },
    );
    if (res.ok) router.push('/me');
  };

  const hp = sheet.hit_points ?? {};
  const ac = sheet.armor_class ?? {};
  const abilities = sheet.ability_scores ?? {};

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
        <span
          className={
            'text-[11px] ' +
            (error ? 'text-[var(--wine)]' : 'text-[var(--ink-soft)]')
          }
        >
          {statusLabel}
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <div className="mb-6 flex items-start gap-4">
          {portraitUrl ? (
            <img
              src={portraitUrl}
              alt=""
              className="h-20 w-20 shrink-0 rounded-[12px] object-cover"
            />
          ) : (
            <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[12px] bg-[var(--parchment-sunk)] text-[var(--ink-soft)]">
              <UserRound size={32} aria-hidden />
            </span>
          )}
          <div className="flex-1">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              className="w-full bg-transparent font-serif text-3xl text-[var(--ink)] outline-none"
              placeholder="Character name"
            />
            <div className="mt-1 text-xs uppercase tracking-wider text-[var(--ink-soft)]">
              {character.kind}
            </div>
          </div>
        </div>

        <Section title="Basics">
          <Field label="Class">
            <input
              type="text"
              value={sheet.class ?? ''}
              onChange={(e) => patchSheet({ class: e.target.value })}
              className={fieldCls}
              placeholder="e.g. Fighter"
            />
          </Field>
          <Field label="Level">
            <input
              type="number"
              min={1}
              max={20}
              value={sheet.level ?? ''}
              onChange={(e) =>
                patchSheet({
                  level: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              className={numCls}
            />
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
        </Section>

        <Section title="Vitals">
          <Field label="HP current">
            <input
              type="number"
              value={hp.current ?? ''}
              onChange={(e) =>
                patchSheet({
                  hit_points: {
                    ...hp,
                    current: e.target.value === '' ? undefined : Number(e.target.value),
                  },
                })
              }
              className={numCls}
            />
          </Field>
          <Field label="HP max">
            <input
              type="number"
              value={hp.max ?? ''}
              onChange={(e) =>
                patchSheet({
                  hit_points: {
                    ...hp,
                    max: e.target.value === '' ? undefined : Number(e.target.value),
                  },
                })
              }
              className={numCls}
            />
          </Field>
          <Field label="AC">
            <input
              type="number"
              value={ac.value ?? ''}
              onChange={(e) =>
                patchSheet({
                  armor_class: {
                    value: e.target.value === '' ? undefined : Number(e.target.value),
                  },
                })
              }
              className={numCls}
            />
          </Field>
        </Section>

        <Section title="Ability scores">
          {ABILITY_KEYS.map((k) => (
            <Field key={k} label={k.toUpperCase()}>
              <input
                type="number"
                min={1}
                max={30}
                value={abilities[k] ?? ''}
                onChange={(e) =>
                  patchSheet({
                    ability_scores: {
                      ...abilities,
                      [k]: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
                className={numCls}
              />
            </Field>
          ))}
        </Section>

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

const fieldCls =
  'w-full rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]';

const numCls =
  'w-24 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-2 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-serif text-base text-[var(--ink)]">{title}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">
        {label}
      </span>
      {children}
    </label>
  );
}
