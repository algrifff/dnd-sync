# Skill: sheet-header

Recipe for adding a new per-kind header (or editing an existing one) in
`server/src/app/notes/sheet-header/`. Use this when a new frontmatter kind
is added, or when an existing kind needs a new inline-editable field.

## When to Use

- Adding a new `kind` to the sheet-header tree.
- Adding a new inline-editable field to an existing header.
- Touching the partial-PATCH contract or `usePatchSheet`.
- Anything involving the `--world-accent` underline or empty-name guards.

## What It Checks

| Category | Item | Required? |
|---|---|---|
| Dispatch | `normalizeKind()` returns a canonical label for the new kind | ✅ |
| Dispatch | `SheetHeader.tsx` switch has a case | ✅ |
| Dispatch | `server/src/lib/ai/tools.ts` mapping updated in the **same commit** | ✅ |
| Schema | Zod schema exists under `shared/src/...` (or server-side validator) | ✅ |
| Schema | `name` field is `z.string().min(1).optional()` | ✅ |
| Layout | Uses `titleSizeClass(name, tier)` for the title | ✅ |
| Layout | Portrait button goes through `PortraitPicker` | ✅ |
| Layout | Parchment palette only (no new hex values) | ✅ |
| State | Uses `usePatchSheet()` — no direct `fetch('/api/notes/sheet')` | ✅ |
| State | `SaveIndicator` wired to `saving` + `error` | ✅ |
| Edit UX | Every inline input: no border/bg/padding; 2px bottom-stroke underline in `var(--world-accent, #8A7E6B)` on hover + focus | ✅ |
| Edit UX | Display span and edit input share font family, size, weight | ✅ |
| Edit UX | Display span has `min-w-[4ch]` (text) / `min-w-[3ch]` (number) hit target | ✅ |
| Edit UX | Number input strips UA spinners + focus ring | ✅ |
| Guards | `name` trim-and-skip: `if (trimmed) patchSheet({ name: trimmed })` | ✅ |
| Guards | Any other `.min(1)` field has a matching trim-and-skip | ✅ |
| Legacy | If mirroring is required, write new nested shape + legacy flat keys in one patch | conditional |
| Legacy | Use readers in `./util` (`readHitPoints`, `readArmorClass`, etc.) — don't reach into `sheet.hp_current` directly | ✅ |
| Typecheck | `bun run typecheck` green | ✅ |
| Tests | `util.test.ts` covers any new helper | ✅ |

## Output Format

When reviewing or producing a sheet-header change, report as:

```
## Summary
<one paragraph: what changed, which kinds touched>

## Compliance checklist
- [ ] normalizeKind + ai/tools.ts in sync
- [ ] Zod schema allows new fields and keeps name min(1).optional
- [ ] usePatchSheet is the only write path
- [ ] Inline editors: bottom-stroke underline only, no input chrome
- [ ] Display/edit font parity
- [ ] Hit target ≥ min-w-[3ch|4ch]
- [ ] titleSizeClass applied
- [ ] Empty-string guards on .min(1) fields
- [ ] Legacy mirror (if a character) — new + flat keys in the same patch
- [ ] bun run typecheck passes

## Files touched
<list>

## Follow-ups
<anything deferred — note in text, do not silently drop>
```

## STRICT Mode Rules

These are non-negotiable — fail the review if violated:

1. **One write path**: `usePatchSheet` is the only thing that may PATCH
   `/api/notes/sheet`. Direct `fetch` calls from headers are a bug.
2. **No orange focus rings**: any new global focus style must scope itself
   out of `.sheet-header` or reinstate the regression fixed in commit
   `8ab0f25`. If you see `outline: 2px solid` without `:not(.sheet-header *)`,
   flag it.
3. **Name guard**: every header's name `onCommit` must trim and skip empties.
   Missing guard = server rejects the whole batch with `invalid_sheet`.
4. **Kind dispatch synchronicity**: changing legacy aliases in one of
   `ai/tools.ts` / `sheet-header/util.ts` without the other is a bug.
5. **No parchment-palette drift**: new colours must come from the CSS
   variables in `globals.css`. No raw hex outside the canonical set.
6. **No prop-drilled accent colour**: inline editors read
   `var(--world-accent)`. If you see an `accentColor` prop on an inline
   editor, refactor it out.

## Example — adding a `faction` kind

```tsx
// 1. shared schema (shared/src/sheet/faction.ts)
export const FactionSheet = z.object({
  name: z.string().min(1).optional(),
  alignment: z.enum(['lawful', 'neutral', 'chaotic']).nullable().optional(),
  headquarters_path: z.string().nullable().optional(),
  portrait: z.string().nullable().optional(),
});

// 2. util.ts — extend normalizeKind
case 'faction':
case 'guild':   // legacy alias
  return 'faction';

// 3. ai/tools.ts — mirror the alias
if (kind === 'guild') kind = 'faction';

// 4. FactionHeader.tsx
export function FactionHeader(props: HeaderProps): React.JSX.Element {
  const { sheet, patchSheet, saving, error } = usePatchSheet(props);
  const name = typeof sheet.name === 'string' ? sheet.name : props.displayName;
  return (
    <section className="mb-4 p-5">
      <InlineText
        value={name}
        readOnly={!props.canEdit}
        className={`font-serif ${titleSizeClass(name, 'hero')} font-semibold text-[#2A241E]`}
        inputClassName={`font-serif ${titleSizeClass(name, 'hero')} font-semibold text-[#2A241E]`}
        onCommit={(next) => {
          const trimmed = next.trim();
          if (trimmed) patchSheet({ name: trimmed });
        }}
        ariaLabel="Faction name"
      />
      <SaveIndicator saving={saving} error={error} />
      {/* …alignment ChipSelect, headquarters NoteAutocomplete, portrait button… */}
    </section>
  );
}

// 5. SheetHeader.tsx — add dispatch case
case 'faction': return <FactionHeader {...common} />;
```

## Invocation

```
/skill:sheet-header add faction kind
/skill:sheet-header review PersonHeader.tsx --strict
```

## See Also

- `.claude/rules/frontend.md` — full inline-editing conventions
- `.claude/rules/backend.md` — `/api/notes/sheet` partial-patch contract
- `server/src/app/notes/sheet-header/CharacterHeader.tsx` — canonical
  legacy-mirror example
