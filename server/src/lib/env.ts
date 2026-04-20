// Runtime environment parsed + validated once. Importing this module
// at boot surfaces misconfiguration immediately rather than at the first
// request.
//
// For v1 the only required secret is `SESSION_COOKIE_SECRET` in
// production — reserved for future HMAC use (e.g. signing the CSRF
// token). Session IDs themselves don't need a secret (256 bits of
// randomness + DB lookup is the proof).

type Env = {
  nodeEnv: 'production' | 'development' | 'test';
  port: number;
  dataDir: string;
  sessionCookieSecret: string | null;
  adminEmail: string | null;
};

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  cached = loadEnv();
  return cached;
}

function loadEnv(): Env {
  const nodeEnv = readNodeEnv();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be a valid TCP port, got ${process.env.PORT}`);
  }

  const dataDir = process.env.DATA_DIR ?? './.data';

  const secret = process.env.SESSION_COOKIE_SECRET ?? null;
  if (nodeEnv === 'production') {
    if (!secret || secret.length < 32) {
      throw new Error(
        'SESSION_COOKIE_SECRET must be set (≥ 32 chars) in production. Generate with `openssl rand -hex 32`.',
      );
    }
  }

  const adminEmail = process.env.ADMIN_EMAIL?.trim() || null;

  return {
    nodeEnv,
    port,
    dataDir,
    sessionCookieSecret: secret,
    adminEmail,
  };
}

function readNodeEnv(): Env['nodeEnv'] {
  const raw = process.env.NODE_ENV;
  if (raw === 'production' || raw === 'test') return raw;
  return 'development';
}
