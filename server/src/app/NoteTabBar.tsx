// Thin secondary bar sitting directly below the main AppHeader.
// Houses the open-note tab strip.

import type { ReactElement } from 'react';
import { NoteTabs } from './NoteTabs';

export function NoteTabBar({ groupId }: { groupId: string }): ReactElement {
  return (
    <div className="flex h-10 shrink-0 items-end gap-1 bg-[var(--parchment-sunk)]/60 pl-2 pr-3">
      {/* Keyed so a world switch remounts the strip with that world's
          tabs rather than handing the last world's list to its pruner. */}
      <NoteTabs key={groupId} groupId={groupId} />
    </div>
  );
}
