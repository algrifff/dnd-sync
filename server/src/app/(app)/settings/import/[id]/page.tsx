import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { getImportJob } from '@/lib/imports';
import type { ImportPlan } from '@/lib/import-parse';
import { ImportJobPanel } from '@/app/settings/import/[id]/ImportJobPanel';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export default async function ImportJobPage({ params }: Ctx): Promise<ReactElement> {
  const { id } = await params;
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader);
  if (!session) redirect(`/login?next=/settings/import/${id}`);

  const job = getImportJob(id);
  if (!job) notFound();
  if (job.groupId !== session.currentGroupId) notFound();
  if (job.createdBy !== session.userId && session.role !== 'admin') notFound();

  const plan = job.plan as ImportPlan | null;

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-1 text-lg font-semibold">Import job</h2>
      <p className="mb-4 text-sm text-[var(--ink-soft)]">
        <code>{job.id}</code> · status <span className="font-medium text-[var(--ink)]">{job.status}</span>
      </p>
      <ImportJobPanel job={job} plan={plan} csrfToken={session.csrfToken} />
    </section>
  );
}
