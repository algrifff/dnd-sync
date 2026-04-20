// Derives the user identity used for cursor presence (name + colour).
// If the user has set an explicit colour in settings, use that; otherwise
// fall back to a deterministic hash of the display name so the same person
// gets the same colour on every device.

import type { UserIdentity } from './cmBinding';

export function makeIdentity(displayName: string, displayColor?: string): UserIdentity {
  const name = displayName.trim() || 'Anonymous';
  if (displayColor && /^#[0-9a-fA-F]{6}$/.test(displayColor)) {
    return {
      name,
      color: displayColor,
      colorLight: hexToRgba(displayColor, 0.25),
    };
  }
  const hue = hashHue(name);
  return {
    name,
    color: `hsl(${hue}, 70%, 50%)`,
    colorLight: `hsla(${hue}, 70%, 50%, 0.25)`,
  };
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
