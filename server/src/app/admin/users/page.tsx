import type { ReactElement } from 'react';
import { listUsersInGroup, DEFAULT_GROUP_ID, type UserWithRole } from '@/lib/users';
import { CreateUserForm } from '@/app/settings/users/CreateUserForm';
import { RevokeButton } from '@/app/settings/users/RevokeButton';

export const dynamic = 'force-dynamic';

export default function AdminUsersPage(): ReactElement {
  const users = listUsersInGroup(DEFAULT_GROUP_ID);

  return (
    <div className="space-y-6">
      <p className="text-sm text-[#5A4F42]">
        Create accounts for your players and DMs. Share the generated
        password out-of-band — it is displayed only once.
      </p>

      <CreateUserForm />

      <UserTable users={users} />
    </div>
  );
}

function UserTable({ users }: { users: UserWithRole[] }): ReactElement {
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
                <RevokeButton userId={u.id} username={u.username} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
