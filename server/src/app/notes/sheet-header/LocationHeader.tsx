'use client';

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { MapPin } from 'lucide-react';
import { InlineText } from './InlineText';
import { ChipSelect } from './ChipSelect';
import { NoteAutocomplete } from './NoteAutocomplete';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { usePatchSheet } from './usePatchSheet';
import { portraitUrl, titleSizeClass } from './util';

const TYPES = [
  { value: 'plane', label: 'Plane' },
  { value: 'continent', label: 'Continent' },
  { value: 'region', label: 'Region' },
  { value: 'city', label: 'City' },
  { value: 'town', label: 'Town' },
  { value: 'village', label: 'Village' },
  { value: 'dungeon', label: 'Dungeon' },
  { value: 'wilderness', label: 'Wilderness' },
  { value: 'landmark', label: 'Landmark' },
  { value: 'building', label: 'Building' },
  { value: 'room', label: 'Room' },
  { value: 'other', label: 'Other' },
];

export function LocationHeader({
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
  const type = typeof sheet.type === 'string' ? sheet.type : null;
  const region = typeof sheet.region === 'string' ? sheet.region : '';
  const parentPath =
    typeof sheet.parent_path === 'string' ? sheet.parent_path : null;
  const population =
    typeof sheet.population === 'string' ? sheet.population : '';
  const government =
    typeof sheet.government === 'string' ? sheet.government : '';

  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  return (
    <>
      <section className="mb-4">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <InlineText
                  value={name}
                  readOnly={!canEdit}
                  className={`font-serif ${titleSizeClass(name, 'hero')} font-semibold leading-tight text-[#2A241E]`}
                  inputClassName={`font-serif ${titleSizeClass(name, 'hero')} font-semibold leading-tight text-[#2A241E]`}
                  onCommit={(next) => patchSheet({ name: next })}
                  ariaLabel="Location name"
                />
                <SaveIndicator saving={saving} error={error} />
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#5A4F42]">
                <ChipSelect
                  value={type}
                  options={TYPES}
                  readOnly={!canEdit}
                  onCommit={(next) => patchSheet({ type: next })}
                  placeholder="Type"
                  ariaLabel="Type"
                />
                <span className="text-[#5A4F42]">·</span>
                <span className="text-[#5A4F42]">Region:</span>
                <InlineText
                  value={region}
                  readOnly={!canEdit}
                  className="text-[11px] text-[#2A241E]"
                  placeholder="none"
                  onCommit={(next) => patchSheet({ region: next })}
                  ariaLabel="Region"
                />
                <span className="text-[#5A4F42]">·</span>
                <span className="inline-flex items-center gap-1 text-[#5A4F42]">
                  <MapPin size={11} /> Parent:
                </span>
                <NoteAutocomplete
                  value={parentPath}
                  readOnly={!canEdit}
                  kind="location"
                  onCommit={(next) => patchSheet({ parent_path: next })}
                  placeholder="Link a parent location…"
                  ariaLabel="Parent link"
                  className="font-mono text-[11px] text-[#2A241E]"
                />
              </div>
            </div>

            {!pUrl && canEdit && (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="rounded border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-xs text-[#2A241E] hover:bg-[#EAE1CF]"
              >
                Add hero image
              </button>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-2">
            <KVRow
              label="Population"
              value={population}
              readOnly={!canEdit}
              onCommit={(next) => patchSheet({ population: next })}
            />
            <KVRow
              label="Government"
              value={government}
              readOnly={!canEdit}
              onCommit={(next) => patchSheet({ government: next })}
            />
          </div>
        </div>

        {/* Hero image sits BELOW the header fields, full-width of the note
         *  column. object-contain so the art is never clipped. */}
        {pUrl && (
          <button
            type="button"
            onClick={() => canEdit && setPickerOpen(true)}
            aria-label={canEdit ? 'Change hero image' : 'Hero image'}
            disabled={!canEdit}
            className="block w-full overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#EAE1CF]"
          >
            <img
              src={pUrl}
              alt=""
              className="mx-auto block max-h-[520px] w-full object-contain"
            />
          </button>
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

function KVRow({
  label,
  value,
  readOnly,
  onCommit,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#5A4F42]">
        {label}
      </span>
      <InlineText
        value={value}
        readOnly={readOnly}
        className="flex-1 text-[#2A241E]"
        placeholder="—"
        onCommit={onCommit}
        ariaLabel={label}
      />
    </div>
  );
}
