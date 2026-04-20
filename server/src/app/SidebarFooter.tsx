// Bottom of the left sidebar: signed-in identity + sign-out.

import type { ReactElement } from 'react';
import { logoutAction } from './login/actions';

export function SidebarFooter({
  username,
}: {
  username: string;
}): ReactElement {
  return (
    <div className="shrink-0 border-r border-t border-[#D4C7AE] bg-[#EAE1CF]/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-[#5A4F42]">@{username}</span>
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-[6px] border border-[#D4C7AE] bg-[#FBF5E8] px-2 py-1 text-xs text-[#5A4F42] transition hover:bg-[#F4EDE0] hover:text-[#2A241E]"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
