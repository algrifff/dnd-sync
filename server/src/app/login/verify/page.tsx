// Email verification consume page. Expects ?token=<hex>. Renders a
// client view that auto-submits the verify action on mount; on success
// the action redirects to "/" (with a freshly rotated session cookie).

import Link from 'next/link';
import { AuthShell } from '../AuthShell';
import { VerifyView } from '../VerifyView';

export const dynamic = 'force-dynamic';

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';

  if (!token) {
    return (
      <AuthShell
        title="Verification link missing"
        subtitle="This page needs a token — request a new email from the sign-in page."
        footer={
          <p>
            <Link
              href="/login"
              className="text-[#2A241E] underline decoration-[#D4A85A] underline-offset-4"
            >
              Back to sign in
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
      title="Verifying…"
      subtitle="One moment while we check your scroll."
    >
      <VerifyView token={token} />
    </AuthShell>
  );
}
