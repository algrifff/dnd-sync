'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { UserRole } from '@/lib/session';

const ROLES: UserRole[] = ['admin', 'editor', 'viewer'];

export function MemberRoleSelect({
  groupId,
  userId,
  initialRole,
  csrfToken,
  disabled,
  disabledReason,
}: {
  groupId: string;
  userId: string;
  initialRole: UserRole;
  csrfToken: string;
  disabled?: boolean;
  disabledReason?: string;
}): React.ReactElement {
  const [role, setRole] = useState<UserRole>(initialRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (disabled) {
    return (
      <span
        title={disabledReason}
        className="rounded-full border border-[var(--rule)] bg-[var(--parchment)] px-2 py-0.5 text-xs"
      >
        {role}
      </span>
    );
  }

  async function onChange(next: UserRole): Promise<void> {
    const previous = role;
    setRole(next);
    setError(null);
    try {
      const res = await fetch(`/api/worlds/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ role: next }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = payload?.error ?? 'update_failed';
        setError(
          code === 'would_orphan_admin'
            ? 'Cannot demote the last admin.'
            : code === 'self_demote'
              ? 'Transfer ownership before changing your own role.'
              : 'Could not update role.',
        );
        setRole(previous);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Could not update role.');
      setRole(previous);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={role}
        disabled={pending}
        onChange={(e) => void onChange(e.target.value as UserRole)}
        className="rounded-full border border-[var(--rule)] bg-[var(--parchment)] px-2 py-0.5 text-xs capitalize disabled:opacity-60"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-[var(--wine)]">{error}</span>}
    </div>
  );
}
