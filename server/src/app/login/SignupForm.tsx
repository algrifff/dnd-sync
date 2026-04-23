'use client';

import { useActionState } from 'react';
import { signupAction, type SignupState } from './actions';
import { AuthField } from './AuthField';
import { CheckEmailNotice } from './CheckEmailNotice';

export function SignupForm() {
  const [state, formAction, pending] = useActionState<SignupState, FormData>(
    signupAction,
    { status: 'idle' },
  );

  if (state.status === 'sent') {
    return <CheckEmailNotice email={state.email} flavour="verify" />;
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
        label="Choose a username"
        name="username"
        autoComplete="username"
        autoFocus
        placeholder="your_hero_name"
        hint="3–32 characters · letters, numbers, dashes"
      />
      <AuthField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        hint="We'll send a verification link here"
      />
      <AuthField
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="••••••••"
        hint="At least 8 characters"
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-[10px] bg-[#2A241E] px-5 py-3 font-medium text-[#F4EDE0] transition hover:scale-[1.015] hover:bg-[#3A342E] disabled:opacity-60 disabled:hover:scale-100"
      >
        {pending ? 'Forging your scroll…' : 'Begin your adventure'}
      </button>
    </form>
  );
}
