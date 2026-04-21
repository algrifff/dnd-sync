'use client';

// Client-side playground: pick a kind, load a canned sample or paste
// your own JSON, submit → POST /api/dev/validate-sheet → render the
// Zod result (defaults/coerced data, or the list of issues).

import { useState, type ReactElement } from 'react';

const KINDS = ['character', 'person', 'creature', 'item', 'location'] as const;
type Kind = (typeof KINDS)[number];

const SAMPLES: Record<Kind, unknown> = {
  character: {
    name: 'Mira Quickfoot',
    race: { ref: { name: 'Half-Elf' } },
    classes: [
      { ref: { name: 'Warlock' }, level: 3 },
      { ref: { name: 'Sorcerer' }, level: 2 },
    ],
    ability_scores: { str: 10, dex: 14, con: 12, int: 11, wis: 13, cha: 18 },
    armor_class: { value: 15 },
    hit_points: { max: 38, current: 38, temporary: 0 },
  },
  person: {
    name: 'Old Finnigan',
    tagline: 'Grizzled innkeeper of the Prancing Pony',
    location_path: 'Places/bree',
    disposition: 'friendly',
    tags: ['innkeeper', 'rumour-monger'],
  },
  creature: {
    name: 'Goblin Scout',
    size: 'small',
    type: 'humanoid',
    challenge_rating: 0.25,
    armor_class: { value: 15 },
    hit_points: { max: 7, current: 7, temporary: 0 },
    actions: [
      {
        name: 'Scimitar',
        description: 'Melee weapon attack.',
        attack_bonus: 4,
        damage_dice: { count: 1, sides: 6, mod: 2 },
        damage_type: 'slashing',
      },
    ],
    player_notes: 'Seen near the Goblin Cave. Vulnerable to radiant?',
  },
  item: {
    name: 'Flame Tongue',
    category: 'weapon',
    rarity: 'rare',
    weight: 3,
    requires_attunement: true,
    weapon: {
      category: 'martial',
      damage: { dice: { count: 1, sides: 8 }, type: 'slashing' },
      range: { normal: 5 },
      properties: ['versatile'],
    },
    modifiers: [
      { target: 'damage_bonus', op: '+', value: 2, when: 'attuned' },
    ],
    effects_notes: 'On command, the blade erupts in flame for +2d6 fire damage.',
  },
  location: {
    name: 'Waterdeep',
    type: 'city',
    region: 'Sword Coast',
    population: 'metropolis',
    notable_residents: [
      { to_path: 'People/laeral-silverhand', role: 'Open Lord' },
    ],
  },
};

const BAD_SAMPLE = {
  name: 'Bad',
  classes: [{ ref: { name: 'Fighter' }, level: 'banana' }],
};

type ValidateResult =
  | { ok: true; data: unknown }
  | { ok: false; issues: Array<{ path: string; message: string }> };

export function DataModelValidator({
  csrfToken,
}: {
  csrfToken: string;
}): ReactElement {
  const [kind, setKind] = useState<Kind>('character');
  const [input, setInput] = useState<string>(
    JSON.stringify(SAMPLES.character, null, 2),
  );
  const [result, setResult] = useState<ValidateResult | { error: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  function loadSample(k: Kind, bad = false): void {
    setKind(k);
    setInput(JSON.stringify(bad ? BAD_SAMPLE : SAMPLES[k], null, 2));
    setResult(null);
  }

  async function run(): Promise<void> {
    setBusy(true);
    setResult(null);
    let sheet: unknown;
    try {
      sheet = JSON.parse(input);
    } catch (err) {
      setResult({ error: `Invalid JSON: ${String(err)}` });
      setBusy(false);
      return;
    }
    try {
      const res = await fetch('/api/dev/validate-sheet', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ kind, sheet }),
      });
      const data = (await res.json()) as ValidateResult | { error: string };
      setResult(data);
    } catch (err) {
      setResult({ error: String(err) });
    }
    setBusy(false);
  }

  return (
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="text-lg font-semibold">Zod validator</h2>
      <p className="mb-3 text-sm text-[#5A4F42]">
        Feed JSON to{' '}
        <code className="font-mono">validateSheet(kind, sheet)</code>. Passing
        sheets echo the coerced data (with Zod defaults filled in); failing
        sheets return a list of issues.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-sm font-semibold">Kind:</label>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => loadSample(k)}
            className={`rounded border px-3 py-1 text-sm ${
              kind === k
                ? 'border-[#2A241E] bg-[#2A241E] text-[#FBF5E8]'
                : 'border-[#D4C7AE] bg-[#F4EDE0] text-[#2A241E] hover:bg-[#EAE1CF]'
            }`}
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          onClick={() => loadSample(kind, true)}
          className="ml-auto rounded border border-[#B46353] bg-[#FBF5E8] px-3 py-1 text-sm text-[#B46353] hover:bg-[#F4DAD2]"
        >
          Load a bad sample
        </button>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={14}
        className="w-full rounded border border-[#D4C7AE] bg-white p-3 font-mono text-xs"
        spellCheck={false}
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded bg-[#2A241E] px-4 py-2 text-sm font-semibold text-[#FBF5E8] disabled:opacity-50"
        >
          {busy ? 'Validating…' : 'Validate'}
        </button>
        <span className="text-xs text-[#5A4F42]">
          kind = <code className="font-mono">{kind}</code>
        </span>
      </div>

      {result ? (
        <div className="mt-4">
          {'error' in result ? (
            <div className="rounded border border-[#B46353] bg-[#F4DAD2] p-3 text-sm text-[#5A1E12]">
              {result.error}
            </div>
          ) : result.ok ? (
            <div>
              <div className="mb-2 text-sm font-semibold text-[#2F6A3D]">
                ✓ valid — coerced data:
              </div>
              <pre className="overflow-x-auto rounded bg-[#F4EDE0] p-3 font-mono text-xs">
                {JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          ) : (
            <div>
              <div className="mb-2 text-sm font-semibold text-[#B46353]">
                ✗ {result.issues.length} issue(s):
              </div>
              <ul className="space-y-1 rounded bg-[#F4DAD2] p-3 text-sm">
                {result.issues.map((iss, i) => (
                  <li key={i}>
                    <code className="font-mono text-xs">{iss.path || '<root>'}</code>{' '}
                    — {iss.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
