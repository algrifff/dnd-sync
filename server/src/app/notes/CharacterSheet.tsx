'use client';

// CharacterSheet — rendered above the prose body on any note whose
// frontmatter declares `kind: character`. The SheetHeader above owns
// identity, HP/AC/Speed, and the ability-score strip; this panel
// hosts everything else (skills, inventory, features, background
// etc.) as a tabbed layout so a long PC sheet doesn't blow out the
// whole note page.
//
// The form shape for Inventory / Features / Extras still comes from
// the admin-editable template (one copy per role). Skills are
// rendered directly from the canonical 5e list keyed off
// `sheet.skills` + `sheet.proficiency_bonus` — no template entry
// required, so every character gets the same single-column skill
// list regardless of the template they were created against.
//
// Values live in frontmatter.sheet and sync via PATCH
// /api/notes/sheet on blur, with a peer-awareness broadcast so
// multi-tab edits are near-instant before the round-trip.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type {
  NoteTemplate,
  TemplateField,
  TemplateSchema,
  TemplateSection,
} from '@/lib/templates';
import {
  abilityModifier,
  formatModifier,
  readAbilityScores,
} from './sheet-header/util';

export type SheetValues = Record<string, unknown>;

// ── Tab layout ─────────────────────────────────────────────────────────

type TabId =
  | 'actions'
  | 'skills'
  | 'inventory'
  | 'features'
  | 'background'
  | 'extras';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'actions', label: 'Actions' },
  { id: 'skills', label: 'Skills' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'features', label: 'Features & Traits' },
  { id: 'background', label: 'Background' },
  { id: 'extras', label: 'Extras' },
];

/** Map a template section.id to a tab. Unknown ids fall through to
 *  'extras' so nothing in the schema ever disappears. */
function sectionTab(sectionId: string): TabId {
  const id = sectionId.toLowerCase();
  if (id === 'combat' || id === 'actions') return 'actions';
  if (id === 'inventory' || id === 'gear' || id === 'equipment') return 'inventory';
  if (id === 'features' || id === 'traits' || id === 'features_traits')
    return 'features';
  if (id === 'basics' || id === 'background' || id === 'relationship')
    return 'background';
  return 'extras';
}

// ── 5e skill catalogue (must match shared/schemas/dnd5e/primitives) ────

const SKILL_CATALOG: Array<{
  key: string;
  label: string;
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
}> = [
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

// Field IDs whose editing lives in the SheetHeader above — filtered
// out of every tab so there's one source of truth per field.
const HEADER_OWNED_FIELDS = new Set<string>([
  'name',
  'race',
  'class',
  'background',
  'portrait',
  'str', 'dex', 'con', 'int', 'wis', 'cha',
  'ac', 'armor_class',
  'hp_current', 'hp_max', 'hp_temporary',
  'speed',
]);

export function CharacterSheet({
  path,
  csrfToken,
  template,
  initialSheet,
  canWriteAll,
  provider,
}: {
  path: string;
  csrfToken: string;
  template: NoteTemplate;
  initialSheet: SheetValues;
  canWriteAll: boolean;
  /** Note's collab provider — used only for awareness broadcasts so
   *  peers see sheet edits before PATCH. All persistence still
   *  flows through /api/notes/sheet. */
  provider: HocuspocusProvider;
}): React.JSX.Element {
  const [sheet, setSheet] = useState<SheetValues>(initialSheet);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('actions');
  const savingRef = useRef<Promise<void> | null>(null);

  const playerEditable = useMemo(
    () => collectPlayerEditable(template.schema),
    [template],
  );

  const fieldEditable = useCallback(
    (field: TemplateField): boolean => {
      if (canWriteAll) return true;
      return !!field.playerEditable;
    },
    [canWriteAll],
  );

  // Group template sections by tab, dropping header-owned fields and
  // any section that ends up empty.
  const sectionsByTab = useMemo(() => {
    const out: Record<TabId, TemplateSection[]> = {
      actions: [],
      skills: [],
      inventory: [],
      features: [],
      background: [],
      extras: [],
    };
    for (const section of template.schema.sections) {
      const visibleFields = section.fields.filter(
        (f) => !HEADER_OWNED_FIELDS.has(f.id),
      );
      if (visibleFields.length === 0) continue;
      const tab = sectionTab(section.id);
      out[tab].push({ ...section, fields: visibleFields });
    }
    return out;
  }, [template]);

  // Coalesce rapid edits into one PATCH; multiple fields may change
  // in a burst (pressing Tab through the ability scores, etc.).
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<Record<string, unknown>>({});

  const flush = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      // Chain — don't fire concurrent requests.
      await savingRef.current;
    }
    const batch = pendingPatchRef.current;
    if (Object.keys(batch).length === 0) return;
    pendingPatchRef.current = {};
    const run = (async () => {
      try {
        const res = await fetch('/api/notes/sheet', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ path, sheet: batch }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          sheet?: SheetValues;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !body.ok) {
          setFlash(body.detail ?? body.error ?? `save failed (${res.status})`);
          return;
        }
        if (body.sheet) setSheet(body.sheet);
        setFlash(null);
      } catch (err) {
        setFlash(err instanceof Error ? err.message : 'network error');
      } finally {
        setPending((p) => {
          const next = { ...p };
          for (const k of Object.keys(batch)) delete next[k];
          return next;
        });
      }
    })();
    savingRef.current = run;
    await run;
    savingRef.current = null;
  }, [csrfToken, path]);

  const commit = useCallback(
    (fieldId: string, value: unknown) => {
      setSheet((prev) => ({ ...prev, [fieldId]: value }));
      pendingPatchRef.current[fieldId] = value;
      setPending((p) => ({ ...p, [fieldId]: true }));
      // Broadcast over awareness so peers' sheets update instantly.
      const aw = provider.awareness;
      if (aw) {
        const seq = Date.now();
        aw.setLocalStateField('sheetEdit', {
          path,
          seq,
          fields: { [fieldId]: value },
        });
      }
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        void flush();
      }, 400);
    },
    [path, provider, flush],
  );

  // Listen for peer sheet edits on the same note and merge into
  // local state. We ignore our own client's awareness entry so the
  // local commit path doesn't bounce back through the observer.
  useEffect(() => {
    const aw = provider.awareness;
    if (!aw) return;
    const seen = new Map<number, number>();
    const onChange = (): void => {
      for (const [clientId, state] of aw.getStates().entries()) {
        if (clientId === aw.clientID) continue;
        const s = state as
          | {
              sheetEdit?: {
                path?: string;
                seq?: number;
                fields?: Record<string, unknown>;
              };
            }
          | undefined;
        const edit = s?.sheetEdit;
        if (!edit || edit.path !== path || typeof edit.seq !== 'number') {
          continue;
        }
        const last = seen.get(clientId);
        if (last === edit.seq) continue;
        seen.set(clientId, edit.seq);
        if (edit.fields && typeof edit.fields === 'object') {
          setSheet((prev) => ({ ...prev, ...edit.fields! }));
        }
      }
    };
    aw.on('change', onChange);
    return () => aw.off('change', onChange);
  }, [provider, path]);

  const savingAny = Object.keys(pending).length > 0;

  const renderSection = (section: TemplateSection): React.JSX.Element => (
    <section key={section.id} className="mb-3 last:mb-0">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
        {section.label}
      </h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {section.fields.map((field) => (
          <FieldControl
            key={field.id}
            field={field}
            value={sheet[field.id]}
            onCommit={commit}
            readOnly={!fieldEditable(field)}
            isPlayerField={playerEditable.has(field.id) && !canWriteAll}
          />
        ))}
      </div>
    </section>
  );

  // Stable skill-toggle callbacks. Reading the latest sheet via a
  // ref keeps the callback identity stable across renders so
  // SkillsPanel's memo isn't invalidated on every parent render.
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const toggleProficient = useCallback(
    (key: string) => {
      const s = sheetRef.current;
      const current = readSkillEntry(s, key);
      const next = {
        ...(s.skills as Record<string, unknown> | undefined),
        [key]: { ...current, proficient: !current.proficient },
      };
      commit('skills', next);
    },
    [commit],
  );
  const toggleExpertise = useCallback(
    (key: string) => {
      const s = sheetRef.current;
      const current = readSkillEntry(s, key);
      const next = {
        ...(s.skills as Record<string, unknown> | undefined),
        [key]: {
          ...current,
          // Expertise implies proficient.
          proficient: current.expertise ? current.proficient : true,
          expertise: !current.expertise,
        },
      };
      commit('skills', next);
    },
    [commit],
  );

  const renderTab = (tab: TabId): React.JSX.Element => {
    if (tab === 'skills') {
      return (
        <SkillsPanel
          sheet={sheet}
          canEdit={canWriteAll}
          onToggleProficient={toggleProficient}
          onToggleExpertise={toggleExpertise}
        />
      );
    }
    const sections = sectionsByTab[tab];
    if (sections.length === 0) {
      return (
        <div className="rounded-[8px] border border-dashed border-[#D4C7AE] bg-[#F4EDE0] p-4 text-center text-xs text-[#8A7E6B]">
          Nothing here yet.
        </div>
      );
    }
    return <div>{sections.map(renderSection)}</div>;
  };

  // Hide tabs that would render empty (except Skills — it's always
  // populated from the canonical 5e list).
  const availableTabs = TABS.filter(
    (t) => t.id === 'skills' || sectionsByTab[t.id].length > 0,
  );
  const effectiveTab = availableTabs.some((t) => t.id === activeTab)
    ? activeTab
    : availableTabs[0]?.id ?? 'skills';

  return (
    <section
      aria-label="Character sheet"
      className="mb-6 rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-4"
    >
      <div
        className="mb-2 h-4 text-right text-xs text-[#5A4F42] transition-opacity"
        style={{ opacity: savingAny || flash ? 1 : 0 }}
        aria-live="polite"
      >
        {savingAny ? (
          'Saving…'
        ) : flash ? (
          <span className="text-[#8B4A52]">{flash}</span>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Character sheet sections"
        className="mb-3 flex flex-wrap gap-1 border-b border-[#D4C7AE]"
      >
        {availableTabs.map((t) => (
          <TabButton
            key={t.id}
            id={t.id}
            label={t.label}
            active={t.id === effectiveTab}
            onSelect={setActiveTab}
          />
        ))}
      </div>

      {renderTab(effectiveTab)}
    </section>
  );
}

// ── Skills panel ───────────────────────────────────────────────────────

const SkillsPanel = memo(function SkillsPanel({
  sheet,
  canEdit,
  onToggleProficient,
  onToggleExpertise,
}: {
  sheet: SheetValues;
  canEdit: boolean;
  onToggleProficient: (key: string) => void;
  onToggleExpertise: (key: string) => void;
}): React.JSX.Element {
  const scores =
    readAbilityScores(sheet) ??
    { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  const profBonus =
    typeof sheet.proficiency_bonus === 'number' ? sheet.proficiency_bonus : 2;

  return (
    <ul className="divide-y divide-[#D4C7AE]/60 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0]">
      {SKILL_CATALOG.map((s) => {
        const entry = readSkillEntry(sheet, s.key);
        const abilityMod = abilityModifier(scores[s.ability]);
        const bonus = entry.expertise
          ? profBonus * 2
          : entry.proficient
            ? profBonus
            : 0;
        const total = abilityMod + bonus;
        return (
          <SkillRow
            key={s.key}
            skillKey={s.key}
            label={s.label}
            ability={s.ability}
            modifier={total}
            state={
              entry.expertise
                ? 'expertise'
                : entry.proficient
                  ? 'proficient'
                  : 'none'
            }
            canEdit={canEdit}
            onToggleProficient={onToggleProficient}
            onToggleExpertise={onToggleExpertise}
          />
        );
      })}
    </ul>
  );
});

// Memoised single skill line. With the parent's stable toggle
// callbacks, peer awareness churn that doesn't change a particular
// skill's prof/expertise/modifier no longer re-renders that row.
const SkillRow = memo(function SkillRow({
  skillKey,
  label,
  ability,
  modifier,
  state,
  canEdit,
  onToggleProficient,
  onToggleExpertise,
}: {
  skillKey: string;
  label: string;
  ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  modifier: number;
  state: 'none' | 'proficient' | 'expertise';
  canEdit: boolean;
  onToggleProficient: (key: string) => void;
  onToggleExpertise: (key: string) => void;
}): React.JSX.Element {
  const onClick = useCallback(
    () => onToggleProficient(skillKey),
    [onToggleProficient, skillKey],
  );
  const onDoubleClick = useCallback(
    () => onToggleExpertise(skillKey),
    [onToggleExpertise, skillKey],
  );
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
      <ProfDot
        state={state}
        canEdit={canEdit}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      />
      <span className="flex-1 text-[#2A241E]">{label}</span>
      <span className="w-10 text-right text-[10px] uppercase tracking-wide text-[#5A4F42]">
        {ability}
      </span>
      <span className="w-10 text-right font-serif text-[14px] font-semibold tabular-nums text-[#2A241E]">
        {formatModifier(modifier)}
      </span>
    </li>
  );
});

function ProfDot({
  state,
  canEdit,
  onClick,
  onDoubleClick,
}: {
  state: 'none' | 'proficient' | 'expertise';
  canEdit: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}): React.JSX.Element {
  const fill =
    state === 'expertise'
      ? '#2A241E'
      : state === 'proficient'
        ? '#8A7E6B'
        : 'transparent';
  const ring =
    state === 'expertise' ? '#2A241E' : '#8A7E6B';
  if (!canEdit) {
    return (
      <span
        aria-label={state}
        title={state}
        className="inline-block h-3 w-3 rounded-full border"
        style={{ backgroundColor: fill, borderColor: ring }}
      />
    );
  }
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

function readSkillEntry(
  sheet: SheetValues,
  key: string,
): { proficient: boolean; expertise: boolean } {
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
  // Legacy: a flat `proficient_skills: string[]` shape.
  if (Array.isArray(sheet.proficient_skills)) {
    return {
      proficient: (sheet.proficient_skills as unknown[]).includes(key),
      expertise: false,
    };
  }
  return { proficient: false, expertise: false };
}

// ── Shared form helpers ───────────────────────────────────────────────

function collectPlayerEditable(schema: TemplateSchema): Set<string> {
  const out = new Set<string>();
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.playerEditable) out.add(field.id);
    }
  }
  return out;
}

// Memoised tab pill. `onSelect` is React's stable setActiveTab
// reference, so as long as id/label/active don't change for a given
// tab, this skips re-rendering on parent state churn.
const TabButton = memo(function TabButton({
  id,
  label,
  active,
  onSelect,
}: {
  id: TabId;
  label: string;
  active: boolean;
  onSelect: (id: TabId) => void;
}): React.JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={() => onSelect(id)}
      className={
        '-mb-px rounded-t border px-3 py-1 text-[11px] font-medium transition-colors ' +
        (active
          ? 'border-[#D4C7AE] border-b-[#FBF5E8] bg-[#FBF5E8] text-[#2A241E]'
          : 'border-transparent text-[#5A4F42] hover:bg-[#F4EDE0]')
      }
    >
      {label}
    </button>
  );
});

// Memoised so a peer awareness tick that updates one field's value
// doesn't force every other FieldControl in the sheet to re-render.
// `onCommit` is the stable parent-level commit fn (takes fieldId), so
// the only props that actually change between renders are `value` for
// the field that was just edited.
const FieldControl = memo(function FieldControl({
  field,
  value,
  onCommit,
  readOnly,
  isPlayerField,
}: {
  field: TemplateField;
  value: unknown;
  onCommit: (fieldId: string, v: unknown) => void;
  readOnly: boolean;
  isPlayerField: boolean;
}): React.JSX.Element {
  // Local adapter so FieldInput keeps its single-arg contract.
  // Recreated per FieldControl render, but FieldControl itself only
  // renders when its memo'd props actually shift — so this is cheap.
  const handle = useCallback(
    (v: unknown) => onCommit(field.id, v),
    [onCommit, field.id],
  );
  return (
    <label
      className={
        'flex flex-col gap-1 ' + (isPlayerField ? 'ring-offset-[#FBF5E8]' : '')
      }
    >
      <span className="text-[11px] font-medium text-[#5A4F42]">
        {field.label}
        {field.required && (
          <span aria-hidden className="ml-0.5 text-[#8B4A52]">*</span>
        )}
      </span>
      <FieldInput
        field={field}
        value={value}
        onCommit={handle}
        readOnly={readOnly}
      />
      {field.hint && (
        <span className="text-[10px] text-[#5A4F42]/80">{field.hint}</span>
      )}
    </label>
  );
});

function FieldInput({
  field,
  value,
  onCommit,
  readOnly,
}: {
  field: TemplateField;
  value: unknown;
  onCommit: (v: unknown) => void;
  readOnly: boolean;
}): React.JSX.Element {
  const base =
    'rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]';
  const ro = readOnly
    ? ' cursor-not-allowed bg-[#EAE1CF]/70 text-[#5A4F42]'
    : '';

  if (field.type === 'longtext') {
    const [local, setLocal] = useControlled(toStr(value) ?? '');
    return (
      <textarea
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onCommit(local)}
        readOnly={readOnly}
        rows={3}
        className={base + ro}
      />
    );
  }
  if (field.type === 'integer' || field.type === 'number') {
    const numeric = toNum(value);
    const [local, setLocal] = useControlled(numeric != null ? String(numeric) : '');
    return (
      <input
        type="number"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local === '') onCommit(null);
          else {
            const n = Number(local);
            if (Number.isFinite(n)) {
              let clamped = field.type === 'integer' ? Math.trunc(n) : n;
              if (field.min != null) clamped = Math.max(field.min, clamped);
              if (field.max != null) clamped = Math.min(field.max, clamped);
              onCommit(clamped);
            }
          }
        }}
        readOnly={readOnly}
        min={field.min}
        max={field.max}
        className={base + ro}
      />
    );
  }
  if (field.type === 'enum') {
    const current = toStr(value) ?? '';
    return (
      <select
        value={current}
        onChange={(e) => onCommit(e.target.value || null)}
        disabled={readOnly}
        className={base + ro}
      >
        <option value="">—</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onCommit(e.target.checked)}
        disabled={readOnly}
        className="h-4 w-4 self-start accent-[#2A241E]"
      />
    );
  }
  if (field.type === 'list<text>') {
    return <ListTextInput value={value} readOnly={readOnly} onCommit={onCommit} />;
  }
  // text (default)
  const [local, setLocal] = useControlled(toStr(value) ?? '');
  return (
    <input
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onCommit(local)}
      readOnly={readOnly}
      className={base + ro}
    />
  );
}

function ListTextInput({
  value,
  readOnly,
  onCommit,
}: {
  value: unknown;
  readOnly: boolean;
  onCommit: (v: string[]) => void;
}): React.JSX.Element {
  const items = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  const [draft, setDraft] = useState<string>('');
  const addItem = (): void => {
    const t = draft.trim();
    if (!t) return;
    onCommit([...items, t]);
    setDraft('');
  };
  const removeAt = (idx: number): void => {
    const next = items.slice();
    next.splice(idx, 1);
    onCommit(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-1.5 py-1">
      {items.map((item, idx) => (
        <span
          key={`${item}:${idx}`}
          className="inline-flex items-center gap-1 rounded-full border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-0.5 text-[11px] text-[#2A241E]"
        >
          {item}
          {!readOnly && (
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={() => removeAt(idx)}
              className="text-[#5A4F42] hover:text-[#8B4A52]"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addItem();
            }
          }}
          onBlur={addItem}
          placeholder="add…"
          className="min-w-[60px] flex-1 bg-transparent text-[11px] text-[#2A241E] outline-none"
        />
      )}
    </div>
  );
}

/** Small helper for controlled inputs that resync when the upstream
 *  value changes (e.g. the server echo arrives). */
function useControlled(initial: string): [string, (v: string) => void] {
  const [val, setVal] = useState<string>(initial);
  const lastInitial = useRef<string>(initial);
  if (lastInitial.current !== initial) {
    lastInitial.current = initial;
    setVal(initial);
  }
  return [val, setVal];
}

function toStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
