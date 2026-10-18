// Wikilink, embed and tag extraction from a ProseMirror doc: the note-save
// derive step and lib/relations.ts read links the same way.

import type { PmNode } from '@/lib/md-to-pm';

/** The wikilink / embed targets and inline tags of a ProseMirror doc. */
export function collectLinksAndTags(doc: PmNode): { wikilinks: string[]; tags: string[] } {
  const links = new Set<string>();
  const tags = new Set<string>();
  walk(doc);
  return { wikilinks: [...links], tags: [...tags] };

  function walk(n: PmNode): void {
    if (n.type === 'wikilink') {
      const target = String(n.attrs?.target ?? '');
      const orphan = Boolean(n.attrs?.orphan);
      links.add(orphan ? `__orphan__:${target}` : target);
    } else if (n.type === 'embedNote') {
      const target = String(n.attrs?.target ?? '');
      if (target) links.add(target);
    } else if (n.type === 'tagMention') {
      const t = String(n.attrs?.tag ?? '').toLowerCase();
      if (t) tags.add(t);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  }
}
