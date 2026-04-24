'use client';

import { useTransition } from 'react';
import { clearDatabaseAction } from './actions';

export function DangerZone(): React.JSX.Element {
  const [pending, startTransition] = useTransition();

  function handleClear(): void {
    if (
      !confirm(
        'Wipe ALL data?\n\nThis deletes every user, note, asset, and world. The admin account will be re-created on next server restart. This cannot be undone.',
      )
    )
      return;
    const confirmation = prompt('Type WIPE to confirm:');
    if (confirmation !== 'WIPE') return;
    startTransition(async () => {
      const res = await clearDatabaseAction();
      if (!res.ok) alert(res.error ?? 'wipe failed');
    });
  }

  return (
    <section className="overflow-hidden rounded-[12px] border border-[var(--wine)]/40 bg-[var(--vellum)]">
      <div className="border-b border-[var(--wine)]/20 bg-[var(--wine)]/5 px-4 py-3">
        <h2
          className="text-sm font-semibold text-[var(--wine)]"
          style={{ fontFamily: '"Fraunces", Georgia, serif' }}
        >
          Danger Zone
        </h2>
      </div>
      <div className="flex items-center justify-between px-4 py-4">
        <div>
          <p className="text-sm font-medium text-[var(--ink)]">Wipe database</p>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
            Deletes all users, notes, assets, and worlds. Admin re-seeds on next restart.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={handleClear}
          className="rounded-[6px] border border-[var(--wine)] bg-[var(--wine)] px-3 py-1.5 text-xs font-medium text-[var(--vellum)] hover:bg-[#7a3f47] disabled:opacity-60"
        >
          {pending ? 'Wiping…' : 'Wipe database'}
        </button>
      </div>
    </section>
  );
}
