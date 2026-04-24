---
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/components/**"
---

# Frontend Rules

## Component Structure
- One component per file
- Use named exports for components
- Colocate styles, tests, and types

## React Patterns
- Prefer functional components with hooks
- Lift state only when necessary
- Use React.memo() for expensive renders
- Prefer composition over inheritance

## TypeScript
- Explicit return types on exported functions
- Use `interface` for objects, `type` for unions
- Avoid `any` — use `unknown` if type is unclear

## Styling
- Use CSS Modules or Tailwind
- Avoid inline styles except for dynamic values
- Mobile-first responsive design
- **All palette colours must be `var(--*)` references.** Hex literals for
  palette values are forbidden outside `server/src/app/globals.css`. The app
  ships both a day (parchment) and night palette under the same variable
  names — hardcoding a hex freezes that surface to one theme and breaks
  nighttime mode. Canonical variables (defined in `:root` and
  `[data-theme="night"]`): `--parchment`, `--parchment-sunk`, `--vellum`,
  `--ink`, `--ink-soft`, `--ink-muted`, `--rule`, `--candlelight`, `--wine`,
  `--moss`, `--sage`, `--embers`, `--shadow`. For opacity tints use
  `rgb(var(--wine-rgb) / 0.12)` against the matching `--*-rgb` tokens.
- Any new colour must be added as a variable in **both** the `:root` and
  `[data-theme="night"]` blocks in the same commit. Night values derive
  from inverting the tonal role (canvas ↔ text) while keeping the warm
  hue family — see `DESIGN.md` § Night mode palette.
- Fonts: Fraunces serif (`font-serif`) for titles and stat numbers; Inter sans
  (default) for body copy and chrome. **Display and edit states of the same
  field must share the same font family, size, and weight** — clicking an
  inline editor should not cause the text to "pop" to a different style.

## Performance
- Lazy load routes and heavy components
- Optimize images (next/image, srcset)
- Avoid unnecessary re-renders

## Inline editing (sheet-header family)

All per-kind headers under `server/src/app/notes/sheet-header/` follow the
same inline-edit conventions. If you add a new inline editor or a new per-kind
header, match these patterns exactly — consistency matters more than local
taste here.

### Chrome
- No borders, no backgrounds, no padding on the input when it enters edit
  mode. The only visual affordance is a **2px bottom-stroke underline** in
  `var(--world-accent, #8A7E6B)` on hover and on focus. Use:
  ```
  border-0 border-b-2 border-transparent
  hover:border-[var(--world-accent,#8A7E6B)]
  focus:border-[var(--world-accent,#8A7E6B)]
  outline-none focus:outline-0 focus-visible:outline-0 focus:ring-0
  bg-transparent p-0
  ```
- Clickable display spans need a minimum hit target: `min-w-[4ch]` for text,
  `min-w-[3ch]` for numbers. Single-character names must still be clickable.
- Number inputs: strip native spinners and UA focus styling with
  `[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none
  [&::-webkit-outer-spin-button]:appearance-none`.

### World accent colour
- `SheetHeader` wraps its subtree in a `<div className="sheet-header"
  style={{ '--world-accent': accent }}>`. Every inline editor reads the
  accent through the CSS variable — **do not prop-drill the colour** into
  individual editors.
- A sibling rule in `globals.css` opts the `.sheet-header` subtree out of the
  universal `*:focus-visible { outline: 2px solid var(--candlelight) }` rule.
  If you add another app-wide focus style, scope it out of `.sheet-header`
  too or reinstate the orange box.

### State flow
- Every header calls `usePatchSheet({ notePath, csrfToken, provider,
  initialSheet })` — shallow-merge-and-debounce hook that:
  1. Optimistically updates local `sheet` state.
  2. Writes the patch to Hocuspocus awareness (`sheetEdit` field) for live
     peer mirroring.
  3. PATCHes `/api/notes/sheet` after **400ms of idle** with the accumulated
     batch. Merges on 200 response.
  4. Re-applies peer `sheetEdit` broadcasts to local state (listens on
     `awareness.change`).
- Never call `fetch('/api/notes/sheet', ...)` directly from a header — go
  through `patchSheet()` so the debounce, optimistic state, and peer
  mirroring all stay in lock-step.

### Validation guards
- `sheet.name` is `z.string().min(1).optional()` for every kind. Trim and
  skip the patch if empty — otherwise the server rejects the whole batch:
  ```tsx
  onCommit={(next) => {
    const trimmed = next.trim();
    if (trimmed) patchSheet({ name: trimmed });
  }}
  ```
- Any other `.min(1)` string field in the schemas needs the same guard. Do
  not silently coerce `''` to `null` unless the field is `.nullable()`.

### Title autoscaling
- Long names wrap or overflow the header. Use `titleSizeClass(name, tier)`
  from `./util` to pick the size class — never hard-code `text-4xl` on a
  title that could hit 40+ characters.
- `'hero'` tier = Character / Creature / Location (wide titles).
- `'compact'` tier = Person / Item (narrower title rows).

### Kind dispatch
- `SheetHeader` is the only switchboard. Canonical kinds are
  `character | person | creature | item | location`; legacy aliases
  (`pc`, `npc`, `ally`, `villain`, `monster`) collapse via
  `normalizeKind()` in `./util`. That mapping **must stay in sync** with
  `server/src/lib/ai/tools.ts`. Change both at once.
- Unknown kinds render `null` — no header, no error. This is what keeps
  lore / session / plain notes unaffected.

### Legacy sheet shape
- Many sheets still carry flat legacy fields (`hp_current`, `ac`, `str`…)
  alongside the new nested shape (`hit_points.current`, `armor_class.value`,
  `ability_scores.str`…). Read with the helpers in `./util` (`readHitPoints`,
  `readArmorClass`, `readAbilityScores`, `readSpeed`, `readInitiative`).
- When you write back, write the **new shape first** and mirror into legacy
  keys the `CharacterSheet` side panel still reads (`hp_current`, `ac`,
  `str`/`dex`/…). See `CharacterHeader.tsx` for the canonical mirroring
  pattern. Don't duplicate mirrors elsewhere — centralise via
  `patchSheet()` in the header.
