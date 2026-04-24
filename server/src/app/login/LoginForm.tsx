'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';
import { AuthField } from './AuthField';

export function LoginForm({ initialNext }: { initialNext: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    loginAction,
    { error: null, next: initialNext },
  );

  return (
    <form action={formAction} className="space-y-7">
      <input type="hidden" name="next" value={state.next} />

      {state.error && (
        <p
          role="alert"
          className="auth-fade rounded-[8px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-3 py-2 text-sm text-[var(--wine)]"
        >
          {state.error}
        </p>
      )}

      <AuthField
        label="Username"
        name="username"
        autoComplete="username"
        autoFocus
        placeholder="your_hero_name"
      />
      <AuthField
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-[10px] bg-[var(--ink)] px-5 py-3 font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-60 disabled:hover:scale-100"
      >
        {pending ? 'Signing in…' : 'Step through the door'}
      </button>
    </form>
  );
}
