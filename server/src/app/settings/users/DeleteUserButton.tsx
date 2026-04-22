'use client';

import { useTransition } from 'react';
import { deleteUserWithContentAction } from './actions';

export function DeleteUserButton({
  userId,
  username,
}: {
  userId: string;
  username: string;
}): React.JSX.Element {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (
          !confirm(
            `Delete "${username}" and all worlds they solely admin?\n\nThis deletes their notes, assets, and any worlds where they are the only admin. This cannot be undone.`,
          )
        )
          return;
        startTransition(async () => {
          const res = await deleteUserWithContentAction(userId);
          if (!res.ok) alert(res.error ?? 'delete failed');
        });
      }}
      className="rounded-[6px] border border-[#8B4A52]/40 px-2 py-1 text-xs text-[#8B4A52] hover:bg-[#8B4A52]/10 disabled:opacity-60"
    >
      {pending ? 'Deleting…' : 'Delete + content'}
    </button>
  );
}
