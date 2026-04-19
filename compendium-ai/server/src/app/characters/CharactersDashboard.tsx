'use client';

// /characters dashboard. Your PCs first (grouped by campaign), then
// — for admins + editors — a "Rest of the vault" section listing
// every other character. Each card links into the sheet and, for
// PCs you own, offers a Set active pin.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Star, StarOff } from 'lucide-react';
import type { CharacterListRow } from '@/lib/characters';

export function CharactersDashboard({
  csrfToken,
  mine,
  others,
  activeCharacterPath,
  campaignNames,
  isAdmin,
}: {
  csrfToken: string;
  mine: CharacterListRow[];
  others: CharacterListRow[];
  activeCharacterPath: string | null;
  campaignNames: Record<string, string>;
  isAdmin: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [activePath, setActivePath] = useState<string | null>(
    activeCharacterPath,
  );
  const [saving, setSaving] = useState<boolean>(false);

  const setActive = async (path: string | null): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const previous = activePath;
    setActivePath(path);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ activeCharacterPath: path }),
      });
      if (!res.ok) setActivePath(previous);
      else router.refresh();
    } catch {
      setActivePath(previous);
    } finally {
      setSaving(false);
    }
  };

  const mineByCampaign = groupByCampaign(mine);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#5A4F42]">
          Your characters
        </h2>
        {mine.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-[#D4C7AE] bg-[#FBF5E8]/60 px-4 py-6 text-sm text-[#5A4F42]">
            You don&rsquo;t own any characters yet. A character is yours when
            its frontmatter carries <code>player: {"<"}your username{">"}</code>.
            Phase 1f will wire this up through a &ldquo;+ New character&rdquo;
            button.
          </p>
        ) : (
          Object.entries(mineByCampaign).map(([slug, rows]) => (
            <CampaignGroup
              key={slug}
              title={slug === '' ? 'No campaign' : campaignNames[slug] ?? slug}
              rows={rows}
              activePath={activePath}
              onSetActive={setActive}
              showActiveToggle
            />
          ))
        )}
      </section>

      {isAdmin && others.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#5A4F42]">
            Rest of the vault
          </h2>
          {Object.entries(groupByCampaign(others)).map(([slug, rows]) => (
            <CampaignGroup
              key={slug}
              title={slug === '' ? 'No campaign' : campaignNames[slug] ?? slug}
              rows={rows}
              activePath={activePath}
              onSetActive={setActive}
              showActiveToggle={false}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function CampaignGroup({
  title,
  rows,
  activePath,
  onSetActive,
  showActiveToggle,
}: {
  title: string;
  rows: CharacterListRow[];
  activePath: string | null;
  onSetActive: (path: string | null) => void;
  showActiveToggle: boolean;
}): React.JSX.Element {
  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[#5A4F42]/80">
        {title}
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((c) =>
          showActiveToggle ? (
            <CharacterCard
              key={c.notePath}
              character={c}
              isActive={activePath === c.notePath}
              onToggleActive={() =>
                onSetActive(activePath === c.notePath ? null : c.notePath)
              }
            />
          ) : (
            <CharacterCard
              key={c.notePath}
              character={c}
              isActive={activePath === c.notePath}
            />
          ),
        )}
      </div>
    </div>
  );
}

function CharacterCard({
  character,
  isActive,
  onToggleActive,
}: {
  character: CharacterListRow;
  isActive: boolean;
  onToggleActive?: () => void;
}): React.JSX.Element {
  const portraitUrl = character.portraitPath
    ? `/api/assets/by-path?path=${encodeURIComponent(character.portraitPath)}`
    : null;
  const tagline = [
    character.level != null ? `Lv ${character.level}` : null,
    character.class,
    character.race,
  ]
    .filter((p): p is string => !!p)
    .join(' · ');
  const kindBadge = KIND_LABELS[character.kind];

  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] p-3">
      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0]">
        {portraitUrl ? (
          <img
            src={portraitUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-[#5A4F42]">
            {character.displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Link
            href={`/notes/${character.notePath
              .split('/')
              .map(encodeURIComponent)
              .join('/')}`}
            className="truncate text-sm font-medium text-[#2A241E] hover:underline"
          >
            {character.displayName}
          </Link>
          <span className="rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-1.5 text-[9px] font-medium uppercase tracking-wide text-[#5A4F42]">
            {kindBadge}
          </span>
        </div>
        {tagline && (
          <div className="truncate text-xs text-[#5A4F42]">{tagline}</div>
        )}
      </div>
      {onToggleActive && (
        <button
          type="button"
          onClick={onToggleActive}
          title={isActive ? 'Unset active' : 'Set active'}
          aria-label={isActive ? 'Unset active character' : 'Set active character'}
          className={
            'rounded-[6px] border p-1 transition ' +
            (isActive
              ? 'border-[#D4A85A] bg-[#D4A85A]/15 text-[#8B4A52]'
              : 'border-[#D4C7AE] text-[#5A4F42] hover:bg-[#F4EDE0] hover:text-[#2A241E]')
          }
        >
          {isActive ? (
            <Star size={14} aria-hidden fill="currentColor" />
          ) : (
            <StarOff size={14} aria-hidden />
          )}
        </button>
      )}
    </div>
  );
}

function groupByCampaign(
  rows: CharacterListRow[],
): Record<string, CharacterListRow[]> {
  const out: Record<string, CharacterListRow[]> = {};
  for (const r of rows) {
    if (r.campaigns.length === 0) {
      (out[''] ??= []).push(r);
    } else {
      for (const slug of r.campaigns) {
        (out[slug] ??= []).push(r);
      }
    }
  }
  return out;
}

const KIND_LABELS: Record<string, string> = {
  pc: 'PC',
  npc: 'NPC',
  ally: 'Ally',
  villain: 'Villain',
};
