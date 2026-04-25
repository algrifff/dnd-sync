// Reshape the flat ExtractedCharacter (LLM output) into the nested
// CharacterSheet shape that lives under `frontmatter.sheet`, plus a
// markdown body suitable for the TipTap editor.
//
// We also write the legacy flat mirror keys (hp_current, ac, str/…) so
// the old CharacterSheet side panel keeps rendering during the
// transition — same convention as CharacterHeader.tsx.

import type { ExtractedCharacter, SkillKey } from './schema';
import { SKILL_KEYS_LIST } from './schema';

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type AbilityKey = (typeof ABILITY_KEYS)[number];

export type CharacterImportResult = {
  /** Patch suitable for `updateUserCharacter({ name, sheet, bodyJson, bodyMd })`. */
  name: string;
  sheet: Record<string, unknown>;
  bodyMd: string;
};

export function buildImportPatch(
  data: ExtractedCharacter,
): CharacterImportResult {
  const name = (data.name ?? '').trim() || 'Unnamed Character';

  const sheet: Record<string, unknown> = {
    name,
    xp: data.xp ?? 0,
  };

  if (data.player) sheet.player = data.player;
  if (data.alignment) sheet.alignment = data.alignment;

  if (data.race) sheet.race = { ref: { name: data.race } };
  if (data.background) sheet.background = { ref: { name: data.background } };

  if (data.classes.length > 0) {
    sheet.classes = data.classes.map((c) => ({
      ref: { name: c.name },
      level: c.level,
      ...(c.subclass ? { subclass: c.subclass } : {}),
      hit_dice_used: 0,
    }));
  }

  // Ability scores — write nested + legacy flat mirror.
  const abilities = data.ability_scores;
  sheet.ability_scores = {
    str: clampAbility(abilities.str),
    dex: clampAbility(abilities.dex),
    con: clampAbility(abilities.con),
    int: clampAbility(abilities.int),
    wis: clampAbility(abilities.wis),
    cha: clampAbility(abilities.cha),
  };
  for (const k of ABILITY_KEYS) {
    sheet[k] = clampAbility(abilities[k]);
  }

  // Saving throws — record-style { str: { proficient: true } }.
  if (data.saving_throw_proficiencies.length > 0) {
    const saves: Record<AbilityKey, { proficient: boolean }> = {} as Record<
      AbilityKey,
      { proficient: boolean }
    >;
    for (const k of data.saving_throw_proficiencies) {
      saves[k] = { proficient: true };
    }
    sheet.saving_throws = saves;
  }

  // Skills — record-style { acrobatics: { proficient, expertise } }.
  if (data.skill_proficiencies.length > 0) {
    const skills: Partial<
      Record<SkillKey, { proficient: boolean; expertise: boolean }>
    > = {};
    for (const entry of data.skill_proficiencies) {
      if (!SKILL_KEYS_LIST.includes(entry.skill)) continue;
      skills[entry.skill] = {
        proficient: true,
        expertise: !!entry.expertise,
      };
    }
    sheet.skills = skills;
  }

  if (Number.isFinite(data.proficiency_bonus)) {
    sheet.proficiency_bonus = clamp(data.proficiency_bonus, 2, 6);
  }

  if (data.armor_class != null) {
    sheet.armor_class = { value: data.armor_class };
    sheet.ac = data.armor_class; // legacy mirror
  }

  if (data.hit_points_max != null || data.hit_points_current != null) {
    const max = data.hit_points_max ?? data.hit_points_current ?? 0;
    const current = data.hit_points_current ?? max;
    const temp = data.hit_points_temp ?? 0;
    sheet.hit_points = { max, current, temporary: temp };
    // legacy flat mirror
    sheet.hp_max = max;
    sheet.hp_current = current;
    if (temp > 0) sheet.hp_temp = temp;
  }

  if (data.speed_walk != null) {
    sheet.speed = { walk: data.speed_walk };
  }

  if (data.darkvision != null || data.passive_perception != null) {
    const senses: Record<string, number> = {};
    if (data.darkvision != null) senses.darkvision = data.darkvision;
    if (data.passive_perception != null) {
      senses.passive_perception = data.passive_perception;
    }
    sheet.senses = senses;
  }

  if (Number.isFinite(data.initiative_bonus)) {
    sheet.initiative_bonus = data.initiative_bonus;
  }

  if (data.languages.length > 0) sheet.languages = data.languages;
  if (data.weapon_proficiencies.length > 0) {
    sheet.weapon_proficiencies = data.weapon_proficiencies;
  }
  if (data.armor_proficiencies.length > 0) {
    sheet.armor_proficiencies = data.armor_proficiencies;
  }
  if (data.tool_proficiencies.length > 0) {
    sheet.tool_proficiencies = data.tool_proficiencies;
  }

  if (data.spellcasting_ability) {
    const slotsRecord: Record<string, { max: number; used: number }> = {};
    for (const s of data.spell_slots) {
      if (s.level >= 1 && s.level <= 9 && s.max >= 0) {
        slotsRecord[String(s.level)] = { max: s.max, used: 0 };
      }
    }
    sheet.spellcasting = {
      ability: data.spellcasting_ability,
      spell_save_dc: data.spell_save_dc ?? 0,
      spell_attack_bonus: data.spell_attack_bonus ?? 0,
      slots: slotsRecord,
    };
  }

  if (data.inventory.length > 0) {
    sheet.inventory = data.inventory.map((item) => ({
      ref: { name: item.name },
      quantity: Math.max(1, item.quantity || 1),
      equipped: !!item.equipped,
      attuned: !!item.attuned,
    }));
  }

  const c = data.currency;
  if (c.pp || c.gp || c.ep || c.sp || c.cp) {
    sheet.currency = { pp: c.pp, gp: c.gp, ep: c.ep, sp: c.sp, cp: c.cp };
  }

  // Roleplay details
  const details: Record<string, string> = {};
  const d = data.details;
  if (d.age) details.age = d.age;
  if (d.height) details.height = d.height;
  if (d.weight) details.weight = d.weight;
  if (d.eyes) details.eyes = d.eyes;
  if (d.hair) details.hair = d.hair;
  if (d.skin) details.skin = d.skin;
  if (d.personality) details.personality = d.personality;
  if (d.ideal) details.ideal = d.ideal;
  if (d.bond) details.bond = d.bond;
  if (d.flaw) details.flaw = d.flaw;
  if (d.backstory) details.backstory = d.backstory;
  if (Object.keys(details).length > 0) sheet.details = details;

  return {
    name,
    sheet,
    bodyMd: buildBodyMarkdown(data),
  };
}

function buildBodyMarkdown(data: ExtractedCharacter): string {
  const sections: string[] = [];
  const d = data.details;

  if (d.appearance) {
    sections.push(`## Appearance\n\n${d.appearance.trim()}`);
  }
  if (d.backstory) {
    sections.push(`## Backstory\n\n${d.backstory.trim()}`);
  }

  const personalityBits: string[] = [];
  if (d.personality) personalityBits.push(`**Personality.** ${d.personality.trim()}`);
  if (d.ideal) personalityBits.push(`**Ideal.** ${d.ideal.trim()}`);
  if (d.bond) personalityBits.push(`**Bond.** ${d.bond.trim()}`);
  if (d.flaw) personalityBits.push(`**Flaw.** ${d.flaw.trim()}`);
  if (personalityBits.length > 0) {
    sections.push(`## Personality\n\n${personalityBits.join('\n\n')}`);
  }

  if (data.features_md.trim()) {
    sections.push(`## Features & Traits\n\n${data.features_md.trim()}`);
  }
  if (data.notes_md.trim()) {
    sections.push(`## Notes\n\n${data.notes_md.trim()}`);
  }

  return sections.join('\n\n').trim();
}

function clampAbility(n: number): number {
  return clamp(Math.round(n), 1, 30);
}
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
