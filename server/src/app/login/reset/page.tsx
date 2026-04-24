// Password-reset consume page. Expects ?token=<hex>. The form posts back
// through resetPasswordAction which validates the token, rotates the
// password, and redirects to /login?reset=ok.

import Link from 'next/link';
import { AuthShell } from '../AuthShell';
import { ResetForm } from '../ResetForm';

export const dynamic = 'force-dynamic';

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  if (!token) {
    return (
      <AuthShell
        title="Reset link missing"
        subtitle="This page needs a reset token — request a new link from the sign-in page."
        footer={
          <p>
            <Link
              href="/login/forgot"
              className="text-[var(--ink)] underline decoration-[var(--candlelight)] underline-offset-4"
            >
              Request a new reset link
            </Link>
          </p>
        }
      >
        <></>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose something sturdy. We'll sign you out of any other devices."
      footer={
        <p>
          <Link
            href="/login"
            className="text-[var(--ink-soft)] underline decoration-[var(--rule)] underline-offset-4 hover:text-[var(--ink)] hover:decoration-[var(--candlelight)]"
          >
            Back to sign in
          </Link>
        </p>
      }
    >
      <ResetForm token={token} />
    </AuthShell>
  );
}
