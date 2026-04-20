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
            className="group relative flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold text-[#2A241E] transition hover:-translate-y-px disabled:cursor-default disabled:hover:translate-y-0"
            style={{
              backgroundColor: withAlpha(p.color, 0.2),
              borderColor: p.color,
            }}
          >
            <span aria-hidden>{initials(p.name)}</span>
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

// Accept "#RRGGBB" or "#RGB"; fall back to the opaque colour if we
// can't parse. alpha clamped to [0, 1].
function withAlpha(hex: string, alpha: number): string {
  const trimmed = hex.trim();
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!m) return trimmed;
  let body = m[1]!;
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
