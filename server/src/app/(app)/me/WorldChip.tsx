// A World's icon, or its colour and initials when it has none. The same
// world wears the same chip on the rail and everywhere on Home.

import { worldColor, worldInitials } from '../../world-chip';

export type ChipWorld = { id: string; name: string; iconVersion: number };

const SIZES = {
  md: 'h-10 w-10 rounded-[14px] text-sm',
  sm: 'h-5 w-5 rounded-[7px] text-[9px]',
} as const;

export function WorldChip({
  world,
  size = 'md',
}: {
  world: ChipWorld;
  size?: keyof typeof SIZES;
}): React.JSX.Element {
  const hasIcon = world.iconVersion > 0;
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden font-semibold leading-none text-[var(--rail-ink)] ${SIZES[size]}`}
      style={{ backgroundColor: hasIcon ? 'var(--ink)' : worldColor(world.id) }}
    >
      {hasIcon ? (
        <img
          src={`/api/worlds/${encodeURIComponent(world.id)}/icon?v=${world.iconVersion}`}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        worldInitials(world.name)
      )}
    </span>
  );
}
