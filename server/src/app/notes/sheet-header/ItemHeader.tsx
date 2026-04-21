'use client';

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Package, Sparkles } from 'lucide-react';
import { InlineText } from './InlineText';
import { InlineNumber } from './InlineNumber';
import { ChipSelect } from './ChipSelect';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { usePatchSheet } from './usePatchSheet';
import { portraitUrl, RARITY_COLOR } from './util';

const CATEGORIES = [
  { value: 'weapon', label: 'Weapon' },
  { value: 'armor', label: 'Armor' },
  { value: 'shield', label: 'Shield' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'tool', label: 'Tool' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'wondrous', label: 'Wondrous' },
  { value: 'scroll', label: 'Scroll' },
  { value: 'potion', label: 'Potion' },
  { value: 'treasure', label: 'Treasure' },
  { value: 'other', label: 'Other' },
];
const RARITIES = [
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'very rare', label: 'Very rare' },
  { value: 'legendary', label: 'Legendary' },
  { value: 'artifact', label: 'Artifact' },
];
const CURRENCY_UNITS = [
  { value: 'cp', label: 'cp' },
  { value: 'sp', label: 'sp' },
  { value: 'ep', label: 'ep' },
  { value: 'gp', label: 'gp' },
  { value: 'pp', label: 'pp' },
];

export function ItemHeader({
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
  const category =
    typeof sheet.category === 'string' ? sheet.category : null;
  const rarity = typeof sheet.rarity === 'string' ? sheet.rarity : null;
  const requiresAttunement = sheet.requires_attunement === true;
  const weight = typeof sheet.weight === 'number' ? sheet.weight : null;
  const costObj = sheet.cost as
    | { amount?: unknown; unit?: unknown }
    | undefined;
  const costAmount =
    costObj && typeof costObj.amount === 'number' ? costObj.amount : null;
  const costUnit =
    costObj && typeof costObj.unit === 'string' ? costObj.unit : 'gp';

  const modifiers = Array.isArray(sheet.modifiers) ? sheet.modifiers : [];
  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  const rarityTone = rarity
    ? RARITY_COLOR[rarity]?.replace(/^--/, '')
    : undefined;

  return (
    <>
      <section className="mb-4 rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4">
        <div className="flex items-start gap-4">
          <IconBox
            url={pUrl}
            canEdit={canEdit}
            onOpen={() => setPickerOpen(true)}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <InlineText
                value={name}
                readOnly={!canEdit}
                className="font-serif text-xl font-semibold text-[#2A241E]"
                inputClassName="font-serif text-xl"
                onCommit={(next) => patchSheet({ name: next })}
                ariaLabel="Item name"
              />
              <SaveIndicator saving={saving} error={error} />
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <ChipSelect
                value={category}
                options={CATEGORIES}
                readOnly={!canEdit}
                onCommit={(next) => patchSheet({ category: next })}
                placeholder="Category"
                ariaLabel="Category"
              />
              <ChipSelect
                value={rarity}
                options={RARITIES}
                readOnly={!canEdit}
                onCommit={(next) => patchSheet({ rarity: next })}
                tone={rarityTone}
                placeholder="Rarity"
                ariaLabel="Rarity"
              />
              <button
                type="button"
                onClick={() => canEdit && patchSheet({ requires_attunement: !requiresAttunement })}
                disabled={!canEdit}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                style={
                  requiresAttunement
                    ? {
                        borderColor: 'var(--candlelight)',
                        backgroundColor: 'var(--candlelight)',
                        color: '#2A241E',
                      }
                    : { borderColor: '#D4C7AE', backgroundColor: '#F4EDE0', color: '#5A4F42' }
                }
                title={requiresAttunement ? 'Requires attunement' : 'No attunement required'}
              >
                <Sparkles size={11} /> Attunement
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[#5A4F42]">
              <span className="inline-flex items-center gap-1">
                Weight
                <InlineNumber
                  value={weight}
                  readOnly={!canEdit}
                  allowNull
                  step={0.1}
                  inputClassName="w-14"
                  onCommit={(n) => patchSheet({ weight: n })}
                  ariaLabel="Weight"
                />
              </span>
              <span className="inline-flex items-center gap-1">
                Cost
                <InlineNumber
                  value={costAmount}
                  readOnly={!canEdit}
                  allowNull
                  inputClassName="w-16"
                  onCommit={(n) => {
                    if (n === null) patchSheet({ cost: null });
                    else patchSheet({ cost: { amount: n, unit: costUnit } });
                  }}
                  ariaLabel="Cost amount"
                />
                <ChipSelect
                  value={costUnit}
                  options={CURRENCY_UNITS}
                  readOnly={!canEdit || costAmount == null}
                  onCommit={(next) =>
                    patchSheet({ cost: { amount: costAmount ?? 0, unit: next } })
                  }
                  ariaLabel="Cost unit"
                />
              </span>
            </div>

            {modifiers.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-[#5A4F42]">Modifiers:</span>
                {modifiers.slice(0, 3).map((m, i) => (
                  <ModifierChip key={i} m={m} />
                ))}
                {modifiers.length > 3 && (
                  <span className="text-[#5A4F42]">
                    +{modifiers.length - 3} more
                  </span>
                )}
              </div>
            )}
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

function IconBox({
  url,
  canEdit,
  onOpen,
}: {
  url: string | null;
  canEdit: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const inner = url ? (
    // object-contain so the item art is never cropped — showcase it
    <img src={url} alt="" className="h-full w-full object-contain p-2" />
  ) : (
    <Package size={56} className="text-[#5A4F42]" />
  );
  const cls =
    'flex h-44 w-44 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#EAE1CF]';
  if (!canEdit) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Change icon"
      className={`${cls} hover:border-[#2A241E]`}
    >
      {inner}
    </button>
  );
}

function ModifierChip({ m }: { m: unknown }): React.JSX.Element | null {
  if (!m || typeof m !== 'object') return null;
  const obj = m as Record<string, unknown>;
  const target = typeof obj.target === 'string' ? obj.target : '?';
  const op = typeof obj.op === 'string' ? obj.op : '';
  const value =
    typeof obj.value === 'number' ? String(obj.value) : '';
  return (
    <span className="inline-flex items-center rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-[10px] text-[#2A241E]">
      {target} {op} {value}
    </span>
  );
}
