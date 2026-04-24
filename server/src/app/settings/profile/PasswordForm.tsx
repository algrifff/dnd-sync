'use client';

// Self-service password change. PATCHes /api/profile/password with
// current + new; server verifies the current hash before rotating
// so a stolen session cookie alone can't hijack the account.

import { useState } from 'react';

export function PasswordForm({
  csrfToken,
}: {
  csrfToken: string;
}): React.JSX.Element {
  const [current, setCurrent] = useState<string>('');
  const [next, setNext] = useState<string>('');
  const [confirm, setConfirm] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);
  const [flash, setFlash] = useState<
    { kind: 'ok' | 'error'; message: string } | null
  >(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setFlash(null);
    if (next.length < 8) {
      setFlash({ kind: 'error', message: 'New password must be at least 8 characters.' });
      return;
    }
    if (next !== confirm) {
      setFlash({ kind: 'error', message: 'New passwords do not match.' });
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/profile/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const msg =
          body.error === 'wrong_password'
            ? 'Current password is incorrect.'
            : body.error === 'same_password'
              ? 'New password must be different from the current one.'
              : (body.detail ?? body.error ?? `HTTP ${res.status}`);
        setFlash({ kind: 'error', message: msg });
        return;
      }
      setFlash({ kind: 'ok', message: 'Password updated.' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setFlash({
        kind: 'error',
        message: err instanceof Error ? err.message : 'network error',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field
        label="Current password"
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <Field
        label="New password"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
      />
      <Field
        label="Confirm new password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !current || !next || !confirm}
          className="rounded-[8px] bg-[var(--ink)] px-4 py-2 text-sm font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-50 disabled:hover:scale-100"
        >
          {pending ? 'Updating…' : 'Change password'}
        </button>
        {flash && (
          <span
            className={
              'text-sm ' +
              (flash.kind === 'ok' ? 'text-[var(--moss)]' : 'text-[var(--wine)]')
            }
          >
            {flash.message}
          </span>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[var(--ink-soft)]">
        {label}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--vellum)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
      />
    </label>
  );
}
