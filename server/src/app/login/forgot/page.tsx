// Forgot-password entry. Public route — renders under the shared
// AuthShell. The action always returns "sent" whether or not the email
// exists, so nothing here leaks account existence.

import Link from 'next/link';
import { AuthShell } from '../AuthShell';
import { ForgotForm } from '../ForgotForm';

export const dynamic = 'force-dynamic';

export default function ForgotPage(): React.ReactElement {
  return (
    <AuthShell
      title="Lost your way?"
      subtitle="Tell us the email on your account and we'll send a reset link."
      footer={
        <p>
          <Link
            href="/login"
            className="text-[#2A241E] underline decoration-[#D4A85A] underline-offset-4 hover:decoration-[#2A241E]"
          >
            Back to sign in
          </Link>
        </p>
      }
    >
      <ForgotForm />
    </AuthShell>
  );
}
