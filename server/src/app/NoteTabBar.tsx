// Thin secondary bar sitting directly below the main AppHeader.
// Houses the open-note tab strip.

import type { ReactElement } from 'react';
import { NoteTabs } from './NoteTabs';

export function NoteTabBar(): ReactElement {
  return (
    <div className="flex h-10 shrink-0 items-end gap-1 bg-[#EAE1CF]/60 pl-2 pr-3">
      <NoteTabs />
    </div>
  );
}
