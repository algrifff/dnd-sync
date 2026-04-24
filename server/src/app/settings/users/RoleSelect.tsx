'use client';

import { useState, useTransition } from 'react';
import type { UserRole } from '@/lib/session';
import { setUserRoleAction } from './actions';

const ROLES: UserRole[] = ['admin', 'editor', 'viewer'];

export function RoleSelect({
  userId,
  initialRole,
}: {
  userId: string;
  initialRole: UserRole;
}): React.ReactElement {
  const [role, setRole] = useState<UserRole>(initialRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onChange(next: UserRole): void {
    const previous = role;
    setRole(next);
    setError(null);
    startTransition(async () => {
      const result = await setUserRoleAction(userId, next);
      if (!result.ok) {
        setRole(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={role}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as UserRole)}
        className="rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-xs capitalize disabled:opacity-60"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-[#8B4A52]">{error}</span>}
    </div>
  );
}
