// Benchmarks the header search query against a seeded multi-world vault.
// Usage: bun scripts/bench-search.ts [notesPerWorld=3000] [worlds=3]

import { randomUUID } from 'node:crypto';
import { getDb } from '../src/lib/db';
import { setupTestDb, teardownTestDb } from '../src/lib/test-utils';
import { searchWorld } from '../src/lib/search';

const NOTES_PER_WORLD = Number(process.argv[2] ?? 3000);
const WORLDS = Number(process.argv[3] ?? 3);
const RUNS = 30;

const WORDS = (
  'the a of and to in that it was he she they party tavern sword shadow ancient ' +
  'dragon goblin forest river king queen castle temple ruin gold silver blade ' +
  'spell wizard rogue cleric ranger paladin bard druid monk warlock sorcerer ' +
  'night storm mountain village harbour ship captain merchant thief guard ' +
  'whisper curse oath vow blood moon sun star fire ice stone iron oak raven'
).split(' ');
const NAMES = [
  'Gandrel', 'Aldric', 'Seraphine', 'Thornwick', 'Mirabel', 'Corvin', 'Ysolde',
  'Brannoc', 'Elowen', 'Kaelith', 'Varric', 'Dunmore', 'Ashgrove', 'Saltmere',
];
const KINDS = ['Characters', 'People', 'Locations', 'Items', 'Lore', 'Sessions'];

let seed = 42;
function rand(n: number): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
}

function prose(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(rand(25) === 0 ? NAMES[rand(NAMES.length)]! : WORDS[rand(WORDS.length)]!);
  }
  return out.join(' ');
}

function seedVault(): string[] {
  const db = getDb();
  const groups: string[] = [];
  const insertGroup = db.query(`INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)`);
  const insertNote = db.query(
    `INSERT INTO notes (id, group_id, path, title, content_json, content_text, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?)`,
  );
  const insertAsset = db.query(
    `INSERT INTO assets (id, group_id, hash, mime, size, original_name, uploaded_at)
     VALUES (?, ?, ?, 'image/png', 10, ?, ?)`,
  );
  for (let w = 0; w < WORLDS; w++) {
    const gid = `world-${w}`;
    groups.push(gid);
    insertGroup.run(gid, gid, Date.now());
    db.transaction(() => {
      for (let i = 0; i < NOTES_PER_WORLD; i++) {
        const kind = KINDS[i % KINDS.length]!;
        const name = `${NAMES[i % NAMES.length]} ${WORDS[rand(WORDS.length)]} ${i}`;
        insertNote.run(randomUUID(), gid, `Campaign/${kind}/${name}.md`, name, prose(200 + rand(800)), Date.now());
      }
      for (let i = 0; i < 300; i++) {
        insertAsset.run(randomUUID(), gid, `${gid}-${i}`, `${NAMES[i % NAMES.length]}-map-${i}.png`, Date.now());
      }
    })();
  }
  return groups;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

setupTestDb();
const groups = seedVault();
const gid = groups[1]!;
const queries = ['g', 'ga', 'gan', 'gand', 'gandrel', 's', 'the', 'dragon', 'salt', 'ashgrove 12'];

console.log(`notes/world=${NOTES_PER_WORLD} worlds=${WORLDS} runs=${RUNS}`);
console.log('query\tmedian_ms\tp95_ms\thits\ttop3');
let total = 0;
for (const q of queries) {
  const times: number[] = [];
  let hits: { title: string }[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    hits = searchWorld({ q, groupId: gid, role: 'admin', gmMode: false }).filter(
      (r): r is Extract<typeof r, { kind: 'note' }> => r.kind === 'note',
    );
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const med = median(times);
  total += med;
  console.log(
    `${JSON.stringify(q)}\t${med.toFixed(2)}\t${sorted[Math.floor(RUNS * 0.95)]!.toFixed(2)}\t${hits.length}\t${hits.slice(0, 3).map((h) => h.title).join(' | ')}`,
  );
}
console.log(`sum_of_medians_ms\t${total.toFixed(2)}`);

// One note save: the notes_au trigger reindexes that note in notes_fts.
const savePaths = getDb()
  .query<{ path: string }, [string]>('SELECT path FROM notes WHERE group_id = ? LIMIT 200')
  .all(gid)
  .map((r) => r.path);
const save = getDb().query<unknown, [string, string, string]>(
  'UPDATE notes SET content_text = ? WHERE group_id = ? AND path = ?',
);
const saves = savePaths.map((path, i) => {
  const t0 = performance.now();
  save.run(`edited body ${i}`, gid, path);
  return performance.now() - t0;
});
console.log(`note_save_median_ms\t${median(saves).toFixed(2)}`);
teardownTestDb();
