import type { ReactElement } from 'react';
import { listUsersInGroup, getUserStorageStats, DEFAULT_GROUP_ID, type UserWithRole, type UserStorageStats } from '@/lib/users';
import { CreateUserForm } from '@/app/settings/users/CreateUserForm';
import { RevokeButton } from '@/app/settings/users/RevokeButton';
import { DeleteUserButton } from '@/app/settings/users/DeleteUserButton';
import { DangerZone } from '@/app/settings/users/DangerZone';
import { RoleSelect } from '@/app/settings/users/RoleSelect';

export const dynamic = 'force-dynamic';

export default function AdminUsersPage(): ReactElement {
  const users = listUsersInGroup(DEFAULT_GROUP_ID);
  const storageMap = new Map(getUserStorageStats().map((s) => [s.userId, s]));

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="mb-1 text-3xl font-bold text-[var(--ink)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Users
        </h1>
        <p className="text-sm text-[var(--ink-soft)]">
          Create accounts and manage who can access this server.
        </p>
      </div>
      <p className="text-sm text-[var(--ink-soft)]">
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
    <section className="overflow-hidden rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--parchment-sunk)] text-xs uppercase tracking-wide text-[var(--ink-soft)]">
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
              <td colSpan={6} className="px-4 py-6 text-center text-[var(--ink-soft)]">
                No users yet.
              </td>
            </tr>
          )}
          {users.map((u) => {
            const stats = storageMap.get(u.id);
            return (
              <tr key={u.id} className="border-t border-[var(--rule)]/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: u.accentColor }}
                    />
                    <span className="font-medium">{u.displayName}</span>
                    <span className="text-[var(--ink-soft)]">({u.username})</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <RoleSelect userId={u.id} initialRole={u.role} />
                </td>
                <td className="px-4 py-3 text-[var(--ink-soft)]">
                  {stats ? (
                    <span title={`Notes: ${formatBytes(stats.notesBytes)} · Assets: ${formatBytes(stats.assetsBytes)} · Avatar: ${formatBytes(stats.avatarBytes)}`}>
                      {formatBytes(stats.totalBytes)}
                    </span>
                  ) : '—'}
                </td>
                <td className="px-4 py-3 text-[var(--ink-soft)]">
                  {new Date(u.createdAt).toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-[var(--ink-soft)]">
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
