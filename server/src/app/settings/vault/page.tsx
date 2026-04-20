import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { DEFAULT_GROUP_ID } from '@/lib/users';
import { getDb } from '@/lib/db';
import { UploadForm } from './UploadForm';

export const dynamic = 'force-dynamic';

export default async function SettingsVaultPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings/vault');
  if (session.role !== 'admin') redirect('/settings/profile');

  const existing = getDb()
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM notes WHERE group_id = ?',
    )
    .get(DEFAULT_GROUP_ID);
  const noteCount = existing?.n ?? 0;

  const lastUpload = getDb()
    .query<{ at: number; details_json: string }, [string]>(
      `SELECT at, details_json FROM audit_log
         WHERE group_id = ? AND action = 'vault.upload'
         ORDER BY at DESC LIMIT 1`,
    )
    .get(DEFAULT_GROUP_ID);

  return (
    <div className="space-y-6">
      <p className="text-sm text-[#5A4F42]">
        Upload a ZIP of your Obsidian vault. The server parses every{' '}
        <code>.md</code> into our shared schema, writes it into the notes
        table, and seeds a Yjs doc for each note so live editing picks up
        where you left off.
      </p>

      <div className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] px-5 py-4">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-[#5A4F42]">Notes in vault</dt>
          <dd>{noteCount}</dd>
          <dt className="text-[#5A4F42]">Last upload</dt>
          <dd>
            {lastUpload
              ? new Date(lastUpload.at).toLocaleString() + relativeAgo(lastUpload.at)
              : '—'}
          </dd>
        </dl>
      </div>

      <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
        <h2 className="mb-3 text-lg font-semibold text-[#2A241E]">Upload</h2>
        <UploadForm csrfToken={session.csrfToken} hasExistingNotes={noteCount > 0} />
      </section>

      <p className="text-xs text-[#5A4F42]">
        Rate limit: up to 5 uploads per hour per admin. Cap: 500 MB per ZIP,
        50 MB per file inside. Files under <code>.obsidian/</code>,{' '}
        <code>.trash/</code>, and <code>.DS_Store</code> are skipped
        automatically.
      </p>
    </div>
  );
}

function relativeAgo(at: number): string {
  const delta = Date.now() - at;
  if (delta < 60_000) return ` · ${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return ` · ${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return ` · ${Math.round(delta / 3_600_000)}h ago`;
  return ` · ${Math.round(delta / 86_400_000)}d ago`;
}
