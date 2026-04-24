// Login page. Renders under the shared AuthShell — no card, inputs draw
// on the parchment gradient with candlelight focus strokes. Already-
// authenticated visitors are bounced to the ?next=… target so clicking
// "Sign in" from an authenticated tab doesn't land them on the form.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { AuthShell } from './AuthShell';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reset?: string }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : '/';
  const resetOk = params.reset === 'ok';

  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader, false);
  if (session) redirect(safeNext(next));

  return (
    <AuthShell
      title="Welcome back, traveller"
      subtitle="The table is set and your seat is still warm."
      footer={
        <div className="space-y-2">
          {resetOk && (
            <p className="text-[var(--moss)]">
              Password updated — sign in with your new one.
            </p>
          )}
          <p>
            <Link
              href="/login/forgot"
              className="text-[var(--ink-soft)] underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)] hover:decoration-[var(--candlelight)]"
            >
              Forgot your password?
            </Link>
          </p>
          <p>
            New to the realm?{' '}
            <Link
              href="/signup"
              className="text-[var(--ink)] underline decoration-[var(--candlelight)] underline-offset-4 hover:decoration-[var(--ink)]"
            >
              Create an account
            </Link>
          </p>
        </div>
      }
    >
      <LoginForm initialNext={safeNext(next)} />
    </AuthShell>
  );
}

function safeNext(raw: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.startsWith('/login')) return '/';
  return raw;
}
