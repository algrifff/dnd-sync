'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';

export function LoginForm({ initialNext }: { initialNext: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    loginAction,
    { error: null, next: initialNext },
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="next" value={state.next} />

      <label className="block">
        <span className="text-sm text-[#5A4F42] font-medium">Username</span>
        <input
          name="username"
          autoComplete="username"
          autoFocus
          required
          className="mt-1 w-full rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] px-3 py-2 text-[#2A241E] outline-none focus:border-[#D4A85A] focus:ring-2 focus:ring-[#D4A85A]/30"
        />
      </label>

      <label className="block">
        <span className="text-sm text-[#5A4F42] font-medium">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 w-full rounded-[10px] border border-[#D4C7AE] bg-[#FBF5E8] px-3 py-2 text-[#2A241E] outline-none focus:border-[#D4A85A] focus:ring-2 focus:ring-[#D4A85A]/30"
        />
      </label>

      {state.error && (
        <p
          role="alert"
          className="rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-sm text-[#8B4A52]"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-[10px] bg-[#2A241E] px-4 py-2.5 font-medium text-[#F4EDE0] transition hover:scale-[1.015] hover:bg-[#3A342E] disabled:opacity-60 disabled:hover:scale-100"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
