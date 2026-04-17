// Derives the user identity used for cursor presence (name + colour).
// Colour is a deterministic hash of the display name so the same person
// gets the same colour on every device.

import type { UserIdentity } from './cmBinding';

export function makeIdentity(displayName: string): UserIdentity {
  const name = displayName.trim() || 'Anonymous';
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
