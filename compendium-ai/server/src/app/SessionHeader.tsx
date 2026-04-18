'use client';

// Thin header rendered on every authenticated page. Shows who's
// logged in + a logout form that calls the Server Action. Styled in
// the D&D parchment palette; matches the Milanote-generous padding.

import type { ReactElement } from 'react';
import { logoutAction } from './login/actions';

export function SessionHeader({
  displayName,
  username,
  role,
  accentColor,
}: {
  displayName: string;
  username: string;
  role: 'admin' | 'editor' | 'viewer';
  accentColor: string;
}): ReactElement {
  return (
    <header className="flex items-center justify-between border-b border-[#D4C7AE] bg-[#FBF5E8] px-6 py-3">
      <div className="flex items-center gap-5">
        <a
          href="/"
          className="font-semibold text-[#2A241E] transition hover:text-[#5A4F42]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Compendium
        </a>
        <nav className="flex items-center gap-4 text-sm text-[#5A4F42]">
          <a href="/" className="underline-offset-2 hover:underline">
            Home
          </a>
          <span aria-hidden className="text-[#D4C7AE]">
            ·
          </span>
          <a href="/tags" className="underline-offset-2 hover:underline">
            Tags
          </a>
          {role === 'admin' && (
            <>
              <span aria-hidden className="text-[#D4C7AE]">
                ·
              </span>
              <a href="/admin/vault" className="underline-offset-2 hover:underline">
                Vault
              </a>
              <a href="/admin/users" className="underline-offset-2 hover:underline">
                Users
              </a>
            </>
          )}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="inline-block h-3 w-3 rounded-full"
          style={{ backgroundColor: accentColor }}
        />
        <span className="text-sm text-[#2A241E]">
          <span className="font-medium">{displayName}</span>{' '}
          <span className="text-[#5A4F42]">({username})</span>
        </span>
        {role === 'admin' && (
          <span className="rounded-full border border-[#D4A85A]/50 bg-[#D4A85A]/15 px-2 py-0.5 text-xs font-medium text-[#5A4F42]">
            admin
          </span>
        )}
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-1.5 text-sm text-[#2A241E] transition hover:scale-[1.015] hover:bg-[#EAE1CF]"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
