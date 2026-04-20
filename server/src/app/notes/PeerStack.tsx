'use client';

// Stacked avatar circles for peers viewing a given note path. Lives
// next to a row in the FileTree so you can see at a glance who's on
// what. Subscribes to the presence snapshot published by
// PresenceClient via useSyncExternalStore — no React context so the
// whole app doesn't re-render on every awareness tick.

import { useSyncExternalStore } from 'react';
import {
  getPresenceServerSnapshot,
  getPresenceSnapshot,
  subscribePresence,
} from '@/lib/presence-state';

const MAX_VISIBLE = 3;

export function PeerStack({ notePath }: { notePath: string }): React.JSX.Element | null {
  const peers = useSyncExternalStore(
    subscribePresence,
    getPresenceSnapshot,
    getPresenceServerSnapshot,
  );

  // Dedupe by userId — same user on two tabs shouldn't double-stack.
  const seen = new Set<string>();
  const here = peers.filter((p) => {
    if (p.notePath !== notePath) return false;
    const key = p.userId || `anon:${p.clientId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (here.length === 0) return null;

  const visible = here.slice(0, MAX_VISIBLE);
  const extra = here.length - visible.length;

  return (
    <div
      className="flex shrink-0 items-center pl-1"
      aria-label={`${here.length} viewing`}
      title={here.map((p) => p.name).join(', ')}
    >
      {visible.map((p, i) => {
        const avatarUrl =
          p.avatarVersion > 0 && p.userId
            ? `/api/users/${p.userId}/avatar?v=${p.avatarVersion}`
            : null;
        return (
          <span
            key={p.clientId}
            className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 text-[8px] font-semibold text-white"
            style={{
              backgroundColor: avatarUrl ? 'transparent' : p.color,
              borderColor: p.color,
              marginLeft: i === 0 ? 0 : -6,
              zIndex: visible.length - i,
            }}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt={p.name} className="h-full w-full object-cover" />
            ) : (
              initials(p.name)
            )}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          className="flex h-4 items-center justify-center rounded-full border-2 border-[#D4C7AE] bg-[#FBF5E8] px-1 text-[8px] font-semibold text-[#5A4F42]"
          style={{ marginLeft: -6, zIndex: 0 }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

function initials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

