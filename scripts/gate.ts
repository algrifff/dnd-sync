// Memory gate for heavy commands, so many agents can run in parallel
// without pushing the machine past a RAM ceiling.
//
//   bun scripts/gate.ts [--pool check|dev] [--cost-mb N] [--cwd DIR] -- <command...>
//
// The command starts only once (a) the pool has a free slot and (b) used RAM
// plus the command's estimated peak stays under the ceiling. Otherwise it
// waits. Cooperative: it only limits commands launched through it.
//
// Env: GATE_CEILING_GB (default 70), GATE_MAX_CHECK (6), GATE_MAX_DEV (3).
// Dev pool also sets PORT to 3100 + slot index when PORT is unset, so
// parallel dev servers never collide.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const POLL_MS = 2000;
const STAGGER_MS = 4000; // let one job's memory spike show before the next starts

const argv = process.argv.slice(2);
// bun drops a bare "--" when no flags precede it, so don't require one: read
// the known flags, then treat the first other token as the command.
const opts: Record<string, string> = {};
let at = 0;
while (at < argv.length) {
  const tok = argv[at] as string;
  if (tok === '--') {
    at++;
    break;
  }
  if (tok === '--pool' || tok === '--cost-mb' || tok === '--cwd') {
    opts[tok] = argv[at + 1] ?? '';
    at += 2;
  } else {
    break;
  }
}
const [cmd, ...cmdArgs] = argv.slice(at);
if (!cmd) {
  console.error('usage: gate.ts [--pool check|dev] [--cost-mb N] [--cwd DIR] -- <command...>');
  process.exit(2);
}
const flag = (name: string, fallback: string): string => opts[name] || fallback;

const pool = flag('--pool', 'check');
const costMb = Number(flag('--cost-mb', '1500'));
const cwd = path.resolve(flag('--cwd', '.'));
const ceilingGb = Number(process.env.GATE_CEILING_GB ?? 70);
const maxSlots = Number(
  pool === 'dev' ? (process.env.GATE_MAX_DEV ?? 3) : (process.env.GATE_MAX_CHECK ?? 6),
);

const root = path.join(os.tmpdir(), 'compendium-gate');
const poolDir = path.join(root, pool);
mkdirSync(poolDir, { recursive: true });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function tryClaim(file: string): boolean {
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const owner = Number(readFileSync(file, 'utf8'));
    if (owner && !alive(owner)) {
      rmSync(file, { force: true });
      return tryClaim(file);
    }
    return false;
  }
}

function claimSlot(): number {
  for (let i = 0; i < maxSlots; i++) {
    if (tryClaim(path.join(poolDir, `slot-${i}.lock`))) return i;
  }
  return -1;
}

// A short global lock, so simultaneous starters see each other's memory use.
const startLock = path.join(root, 'start.lock');
function claimStart(): boolean {
  try {
    writeFileSync(startLock, String(process.pid), { flag: 'wx' });
    setTimeout(() => rmSync(startLock, { force: true }), STAGGER_MS).unref();
    return true;
  } catch {
    if (existsSync(startLock) && Date.now() - statSync(startLock).mtimeMs > STAGGER_MS * 2) {
      rmSync(startLock, { force: true });
    }
    return false;
  }
}

let slot = -1;
const release = (): void => {
  if (slot >= 0) rmSync(path.join(poolDir, `slot-${slot}.lock`), { force: true });
  slot = -1;
};
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let lastLog = 0;
const note = (msg: string): void => {
  if (Date.now() - lastLog > 20_000) {
    lastLog = Date.now();
    console.error(`[gate] waiting: ${msg}`);
  }
};

for (;;) {
  if (slot < 0) slot = claimSlot();
  if (slot < 0) {
    note(`all ${maxSlots} "${pool}" slots busy`);
  } else {
    const usedGb = (os.totalmem() - os.freemem()) / GB;
    if (usedGb + costMb / 1024 > ceilingGb) {
      note(`${usedGb.toFixed(1)} GB in use, ceiling ${ceilingGb} GB, job needs ~${costMb} MB`);
    } else if (claimStart()) {
      break;
    }
  }
  await sleep(POLL_MS + Math.random() * 500);
}

const env = { ...process.env };
if (pool === 'dev' && !env.PORT) env.PORT = String(3100 + slot);
const bin = cmd === 'bun' ? process.execPath : cmd;
const child = spawn(bin, cmdArgs, { stdio: 'inherit', cwd, env });
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
