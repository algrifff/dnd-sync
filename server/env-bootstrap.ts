// Custom `server.ts` entrypoints do not automatically load `.env*` the way
// `next dev` / `next start` do. Prime `process.env` once at process startup.
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());
