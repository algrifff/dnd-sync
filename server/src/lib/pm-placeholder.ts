// Tiptap extension that decorates the focused empty paragraph with a
// ghost "Type '/' for commands, or start typing…" hint, Notion-style.
// Implemented as a small ProseMirror plugin so we don't take another
// dep. The hint itself is injected via CSS `content: attr(...)` so the
// string lives in one place.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const PLACEHOLDER_TEXT = "Type '/' for commands, or start typing…";

export const Placeholder = Extension.create({
  name: 'placeholder',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('placeholder'),
        props: {
          decorations(state) {
            const { doc, selection } = state;
            const decos: Decoration[] = [];
            doc.descendants((node, pos) => {
              if (
                node.type.name === 'paragraph' &&
                node.childCount === 0 &&
                selection.from >= pos &&
                selection.to <= pos + node.nodeSize
              ) {
                decos.push(
                  Decoration.node(pos, pos + node.nodeSize, {
                    class: 'is-empty',
                    'data-placeholder': PLACEHOLDER_TEXT,
                  }),
                );
              }
              // Continue walking; we want block children of block nodes too.
              return true;
            });
            return DecorationSet.create(doc, decos);
          },
        },
      }),
    ];
  },
});
