import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listTemplates, TEMPLATE_KINDS, type TemplateKind } from '@/lib/templates';
import { TemplatesEditor } from '@/app/settings/templates/TemplatesEditor';

export const dynamic = 'force-dynamic';

export default async function SettingsTemplatesPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/settings/templates');
  if (session.role !== 'admin') redirect('/settings/profile');

  const templates = listTemplates();
  const byKind = new Map(templates.map((t) => [t.kind, t]));
  const ordered = TEMPLATE_KINDS.map((k) => byKind.get(k)).filter(
    (t): t is NonNullable<typeof t> => t != null,
  );

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-lg font-semibold">Templates</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        The schema that shapes every character sheet and session log in every world on this server.
        Players don&rsquo;t see this page - they fill in values via the sheet UI.
      </p>
      <TemplatesEditor
        csrfToken={session.csrfToken}
        initialTemplates={ordered}
        initialActiveKind={TEMPLATE_KINDS[0] as TemplateKind}
      />
    </section>
  );
}
