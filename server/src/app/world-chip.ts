// Fallback chip for a world with no uploaded icon: a palette colour
// picked from the world id plus initials from its name. Shared by the
// worlds rail and /me so one world wears the same colour everywhere.

export const WORLD_CHIP_PALETTE = [
  'var(--wine)',
  'var(--moss)',
  'var(--sage)',
  'var(--candlelight)',
  'var(--embers)',
  'var(--wisteria)',
  'var(--deep-water)',
  'var(--chestnut)',
] as const;

export function worldColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return WORLD_CHIP_PALETTE[h % WORLD_CHIP_PALETTE.length]!;
}

export function worldInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
