'use client';

// Item / loot header. Big icon box on the left to showcase the art;
// compendium search bar on the right so the GM can attach a canonical
// item (Longsword, Potion of Healing, …) and autofill category,
// rarity, weapon damage, armor AC and modifiers in one click. Weapon
// and armor sub-sheets surface as their own tiles when present.

import { useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Package, Sparkles } from 'lucide-react';
import { InlineText } from './InlineText';
import { InlineNumber } from './InlineNumber';
import { ChipSelect } from './ChipSelect';
import { PortraitPicker } from './PortraitPicker';
import { SaveIndicator } from './SaveIndicator';
import { CompendiumSearch } from './CompendiumSearch';
import { usePatchSheet } from './usePatchSheet';
import { portraitUrl, titleSizeClass, RARITY_COLOR } from './util';

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
  { value: 'ammunition', label: 'Ammunition' },
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

type WeaponDetails = {
  category?: string;
  damage?: { dice?: { count?: number; sides?: number; mod?: number }; type?: string };
  versatile_damage?: { dice?: { count?: number; sides?: number; mod?: number } };
  range?: { normal?: number; long?: number };
  properties?: string[];
};
type ArmorDetails = {
  category?: string;
  ac_base?: number;
  dex_cap?: number;
  stealth_disadvantage?: boolean;
  strength_requirement?: number;
};

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

  const weapon =
    sheet.weapon && typeof sheet.weapon === 'object'
      ? (sheet.weapon as WeaponDetails)
      : null;
  const armor =
    sheet.armor && typeof sheet.armor === 'object'
      ? (sheet.armor as ArmorDetails)
      : null;

  const modifiers = Array.isArray(sheet.modifiers) ? sheet.modifiers : [];
  const portraitRaw =
    typeof sheet.portrait === 'string' ? sheet.portrait : null;
  const pUrl = portraitUrl(portraitRaw);

  const rarityTone = rarity
    ? RARITY_COLOR[rarity]?.replace(/^--/, '')
    : undefined;

  // When a compendium item is picked we autofill the core fields in one
  // PATCH so the sheet reflects the canonical shape (weapon damage,
  // armor AC, modifiers etc.) without the GM having to retype anything.
  const applyCompendium = (data: Record<string, unknown>): void => {
    const patch: Record<string, unknown> = {};
    if (typeof data.category === 'string') patch.category = data.category;
    if (typeof data.rarity === 'string') patch.rarity = data.rarity;
    if (typeof data.weight === 'number') patch.weight = data.weight;
    if (data.cost !== undefined) patch.cost = data.cost;
    if (typeof data.requires_attunement === 'boolean') {
      patch.requires_attunement = data.requires_attunement;
    }
    if (typeof data.attunement_requirements === 'string') {
      patch.attunement_requirements = data.attunement_requirements;
    }
    if (data.weapon !== undefined) patch.weapon = data.weapon;
    if (data.armor !== undefined) patch.armor = data.armor;
    if (Array.isArray(data.modifiers)) patch.modifiers = data.modifiers;
    if (typeof data.description === 'string') patch.description = data.description;
    if (Array.isArray(data.tags) && data.tags.length > 0) patch.tags = data.tags;
    patchSheet(patch);
  };

  return (
    <>
      <section className="mb-4 p-4">
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
                className={`font-serif ${titleSizeClass(name, 'compact')} font-semibold leading-tight text-[var(--ink)]`}
                inputClassName={`font-serif ${titleSizeClass(name, 'compact')} font-semibold leading-tight text-[var(--ink)]`}
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (trimmed) patchSheet({ name: trimmed });
                }}
                ariaLabel="Item name"
              />
              <SaveIndicator saving={saving} error={error} />
            </div>

            {canEdit && (
              <div className="mt-1.5">
                <CompendiumSearch
                  kind="item"
                  placeholder="Link a compendium item (autofills stats)…"
                  ariaLabel="Link item from compendium"
                  onPick={(hit) =>
                    applyCompendium(hit.data as Record<string, unknown>)
                  }
                />
              </div>
            )}

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
                onClick={() =>
                  canEdit &&
                  patchSheet({ requires_attunement: !requiresAttunement })
                }
                disabled={!canEdit}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                style={
                  requiresAttunement
                    ? {
                        borderColor: 'var(--candlelight)',
                        backgroundColor: 'var(--candlelight)',
                        color: 'var(--ink)',
                      }
                    : {
                        borderColor: 'var(--rule)',
                        backgroundColor: 'var(--parchment)',
                        color: 'var(--ink-soft)',
                      }
                }
                title={
                  requiresAttunement
                    ? 'Requires attunement'
                    : 'No attunement required'
                }
              >
                <Sparkles size={11} /> Attunement
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--ink-soft)]">
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
                    patchSheet({
                      cost: { amount: costAmount ?? 0, unit: next },
                    })
                  }
                  ariaLabel="Cost unit"
                />
              </span>
            </div>

            {(weapon || armor) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {weapon && <WeaponTile w={weapon} />}
                {armor && <ArmorTile a={armor} />}
              </div>
            )}

            {modifiers.length > 0 && (
              <div className="mt-3 border-t border-[var(--rule)] pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
                  Modifiers
                </div>
                <div className="flex flex-wrap gap-1 text-[11px]">
                  {modifiers.map((m, i) => (
                    <ModifierChip key={i} m={m} />
                  ))}
                </div>
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
    <Package size={56} className="text-[var(--ink-soft)]" />
  );
  const cls =
    'flex h-44 w-44 shrink-0 items-center justify-center overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--parchment-sunk)]';
  if (!canEdit) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Change icon"
      className={`${cls} hover:border-[var(--ink)]`}
    >
      {inner}
    </button>
  );
}

function WeaponTile({ w }: { w: WeaponDetails }): React.JSX.Element {
  const dice = w.damage?.dice;
  const diceLabel = dice
    ? `${dice.count ?? 1}d${dice.sides ?? 6}${
        dice.mod ? (dice.mod > 0 ? `+${dice.mod}` : `${dice.mod}`) : ''
      }`
    : '—';
  const vDice = w.versatile_damage?.dice;
  const vLabel = vDice ? ` (${vDice.count ?? 1}d${vDice.sides ?? 6})` : '';
  const type = w.damage?.type ?? '';
  const range = w.range;
  const rangeLabel = range
    ? range.long
      ? `${range.normal ?? 5}/${range.long} ft`
      : `${range.normal ?? 5} ft`
    : '';
  const props = (w.properties ?? []).join(', ');
  return (
    <div className="min-w-[140px] rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        Damage
      </div>
      <div className="font-serif text-lg text-[var(--ink)]">
        {diceLabel}
        {vLabel}
      </div>
      {type && (
        <div className="text-[11px] capitalize text-[var(--ink-soft)]">{type}</div>
      )}
      {rangeLabel && (
        <div className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
          Range {rangeLabel}
        </div>
      )}
      {props && (
        <div className="mt-0.5 truncate text-[11px] capitalize text-[var(--ink-muted)]">
          {props}
        </div>
      )}
    </div>
  );
}

function ArmorTile({ a }: { a: ArmorDetails }): React.JSX.Element {
  const ac = a.ac_base ?? 10;
  return (
    <div className="min-w-[140px] rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        Armor class
      </div>
      <div className="font-serif text-lg text-[var(--ink)]">{ac}</div>
      {a.category && (
        <div className="text-[11px] capitalize text-[var(--ink-soft)]">
          {a.category}
        </div>
      )}
      {typeof a.dex_cap === 'number' && (
        <div className="text-[11px] text-[var(--ink-soft)]">Dex cap +{a.dex_cap}</div>
      )}
      {a.stealth_disadvantage && (
        <div className="text-[11px] text-[var(--wine)]">Stealth disadvantage</div>
      )}
    </div>
  );
}

function ModifierChip({ m }: { m: unknown }): React.JSX.Element | null {
  if (!m || typeof m !== 'object') return null;
  const obj = m as Record<string, unknown>;
  const target = typeof obj.target === 'string' ? obj.target : '?';
  const op = typeof obj.op === 'string' ? obj.op : '';
  const value = typeof obj.value === 'number' ? String(obj.value) : '';
  const when = typeof obj.when === 'string' ? obj.when : '';
  const qualifier =
    typeof obj.qualifier === 'string' ? ` (${obj.qualifier})` : '';
  return (
    <span
      className="inline-flex items-center rounded-full border border-[var(--rule)] bg-[var(--parchment)] px-2 py-0.5 text-[10px] text-[var(--ink)]"
      title={when ? `While ${when}${qualifier}` : undefined}
    >
      {target} {op} {value}
      {qualifier}
    </span>
  );
}
