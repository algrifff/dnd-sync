import { timingSafeEqual } from 'node:crypto';

const COOKIE = '__sa';
const MAX_AGE = 8 * 3600; // 8 hours

export function isSuperAdmin(cookieHeader: string): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const match = cookieHeader.match(/(?:^|;\s*)__sa=([^;]+)/);
  if (!match?.[1]) return false;
  try {
    const a = Buffer.from(decodeURIComponent(match[1]));
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function superAdminCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

export function clearSuperAdminCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}
