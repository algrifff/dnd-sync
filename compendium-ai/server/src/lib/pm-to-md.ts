// ProseMirror JSON → Markdown serializer. The inverse of md-to-pm for
// canonical content. Used to:
//   - populate notes.content_md (FTS cache + Obsidian export)
//   - verify round-trip fidelity (md → PM → md → PM; the two PM JSONs
//     must match exactly)
//
// Pure module — no I/O.

import type { PmNode } from './md-to-pm';

type Mark = { type: string; attrs?: Record<string, unknown> };

export function pmToMarkdown(doc: PmNode, frontmatter?: Record<string, unknown>): string {
  const body = serialiseBlocks(doc.content ?? [], 0);
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  return `---\n${frontmatterYaml(frontmatter)}---\n\n${body}`;
}

function frontmatterYaml(data: Record<string, unknown>): string {
  // Stable, readable YAML for arrays of strings — matches Obsidian's
  // usual shape (`tags: [a, b]`). Fall back to JSON for anything exotic.
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    lines.push(renderYamlKey(key, raw));
  }
  return lines.join('\n') + '\n';
}

function renderYamlKey(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`;
  if (typeof value === 'string') return `${key}: ${yamlScalar(value)}`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    const scalars = value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
    if (scalars && value.length <= 6) return `${key}: [${value.map((v) => yamlScalar(String(v))).join(', ')}]`;
    return `${key}:\n` + value.map((v) => `  - ${yamlScalar(String(v))}`).join('\n');
  }
  // Objects and anything else — JSON-as-flow; round-trip safe via yaml lib.
  return `${key}: ${JSON.stringify(value)}`;
}

function yamlScalar(s: string): string {
  if (s === '') return '""';
  if (/^[\w./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

// ── Block serialisation ────────────────────────────────────────────────

function serialiseBlocks(nodes: PmNode[], depth: number): string {
  const chunks: string[] = [];
  for (const n of nodes) {
    const out = serialiseBlock(n, depth);
    if (out.length > 0) chunks.push(out);
  }
  return chunks.join('\n\n').trim() + '\n';
}

function serialiseBlock(n: PmNode, depth: number): string {
  switch (n.type) {
    case 'doc':
      return serialiseBlocks(n.content ?? [], depth).trimEnd();
    case 'paragraph':
      return serialiseInline(n.content ?? []);
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(n.attrs?.level ?? 1)));
      return '#'.repeat(level) + ' ' + serialiseInline(n.content ?? []);
    }
    case 'blockquote':
      return prefixLines(serialiseBlocks(n.content ?? [], depth).trimEnd(), '> ');
    case 'bulletList':
    case 'orderedList':
      return serialiseList(n, depth);
    case 'listItem':
      return serialiseBlocks(n.content ?? [], depth).trimEnd();
    case 'taskList':
      return serialiseList(n, depth);
    case 'taskItem':
      return serialiseBlocks(n.content ?? [], depth).trimEnd();
    case 'codeBlock': {
      const lang = (n.attrs?.language as string | null) ?? '';
      const text = (n.content ?? []).map((c) => c.text ?? '').join('');
      return '```' + lang + '\n' + text + '\n```';
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return serialiseTable(n);
    case 'image': {
      const alt = String(n.attrs?.alt ?? '');
      const src = String(n.attrs?.src ?? '');
      const title = n.attrs?.title ? ` "${String(n.attrs.title)}"` : '';
      return `![${alt}](${src}${title})`;
    }
    case 'embed': {
      const original = String(n.attrs?.originalName ?? '');
      const caption = n.attrs?.caption ? String(n.attrs.caption) : '';
      if (original) return `![[${original}${caption ? '|' + caption : ''}]]`;
      return `![[${String(n.attrs?.assetId ?? '')}${caption ? '|' + caption : ''}]]`;
    }
    case 'embedNote': {
      const target = String(n.attrs?.target ?? '');
      const label = String(n.attrs?.label ?? '');
      return `![[${target}${label && label !== target ? '|' + label : ''}]]`;
    }
    case 'callout': {
      const kind = String(n.attrs?.kind ?? 'note');
      const title = n.attrs?.title ? String(n.attrs.title) : '';
      const body = serialiseBlocks(n.content ?? [], depth).trimEnd();
      const head = `[!${kind}]${title ? ' ' + title : ''}`;
      const lines = body.length > 0 ? head + '\n' + body : head;
      return prefixLines(lines, '> ');
    }
    default:
      if (n.content) return serialiseBlocks(n.content, depth);
      return n.text ?? '';
  }
}

function serialiseList(list: PmNode, depth: number): string {
  const isTask = list.type === 'taskList';
  const ordered = list.type === 'orderedList';
  const start = Number(list.attrs?.start ?? 1);
  const items = list.content ?? [];
  const indent = '  '.repeat(depth);

  return items
    .map((item, i) => {
      const checked = isTask ? (item.attrs?.checked === true ? '[x] ' : '[ ] ') : '';
      const marker = isTask ? '- ' + checked : ordered ? `${start + i}. ` : '- ';

      // Walk the item's children. Inline content on first line; nested
      // blocks (lists, code) hang off the following lines indented.
      const children = item.content ?? [];
      const firstBlock = children[0];
      let leading = '';
      let rest: PmNode[] = [];
      if (firstBlock && firstBlock.type === 'paragraph') {
        leading = serialiseInline(firstBlock.content ?? []);
        rest = children.slice(1);
      } else {
        rest = children;
      }

      const body = rest
        .map((child) => {
          const out = serialiseBlock(child, depth + 1);
          return out
            .split('\n')
            .map((ln) => (ln.length ? '  ' + ln : ln))
            .join('\n');
        })
        .join('\n\n');

      const head = indent + marker + leading;
      return body.length ? head + '\n' + body : head;
    })
    .join('\n');
}

function serialiseTable(t: PmNode): string {
  const rows = t.content ?? [];
  if (rows.length === 0) return '';
  const serialiseRow = (row: PmNode): string[] =>
    (row.content ?? []).map((cell) => {
      const para = (cell.content ?? [])[0];
      const inline = para ? serialiseInline(para.content ?? []) : '';
      return inline.replace(/\|/g, '\\|').trim();
    });

  const header = serialiseRow(rows[0]!);
  const body = rows.slice(1).map(serialiseRow);
  const divider = header.map(() => '---');
  const widths = header.map((_, i) =>
    Math.max(3, header[i]!.length, ...body.map((r) => (r[i] ?? '').length)),
  );

  const renderRow = (cells: string[]): string =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join(' | ') + ' |';

  return [
    renderRow(header),
    renderRow(divider.map((d, i) => d.padEnd(widths[i] ?? 3, '-'))),
    ...body.map(renderRow),
  ].join('\n');
}

// ── Inline serialisation ──────────────────────────────────────────────

function serialiseInline(nodes: PmNode[]): string {
  return nodes.map((n) => serialiseOneInline(n)).join('');
}

function serialiseOneInline(n: PmNode): string {
  if (n.type === 'text') return applyMarks(n.text ?? '', n.marks ?? []);
  if (n.type === 'hardBreak') return '  \n';
  if (n.type === 'wikilink') {
    const target = String(n.attrs?.target ?? '');
    const label = String(n.attrs?.label ?? '');
    const anchor = n.attrs?.anchor ? '^' + String(n.attrs.anchor) : '';
    const inner = target + anchor;
    if (label && label !== labelFromTarget(target)) return `[[${inner}|${label}]]`;
    return `[[${inner}]]`;
  }
  if (n.type === 'tagMention') {
    return '#' + String(n.attrs?.tag ?? '');
  }
  if (n.type === 'image') {
    const alt = String(n.attrs?.alt ?? '');
    const src = String(n.attrs?.src ?? '');
    return `![${alt}](${src})`;
  }
  if (n.type === 'embed' || n.type === 'embedNote') {
    // Rare inline usage — fall through to block serialisation output.
    return serialiseBlock(n, 0);
  }
  return n.text ?? '';
}

function applyMarks(text: string, marks: Mark[]): string {
  let out = text;
  // Inner-first wrapping so outermost marks come out outside.
  const order = ['code', 'italic', 'bold', 'strike', 'highlight', 'underline', 'link'];
  const sorted = [...marks].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  for (const m of sorted) {
    out = wrapMark(out, m);
  }
  return out;
}

function wrapMark(text: string, m: Mark): string {
  switch (m.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'code':
      return `\`${text}\``;
    case 'strike':
      return `~~${text}~~`;
    case 'highlight':
      return `==${text}==`;
    case 'underline':
      return `<u>${text}</u>`;
    case 'link': {
      const href = String(m.attrs?.href ?? '');
      const title = m.attrs?.title ? ` "${String(m.attrs.title)}"` : '';
      return `[${text}](${href}${title})`;
    }
    default:
      return text;
  }
}

function prefixLines(text: string, prefix: string): string {
  return text.split('\n').map((ln) => (ln.length ? prefix + ln : prefix.trimEnd())).join('\n');
}

function labelFromTarget(t: string): string {
  const last = t.split('/').pop() ?? t;
  return last.replace(/\.(md|canvas)$/i, '');
}
