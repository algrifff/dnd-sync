'use client';

// "+" next to the tab strip. Creates a new blank note at the vault
// root, auto-incrementing the title if Untitled is taken, then
// navigates the tab to it (which the NoteTabs hook-in does on its own
// once the URL flips). Small client island so the header stays a
// server component.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

export function NewTabButton({ csrfToken }: { csrfToken: string }): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState<boolean>(false);

  const create = async (): Promise<void> => {
    setPending(true);
    try {
      // Try Untitled, Untitled 2, … to dodge 409 conflicts. Cap at a
      // sane ceiling so a hostile collision doesn't hot-loop.
      for (let n = 1; n <= 50; n++) {
        const name = n === 1 ? 'Untitled' : `Untitled ${n}`;
        const res = await fetch('/api/notes/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ folder: '', name }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.error === 'exists') continue;
        if (!res.ok || !body.ok) {
          alert(body.error ?? `Create failed (HTTP ${res.status})`);
          return;
        }
        router.push('/notes/' + body.path.split('/').map(encodeURIComponent).join('/'));
        router.refresh();
        return;
      }
      alert('Could not find a free Untitled slot (checked 50).');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void create()}
      disabled={pending}
      title="New note"
      aria-label="New note"
      className="mb-1.5 rounded-[6px] p-1 text-[#5A4F42] transition hover:bg-[#D4A85A]/15 hover:text-[#2A241E] disabled:opacity-60"
    >
      <Plus size={14} aria-hidden />
    </button>
  );
}
