import type { ReactElement } from 'react';
import { listUsersInGroup, getUserStorageStats, DEFAULT_GROUP_ID, type UserWithRole, type UserStorageStats } from '@/lib/users';
import { CreateUserForm } from '@/app/settings/users/CreateUserForm';
import { RevokeButton } from '@/app/settings/users/RevokeButton';
import { DeleteUserButton } from '@/app/settings/users/DeleteUserButton';
import { DangerZone } from '@/app/settings/users/DangerZone';

export const dynamic = 'force-dynamic';

export default function AdminUsersPage(): ReactElement {
  const users = listUsersInGroup(DEFAULT_GROUP_ID);
  const storageMap = new Map(getUserStorageStats().map((s) => [s.userId, s]));

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="mb-1 text-3xl font-bold text-[#2A241E]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Users
        </h1>
        <p className="text-sm text-[#5A4F42]">
          Create accounts and manage who can access this server.
        </p>
      </div>
      <p className="text-sm text-[#5A4F42]">
        Create accounts for your players and DMs. Share the generated
        password out-of-band — it is displayed only once.
      </p>

      <CreateUserForm />

      <UserTable users={users} storageMap={storageMap} />

      <DangerZone />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UserTable({
  users,
  storageMap,
}: {
  users: UserWithRole[];
  storageMap: Map<string, UserStorageStats>;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[#EAE1CF] text-xs uppercase tracking-wide text-[#5A4F42]">
          <tr>
            <th className="px-4 py-3">User</th>
            <th className="px-4 py-3">Role</th>
            <th className="px-4 py-3">Storage</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3">Last login</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-[#5A4F42]">
                No users yet.
              </td>
            </tr>
          )}
          {users.map((u) => {
            const stats = storageMap.get(u.id);
            return (
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
                  {stats ? (
                    <span title={`Notes: ${formatBytes(stats.notesBytes)} · Assets: ${formatBytes(stats.assetsBytes)} · Avatar: ${formatBytes(stats.avatarBytes)}`}>
                      {formatBytes(stats.totalBytes)}
                    </span>
                  ) : '—'}
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
                  <div className="flex items-center justify-end gap-2">
                    <RevokeButton userId={u.id} username={u.username} />
                    <DeleteUserButton userId={u.id} username={u.username} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
