// Outbound-fetch guard for URLs a user controls (OAuth client metadata
// documents). A hostname is resolved first and refused if any address it
// maps to is not publicly routable, so the server cannot be pointed at
// loopback, the LAN or a cloud metadata endpoint.

import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Resolver = (host: string) => Promise<{ address: string }[]>;

const defaultResolver: Resolver = (host) => lookup(host, { all: true });

function ipv4Public(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

/** Expand an IPv6 literal to its 8 hextets, or null if malformed. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

function ipv6Public(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const embedded = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const allZeroTo = (n: number): boolean => h.slice(0, n).every((x) => x === 0);
  if (allZeroTo(5) && h[5] === 0xffff) return ipv4Public(embedded(h[6]!, h[7]!)); // ::ffff:a.b.c.d
  if (allZeroTo(6)) return false; // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b) return false; // NAT64 64:ff9b::/96
  if ((h[0]! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((h[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((h[0]! & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** True only for a publicly routable IP literal. Hostnames return false. */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return ipv4Public(ip);
  if (isIPv6(ip)) return ipv6Public(ip);
  return false;
}

/** Wrap a fetch so it refuses hosts with any non-public address.
 *  Residual: the name is resolved again at connect time, so a DNS
 *  rebinding server could answer differently the second time. */
export function createGuardedFetch(resolve: Resolver = defaultResolver, inner: Fetcher = fetch): Fetcher {
  return async (url, init) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const addrs = isIPv4(host) || isIPv6(host) ? [{ address: host }] : await resolve(host);
    if (addrs.length === 0 || !addrs.every((a) => isPublicAddress(a.address))) {
      throw new Error(`refusing to fetch non-public host ${host}`);
    }
    return inner(url, init);
  };
}
