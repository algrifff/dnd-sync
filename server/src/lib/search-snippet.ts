// Wrap each highlighted span in a search snippet. The client splits on
// these and renders text nodes, never HTML. A stray marker in note text
// only misplaces a highlight.
export const SNIPPET_MARK_OPEN = '\u0002';
export const SNIPPET_MARK_CLOSE = '\u0003';
