'use client';

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { User } from 'lucide-react';
import { InlineText } from './InlineText';
import { ChipSelect } from './ChipSelect';
import { NoteAutocomplete } from './NoteAutocomplete';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { usePatchSheet } from './usePatchSheet';
import { portraitUrl, DISPOSITION_COLOR } from './util';

const DISPOSITION_OPTIONS = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'hostile', label: 'Hostile' },
  { value: 'unknown', label: 'Unknown' },
];

export function PersonHeader({
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
  const tagline = typeof sheet.tagline === 'string' ? sheet.tagline : '';
  const disposition =
    typeof sheet.disposition === 'string' ? sheet.disposition : null;
  const locationPath =
    typeof sheet.location_path === 'string' ? sheet.location_path : null;

  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  const dispTone = disposition
    ? DISPOSITION_COLOR[disposition]?.replace(/^--/, '')
    : undefined;

  return (
    <>
      <section className="mb-4 p-4">
        <div className="flex items-start gap-4">
          <PortraitSmall
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
                className="font-serif text-xl font-semibold text-[#2A241E]"
                inputClassName="font-serif text-xl font-semibold text-[#2A241E]"
                onCommit={(next) => patchSheet({ name: next })}
                ariaLabel="Person name"
              />
              <SaveIndicator saving={saving} error={error} />
            </div>

            <div className="mt-1">
              <InlineText
                value={tagline}
                readOnly={!canEdit}
                className="italic text-[#5A4F42]"
                inputClassName="italic"
                placeholder="Add a tagline…"
                onCommit={(next) => patchSheet({ tagline: next })}
                ariaLabel="Tagline"
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              <ChipSelect
                value={disposition}
                options={DISPOSITION_OPTIONS}
                readOnly={!canEdit}
                onCommit={(next) => patchSheet({ disposition: next })}
                tone={dispTone}
                placeholder="Disposition"
                ariaLabel="Disposition"
              />
              <span className="text-[#5A4F42]">·</span>
              <span className="text-[#5A4F42]">Location:</span>
              <NoteAutocomplete
                value={locationPath}
                readOnly={!canEdit}
                kind="location"
                onCommit={(next) => patchSheet({ location_path: next })}
                placeholder="Link a location…"
                ariaLabel="Location link"
                className="font-mono text-[11px] text-[#2A241E]"
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

function PortraitSmall({
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
    // object-contain so the character is never cropped
    <img src={url} alt="" className="h-full w-full object-contain" />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-5xl font-semibold text-[#5A4F42]">
      {displayName.slice(0, 1).toUpperCase() || <User size={48} />}
    </div>
  );
  const cls =
    'h-44 w-44 shrink-0 overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#EAE1CF]';
  if (!canEdit) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Change portrait"
      className={`${cls} hover:border-[#2A241E]`}
    >
      {inner}
    </button>
  );
}
