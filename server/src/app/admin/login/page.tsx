'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage(): React.JSX.Element {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!token.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        setError('Invalid token.');
        return;
      }
      router.push('/admin/users');
      router.refresh();
    } catch {
      setError('Network error.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="max-w-sm">
      <form
        onSubmit={submit}
        className="rounded-[12px] border border-[var(--rule)] bg-[var(--vellum)] p-6 shadow-sm"
      >
        <label className="mb-4 block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--ink-soft)]">
            Admin token
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="current-password"
            className="w-full rounded-[8px] border border-[var(--rule)] bg-[var(--parchment)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--candlelight)]"
          />
        </label>
        {error && <p className="mb-3 text-xs text-[var(--wine)]">{error}</p>}
        <button
          type="submit"
          disabled={pending || !token.trim()}
          className="w-full rounded-[8px] bg-[var(--ink)] py-2 text-sm font-medium text-[var(--parchment)] transition hover:bg-[var(--vellum)] disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
