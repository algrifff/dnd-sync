import { describe, expect, it } from 'bun:test';
import { ingestMarkdown, type IngestContext, type PmNode } from './md-to-pm';
import { pmToMarkdown } from './pm-to-md';

const EMPTY_CTX: IngestContext = {
  allPaths: new Set(),
  aliasMap: new Map(),
  assetsByName: new Map(),
};

function ctxWith(overrides: Partial<IngestContext>): IngestContext {
  return {
    allPaths: overrides.allPaths ?? new Set(),
    aliasMap: overrides.aliasMap ?? new Map(),
    assetsByName: overrides.assetsByName ?? new Map(),
  };
}

function ingest(md: string, ctx: IngestContext = EMPTY_CTX) {
  return ingestMarkdown('note.md', md, ctx);
}

describe('ingestMarkdown — node coverage', () => {
  it('extracts H1 as title, falls back to filename', () => {
    expect(ingest('# Hello\nbody').title).toBe('Hello');
    expect(ingestMarkdown('foo/bar.md', 'no heading', EMPTY_CTX).title).toBe('bar');
  });

  it('parses YAML frontmatter + aliases + tags', () => {
    const md = `---\nname: Atoxis\naliases: [Demon Prince, BBEG]\ntags: [villain, bbeg]\n---\n\n# Atoxis`;
    const res = ingest(md);
    expect(res.aliases).toEqual(['Demon Prince', 'BBEG']);
    expect(res.tags.sort()).toEqual(['bbeg', 'villain']);
  });

  it('emits heading + paragraph + bold/italic/code marks', () => {
    const md = '# T\n\nSome **bold** and *italic* and `code` inline.';
    const doc = ingest(md).contentJson;
    expect(doc.content?.[0]?.type).toBe('heading');
    const para = doc.content?.[1];
    expect(para?.type).toBe('paragraph');
    const marks = para?.content?.flatMap((c) => c.marks ?? []).map((m) => m.type) ?? [];
    expect(marks).toContain('bold');
    expect(marks).toContain('italic');
    expect(marks).toContain('code');
  });

  it('splits [[wikilink|label]] into a wikilink node and resolves the target', () => {
    const ctx = ctxWith({ allPaths: new Set(['NPCs/Villains/Atoxis.md']) });
    const para = ingest('Meet [[Atoxis|the demon]].', ctx).contentJson.content?.[0];
    const link = para?.content?.find((c) => c.type === 'wikilink');
    expect(link).toBeDefined();
    expect(link?.attrs?.target).toBe('NPCs/Villains/Atoxis.md');
    expect(link?.attrs?.label).toBe('the demon');
    expect(link?.attrs?.orphan).toBe(false);
  });

  it('marks unresolved wikilinks as orphan', () => {
    const link = ingest('See [[NoSuch]].').contentJson.content?.[0]?.content?.find(
      (c) => c.type === 'wikilink',
    );
    expect(link?.attrs?.orphan).toBe(true);
    expect(link?.attrs?.target).toBe('NoSuch');
  });

  it('resolves wikilinks via the alias map', () => {
    const ctx = ctxWith({
      allPaths: new Set(['NPCs/Villains/Atoxis.md']),
      aliasMap: new Map([['demon prince', 'NPCs/Villains/Atoxis.md']]),
    });
    const link = ingest('A [[Demon Prince]].', ctx).contentJson.content?.[0]?.content?.find(
      (c) => c.type === 'wikilink',
    );
    expect(link?.attrs?.target).toBe('NPCs/Villains/Atoxis.md');
  });

  it('lifts ![[asset]] to a block-level embed when alone', () => {
    const ctx = ctxWith({
      assetsByName: new Map([['token.png', { id: 'asset-1', mime: 'image/png' }]]),
    });
    const docContent = ingest('![[token.png]]', ctx).contentJson.content ?? [];
    expect(docContent[0]?.type).toBe('embed');
    expect(docContent[0]?.attrs?.assetId).toBe('asset-1');
    expect(docContent[0]?.attrs?.mime).toBe('image/png');
  });

  it('detects Obsidian callouts', () => {
    const md = '> [!danger] Title\n> body text';
    const block = ingest(md).contentJson.content?.[0];
    expect(block?.type).toBe('callout');
    expect(block?.attrs?.kind).toBe('danger');
    expect(block?.attrs?.title).toBe('Title');
  });

  it('produces a taskList for `- [x]` list items', () => {
    const doc = ingest('- [ ] todo one\n- [x] done').contentJson;
    const list = doc.content?.[0];
    expect(list?.type).toBe('taskList');
    expect(list?.content?.[0]?.attrs?.checked).toBe(false);
    expect(list?.content?.[1]?.attrs?.checked).toBe(true);
  });

  it('collects tags from both frontmatter and inline #text', () => {
    const ctx = ctxWith({});
    const res = ingest('---\ntags: [villain]\n---\n\n#bbeg and #demon are bad.', ctx);
    const tags = [...res.tags].sort();
    expect(tags).toEqual(['bbeg', 'demon', 'villain']);
  });

  it('highlights with == wrap', () => {
    const para = ingest('see ==important== bit').contentJson.content?.[0];
    const hl = para?.content?.find((c) => c.marks?.some((m) => m.type === 'highlight'));
    expect(hl?.text).toBe('important');
  });

  it('emits tables as table/row/header/cell nesting', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const table = ingest(md).contentJson.content?.[0];
    expect(table?.type).toBe('table');
    expect(table?.content?.[0]?.type).toBe('tableRow');
    expect(table?.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
    expect(table?.content?.[1]?.content?.[0]?.type).toBe('tableCell');
  });

  it('strips YAML frontmatter from the rendered body', () => {
    const doc = ingest('---\nname: X\n---\n\n# After').contentJson;
    expect(doc.content?.[0]?.type).toBe('heading');
    expect((doc.content?.[0]?.content?.[0]?.text ?? '').trim()).toBe('After');
  });
});

describe('md round-trip fidelity', () => {
  const cases: Array<{ name: string; md: string; ctx?: IngestContext }> = [
    { name: 'plain paragraph', md: '# Title\n\nHello world.' },
    { name: 'emphasis + bold', md: 'Some **bold** and *em*.' },
    {
      name: 'bullet list',
      md: '- one\n- two\n- three',
    },
    {
      name: 'ordered list',
      md: '1. first\n2. second',
    },
    {
      name: 'task list',
      md: '- [ ] open\n- [x] done',
    },
    {
      name: 'inline code',
      md: 'Use `code` for fun.',
    },
    {
      name: 'code block',
      md: '```ts\nconst x = 1;\n```',
    },
    {
      name: 'table',
      md: '| A | B |\n| --- | --- |\n| 1 | 2 |',
    },
    {
      name: 'wikilink with label',
      md: 'See [[Atoxis|the demon]].',
      ctx: ctxWith({ allPaths: new Set(['NPCs/Villains/Atoxis.md']) }),
    },
    {
      name: 'tag mention',
      md: 'A #villain plotting.',
    },
    {
      name: 'callout',
      md: '> [!note] Title\n> body',
    },
    {
      name: 'embed',
      md: '![[token.png]]',
      ctx: ctxWith({
        assetsByName: new Map([['token.png', { id: 'asset-1', mime: 'image/png' }]]),
      }),
    },
  ];

  for (const c of cases) {
    it(`stable: ${c.name}`, () => {
      const ctx = c.ctx ?? EMPTY_CTX;
      const first = ingest(c.md, ctx);
      const regenerated = pmToMarkdown(first.contentJson);
      const second = ingest(regenerated, ctx);
      expect(shape(second.contentJson)).toEqual(shape(first.contentJson));
    });
  }
});

// Strip `originalName` from embed/embedNote before comparing — the
// serialiser drops to the assetId when originalName isn't present, so
// the round-trip erases that field (a harmless loss).
function shape(node: PmNode): PmNode {
  const { type, attrs, content, text, marks } = node;
  const shaped: PmNode = { type };
  if (attrs) {
    const copy: Record<string, unknown> = { ...attrs };
    if (type === 'embed') delete copy.originalName;
    if (Object.keys(copy).length > 0) shaped.attrs = copy;
  }
  if (content) shaped.content = content.map(shape);
  if (text !== undefined) shaped.text = text;
  if (marks && marks.length > 0) {
    shaped.marks = marks.map((m) => ({
      type: m.type,
      ...(m.attrs ? { attrs: m.attrs } : {}),
    }));
  }
  return shaped;
}
