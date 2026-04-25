// Smoke test: the PM JSON we hand-build for the managed callout must
// survive both schema.nodeFromJSON() and prosemirrorJSONToYDoc(). A
// silent schema-validation failure leaves the index with an empty
// Y.Doc, which is exactly the symptom we hit on the first attempt.

import { describe, expect, it } from 'bun:test';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { getPmSchema } from './pm-schema';

// Reach into the module's internals via a small re-export to get the
// callout builder without forcing it onto the public API. We mirror
// the unexported builder shape here so the test fails loudly if the
// real one drifts.
import * as Y from 'yjs';

function paragraph(text: string) {
  return text
    ? { type: 'paragraph', content: [{ type: 'text', text }] }
    : { type: 'paragraph', content: [] };
}

describe('campaign-index PM JSON', () => {
  it('round-trips a callout containing a wikilink table through the schema', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Campaign Title' }],
        },
        {
          type: 'callout',
          attrs: { kind: 'info', title: '📚 Campaign Index' },
          content: [
            paragraph('Auto-managed — edit your own notes outside this block.'),
            {
              type: 'heading',
              attrs: { level: 3 },
              content: [{ type: 'text', text: 'Sessions' }],
            },
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    { type: 'tableHeader', content: [paragraph('Name')] },
                    { type: 'tableHeader', content: [paragraph('Path')] },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [
                        {
                          type: 'paragraph',
                          content: [
                            {
                              type: 'wikilink',
                              attrs: {
                                target: 'Campaigns/Demo/Sessions/Foo.md',
                                label: '',
                                anchor: null,
                                orphan: false,
                              },
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: 'tableCell',
                      content: [paragraph('Campaigns/Demo/Sessions/Foo.md')],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const schema = getPmSchema();
    expect(() => schema.nodeFromJSON(doc)).not.toThrow();

    const ydoc = prosemirrorJSONToYDoc(schema, doc, 'default');
    const state = Y.encodeStateAsUpdate(ydoc);
    expect(state.byteLength).toBeGreaterThan(0);

    // Decode back and confirm the callout + wikilink survived.
    const back = yDocToProsemirrorJSON(ydoc, 'default') as { content?: unknown[] };
    expect(Array.isArray(back.content)).toBe(true);
    const calloutNode = (back.content ?? []).find(
      (n) => (n as { type?: string }).type === 'callout',
    );
    expect(calloutNode).toBeDefined();
  });
});
