'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { resendVerificationAction, type ResendVerifyState } from './actions';

type Flavour = 'verify' | 'reset';

const copy: Record<Flavour, { title: string; body: (email: string) => string; resendCta: string }> = {
  verify: {
    title: 'Check your scroll',
    body: (email) =>
      email
        ? `We've sent a verification link to ${email}. Click through to confirm your email and step into the realm.`
        : "We've sent a verification link to your email. Click through to confirm and step into the realm.",
    resendCta: 'Send another verification email',
  },
  reset: {
    title: 'Check your scroll',
    body: (email) =>
      email
        ? `If an account exists for ${email}, a reset link is on its way. It expires in one hour.`
        : 'If an account exists for that email, a reset link is on its way. It expires in one hour.',
    resendCta: 'Send again',
  },
};

export function CheckEmailNotice({
  email,
  flavour,
  showBackLink = true,
}: {
  email: string;
  flavour: Flavour;
  showBackLink?: boolean;
}) {
  const c = copy[flavour];
  const [state, formAction, pending] = useActionState<ResendVerifyState, FormData>(
    resendVerificationAction,
    { status: 'idle' },
  );

  return (
    <div className="auth-fade space-y-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border-2 border-[var(--candlelight)]/60 bg-[var(--vellum)]/40">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      </div>

      <h2
        className="text-[28px] font-semibold text-[var(--ink)]"
        style={{ fontFamily: '"Fraunces", Georgia, serif' }}
      >
        {c.title}
      </h2>
      <p className="text-[var(--ink-soft)]">{c.body(email)}</p>

      {flavour === 'verify' && (
        <form action={formAction} className="space-y-3 pt-2">
          <input type="hidden" name="email" value={email} />
          <button
            type="submit"
            disabled={pending || state.status === 'sent'}
            className="text-sm text-[var(--ink-soft)] underline decoration-[var(--rule)] underline-offset-4 transition hover:text-[var(--ink)] hover:decoration-[var(--candlelight)] disabled:opacity-60"
          >
            {state.status === 'sent' ? 'Sent — check again in a moment' : pending ? 'Sending…' : c.resendCta}
          </button>
        </form>
      )}

      {showBackLink && (
        <p className="pt-2">
          <Link
            href="/login"
            className="text-sm text-[var(--ink)] underline decoration-[var(--candlelight)] underline-offset-4"
          >
            Back to sign in
          </Link>
        </p>
      )}
    </div>
  );
}
