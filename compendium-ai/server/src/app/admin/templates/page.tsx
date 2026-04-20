import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { listTemplates, TEMPLATE_KINDS, type TemplateKind } from '@/lib/templates';
import { TemplatesEditor } from '@/app/settings/templates/TemplatesEditor';

export const dynamic = 'force-dynamic';

export default async function AdminTemplatesPage(): Promise<ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect('/login?next=/admin/templates');
  if (session.role !== 'admin') redirect('/');

  const templates = listTemplates();
  const byKind = new Map(templates.map((t) => [t.kind, t]));
  const ordered = TEMPLATE_KINDS.map((k) => byKind.get(k))
    .filter((t): t is NonNullable<typeof t> => t != null);

  return (
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-1 text-lg font-semibold">Templates</h2>
      <p className="mb-4 text-sm text-[#5A4F42]">
        The schema that shapes every character sheet and session log in every
        world on this server. Players don&rsquo;t see this page — they fill in
        values via the sheet UI.
      </p>
      <TemplatesEditor
        csrfToken={session.csrfToken}
        initialTemplates={ordered}
        initialActiveKind={KIND_ORDER[0] as TemplateKind}
      />
    </section>
  );
}

const KIND_ORDER: readonly TemplateKind[] = TEMPLATE_KINDS;
