'use client';

// "Import from PDF" — drops on the character editor header. Posts the
// file to /api/me/characters/[id]/import-pdf, shows an AI-derived
// preview, and on confirm PATCHes the master record. The page refresh
// after success picks up the new sheet/body and the master→notes sync
// engine fans changes out to bound campaign notes.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Loader2, X } from 'lucide-react';

type Patch = {
  name: string;
  sheet: Record<string, unknown>;
  bodyJson: Record<string, unknown> | null;
  bodyMd: string | null;
};

export function ImportPdfButton({
  characterId,
  csrfToken,
}: {
  characterId: string;
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'preview' | 'applying'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [filename, setFilename] = useState<string>('');

  const onPick = (): void => {
    setError(null);
    fileRef.current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFilename(file.name);
    setStage('uploading');
    setError(null);

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(
        `/api/me/characters/${encodeURIComponent(characterId)}/import-pdf`,
        {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
          body: fd,
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        patch?: Patch;
        error?: string;
        reason?: string;
      };
      if (!res.ok || !json.ok || !json.patch) {
        throw new Error(json.reason ?? json.error ?? `HTTP ${res.status}`);
      }
      setPatch(json.patch);
      setStage('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import failed');
      setStage('idle');
    }
  };

  const apply = async (): Promise<void> => {
    if (!patch) return;
    setStage('applying');
    setError(null);
    try {
      const res = await fetch(
        `/api/me/characters/${encodeURIComponent(characterId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            name: patch.name,
            sheet: patch.sheet,
            bodyJson: patch.bodyJson,
            bodyMd: patch.bodyMd,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        throw new Error(body.reason ?? body.error ?? `HTTP ${res.status}`);
      }
      setStage('idle');
      setPatch(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'apply failed');
      setStage('preview');
    }
  };

  const cancel = (): void => {
    setStage('idle');
    setPatch(null);
    setError(null);
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => void onFile(e)}
      />
      <button
        type="button"
        onClick={onPick}
        disabled={stage === 'uploading'}
        className="flex items-center gap-1 rounded-[6px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--candlelight)]/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {stage === 'uploading' ? (
          <Loader2 size={12} className="animate-spin" aria-hidden />
        ) : (
          <FileUp size={12} aria-hidden />
        )}
        {stage === 'uploading' ? 'Reading…' : 'Import PDF'}
      </button>

      {error && stage === 'idle' && (
        <span
          className="ml-2 max-w-[260px] truncate text-[11px] text-[var(--wine)]"
          title={error}
        >
          {error}
        </span>
      )}

      {stage === 'preview' && patch && (
        <PreviewModal
          patch={patch}
          filename={filename}
          onApply={() => void apply()}
          onCancel={cancel}
          applying={false}
          error={error}
        />
      )}
      {stage === 'applying' && patch && (
        <PreviewModal
          patch={patch}
          filename={filename}
          onApply={() => void apply()}
          onCancel={cancel}
          applying={true}
          error={error}
        />
      )}
    </>
  );
}

function PreviewModal({
  patch,
  filename,
  onApply,
  onCancel,
  applying,
  error,
}: {
  patch: Patch;
  filename: string;
  onApply: () => void;
  onCancel: () => void;
  applying: boolean;
  error: string | null;
}): React.JSX.Element {
  const summary = summarisePatch(patch);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--shadow)]/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5 shadow-2xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="font-serif text-lg text-[var(--ink)]">
              Import preview
            </h2>
            <p className="text-[11px] text-[var(--ink-soft)]">
              From {filename}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] p-1 text-[var(--ink-soft)] transition hover:bg-[var(--parchment)]"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </div>

        <div className="mb-4 rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] p-3">
          <div className="mb-2 font-serif text-xl text-[var(--ink)]">
            {patch.name}
          </div>
          <ul className="space-y-1 text-[12px] text-[var(--ink-soft)]">
            {summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>

        <p className="mb-4 text-[11px] text-[var(--ink-muted)]">
          Applying will overwrite the matching fields on this character and
          replace the body content. Other sheet fields are preserved.
        </p>

        {error && (
          <p className="mb-3 text-[11px] text-[var(--wine)]">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="rounded-[6px] border border-[var(--rule)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--parchment)] disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="flex items-center gap-1 rounded-[6px] bg-[var(--ink)] px-3 py-1.5 text-xs font-medium text-[var(--parchment)] transition hover:bg-[var(--ink-soft)] disabled:opacity-60"
          >
            {applying && (
              <Loader2 size={12} className="animate-spin" aria-hidden />
            )}
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function summarisePatch(patch: Patch): string[] {
  const s = patch.sheet;
  const lines: string[] = [];
  const classes = Array.isArray(s.classes) ? (s.classes as Array<Record<string, unknown>>) : [];
  if (classes.length > 0) {
    const desc = classes
      .map((c) => {
        const ref = c.ref as { name?: string } | undefined;
        const subclass = typeof c.subclass === 'string' ? c.subclass : '';
        const name = ref?.name ?? 'Unknown';
        return subclass ? `${name} (${subclass}) ${c.level}` : `${name} ${c.level}`;
      })
      .join(' / ');
    lines.push(`Class: ${desc}`);
  }
  const race = (s.race as { ref?: { name?: string } } | undefined)?.ref?.name;
  if (race) lines.push(`Race: ${race}`);
  const bg = (s.background as { ref?: { name?: string } } | undefined)?.ref?.name;
  if (bg) lines.push(`Background: ${bg}`);

  const ab = s.ability_scores as Record<string, number> | undefined;
  if (ab) {
    lines.push(
      `Abilities: STR ${ab.str} · DEX ${ab.dex} · CON ${ab.con} · INT ${ab.int} · WIS ${ab.wis} · CHA ${ab.cha}`,
    );
  }
  const hp = s.hit_points as { current?: number; max?: number } | undefined;
  if (hp && (hp.current != null || hp.max != null)) {
    lines.push(`HP: ${hp.current ?? '?'} / ${hp.max ?? '?'}`);
  }
  const ac = s.armor_class as { value?: number } | undefined;
  if (ac?.value != null) lines.push(`AC: ${ac.value}`);

  const skills = s.skills as Record<string, unknown> | undefined;
  if (skills) {
    const profCount = Object.keys(skills).length;
    if (profCount > 0) lines.push(`Skill proficiencies: ${profCount}`);
  }
  const inventory = s.inventory as unknown[] | undefined;
  if (inventory && inventory.length > 0) {
    lines.push(`Inventory items: ${inventory.length}`);
  }
  if (patch.bodyMd && patch.bodyMd.trim()) {
    const chars = patch.bodyMd.length;
    lines.push(`Body content: ${chars} characters of features & backstory`);
  }
  return lines;
}
