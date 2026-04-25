// Send extracted PDF text to OpenAI and get back a structured
// ExtractedCharacter object. Validation + fallbacks live in transform.ts.

import { generateStructured } from '../ai/openai';
import { EXTRACTED_CHARACTER_SCHEMA, type ExtractedCharacter } from './schema';

const SYSTEM_PROMPT = `You extract structured data from D&D 5e character sheets.

The user will paste the layout-preserved text contents of a single
character sheet PDF. Read the entire sheet and produce a JSON object
matching the supplied schema exactly. Rules:

- Skip table headers, watermarks, page footers ("TM & © Wizards of the Coast"),
  and form-field labels — extract values only.
- Multiclass: if "CLASS & LEVEL" reads "Druid 17 / Wizard 2", emit one
  classes[] entry per class with the integer level. If a single class is
  shown, emit one entry.
- Ability scores are integers 1–30. If only a modifier is visible, work
  back to the score (e.g. mod -1 → score 8/9, prefer the score shown
  alongside).
- Saving throw / skill proficiencies: include only those with a clear
  proficiency mark (filled circle, "P", "•", checkmark). Set
  expertise:true only when explicitly indicated (double-marked / "E").
- spell_slots: emit ONLY non-zero rows. Cantrips are not slots.
- inventory: list every distinct item with its quantity. Currency goes
  in currency, not inventory.
- features_md: a markdown string of class features, species traits,
  feats, and any other narrative bullets that don't fit elsewhere. Use
  '## Header' for sections, '- ' for bullet items. Keep the original
  source text as faithfully as possible.
- notes_md: anything else worth preserving (Allies & Organizations,
  Additional Notes, freeform sections at the back of the sheet).
- details.appearance / backstory / personality / ideal / bond / flaw:
  pull the matching free-text fields. Empty string when absent.
- Absent numeric fields → null. Absent string fields → null OR empty
  string per the schema (follow the schema's nullability exactly).
- Never hallucinate. If a value isn't in the text, emit null/0/[]/"".`;

export async function extractCharacterFromText(
  text: string,
  signal?: AbortSignal,
): Promise<ExtractedCharacter> {
  const trimmed = text.length > 60_000 ? text.slice(0, 60_000) : text;
  const model = process.env.OPENAI_PDF_IMPORT_MODEL ?? 'gpt-4o-mini';
  const result = await generateStructured<ExtractedCharacter>({
    systemPrompt: SYSTEM_PROMPT,
    userContent: trimmed,
    schema: EXTRACTED_CHARACTER_SCHEMA,
    schemaName: 'extracted_character',
    modelOverride: model,
    ...(signal ? { signal } : {}),
  });
  return result.data;
}
