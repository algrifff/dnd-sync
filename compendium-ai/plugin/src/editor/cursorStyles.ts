// y-codemirror.next renders each remote user's name as a small label on the
// caret, but hides it unless you hover over the cursor. This injects a small
// CSS override that keeps the label visible permanently.

const STYLE_ID = 'compendium-cursor-styles';

const CSS = `
/* Always show the name tag on remote carets, not just on hover. */
.cm-ySelectionInfo {
  opacity: 1 !important;
  transition-delay: 0s !important;
  transform: translateY(-1.25em) !important;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.7em;
  font-weight: 600;
  line-height: 1.1;
  white-space: nowrap;
  pointer-events: none;
  /* Background is set inline by y-codemirror.next from awareness.user.color */
}

/* Slightly thicker caret for visibility over code fonts. */
.cm-ySelectionCaret {
  width: 2px !important;
}
`;

export function injectCursorStyles(): () => void {
  if (document.getElementById(STYLE_ID)) {
    // Already injected (e.g. by a previous plugin load this session).
    return () => {
      document.getElementById(STYLE_ID)?.remove();
    };
  }
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
  return () => el.remove();
}
