// Build per-OS installers with the plugin + credentials baked in.
//
//   $ bun installer/build-release.ts [--server URL] [--token TOKEN]
//
// Defaults pull from $SERVER_URL and $PLAYER_TOKEN env vars (or values in
// the server's .env.local). Output lands in compendium-ai/dist/ as
// `compendium-mac.sh`, `compendium-linux.sh`, `compendium-windows.ps1`
// (+ a `.bat` wrapper). Friends download one file and double-click.

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PLUGIN_DIR = join(ROOT, 'plugin');
const TEMPLATE_DIR = join(ROOT, 'installer', 'templates');
const DIST_DIR = join(ROOT, 'dist');

function parseArgs(): { serverUrl: string; playerToken: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const serverUrl = get('--server') ?? process.env.SERVER_URL ?? process.env.COMPENDIUM_SERVER_URL ?? '';
  const playerToken = get('--token') ?? process.env.PLAYER_TOKEN ?? process.env.COMPENDIUM_PLAYER_TOKEN ?? '';

  if (!serverUrl) {
    console.error('build-release: --server URL (or SERVER_URL env) is required');
    process.exit(1);
  }
  if (!playerToken) {
    console.error('build-release: --token TOKEN (or PLAYER_TOKEN env) is required');
    process.exit(1);
  }

  return { serverUrl: serverUrl.replace(/\/+$/, ''), playerToken };
}

function buildPlugin(): void {
  console.log('[build] bundling plugin…');
  execSync('bun run build', { cwd: PLUGIN_DIR, stdio: 'inherit' });
}

function readBase64(path: string): string {
  const bytes = readFileSync(path);
  // Wrap at 76 columns so heredoc shells don't choke on single-line BLOBs.
  return bytes.toString('base64').replace(/(.{76})/g, '$1\n');
}

function render(
  templatePath: string,
  replacements: Record<string, string>,
): string {
  let src = readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    src = src.replaceAll(`__${key}__`, value);
  }
  return src;
}

function withUtf8Bom(content: string): string {
  // PowerShell 5.1 reads UTF-8 files without a BOM as Windows-1252, which
  // corrupts non-ASCII characters. Baking a BOM keeps the script parseable.
  return '\uFEFF' + content;
}

function main(): void {
  const { serverUrl, playerToken } = parseArgs();
  if (!existsSync(TEMPLATE_DIR)) {
    console.error(`templates missing: ${TEMPLATE_DIR}`);
    process.exit(1);
  }

  buildPlugin();

  const mainJsBase64 = readBase64(join(PLUGIN_DIR, 'main.js'));
  const manifestBase64 = readBase64(join(PLUGIN_DIR, 'manifest.json'));

  const repl = {
    SERVER_URL: serverUrl,
    PLAYER_TOKEN: playerToken,
    MAIN_JS_BASE64: mainJsBase64,
    MANIFEST_BASE64: manifestBase64,
  };

  mkdirSync(DIST_DIR, { recursive: true });

  const mac = render(join(TEMPLATE_DIR, 'install-mac.sh'), repl);
  writeFileSync(join(DIST_DIR, 'compendium-mac.sh'), mac, { mode: 0o755 });
  writeFileSync(join(DIST_DIR, 'compendium-mac.command'), mac, { mode: 0o755 });

  const linux = render(join(TEMPLATE_DIR, 'install-linux.sh'), repl);
  writeFileSync(join(DIST_DIR, 'compendium-linux.sh'), linux, { mode: 0o755 });

  const win = render(join(TEMPLATE_DIR, 'install-windows.ps1'), repl);
  writeFileSync(join(DIST_DIR, 'compendium-windows.ps1'), withUtf8Bom(win));
  cpSync(
    join(TEMPLATE_DIR, 'install-windows.bat'),
    join(DIST_DIR, 'compendium-windows.bat'),
  );

  console.log('');
  console.log(`[build] wrote installers to ${DIST_DIR}:`);
  console.log(`        compendium-mac.sh   (also .command for double-click)`);
  console.log(`        compendium-linux.sh`);
  console.log(`        compendium-windows.ps1 + compendium-windows.bat`);
  console.log('');
  console.log(`server: ${serverUrl}`);
  console.log(`token:  ${playerToken.slice(0, 4)}…${playerToken.slice(-4)} (${playerToken.length} chars)`);
}

main();
