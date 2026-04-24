import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listUsersInGroup, type UserWithRole } from '@/lib/users';
import { MemberRoleSelect } from './MemberRoleSelect';

export const dynamic = 'force-dynamic';

export default async function WorldMembersPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings/members');
  if (session.role !== 'admin') redirect('/settings/profile');

  const members = listUsersInGroup(session.currentGroupId);

  return (
    <div className="space-y-6">
      <p className="text-sm text-[var(--ink-soft)]">
        Everyone who belongs to this world, and their role within it. New members join via the
        invite link under the World tab. Demote a member to <em>viewer</em> to make them
        read-only; promote back to <em>editor</em> to restore editing.
      </p>
      <MemberTable
        members={members}
        currentUserId={session.userId}
        groupId={session.currentGroupId}
        csrfToken={session.csrfToken}
      />
    </div>
  );
}

function MemberTable({
  members,
  currentUserId,
  groupId,
  csrfToken,
}: {
  members: UserWithRole[];
  currentUserId: string;
  groupId: string;
  csrfToken: string;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--parchment-sunk)] text-xs uppercase tracking-wide text-[var(--ink-soft)]">
          <tr>
            <th className="px-4 py-3">Member</th>
            <th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Joined</th>
            <th className="px-4 py-3">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-[var(--ink-soft)]">
                No members in this world yet.
              </td>
            </tr>
          )}
          {members.map((m) => (
            <tr key={m.id} className="border-t border-[var(--rule)]/50">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: m.accentColor }}
                  />
                  <span className="font-medium">{m.displayName}</span>
                  <span className="text-[var(--ink-soft)]">({m.username})</span>
                  {m.id === currentUserId && <span className="text-xs text-[var(--ink-soft)]">· you</span>}
                </div>
              </td>
              <td className="px-4 py-3">
                <MemberRoleSelect
                  groupId={groupId}
                  userId={m.id}
                  initialRole={m.role}
                  csrfToken={csrfToken}
                  {...(m.id === currentUserId
                    ? { disabled: true, disabledReason: 'Transfer world ownership to change your own role.' }
                    : {})}
                />
              </td>
              <td className="px-4 py-3 text-[var(--ink-soft)]">
                {new Date(m.createdAt).toISOString().slice(0, 10)}
              </td>
              <td className="px-4 py-3 text-[var(--ink-soft)]">
                {m.lastLoginAt ? new Date(m.lastLoginAt).toISOString().slice(0, 10) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
