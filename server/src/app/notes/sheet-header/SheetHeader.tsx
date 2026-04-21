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
}: {
  rawKind: string | undefined;
  initialSheet: Record<string, unknown>;
  notePath: string;
  csrfToken: string;
  provider: HocuspocusProvider;
  canEdit: boolean;
  displayName: string;
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
}
