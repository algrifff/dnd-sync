// Login page. Renders a centred card in the D&D parchment palette.
// Already-authenticated visitors are bounced to the ?next=… target so
// clicking "Sign in" from an authenticated tab doesn't land them on the
// form.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : '/';

  // If already signed in, skip the form.
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader, false);
  if (session) redirect(safeNext(next));

  return (
    <main
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background:
          'radial-gradient(ellipse at top, #F4EDE0 0%, #EAE1CF 60%, #D9CCAF 100%)',
      }}
    >
      <div className="w-full max-w-sm rounded-[14px] border border-[#D4C7AE] bg-[#FBF5E8] p-8 shadow-[0_10px_40px_rgba(42,36,30,0.08)]">
        <div className="mb-6 text-center">
          <h1
            className="text-3xl font-bold text-[#2A241E]"
            style={{ fontFamily: '"Fraunces", Georgia, serif' }}
          >
            Compendium
          </h1>
          <p className="mt-1 text-sm text-[#5A4F42]">Sign in to your table.</p>
        </div>
        <LoginForm initialNext={safeNext(next)} />
      </div>
    </main>
  );
}

function safeNext(raw: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.startsWith('/login')) return '/';
  return raw;
}
