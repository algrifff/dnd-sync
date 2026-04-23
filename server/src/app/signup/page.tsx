// Signup page. Public route — uses the shared AuthShell layout and the
// SignupForm client component. Already-signed-in visitors are bounced
// home so the "Create account" link from a logged-in tab doesn't land
// them on the form.

import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSession } from '@/lib/session';
import { AuthShell } from '../login/AuthShell';
import { SignupForm } from '../login/SignupForm';

export const dynamic = 'force-dynamic';

export default async function SignupPage(): Promise<React.ReactElement> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = readSession(cookieHeader, false);
  if (session) redirect('/');

  return (
    <AuthShell
      title="Begin your adventure"
      subtitle="Name your hero, claim your inn-key. The hearth is lit."
      footer={
        <p>
          Already have an account?{' '}
          <Link
            href="/login"
            className="text-[#2A241E] underline decoration-[#D4A85A] underline-offset-4 hover:decoration-[#2A241E]"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
