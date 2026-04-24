'use client';

import { useActionState } from 'react';
import { resetPasswordAction, type ResetState } from './actions';
import { AuthField } from './AuthField';

export function ResetForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<ResetState, FormData>(
    resetPasswordAction,
    { status: 'idle' },
  );

  return (
    <form action={formAction} className="space-y-7">
      <input type="hidden" name="token" value={token} />

      {state.status === 'error' && (
        <p
          role="alert"
          className="auth-fade rounded-[8px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-3 py-2 text-sm text-[var(--wine)]"
        >
          {state.error}
        </p>
      )}

      <AuthField
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        autoFocus
        placeholder="••••••••"
        hint="At least 8 characters. Any previous sessions will be signed out."
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-[10px] bg-[var(--ink)] px-5 py-3 font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-60 disabled:hover:scale-100"
      >
        {pending ? 'Re-inking the ledger…' : 'Set new password'}
      </button>
    </form>
  );
}
