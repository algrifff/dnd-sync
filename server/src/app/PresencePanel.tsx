'use client';

// Avatar row in the top bar. One chip per connected peer, coloured by
// their accent, tooltip shows "Name is viewing <title>", click routes
// to their current page (if it's one we can navigate to).

export type PresencePeer = {
  clientId: number;
  userId: string;
  name: string;
  username: string;
  color: string;
  avatarVersion: number;
  viewing: string | null;
  viewingTitle: string | null;
};

export function PresencePanel({
  peers,
  onNavigate,
}: {
  peers: PresencePeer[];
  onNavigate: (href: string) => void;
}): React.JSX.Element {
  // Collapse duplicate chips when the same user has multiple tabs
  // open: take the most recent (highest clientId) per userId.
  const deduped = new Map<string, PresencePeer>();
  for (const p of peers) {
    const key = p.userId || `anon:${p.clientId}`;
    const prev = deduped.get(key);
    if (!prev || prev.clientId < p.clientId) deduped.set(key, p);
  }
  const visible = [...deduped.values()];

  if (visible.length === 0) {
    return <div aria-hidden className="mb-1.5 shrink-0" />;
  }

  return (
    <div className="mb-1.5 flex shrink-0 items-center gap-1 pl-2">
      {visible.map((p) => {
        const isNavigable = Boolean(p.viewing && p.viewing.startsWith('/'));
        const tooltip = p.viewingTitle
          ? `${p.name} is viewing ${p.viewingTitle}`
          : `${p.name} is online`;
        const avatarUrl =
          p.avatarVersion > 0 && p.userId
            ? `/api/users/${p.userId}/avatar?v=${p.avatarVersion}`
            : null;
        return (
          <button
            key={p.clientId}
            type="button"
            onClick={() => {
              if (isNavigable && p.viewing) onNavigate(p.viewing);
            }}
            disabled={!isNavigable}
            title={tooltip}
            aria-label={tooltip}
            className="group relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 text-xs font-semibold text-white transition hover:-translate-y-px disabled:cursor-default disabled:hover:translate-y-0"
            style={{
              backgroundColor: avatarUrl ? 'transparent' : p.color,
              borderColor: p.color,
            }}
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={p.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <span aria-hidden>{initials(p.name)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function initials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

