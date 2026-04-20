'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

export function AdminSignOut(): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const signOut = async (): Promise<void> => {
    setPending(true);
    try {
      await fetch('/api/admin/login', { method: 'DELETE' });
    } finally {
      router.push('/admin/login');
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      title="Sign out of admin"
      className="flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs text-[#5A4F42] transition hover:bg-[#EAE1CF] hover:text-[#2A241E] disabled:opacity-50"
    >
      <LogOut size={13} aria-hidden />
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
