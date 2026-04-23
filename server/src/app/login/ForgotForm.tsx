'use client';

import { useActionState } from 'react';
import { requestPasswordResetAction, type ForgotState } from './actions';
import { AuthField } from './AuthField';
import { CheckEmailNotice } from './CheckEmailNotice';

export function ForgotForm() {
  const [state, formAction, pending] = useActionState<ForgotState, FormData>(
    requestPasswordResetAction,
    { status: 'idle' },
  );

  if (state.status === 'sent') {
    return <CheckEmailNotice email="" flavour="reset" showBackLink={false} />;
  }

  return (
    <form action={formAction} className="space-y-7">
      {state.status === 'error' && (
        <p
          role="alert"
          className="auth-fade rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-sm text-[#8B4A52]"
        >
          {state.error}
        </p>
      )}

      <AuthField
        label="Your email"
        name="email"
        type="email"
        autoComplete="email"
        autoFocus
        placeholder="you@example.com"
        hint="We'll send a reset link if this email is on an account"
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-[10px] bg-[#2A241E] px-5 py-3 font-medium text-[#F4EDE0] transition hover:scale-[1.015] hover:bg-[#3A342E] disabled:opacity-60 disabled:hover:scale-100"
      >
        {pending ? 'Summoning the ravens…' : 'Send reset link'}
      </button>
    </form>
  );
}
