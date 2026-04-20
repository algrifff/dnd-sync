// Runtime config — auto-generates secrets on first boot so the DM doesn't
// have to paste tokens into Railway env vars. Env vars still win if set
// (useful for CI / local testing / emergency override).
//
// Keys:
//   admin_token  — legacy bearer token for admin API access.
//   player_token — legacy bearer token for player API access.

import { randomBytes } from 'node:crypto';
import { getDb } from './db';

export type ConfigKey = 'admin_token' | 'player_token';

type Row = { value: string };

function envNameFor(key: ConfigKey): string {
  switch (key) {
    case 'admin_token':
      return 'ADMIN_TOKEN';
    case 'player_token':
      return 'PLAYER_TOKEN';
  }
}

function generateSecret(): string {
  return randomBytes(24).toString('hex'); // 48-char hex
}

function readRow(key: ConfigKey): string | null {
  const row = getDb()
    .query<Row, [string]>('SELECT value FROM config WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeRow(key: ConfigKey, value: string): void {
  getDb()
    .query(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

/** Read (env first, then DB). Assumes ensureConfig has run at boot. */
export function getConfigValue(key: ConfigKey): string {
  const envVal = process.env[envNameFor(key)];
  if (envVal && envVal.length > 0) return envVal;
  const stored = readRow(key);
  if (!stored) {
    throw new Error(`config missing: ${key}. Did ensureConfig run at boot?`);
  }
  return stored;
}

/** Force a new value for a config key. */
export function setConfigValue(key: ConfigKey, value: string): void {
  writeRow(key, value);
}

/** Convenience: generate + store a fresh secret. Returns the new value. */
export function regenerateConfigValue(key: ConfigKey): string {
  const fresh = generateSecret();
  writeRow(key, fresh);
  return fresh;
}

/**
 * Called once at server boot. Seeds missing keys with random secrets and
 * prints the admin token to stdout the first time it's generated so the
 * DM can grab it from Railway logs.
 */
export function ensureConfig(): void {
  const bootstrap: ConfigKey[] = ['admin_token', 'player_token'];
  const firstTimeAdmin = !readRow('admin_token') && !process.env.ADMIN_TOKEN;

  for (const key of bootstrap) {
    if (!readRow(key)) writeRow(key, generateSecret());
  }

  if (firstTimeAdmin) {
    const token = getConfigValue('admin_token');
    console.log('');
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('  Compendium first-time setup');
    console.log('');
    console.log('  Admin token (save this — used to sign into the dashboard):');
    console.log(`    ${token}`);
    console.log('');
    console.log('  Override with ADMIN_TOKEN env var to set your own.');
    console.log('══════════════════════════════════════════════════════════════════');
    console.log('');
  }
}
