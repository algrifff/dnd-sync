// GET /install/<os>?key=<installer_key>
//   <os> ∈ { mac, linux, windows.ps1, windows.bat }
//
// Public endpoint gated by the installer key. Returns a customized
// installer with SERVER_URL + PLAYER_TOKEN baked in so friends never
// have to paste anything. The key is rotatable from the dashboard.

import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getConfigValue } from '@/lib/config';
import { buildInstaller, type OsTarget } from '@/lib/installer/builder';

export const dynamic = 'force-dynamic';

type RouteCtx = { params: Promise<{ os: string }> };

function isOsTarget(raw: string): raw is OsTarget {
  return raw === 'mac' || raw === 'linux' || raw === 'windows.ps1' || raw === 'windows.bat';
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function resolveServerUrl(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) {
    // Fallback: reconstruct from the request URL.
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  }
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { os } = await ctx.params;
  if (!isOsTarget(os)) {
    return new Response('not found', { status: 404 });
  }

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  const expected = getConfigValue('installer_key');
  if (!key || !safeEqual(key, expected)) {
    return new Response('invalid or missing installer key', { status: 403 });
  }

  const installer = buildInstaller(os, {
    serverUrl: resolveServerUrl(req),
    playerToken: getConfigValue('player_token'),
    installerKey: expected,
  });

  return new Response(new Uint8Array(installer.body), {
    status: 200,
    headers: {
      'Content-Type': installer.contentType,
      'Content-Disposition': `attachment; filename="${installer.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
