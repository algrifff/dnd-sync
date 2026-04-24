'use client';

// Character header: portrait + name / race / class (inline-edit, name-
// style) over AC / HP / Speed / Init tiles, with an editable ability
// strip beneath. Mirrors HP / ability edits to the legacy flat fields
// so the CharacterSheet side panel stays in sync during transition.

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { User } from 'lucide-react';
import { InlineText } from './InlineText';
import { InlineNumber } from './InlineNumber';
import { StatTile } from './StatTile';
import { AbilityScoreStrip } from './AbilityScoreStrip';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { usePatchSheet } from './usePatchSheet';
import {
  abilityModifier,
  formatClassList,
  formatModifier,
  parseClassList,
  portraitUrl,
  readAbilityScores,
  readArmorClass,
  readHitPoints,
  readInitiative,
  readSpeed,
  refName,
  titleSizeClass,
} from './util';

export function CharacterHeader({
  initialSheet,
  notePath,
  csrfToken,
  provider,
  canEdit,
  displayName,
}: {
  initialSheet: Record<string, unknown>;
  notePath: string;
  csrfToken: string;
  provider: HocuspocusProvider;
  canEdit: boolean;
  displayName: string;
}): React.JSX.Element {
  const { sheet, patchSheet, saving, error } = usePatchSheet({
    notePath,
    csrfToken,
    provider,
    initialSheet,
  });
  const [pickerOpen, setPickerOpen] = useState(false);

  const name = typeof sheet.name === 'string' ? sheet.name : displayName;
  const classesLabel = formatClassList(sheet.classes);
  const raceName = refName(sheet.race);
  const backgroundName = refName(sheet.background);

  const hp = readHitPoints(sheet);
  const ac = readArmorClass(sheet);
  const speed = readSpeed(sheet);
  const init = readInitiative(sheet);
  const scores =
    readAbilityScores(sheet) ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  // Legacy flat fields stay in sync so the template-driven CharacterSheet
  // side panel keeps working.
  const setHpCurrent = (n: number | null): void => {
    const next = {
      current: n ?? 0,
      max: hp.max ?? 0,
      temporary: hp.temporary ?? 0,
    };
    patchSheet({ hit_points: next, hp_current: next.current });
  };
  const setHpMax = (n: number | null): void => {
    const next = {
      current: hp.current ?? 0,
      max: n ?? 0,
      temporary: hp.temporary ?? 0,
    };
    patchSheet({ hit_points: next, hp_max: next.max });
  };
  const setAc = (n: number | null): void => {
    patchSheet({ armor_class: { value: n ?? 0 }, ac: n ?? 0 });
  };
  const setSpeed = (n: number | null): void => {
    patchSheet({ speed: { walk: n ?? 0 } });
  };
  const setScores = (next: typeof scores): void => {
    // Mirror each score to the legacy flat keys the old CharacterSheet
    // template still reads (str/dex/con/int/wis/cha).
    patchSheet({
      ability_scores: next,
      str: next.str,
      dex: next.dex,
      con: next.con,
      int: next.int,
      wis: next.wis,
      cha: next.cha,
    });
  };

  return (
    <>
      {/* Header sits flush on the page — no card chrome — so it reads
       *  like ink on the notebook, not a UI panel. Inner tiles
       *  (stat tiles, ability boxes) keep their own borders so
       *  they still feel like objects on the page. */}
      <section className="mb-4 p-5">
        <div className="flex items-start gap-5">
          <Portrait
            url={pUrl}
            displayName={name}
            canEdit={canEdit}
            onOpen={() => setPickerOpen(true)}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <InlineText
                value={name}
                readOnly={!canEdit}
                className={`font-serif ${titleSizeClass(name, 'hero')} font-semibold leading-tight text-[var(--ink)]`}
                inputClassName={`font-serif ${titleSizeClass(name, 'hero')} font-semibold leading-tight text-[var(--ink)]`}
                onCommit={(next) => {
                  // Schema requires a non-empty name; a blank clear
                  // would otherwise bounce the whole PATCH as invalid.
                  const trimmed = next.trim();
                  if (trimmed) patchSheet({ name: trimmed });
                }}
                ariaLabel="Character name"
              />
              <SaveIndicator saving={saving} error={error} />
            </div>

            {/* Race / class / background — serif, see-through buttons so
             *  they read as part of the title block, not as pills. */}
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-serif text-base text-[var(--ink-soft)]">
              <InlineText
                value={raceName ?? ''}
                readOnly={!canEdit}
                className="font-serif"
                inputClassName="font-serif text-base"
                placeholder={canEdit ? 'Race' : ''}
                onCommit={(next) =>
                  patchSheet({ race: next ? { ref: { name: next } } : null })
                }
                ariaLabel="Race"
              />
              <span aria-hidden className="text-[var(--ink-muted)]">
                ·
              </span>
              <InlineText
                value={classesLabel}
                readOnly={!canEdit}
                className="font-serif"
                inputClassName="font-serif text-base"
                placeholder={canEdit ? 'Class (e.g. Warlock 3)' : ''}
                onCommit={(next) =>
                  patchSheet({ classes: next ? parseClassList(next) : [] })
                }
                ariaLabel="Classes"
              />
              <span aria-hidden className="text-[var(--ink-muted)]">
                ·
              </span>
              <InlineText
                value={backgroundName ?? ''}
                readOnly={!canEdit}
                className="font-serif"
                inputClassName="font-serif text-base"
                placeholder={canEdit ? 'Background' : ''}
                onCommit={(next) =>
                  patchSheet({
                    background: next ? { ref: { name: next } } : null,
                  })
                }
                ariaLabel="Background"
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <StatTile label="AC" value={ac} onCommit={canEdit ? setAc : undefined} />
              <StatTile label="HP">
                <InlineNumber
                  value={hp.current}
                  onCommit={setHpCurrent}
                  readOnly={!canEdit}
                  className="font-serif text-lg font-semibold text-[var(--ink)]"
                  inputClassName="font-serif text-lg font-semibold w-12 text-[var(--ink)]"
                  ariaLabel="HP current"
                />
                <span className="text-xs text-[var(--ink-soft)]">/</span>
                <InlineNumber
                  value={hp.max}
                  onCommit={setHpMax}
                  readOnly={!canEdit}
                  className="font-serif text-lg font-semibold text-[var(--ink)]"
                  inputClassName="font-serif text-lg font-semibold w-12 text-[var(--ink)]"
                  ariaLabel="HP max"
                />
              </StatTile>
              <StatTile
                label="Speed"
                value={speed}
                suffix="ft"
                onCommit={canEdit ? setSpeed : undefined}
              />
              <StatTile label="Init">
                <InlineNumber
                  value={init ?? abilityModifier(scores.dex)}
                  readOnly={!canEdit}
                  // Editing the total, not the bonus — so the user types
                  // the initiative they want and we back out the bonus
                  // from DEX mod. Keeps the bonus stable when DEX later
                  // changes (total follows DEX the way the rules expect).
                  onCommit={(n) =>
                    n == null
                      ? undefined
                      : patchSheet({
                          initiative_bonus: n - abilityModifier(scores.dex),
                        })
                  }
                  format={(n) => (n == null ? '—' : formatModifier(n))}
                  className="font-serif text-lg font-semibold text-[var(--ink)]"
                  inputClassName="font-serif text-lg font-semibold w-12 text-[var(--ink)]"
                  ariaLabel="Initiative"
                />
              </StatTile>
            </div>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--rule)] pt-4">
          <AbilityScoreStrip
            scores={scores}
            readOnly={!canEdit}
            onChange={canEdit ? setScores : undefined}
          />
        </div>
      </section>

      <PortraitPicker
        open={pickerOpen}
        csrfToken={csrfToken}
        currentUrl={pUrl}
        onClose={() => setPickerOpen(false)}
        onPick={(value) => patchSheet({ portrait: value })}
      />
    </>
  );
}

function Portrait({
  url,
  displayName,
  canEdit,
  onOpen,
}: {
  url: string | null;
  displayName: string;
  canEdit: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const inner = url ? (
    // object-contain so the portrait is never cropped
    <img src={url} alt="" className="h-full w-full object-contain" />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-5xl font-semibold text-[var(--ink-soft)]">
      {displayName.slice(0, 1).toUpperCase() || <User size={48} />}
    </div>
  );
  const cls =
    'h-44 w-44 shrink-0 overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--parchment-sunk)]';
  if (!canEdit) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Change portrait"
      className={`${cls} relative hover:border-[var(--ink)]`}
    >
      {inner}
    </button>
  );
}
