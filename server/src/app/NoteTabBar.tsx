// Thin secondary bar sitting directly below the main AppHeader.
// Houses the open-note tab strip and the new-tab button.

import type { ReactElement } from 'react';
import { NoteTabs } from './NoteTabs';
import { NewTabButton } from './NewTabButton';

export function NoteTabBar({
  canCreate,
  csrfToken,
}: {
  canCreate: boolean;
  csrfToken?: string;
}): ReactElement {
  return (
    <div className="flex h-10 shrink-0 items-end gap-1 bg-[#EAE1CF]/60 pl-2 pr-3">
      <NoteTabs />
      {canCreate && csrfToken && <NewTabButton csrfToken={csrfToken} />}
    </div>
  );
}
