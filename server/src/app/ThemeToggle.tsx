'use client';

import { useEffect, useState, type ReactElement } from 'react';

function readCookieTheme(): 'day' | 'night' {
  if (typeof document === 'undefined') return 'day';
  const m = document.cookie.match(/(?:^|;\s*)pp_theme=(day|night)/);
  return m?.[1] === 'night' ? 'night' : 'day';
}

export function ThemeToggle(): ReactElement {
  const [theme, setTheme] = useState<'day' | 'night'>('day');

  useEffect(() => {
    setTheme(readCookieTheme());
  }, []);

  const isNight = theme === 'night';

  function toggle(): void {
    const next = isNight ? 'day' : 'night';
    document.cookie = `pp_theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.location.reload();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isNight ? 'Switch to daytime' : 'Switch to nighttime'}
      title={isNight ? 'Switch to daytime' : 'Switch to nighttime'}
      className="fixed right-4 top-4 z-[60] grid h-9 w-9 cursor-pointer place-items-center rounded-full text-[var(--ink-soft)] transition-transform duration-150 ease-out hover:scale-125 hover:text-[var(--ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--candlelight)]"
    >
      {isNight ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      )}
    </button>
  );
}
