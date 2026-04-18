'use client';

import { useActionState } from 'react';
import { createUserAction, type CreateUserResult } from './actions';

export function CreateUserForm(): React.JSX.Element {
  const [state, formAction, pending] = useActionState<CreateUserResult | null, FormData>(
    createUserAction,
    null,
  );

  return (
    <section className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-5">
      <h2 className="mb-3 text-lg font-semibold text-[#2A241E]">Add a user</h2>

      <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto]">
        <label className="text-sm text-[#5A4F42]">
          <span className="mb-1 block font-medium">Username</span>
          <input
            name="username"
            required
            placeholder="ben"
            pattern="^[a-z0-9_\-]{3,32}$"
            title="3–32 chars, letters/digits/_/-"
            className="w-full rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>

        <label className="text-sm text-[#5A4F42]">
          <span className="mb-1 block font-medium">Display name</span>
          <input
            name="displayName"
            required
            placeholder="Ben"
            maxLength={64}
            className="w-full rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>

        <label className="text-sm text-[#5A4F42]">
          <span className="mb-1 block font-medium">Role</span>
          <select
            name="role"
            defaultValue="editor"
            className="w-full rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-[#2A241E] outline-none focus:border-[#D4A85A]"
          >
            <option value="admin">admin</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="self-end rounded-[8px] bg-[#2A241E] px-4 py-2 font-medium text-[#F4EDE0] transition hover:scale-[1.015] hover:bg-[#3A342E] disabled:opacity-60 disabled:hover:scale-100"
        >
          {pending ? 'Adding…' : 'Add user'}
        </button>
      </form>

      {state && !state.ok && (
        <p className="mt-3 rounded-[8px] border border-[#8B4A52]/40 bg-[#8B4A52]/10 px-3 py-2 text-sm text-[#8B4A52]">
          {state.error}
        </p>
      )}
      {state && state.ok && (
        <div className="mt-3 rounded-[8px] border border-[#D4A85A]/50 bg-[#D4A85A]/10 px-3 py-3">
          <p className="text-sm text-[#5A4F42]">{state.message}</p>
          <dl className="mt-2 grid gap-1 text-sm">
            <div className="flex items-center gap-2">
              <dt className="w-24 text-[#5A4F42]">Username</dt>
              <dd>
                <code className="rounded bg-[#F4EDE0] px-2 py-0.5 font-mono text-[#2A241E]">
                  {state.username}
                </code>
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="w-24 text-[#5A4F42]">Password</dt>
              <dd>
                <code className="rounded bg-[#F4EDE0] px-2 py-0.5 font-mono text-[#2A241E]">
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
