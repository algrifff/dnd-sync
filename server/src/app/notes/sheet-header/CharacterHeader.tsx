'use client';

// Two-row character header: identity strip (portrait + name + pills
// + AC/HP/Speed tiles) over the ability-score strip.

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { User } from 'lucide-react';
import { InlineText } from './InlineText';
import { InlineNumber } from './InlineNumber';
import { StatTile } from './StatTile';
import { AbilityScoreStrip } from './AbilityScoreStrip';
import { Pill } from './Pill';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { usePatchSheet } from './usePatchSheet';
import {
  formatClassList,
  portraitUrl,
  readAbilityScores,
  readArmorClass,
  readHitPoints,
  readSpeed,
  refName,
} from './util';

export function CharacterHeader({
  initialSheet,
  notePath,
  csrfToken,
  provider,
  canEdit,
  roleLabel,
  displayName,
}: {
  initialSheet: Record<string, unknown>;
  notePath: string;
  csrfToken: string;
  provider: HocuspocusProvider;
  canEdit: boolean;
  roleLabel: string;
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
  const scores = readAbilityScores(sheet);

  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  const setHpCurrent = (n: number | null): void => {
    const next = {
      current: n ?? 0,
      max: hp.max ?? 0,
      temporary: hp.temporary ?? 0,
    };
    // Also mirror to legacy flat fields so the CharacterSheet side
    // panel (template-driven) keeps showing the same value.
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

  return (
    <>
      <section className="mb-4 rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
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
                className="font-serif text-2xl font-semibold text-[#2A241E]"
                inputClassName="font-serif text-2xl"
                onCommit={(next) => patchSheet({ name: next })}
                ariaLabel="Character name"
              />
              <SaveIndicator saving={saving} error={error} />
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#5A4F42]">
              <Pill>{roleLabel}</Pill>
              {classesLabel && <Pill>{classesLabel}</Pill>}
              {raceName && <Pill>{raceName}</Pill>}
              {backgroundName && <Pill>{backgroundName}</Pill>}
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <StatTile label="AC" value={ac} />
            <StatTile label="HP">
              <InlineNumber
                value={hp.current}
                onCommit={setHpCurrent}
                readOnly={!canEdit}
                inputClassName="font-serif text-lg w-12"
                ariaLabel="HP current"
              />
              <span className="text-xs text-[#5A4F42]">/</span>
              <InlineNumber
                value={hp.max}
                onCommit={setHpMax}
                readOnly={!canEdit}
                inputClassName="font-serif text-lg w-12"
                ariaLabel="HP max"
              />
            </StatTile>
            <StatTile label="Speed" value={speed} suffix="ft" />
          </div>
        </div>

        {scores && (
          <div className="mt-4 border-t border-[#D4C7AE] pt-4">
            <AbilityScoreStrip scores={scores} readOnly />
          </div>
        )}
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
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[#5A4F42]">
      {displayName.slice(0, 1).toUpperCase() || <User size={32} />}
    </div>
  );
  const cls =
    'h-24 w-24 shrink-0 overflow-hidden rounded-full border-2 border-[#D4C7AE] bg-[#EAE1CF]';
  if (!canEdit) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Change portrait"
      className={`${cls} relative hover:border-[#2A241E]`}
    >
      {inner}
    </button>
  );
}
