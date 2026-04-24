'use client';

// Dispatcher: picks the right per-kind header for a note and renders
// nothing for kinds we don't handle (lore/session/note/etc).

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { normalizeKind } from './util';
import { CharacterHeader } from './CharacterHeader';
import { PersonHeader } from './PersonHeader';
import { CreatureHeader } from './CreatureHeader';
import { ItemHeader } from './ItemHeader';
import { LocationHeader } from './LocationHeader';

export function SheetHeader({
  rawKind,
  initialSheet,
  notePath,
  csrfToken,
  provider,
  canEdit,
  displayName,
  accentColor,
}: {
  rawKind: string | undefined;
  initialSheet: Record<string, unknown>;
  notePath: string;
  csrfToken: string;
  provider: HocuspocusProvider;
  canEdit: boolean;
  displayName: string;
  /** Per-world highlight colour. Exposed to every descendant via the
   *  `--world-accent` CSS variable so inline editors can pick it up
   *  for hover / focus underlines without prop-drilling. */
  accentColor: string | null;
}): React.JSX.Element | null {
  const kind = normalizeKind(rawKind);
  if (!kind) return null;

  const common = {
    initialSheet,
    notePath,
    csrfToken,
    provider,
    canEdit,
    displayName,
  };

  const inner = ((): React.JSX.Element => {
    switch (kind) {
      case 'character':
        return <CharacterHeader {...common} />;
      case 'person':
        return <PersonHeader {...common} />;
      case 'creature':
        return <CreatureHeader {...common} />;
      case 'item':
        return <ItemHeader {...common} />;
      case 'location':
        return <LocationHeader {...common} />;
    }
  })();

  // Fallback matches parchment ink-soft so notes without a custom world
  // colour still get a visible underline instead of nothing.
  const accent = accentColor ?? 'var(--ink-muted)';
  return (
    // `sheet-header` marker lets globals.css opt this subtree out of
    // the universal candlelight focus ring — inline editors draw their
    // own bottom stroke in --world-accent instead.
    <div
      className="sheet-header"
      style={{ '--world-accent': accent } as React.CSSProperties}
    >
      {inner}
    </div>
  );
}
