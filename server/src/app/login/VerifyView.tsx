'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import { verifyEmailAction, type VerifyState } from './actions';

// Client component that auto-submits the verify action on mount. The
// action either redirects to "/" (success) or returns a VerifyState with
// an error, which we render below.

export function VerifyView({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<VerifyState, FormData>(
    verifyEmailAction,
    { status: 'idle' },
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.requestSubmit();
  }, []);

  return (
    <div className="auth-fade space-y-6 text-center">
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="token" value={token} />
      </form>

      {state.status === 'idle' && (
        <>
          <p className="text-[var(--ink-soft)]">
            {pending ? 'Verifying your scroll…' : 'Verifying your scroll…'}
          </p>
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--rule)] border-t-[var(--candlelight)]" />
        </>
      )}

      {state.status === 'error' && (
        <>
          <p className="rounded-[8px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-3 py-2 text-sm text-[var(--wine)]">
            {state.error}
          </p>
          <Link
            href="/login"
            className="inline-block rounded-[10px] bg-[var(--ink)] px-5 py-3 font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)]"
          >
            Back to sign in
          </Link>
        </>
      )}
    </div>
  );
}
