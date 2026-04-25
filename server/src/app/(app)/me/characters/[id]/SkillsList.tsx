'use client';

// All 18 D&D 5e skills as a single column. Click a row's prof dot to
// toggle proficiency; double-click to toggle expertise. Modifier =
// ability mod + (expertise ? 2× : proficient ? 1× : 0×) prof bonus.
//
// Mirrors the SkillsPanel inside CharacterSheet.tsx so the master
// editor and in-world note share visual language. Owns its own ref
// to the latest sheet to survive double-click closures racing the
// 400ms patchSheet debounce.

import { useRef } from 'react';
import {
  abilityModifier,
  formatModifier,
  readAbilityScores,
} from '@/app/notes/sheet-header/util';

type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

const SKILL_CATALOG: Array<{ key: string; label: string; ability: Ability }> = [
  { key: 'acrobatics', label: 'Acrobatics', ability: 'dex' },
  { key: 'animal_handling', label: 'Animal Handling', ability: 'wis' },
  { key: 'arcana', label: 'Arcana', ability: 'int' },
  { key: 'athletics', label: 'Athletics', ability: 'str' },
  { key: 'deception', label: 'Deception', ability: 'cha' },
  { key: 'history', label: 'History', ability: 'int' },
  { key: 'insight', label: 'Insight', ability: 'wis' },
  { key: 'intimidation', label: 'Intimidation', ability: 'cha' },
  { key: 'investigation', label: 'Investigation', ability: 'int' },
  { key: 'medicine', label: 'Medicine', ability: 'wis' },
  { key: 'nature', label: 'Nature', ability: 'int' },
  { key: 'perception', label: 'Perception', ability: 'wis' },
  { key: 'performance', label: 'Performance', ability: 'cha' },
  { key: 'persuasion', label: 'Persuasion', ability: 'cha' },
  { key: 'religion', label: 'Religion', ability: 'int' },
  { key: 'sleight_of_hand', label: 'Sleight of Hand', ability: 'dex' },
  { key: 'stealth', label: 'Stealth', ability: 'dex' },
  { key: 'survival', label: 'Survival', ability: 'wis' },
];

type SkillEntry = { proficient: boolean; expertise: boolean };

function readSkillEntry(
  sheet: Record<string, unknown>,
  key: string,
): SkillEntry {
  const skills = sheet.skills;
  if (skills && typeof skills === 'object') {
    const entry = (skills as Record<string, unknown>)[key];
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      return {
        proficient: o.proficient === true,
        expertise: o.expertise === true,
      };
    }
  }
  if (Array.isArray(sheet.proficient_skills)) {
    return {
      proficient: (sheet.proficient_skills as unknown[]).includes(key),
      expertise: false,
    };
  }
  return { proficient: false, expertise: false };
}

export function SkillsList({
  sheet,
  onPatch,
}: {
  sheet: Record<string, unknown>;
  onPatch: (partial: Record<string, unknown>) => void;
}): React.JSX.Element {
  // Latest-sheet ref so a fast click+click+dblclick computes against
  // the in-flight state rather than the closure's stale snapshot.
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;

  const scores = readAbilityScores(sheet) ?? {
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
  };
  const profBonus =
    typeof sheet.proficiency_bonus === 'number' ? sheet.proficiency_bonus : 2;

  const writeSkill = (key: string, next: SkillEntry): void => {
    const s = sheetRef.current;
    const current =
      s.skills && typeof s.skills === 'object'
        ? (s.skills as Record<string, unknown>)
        : {};
    onPatch({ skills: { ...current, [key]: next } });
  };

  const toggleProficient = (key: string): void => {
    const cur = readSkillEntry(sheetRef.current, key);
    writeSkill(key, { proficient: !cur.proficient, expertise: false });
  };

  const toggleExpertise = (key: string): void => {
    const cur = readSkillEntry(sheetRef.current, key);
    const expertise = !cur.expertise;
    writeSkill(key, { proficient: expertise || cur.proficient, expertise });
  };

  return (
    <div className="rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)]">
      <div className="flex items-center justify-between border-b border-[var(--rule)] px-3 py-2 text-[11px] text-[var(--ink-muted)]">
        <span>
          Click to toggle proficiency · double-click for expertise
        </span>
        <span className="font-serif tabular-nums text-[var(--ink-soft)]">
          Prof +{profBonus}
        </span>
      </div>
      <ul className="divide-y divide-[var(--rule)]/60">
        {SKILL_CATALOG.map((s) => {
          const entry = readSkillEntry(sheet, s.key);
          const abilityMod = abilityModifier(scores[s.ability]);
          const bonus = entry.expertise
            ? profBonus * 2
            : entry.proficient
              ? profBonus
              : 0;
          const total = abilityMod + bonus;
          const state: 'none' | 'proficient' | 'expertise' = entry.expertise
            ? 'expertise'
            : entry.proficient
              ? 'proficient'
              : 'none';
          return (
            <li
              key={s.key}
              className="flex items-center gap-2 px-3 py-1.5 text-[12px]"
            >
              <ProfDot
                state={state}
                onClick={() => toggleProficient(s.key)}
                onDoubleClick={() => toggleExpertise(s.key)}
              />
              <span className="flex-1 text-[var(--ink)]">{s.label}</span>
              <span className="w-10 text-right text-[10px] uppercase tracking-wide text-[var(--ink-soft)]">
                {s.ability}
              </span>
              <span className="w-10 text-right font-serif text-[14px] font-semibold tabular-nums text-[var(--ink)]">
                {formatModifier(total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProfDot({
  state,
  onClick,
  onDoubleClick,
}: {
  state: 'none' | 'proficient' | 'expertise';
  onClick: () => void;
  onDoubleClick: () => void;
}): React.JSX.Element {
  const fill =
    state === 'expertise'
      ? 'var(--ink)'
      : state === 'proficient'
        ? 'var(--ink-muted)'
        : 'transparent';
  const ring = state === 'expertise' ? 'var(--ink)' : 'var(--ink-muted)';
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-label={`Toggle proficiency (${state}); double-click for expertise`}
      title="Click: proficient · Double-click: expertise"
      className="inline-block h-3 w-3 rounded-full border transition-transform hover:scale-110"
      style={{ backgroundColor: fill, borderColor: ring }}
    />
  );
}
