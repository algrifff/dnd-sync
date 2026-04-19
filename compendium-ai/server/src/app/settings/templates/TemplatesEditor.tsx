'use client';

// Template editor. Admin-only UI that CRUDs the server-global
// note_templates table via /api/templates/:kind. One kind visible at
// a time; a left rail picks which. The right pane toggles between
// edit mode (forms) and preview mode (a mock sheet populated with
// defaults so the admin sees what a fresh note will look like).

import { useCallback, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
} from 'lucide-react';
import type {
  NoteTemplate,
  TemplateField,
  TemplateFieldType,
  TemplateKind,
  TemplateSchema,
  TemplateSection,
} from '@/lib/templates';

const FIELD_TYPES: readonly TemplateFieldType[] = [
  'text',
  'longtext',
  'integer',
  'number',
  'enum',
  'boolean',
  'list<text>',
] as const;

const KIND_LABELS: Record<TemplateKind, string> = {
  pc: 'Player character',
  npc: 'NPC',
  ally: 'Ally',
  villain: 'Villain',
  session: 'Session',
  item: 'Item',
  location: 'Location',
};

type Flash = { kind: 'ok' | 'error'; message: string } | null;

export function TemplatesEditor({
  csrfToken,
  initialTemplates,
  initialActiveKind,
}: {
  csrfToken: string;
  initialTemplates: NoteTemplate[];
  initialActiveKind: TemplateKind;
}): React.JSX.Element {
  const [templates, setTemplates] = useState<Record<string, NoteTemplate>>(() =>
    Object.fromEntries(initialTemplates.map((t) => [t.kind, t])),
  );
  const [activeKind, setActiveKind] = useState<TemplateKind>(initialActiveKind);
  const [previewMode, setPreviewMode] = useState<boolean>(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [saving, setSaving] = useState<boolean>(false);

  const active = templates[activeKind];
  const kinds = Object.keys(templates) as TemplateKind[];

  const updateActive = useCallback(
    (mut: (tpl: NoteTemplate) => NoteTemplate): void => {
      setTemplates((t) => ({ ...t, [activeKind]: mut(t[activeKind]!) }));
    },
    [activeKind],
  );

  const save = async (): Promise<void> => {
    if (!active || saving) return;
    setSaving(true);
    setFlash(null);
    try {
      const res = await fetch(
        `/api/templates/${encodeURIComponent(activeKind)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ name: active.name, schema: active.schema }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok) {
        setFlash({
          kind: 'error',
          message: body.detail ?? body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setFlash({ kind: 'ok', message: 'Template saved.' });
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setSaving(false);
    }
  };

  if (!active) return <p className="text-sm text-[#8B4A52]">No template loaded.</p>;

  return (
    <div className="grid grid-cols-[200px_1fr] gap-5">
      {/* Left rail: kind switcher */}
      <nav aria-label="Template kinds" className="flex flex-col gap-1">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setActiveKind(k);
              setFlash(null);
            }}
            aria-pressed={k === activeKind}
            className={
              'rounded-[8px] border px-3 py-2 text-left text-sm transition ' +
              (k === activeKind
                ? 'border-[#2A241E] bg-[#2A241E] text-[#F4EDE0]'
                : 'border-[#D4C7AE] bg-[#F4EDE0] text-[#2A241E] hover:bg-[#EAE1CF]')
            }
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </nav>

      {/* Main pane */}
      <div className="flex flex-col gap-4">
        {/* Header: name + preview toggle + save */}
        <div className="flex items-center gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-[#5A4F42]">Name</span>
            <input
              type="text"
              value={active.name}
              onChange={(e) =>
                updateActive((t) => ({ ...t, name: e.target.value }))
              }
              className="rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
            />
          </label>
          <button
            type="button"
            onClick={() => setPreviewMode((p) => !p)}
            className="flex items-center gap-1 rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-xs font-medium text-[#2A241E] transition hover:bg-[#EAE1CF]"
          >
            {previewMode ? (
              <>
                <EyeOff size={14} aria-hidden /> Edit
              </>
            ) : (
              <>
                <Eye size={14} aria-hidden /> Preview
              </>
            )}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-[8px] bg-[#2A241E] px-4 py-2 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {flash && (
          <span
            className={
              'text-sm ' +
              (flash.kind === 'ok' ? 'text-[#7B8A5F]' : 'text-[#8B4A52]')
            }
          >
            {flash.message}
          </span>
        )}

        {previewMode ? (
          <SheetPreview schema={active.schema} />
        ) : (
          <SchemaEditor
            schema={active.schema}
            onChange={(next) =>
              updateActive((t) => ({ ...t, schema: next }))
            }
          />
        )}
      </div>
    </div>
  );
}

// ── Schema editor (add/remove/reorder sections + fields) ─────────────

function SchemaEditor({
  schema,
  onChange,
}: {
  schema: TemplateSchema;
  onChange: (s: TemplateSchema) => void;
}): React.JSX.Element {
  const addSection = (): void => {
    const id = `section_${schema.sections.length + 1}`;
    onChange({
      ...schema,
      sections: [
        ...schema.sections,
        { id, label: 'New section', fields: [] },
      ],
    });
  };
  const updateSection = (idx: number, next: TemplateSection): void => {
    const sections = schema.sections.slice();
    sections[idx] = next;
    onChange({ ...schema, sections });
  };
  const removeSection = (idx: number): void => {
    const sections = schema.sections.slice();
    sections.splice(idx, 1);
    onChange({ ...schema, sections });
  };
  const moveSection = (idx: number, dir: -1 | 1): void => {
    const sections = schema.sections.slice();
    const target = idx + dir;
    if (target < 0 || target >= sections.length) return;
    [sections[idx], sections[target]] = [sections[target]!, sections[idx]!];
    onChange({ ...schema, sections });
  };

  return (
    <div className="flex flex-col gap-3">
      {schema.sections.map((section, idx) => (
        <SectionCard
          key={`${section.id}:${idx}`}
          section={section}
          canMoveUp={idx > 0}
          canMoveDown={idx < schema.sections.length - 1}
          onChange={(s) => updateSection(idx, s)}
          onRemove={() => removeSection(idx)}
          onMove={(dir) => moveSection(idx, dir)}
        />
      ))}
      <button
        type="button"
        onClick={addSection}
        className="flex items-center justify-center gap-1 rounded-[8px] border border-dashed border-[#D4C7AE] bg-[#F4EDE0]/60 px-3 py-2 text-sm text-[#5A4F42] transition hover:bg-[#F4EDE0]"
      >
        <Plus size={14} aria-hidden /> Add section
      </button>
    </div>
  );
}

function SectionCard({
  section,
  canMoveUp,
  canMoveDown,
  onChange,
  onRemove,
  onMove,
}: {
  section: TemplateSection;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (next: TemplateSection) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}): React.JSX.Element {
  const addField = (): void => {
    const id = `field_${section.fields.length + 1}`;
    onChange({
      ...section,
      fields: [
        ...section.fields,
        { id, label: 'New field', type: 'text' },
      ],
    });
  };
  const updateField = (idx: number, next: TemplateField): void => {
    const fields = section.fields.slice();
    fields[idx] = next;
    onChange({ ...section, fields });
  };
  const removeField = (idx: number): void => {
    const fields = section.fields.slice();
    fields.splice(idx, 1);
    onChange({ ...section, fields });
  };
  const moveField = (idx: number, dir: -1 | 1): void => {
    const fields = section.fields.slice();
    const target = idx + dir;
    if (target < 0 || target >= fields.length) return;
    [fields[idx], fields[target]] = [fields[target]!, fields[idx]!];
    onChange({ ...section, fields });
  };

  return (
    <div className="rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0] p-3">
      <div className="mb-3 flex items-center gap-2">
        <IconButton
          title="Move up"
          onClick={() => onMove(-1)}
          disabled={!canMoveUp}
        >
          <ChevronUp size={14} aria-hidden />
        </IconButton>
        <IconButton
          title="Move down"
          onClick={() => onMove(1)}
          disabled={!canMoveDown}
        >
          <ChevronDown size={14} aria-hidden />
        </IconButton>
        <input
          type="text"
          value={section.id}
          onChange={(e) => onChange({ ...section, id: slugify(e.target.value) })}
          aria-label="Section id"
          className="w-28 rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-1 font-mono text-xs text-[#2A241E]"
        />
        <input
          type="text"
          value={section.label}
          onChange={(e) => onChange({ ...section, label: e.target.value })}
          placeholder="Section label"
          aria-label="Section label"
          className="flex-1 rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-1 text-sm font-medium text-[#2A241E]"
        />
        <IconButton title="Remove section" onClick={onRemove}>
          <Trash2 size={14} aria-hidden />
        </IconButton>
      </div>

      <div className="flex flex-col gap-2">
        {section.fields.map((field, fIdx) => (
          <FieldRow
            key={`${field.id}:${fIdx}`}
            field={field}
            canMoveUp={fIdx > 0}
            canMoveDown={fIdx < section.fields.length - 1}
            onChange={(f) => updateField(fIdx, f)}
            onRemove={() => removeField(fIdx)}
            onMove={(dir) => moveField(fIdx, dir)}
          />
        ))}
        <button
          type="button"
          onClick={addField}
          className="flex items-center justify-center gap-1 rounded-[6px] border border-dashed border-[#D4C7AE] px-2 py-1 text-xs text-[#5A4F42] transition hover:bg-[#EAE1CF]"
        >
          <Plus size={12} aria-hidden /> Add field
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  canMoveUp,
  canMoveDown,
  onChange,
  onRemove,
  onMove,
}: {
  field: TemplateField;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (next: TemplateField) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}): React.JSX.Element {
  const setType = (type: TemplateFieldType): void => {
    // Reset type-specific constraints when the type changes so stale
    // min/max/options don't leak across.
    const next: TemplateField = {
      id: field.id,
      label: field.label,
      type,
      required: field.required,
      hint: field.hint,
      playerEditable: field.playerEditable,
    };
    onChange(next);
  };

  return (
    <div className="rounded-[8px] border border-[#D4C7AE]/70 bg-[#FBF5E8] p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <IconButton title="Move up" onClick={() => onMove(-1)} disabled={!canMoveUp}>
          <ChevronUp size={12} aria-hidden />
        </IconButton>
        <IconButton title="Move down" onClick={() => onMove(1)} disabled={!canMoveDown}>
          <ChevronDown size={12} aria-hidden />
        </IconButton>
        <input
          type="text"
          value={field.id}
          onChange={(e) => onChange({ ...field, id: slugify(e.target.value) })}
          placeholder="field_id"
          aria-label="Field id"
          className="w-28 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 font-mono text-xs text-[#2A241E]"
        />
        <input
          type="text"
          value={field.label}
          onChange={(e) => onChange({ ...field, label: e.target.value })}
          placeholder="Label"
          aria-label="Field label"
          className="flex-1 rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-xs text-[#2A241E]"
        />
        <select
          value={field.type}
          onChange={(e) => setType(e.target.value as TemplateFieldType)}
          aria-label="Field type"
          className="rounded-[6px] border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-1 text-xs text-[#2A241E]"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <IconButton title="Remove field" onClick={onRemove}>
          <Trash2 size={12} aria-hidden />
        </IconButton>
      </div>

      {/* Type-specific constraints */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-[56px] text-[11px] text-[#5A4F42]">
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!field.required}
            onChange={(e) => onChange({ ...field, required: e.target.checked })}
          />
          required
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!field.playerEditable}
            onChange={(e) =>
              onChange({ ...field, playerEditable: e.target.checked })
            }
          />
          playerEditable
        </label>
        {(field.type === 'integer' || field.type === 'number') && (
          <>
            <NumberInput
              label="min"
              value={field.min}
              onChange={(v) => onChange({ ...field, min: v })}
            />
            <NumberInput
              label="max"
              value={field.max}
              onChange={(v) => onChange({ ...field, max: v })}
            />
          </>
        )}
        {field.type === 'enum' && (
          <label className="inline-flex items-center gap-1">
            options
            <input
              type="text"
              value={(field.options ?? []).join(', ')}
              onChange={(e) =>
                onChange({
                  ...field,
                  options: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="comma, separated"
              className="rounded-[4px] border border-[#D4C7AE] bg-[#F4EDE0] px-1 py-0.5 text-xs text-[#2A241E]"
            />
          </label>
        )}
        <label className="inline-flex flex-1 items-center gap-1">
          hint
          <input
            type="text"
            value={field.hint ?? ''}
            onChange={(e) =>
              onChange({ ...field, hint: e.target.value || undefined })
            }
            className="flex-1 rounded-[4px] border border-[#D4C7AE] bg-[#F4EDE0] px-1 py-0.5 text-xs text-[#2A241E]"
          />
        </label>
      </div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}): React.JSX.Element {
  return (
    <label className="inline-flex items-center gap-1">
      {label}
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') onChange(undefined);
          else {
            const n = Number(v);
            onChange(Number.isFinite(n) ? n : undefined);
          }
        }}
        className="w-16 rounded-[4px] border border-[#D4C7AE] bg-[#F4EDE0] px-1 py-0.5 text-xs text-[#2A241E]"
      />
    </label>
  );
}

function IconButton({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="rounded-[4px] p-1 text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// ── Preview ────────────────────────────────────────────────────────────

function SheetPreview({ schema }: { schema: TemplateSchema }): React.JSX.Element {
  // Seed each field with its default (or a type-appropriate placeholder)
  // so admins see what a freshly-created note will look like.
  const values = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const section of schema.sections) {
      for (const field of section.fields) {
        if (field.default !== undefined) {
          out[field.id] = field.default;
        } else {
          out[field.id] = emptyForType(field.type);
        }
      }
    }
    return out;
  }, [schema]);

  return (
    <div className="space-y-4 rounded-[10px] border border-[#D4C7AE] bg-[#F4EDE0]/70 p-4">
      <p className="text-xs text-[#5A4F42]">
        Preview of a fresh note using this template. Values are defaults; real
        sheets will show whatever the player has filled in.
      </p>
      {schema.sections.map((section) => (
        <section key={section.id}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#5A4F42]">
            {section.label}
          </h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[#2A241E]">
            {section.fields.map((field) => (
              <div key={field.id} className="contents">
                <dt className="text-[#5A4F42]">
                  {field.label}
                  {field.required && (
                    <span aria-hidden className="ml-0.5 text-[#8B4A52]">*</span>
                  )}
                </dt>
                <dd className="font-mono">{formatValue(values[field.id])}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function emptyForType(type: TemplateFieldType): unknown {
  switch (type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'list<text>':
      return [];
    default:
      return '';
  }
}

function formatValue(v: unknown): string {
  if (v === '' || v == null) return '—';
  if (Array.isArray(v)) return v.length > 0 ? v.join(', ') : '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
