// Dev-only inspector for the new D&D 5e data-model backbone. Lets you:
//   * See current rows in the new index tables (items, locations,
//     creatures) alongside the extended characters index.
//   * Feed arbitrary JSON into validateSheet() for each kind and see
//     the coerced/defaulted output or the Zod issues it rejects with.
//
// Admin-only. Intended to be removed (or gated behind a feature flag)
// once the canonical sheet UI lands.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getDb } from '@/lib/db';
import { listItems } from '@/lib/items';
import { listLocations } from '@/lib/locations';
import { listCreatures } from '@/lib/creatures';
import { listCharacters } from '@/lib/characters';
import { DataModelValidator } from './Validator';

export const dynamic = 'force-dynamic';

type CompendiumCountRow = { kind: string; n: number };

export default async function DataModelPlayground(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/dev/data-model');
  if (session.role !== 'admin' && session.role !== 'editor') {
    redirect('/settings/profile');
  }

  const groupId = session.currentGroupId;
  const items = listItems(groupId);
  const locations = listLocations(groupId);
  const creatures = listCreatures(groupId);
  const characters = listCharacters(groupId);

  const compendiumCounts = getDb()
    .query<CompendiumCountRow, []>(
      `SELECT kind, COUNT(*) AS n FROM compendium_entries GROUP BY kind ORDER BY kind`,
    )
    .all();

  return (
    <div className="min-h-screen bg-[#F4EDE0] px-6 py-8 text-[#2A241E]">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold">Data-model playground</h1>
          <p className="mt-1 text-sm text-[#5A4F42]">
            Read-only view of the new index tables + a live Zod validator.
            Scope: world <code className="font-mono">{groupId}</code>.
          </p>
        </header>

        <IndexTable
          title={`Characters (${characters.length})`}
          blurb="Rebuilt from note frontmatter on every save. New columns from v28: ac / hp_max / hp_current / proficiency_bonus."
          columns={['path', 'name', 'kind', 'level', 'class', 'ac', 'hp_max', 'hp_current']}
          rows={characters.map((c) => ({
            path: c.notePath,
            name: c.displayName,
            kind: c.kind,
            level: c.level ?? '—',
            class: c.class ?? '—',
            ac: c.ac ?? '—',
            hp_max: c.hpMax ?? '—',
            hp_current: c.hpCurrent ?? '—',
          }))}
          empty="No characters in this world yet. Create one from the sidebar."
        />

        <IndexTable
          title={`Items (${items.length})`}
          blurb="v25 — populated by deriveItemFromFrontmatter."
          columns={['path', 'name', 'category', 'rarity', 'attunement', 'weight', 'compendium_id']}
          rows={items.map((i) => ({
            path: i.notePath,
            name: i.name,
            category: i.category ?? '—',
            rarity: i.rarity ?? '—',
            attunement: i.attunement ? 'yes' : 'no',
            weight: i.weight ?? '—',
            compendium_id: i.compendiumId ?? '—',
          }))}
          empty="No items yet. Create a kind:item note to see a row here."
        />

        <IndexTable
          title={`Locations (${locations.length})`}
          blurb="v26 — populated by deriveLocationFromFrontmatter."
          columns={['path', 'name', 'type', 'region', 'parent_path']}
          rows={locations.map((l) => ({
            path: l.notePath,
            name: l.name,
            type: l.type ?? '—',
            region: l.region ?? '—',
            parent_path: l.parentPath ?? '—',
          }))}
          empty="No locations yet."
        />

        <IndexTable
          title={`Creatures (${creatures.length})`}
          blurb="v27 — captures kind:creature AND legacy kind:monster notes."
          columns={['path', 'name', 'type', 'size', 'cr', 'ac', 'hp_max']}
          rows={creatures.map((c) => ({
            path: c.notePath,
            name: c.name,
            type: c.type ?? '—',
            size: c.size ?? '—',
            cr: c.cr ?? '—',
            ac: c.ac ?? '—',
            hp_max: c.hpMax ?? '—',
          }))}
          empty="No creatures yet. Create a kind:creature note to see a row here."
        />

        <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
          <h2 className="text-lg font-semibold">Compendium entries</h2>
          <p className="mb-3 text-sm text-[#5A4F42]">
            v24 — global <code className="font-mono">compendium_entries</code> table (ruleset-scoped).
            {compendiumCounts.length === 0
              ? ' Empty — the seed loader is scaffolded but no entries are loaded yet.'
              : ''}
          </p>
          {compendiumCounts.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {compendiumCounts.map((c) => (
                <li key={c.kind}>
                  <code className="font-mono">{c.kind}</code> — {c.n}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <DataModelValidator csrfToken={session.csrfToken} />
      </div>
    </div>
  );
}

function IndexTable(props: {
  title: string;
  blurb: string;
  columns: string[];
  rows: Array<Record<string, string | number>>;
  empty: string;
}): ReactElement {
  return (
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="text-lg font-semibold">{props.title}</h2>
      <p className="mb-3 text-sm text-[#5A4F42]">{props.blurb}</p>
      {props.rows.length === 0 ? (
        <p className="text-sm italic text-[#8A7E6B]">{props.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#D4C7AE] text-xs uppercase tracking-wide text-[#5A4F42]">
                {props.columns.map((c) => (
                  <th key={c} className="px-2 py-1 font-semibold">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, i) => (
                <tr key={i} className="border-b border-[#EEE5D1] last:border-b-0">
                  {props.columns.map((c) => (
                    <td key={c} className="px-2 py-1 font-mono text-xs">
                      {String(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
