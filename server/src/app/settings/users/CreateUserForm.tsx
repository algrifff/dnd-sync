'use client';

import { useActionState } from 'react';
import { createUserAction, type CreateUserResult } from './actions';

export function CreateUserForm(): React.JSX.Element {
  const [state, formAction, pending] = useActionState<CreateUserResult | null, FormData>(
    createUserAction,
    null,
  );

  return (
    <section className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-5">
      <h2 className="mb-3 text-lg font-semibold text-[var(--ink)]">Add a user</h2>

      <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto]">
        <label className="text-sm text-[var(--ink-soft)]">
          <span className="mb-1 block font-medium">Username</span>
          <input
            name="username"
            required
            placeholder="ben"
            pattern="^[a-z0-9_\-]{3,32}$"
            title="3–32 chars, letters/digits/_/-"
            className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>

        <label className="text-sm text-[var(--ink-soft)]">
          <span className="mb-1 block font-medium">Display name</span>
          <input
            name="displayName"
            required
            placeholder="Ben"
            maxLength={64}
            className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>

        <label className="text-sm text-[var(--ink-soft)]">
          <span className="mb-1 block font-medium">Role</span>
          <select
            name="role"
            defaultValue="editor"
            className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          >
            <option value="admin">admin</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="self-end rounded-[8px] bg-[var(--ink)] px-4 py-2 font-medium text-[var(--parchment)] transition hover:scale-[1.015] hover:bg-[var(--vellum)] disabled:opacity-60 disabled:hover:scale-100"
        >
          {pending ? 'Adding…' : 'Add user'}
        </button>
      </form>

      {state && !state.ok && (
        <p className="mt-3 rounded-[8px] border border-[var(--wine)]/40 bg-[var(--wine)]/10 px-3 py-2 text-sm text-[var(--wine)]">
          {state.error}
        </p>
      )}
      {state && state.ok && (
        <div className="mt-3 rounded-[8px] border border-[var(--candlelight)]/50 bg-[var(--candlelight)]/10 px-3 py-3">
          <p className="text-sm text-[var(--ink-soft)]">{state.message}</p>
          <dl className="mt-2 grid gap-1 text-sm">
            <div className="flex items-center gap-2">
              <dt className="w-24 text-[var(--ink-soft)]">Username</dt>
              <dd>
                <code className="rounded bg-[var(--parchment)] px-2 py-0.5 font-mono text-[var(--ink)]">
                  {state.username}
                </code>
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-24 text-[var(--ink-soft)]">Password</dt>
              <dd>
                <code className="rounded bg-[var(--parchment)] px-2 py-0.5 font-mono text-[var(--ink)]">
                  {state.password}
                </code>
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
