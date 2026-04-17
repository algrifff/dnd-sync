// Reads the baked plugin bundle (main.js) once and memoises it with its
// sha256. The bundle is copied into the image at Docker build time; every
// deploy gets a new image → new boot → fresh hash.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BUNDLE_DIR =
  process.env.PLUGIN_BUNDLE_DIR ?? resolve(process.cwd(), 'src/lib/installer/bundle');

type Bundle = { hash: string; bytes: Buffer };

let cached: Bundle | null = null;

export function getPluginBundle(): Bundle {
  if (cached) return cached;
  const bytes = readFileSync(resolve(BUNDLE_DIR, 'main.js'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  cached = { hash, bytes };
  return cached;
}
