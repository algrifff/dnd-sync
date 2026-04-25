'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

export function NewDrawingButton({
  csrfToken,
}: {
  csrfToken: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const d = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const name = `Drawing ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
      const res = await fetch('/api/notes/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          folder: 'Excalidraw',
          name,
          kind: 'excalidraw',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        path?: string;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.path) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push('/notes/' + body.path.split('/').map(encodeURIComponent).join('/'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void create()}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--rule)] bg-[var(--parchment)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] hover:bg-[var(--parchment-sunk)]/50 disabled:opacity-50"
      >
        <Plus size={14} aria-hidden />
        New drawing
      </button>
      {error && <span className="text-[11px] text-[var(--wine)]">{error}</span>}
    </div>
  );
}
