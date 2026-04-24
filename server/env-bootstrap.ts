// Custom `server.ts` entrypoints do not automatically load `.env*` the way
// `next dev` / `next start` do. Prime `process.env` once at process startup.
//
// @next/env is CJS (module.exports = IIFE), so Node 22 ESM can't resolve its
// named exports via static analysis. createRequire sidesteps that gap.
import { createRequire } from 'module';
import type * as NextEnv from '@next/env';
const _require = createRequire(import.meta.url);
const { loadEnvConfig } = _require('@next/env') as typeof NextEnv;


loadEnvConfig(process.cwd());
