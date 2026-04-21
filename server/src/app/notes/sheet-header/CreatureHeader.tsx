'use client';

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { InlineText } from './InlineText';
import { InlineNumber } from './InlineNumber';
import { ChipSelect } from './ChipSelect';
import { StatTile } from './StatTile';
import { AbilityScoreStrip } from './AbilityScoreStrip';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { usePatchSheet } from './usePatchSheet';
import {
  portraitUrl,
  readAbilityScores,
  readArmorClass,
  readHitPoints,
  readSpeed,
  titleSizeClass,
} from './util';

const SIZES = [
  { value: 'tiny', label: 'Tiny' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'huge', label: 'Huge' },
  { value: 'gargantuan', label: 'Gargantuan' },
];
const TYPES = [
  { value: 'aberration', label: 'Aberration' },
  { value: 'beast', label: 'Beast' },
  { value: 'celestial', label: 'Celestial' },
  { value: 'construct', label: 'Construct' },
  { value: 'dragon', label: 'Dragon' },
  { value: 'elemental', label: 'Elemental' },
  { value: 'fey', label: 'Fey' },
  { value: 'fiend', label: 'Fiend' },
  { value: 'giant', label: 'Giant' },
  { value: 'humanoid', label: 'Humanoid' },
  { value: 'monstrosity', label: 'Monstrosity' },
  { value: 'ooze', label: 'Ooze' },
  { value: 'plant', label: 'Plant' },
  { value: 'undead', label: 'Undead' },
];

export function CreatureHeader({
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
  const size = typeof sheet.size === 'string' ? sheet.size : null;
  const type = typeof sheet.type === 'string' ? sheet.type : null;
  const cr =
    typeof sheet.challenge_rating === 'number' ? sheet.challenge_rating : null;

  const hp = readHitPoints(sheet);
  const ac = readArmorClass(sheet);
  const speed = readSpeed(sheet);
  const scores =
    readAbilityScores(sheet) ?? { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  const setHp = (current: number | null, max: number | null): void => {
    patchSheet({
      hit_points: {
        current: current ?? 0,
        max: max ?? 0,
        temporary: hp.temporary ?? 0,
      },
    });
  };
  const setAc = (n: number | null): void => {
    patchSheet({ armor_class: { value: n ?? 0 } });
  };

  return (
    <>
      <section className="mb-4 p-5">
        <div className="flex items-start gap-4">
          <CreaturePortrait
            url={pUrl}
            canEdit={canEdit}
            onOpen={() => setPickerOpen(true)}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <InlineText
                value={name}
                readOnly={!canEdit}
                className={`font-serif ${titleSizeClass(name, 'hero')} font-semibold leading-tight text-[#2A241E]`}
                inputClassName={`font-serif ${titleSizeClass(name, 'hero')} font-semibold leading-tight text-[#2A241E]`}
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (trimmed) patchSheet({ name: trimmed });
                }}
                ariaLabel="Creature name"
              />
              <SaveIndicator saving={saving} error={error} />
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#5A4F42]">
              <ChipSelect
                value={size}
                options={SIZES}
                readOnly={!canEdit}
                onCommit={(next) => patchSheet({ size: next })}
                placeholder="Size"
                ariaLabel="Size"
              />
              <ChipSelect
                value={type}
                options={TYPES}
                readOnly={!canEdit}
                onCommit={(next) => patchSheet({ type: next })}
                placeholder="Type"
                ariaLabel="Type"
              />
              <span className="text-[#5A4F42]">·</span>
              <span className="text-[#5A4F42]">CR</span>
              <InlineNumber
                value={cr}
                readOnly={!canEdit}
                onCommit={(n) => patchSheet({ challenge_rating: n })}
                min={0}
                max={30}
                step={0.125}
                allowNull
                inputClassName="w-16"
                ariaLabel="Challenge rating"
              />
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <StatTile label="AC" value={ac} onCommit={canEdit ? setAc : undefined} />
              <StatTile label="HP">
                <InlineNumber
                  value={hp.current}
                  onCommit={(n) => setHp(n, hp.max)}
                  readOnly={!canEdit}
                  className="font-serif text-lg font-semibold text-[#2A241E]"
                  inputClassName="font-serif text-lg font-semibold w-12 text-[#2A241E]"
                  ariaLabel="HP current"
                />
                <span className="text-xs text-[#5A4F42]">/</span>
                <InlineNumber
                  value={hp.max}
                  onCommit={(n) => setHp(hp.current, n)}
                  readOnly={!canEdit}
                  className="font-serif text-lg font-semibold text-[#2A241E]"
                  inputClassName="font-serif text-lg font-semibold w-12 text-[#2A241E]"
                  ariaLabel="HP max"
                />
              </StatTile>
              <StatTile label="Speed" value={speed} suffix="ft" />
            </div>

            <div className="mt-3 border-t border-[#D4C7AE] pt-3">
              <AbilityScoreStrip
                scores={scores}
                readOnly={!canEdit}
                onChange={canEdit ? (next) => patchSheet({ ability_scores: next }) : undefined}
              />
            </div>
          </div>
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

function CreaturePortrait({
  url,
  canEdit,
  onOpen,
}: {
  url: string | null;
  canEdit: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const inner = url ? (
    // object-contain — never clip the art
    <img src={url} alt="" className="h-full w-full object-contain" />
  ) : (
    <span className="text-sm text-[#8A7E6B]">No image</span>
  );
  const cls =
    'flex h-52 w-52 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#EAE1CF]';
  if (!canEdit) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={url ? 'Change image' : 'Add image'}
      className={`${cls} hover:border-[#2A241E]`}
    >
      {inner}
    </button>
  );
}
