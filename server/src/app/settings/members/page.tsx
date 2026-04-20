import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listUsersInGroup, type UserWithRole } from '@/lib/users';

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
      <p className="text-sm text-[#5A4F42]">
        Everyone who belongs to this world, and their role within it. New
        members join via the invite link under the World tab.
      </p>

      <MemberTable members={members} currentUserId={session.userId} />
    </div>
  );
}

function MemberTable({
  members,
  currentUserId,
}: {
  members: UserWithRole[];
  currentUserId: string;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[#EAE1CF] text-xs uppercase tracking-wide text-[#5A4F42]">
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
              <td colSpan={4} className="px-4 py-6 text-center text-[#5A4F42]">
                No members in this world yet.
              </td>
            </tr>
          )}
          {members.map((m) => (
            <tr key={m.id} className="border-t border-[#D4C7AE]/50">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: m.accentColor }}
                  />
                  <span className="font-medium">{m.displayName}</span>
                  <span className="text-[#5A4F42]">({m.username})</span>
                  {m.id === currentUserId && (
                    <span className="text-xs text-[#5A4F42]">· you</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3">
                <span className="rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-xs">
                  {m.role}
                </span>
              </td>
              <td className="px-4 py-3 text-[#5A4F42]">
                {new Date(m.createdAt).toISOString().slice(0, 10)}
              </td>
              <td className="px-4 py-3 text-[#5A4F42]">
                {m.lastLoginAt
                  ? new Date(m.lastLoginAt).toISOString().slice(0, 10)
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
