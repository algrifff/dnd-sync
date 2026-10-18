// Fallback chip for a world with no uploaded icon: a colour picked from
// the world id plus initials from its name. Shared by the worlds rail
// and /me so one world wears the same chip everywhere. Each chip's
// background and initials ink are a pair of tokens in globals.css
// (`--chip-<name>`, `--chip-<name>-ink`), chosen per theme so the
// initials stay readable in day and night.

export const WORLD_CHIPS = [
  'wine',
  'moss',
  'sage',
  'candlelight',
  'embers',
  'wisteria',
  'deep-water',
  'chestnut',
] as const;

export type WorldChipStyle = { backgroundColor: string; color: string };

export function worldChipStyle(id: string): WorldChipStyle {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  const chip = WORLD_CHIPS[h % WORLD_CHIPS.length]!;
  return { backgroundColor: `var(--chip-${chip})`, color: `var(--chip-${chip}-ink)` };
}

export function worldInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
