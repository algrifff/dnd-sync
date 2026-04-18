// Admin → Users. Create + revoke friend accounts.
// Layout at /admin already gated role=admin.

import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { readSession } from '@/lib/session';
import {
  DEFAULT_GROUP_ID,
  listUsersInGroup,
  type UserWithRole,
} from '@/lib/users';
import { SessionHeader } from '../../SessionHeader';
import { CreateUserForm } from './CreateUserForm';
import { RevokeButton } from './RevokeButton';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  // Layout already guarded; this is defence-in-depth for types.
  if (!session) throw new Error('missing session in admin users page');

  const users = listUsersInGroup(DEFAULT_GROUP_ID);

  return (
    <div className="min-h-screen bg-[#F4EDE0] text-[#2A241E]">
      <SessionHeader
        displayName={session.displayName}
        username={session.username}
        role={session.role}
        accentColor={session.accentColor}
      />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <div>
          <h1
            className="text-3xl font-bold text-[#2A241E]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            Users
          </h1>
          <p className="mt-1 text-sm text-[#5A4F42]">
            Create accounts for your players and DMs. Share the generated
            password out-of-band — it is displayed only once.
          </p>
        </div>

        <CreateUserForm />

        <UserTable users={users} currentUserId={session.userId} />
      </main>
    </div>
  );
}

function UserTable({
  users,
  currentUserId,
}: {
  users: UserWithRole[];
  currentUserId: string;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[#EAE1CF] text-xs uppercase tracking-wide text-[#5A4F42]">
          <tr>
            <th className="px-4 py-3">User</th>
            <th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3">Last login</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-[#5A4F42]">
                No users yet.
              </td>
            </tr>
          )}
          {users.map((u) => (
            <tr key={u.id} className="border-t border-[#D4C7AE]/50">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: u.accentColor }}
                  />
                  <span className="font-medium">{u.displayName}</span>
                  <span className="text-[#5A4F42]">({u.username})</span>
                </div>
              </td>
              <td className="px-4 py-3">
                <span className="rounded-full border border-[#D4C7AE] bg-[#F4EDE0] px-2 py-0.5 text-xs">
                  {u.role}
                </span>
              </td>
              <td className="px-4 py-3 text-[#5A4F42]">
                {new Date(u.createdAt).toISOString().slice(0, 10)}
              </td>
              <td className="px-4 py-3 text-[#5A4F42]">
                {u.lastLoginAt
                  ? new Date(u.lastLoginAt).toISOString().slice(0, 10)
                  : '—'}
              </td>
              <td className="px-4 py-3 text-right">
                {u.id === currentUserId ? (
                  <span className="text-xs text-[#5A4F42]">(you)</span>
                ) : (
                  <RevokeButton userId={u.id} username={u.username} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
