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
        className="rounded-[12px] border border-[#D4C7AE] bg-[#FBF5E8] p-6 shadow-sm"
      >
        <label className="mb-4 block">
          <span className="mb-1.5 block text-xs font-medium text-[#5A4F42]">
            Admin token
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="current-password"
            className="w-full rounded-[8px] border border-[#D4C7AE] bg-[#F4EDE0] px-3 py-2 text-sm text-[#2A241E] outline-none focus:border-[#D4A85A]"
          />
        </label>
        {error && <p className="mb-3 text-xs text-[#8B4A52]">{error}</p>}
        <button
          type="submit"
          disabled={pending || !token.trim()}
          className="w-full rounded-[8px] bg-[#2A241E] py-2 text-sm font-medium text-[#F4EDE0] transition hover:bg-[#3A342E] disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
