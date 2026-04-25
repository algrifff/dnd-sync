'use client';

// Pill that switches the world owner between the player namespace
// (the default) and a hidden GM namespace. Only mounted by AppHeader
// when the caller's role is 'admin' — non-admins never see it.

import { useState, useTransition, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';

export function GmModeToggle({
  initialOn,
  csrfToken,
}: {
  initialOn: boolean;
  csrfToken: string;
}): ReactElement {
  const [on, setOn] = useState<boolean>(initialOn);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function flip(): void {
    const next = !on;
    setOn(next);
    startTransition(async () => {
      try {
        await fetch('/api/ui/gm-mode', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({ on: next }),
        });
      } catch {
        setOn(!next);
        return;
      }
      router.refresh();
    });
  }

  const offClass =
    'rounded-full border border-[var(--rule)] bg-[var(--vellum)] ' +
    'px-3 py-1 text-xs text-[var(--ink-soft)] ' +
    'transition hover:border-[var(--candlelight)] hover:text-[var(--ink)]';
  const onClass =
    'rounded-full border border-[var(--wine)] bg-[rgb(var(--wine-rgb)/0.12)] ' +
    'px-3 py-1 text-xs font-medium text-[var(--wine)] ' +
    'transition';

  return (
    <button
      type="button"
      onClick={flip}
      disabled={pending}
      aria-pressed={on}
      title={on ? 'GM mode is on — switch to player view' : 'Switch to GM mode'}
      className={`${on ? onClass : offClass} disabled:opacity-60`}
    >
      {on ? 'GM mode' : 'GM mode'}
      <span aria-hidden className="ml-2 inline-block">
        {on ? '●' : '○'}
      </span>
    </button>
  );
}
