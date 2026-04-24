'use client';

import { useTransition } from 'react';
import { revokeUserAction } from './actions';

export function RevokeButton({
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
        if (!confirm(`Revoke ${username}? They'll be signed out immediately.`)) return;
        startTransition(async () => {
          const res = await revokeUserAction(userId);
          if (!res.ok) alert(res.error ?? 'revoke failed');
        });
      }}
      className="rounded-[6px] border border-[var(--wine)]/40 px-2 py-1 text-xs text-[var(--wine)] hover:bg-[var(--wine)]/10 disabled:opacity-60"
    >
      {pending ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
