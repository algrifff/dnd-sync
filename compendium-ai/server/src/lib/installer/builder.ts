// Server-side installer builder. At request time, reads the plugin bundle
// (copied into the image during docker build) and a template from disk,
// substitutes SERVER_URL / PLAYER_TOKEN / base64 payloads, and returns the
// file bytes.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type OsTarget = 'mac' | 'linux' | 'windows.ps1' | 'windows.bat';

export type InstallerParams = {
  serverUrl: string;
  playerToken: string;
  installerKey: string;
};

export type BuiltInstaller = {
  filename: string;
  contentType: string;
  body: Buffer;
};

// Resolved at module load. In the Next.js build, process.cwd() is the
// server package root (/app/server) both in dev and in the docker image.
const SERVER_ROOT = process.cwd();
const TEMPLATE_DIR = resolve(SERVER_ROOT, 'src/lib/installer/templates');
const BUNDLE_DIR =
  process.env.PLUGIN_BUNDLE_DIR ?? resolve(SERVER_ROOT, 'src/lib/installer/bundle');

function wrap76(s: string): string {
  return s.replace(/(.{76})/g, '$1\n');
}

function readBundle(name: 'main.js' | 'manifest.json'): string {
  const path = resolve(BUNDLE_DIR, name);
  return wrap76(readFileSync(path).toString('base64'));
}

function render(
  templateName: string,
  params: InstallerParams,
  extra: Record<string, string> = {},
): string {
  const templatePath = resolve(TEMPLATE_DIR, templateName);
  let src = readFileSync(templatePath, 'utf8');
  const replacements: Record<string, string> = {
    SERVER_URL: params.serverUrl,
    PLAYER_TOKEN: params.playerToken,
    INSTALLER_KEY: params.installerKey,
    MAIN_JS_BASE64: readBundle('main.js'),
    MANIFEST_BASE64: readBundle('manifest.json'),
    ...extra,
  };
  for (const [k, v] of Object.entries(replacements)) {
    src = src.replaceAll(`__${k}__`, v);
  }
  return src;
}

function buildWindowsBat(params: InstallerParams): string {
  // Tiny .bat that downloads the .ps1 (curl is built into Windows 10+) and
  // runs it. Friend double-clicks the .bat — one file to share.
  const url = `${params.serverUrl}/install/windows.ps1?key=${params.installerKey}`;
  return [
    '@echo off',
    'chcp 65001 > nul',
    'set "PS1_PATH=%TEMP%\\compendium-install.ps1"',
    `curl -fsSL -o "%PS1_PATH%" "${url}"`,
    'if %ERRORLEVEL% NEQ 0 (',
    '    echo Failed to download the Compendium installer.',
    '    pause',
    '    exit /b 1',
    ')',
    'powershell -ExecutionPolicy Bypass -File "%PS1_PATH%"',
    'del "%PS1_PATH%" >nul 2>&1',
    'if %ERRORLEVEL% NEQ 0 pause',
    '',
  ].join('\r\n');
}

export function buildInstaller(os: OsTarget, params: InstallerParams): BuiltInstaller {
  switch (os) {
    case 'mac': {
      const body = Buffer.from(render('install-mac.sh', params), 'utf8');
      return {
        filename: 'compendium-mac.command',
        contentType: 'application/x-sh; charset=utf-8',
        body,
      };
    }
    case 'linux': {
      const body = Buffer.from(render('install-linux.sh', params), 'utf8');
      return {
        filename: 'compendium-linux.sh',
        contentType: 'application/x-sh; charset=utf-8',
        body,
      };
    }
    case 'windows.ps1': {
      // PowerShell 5.1 needs a BOM to parse UTF-8 correctly.
      const body = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(render('install-windows.ps1', params), 'utf8'),
      ]);
      return {
        filename: 'compendium-install.ps1',
        contentType: 'text/plain; charset=utf-8',
        body,
      };
    }
    case 'windows.bat': {
      return {
        filename: 'compendium-windows.bat',
        contentType: 'application/bat; charset=utf-8',
        body: Buffer.from(buildWindowsBat(params), 'utf8'),
      };
    }
  }
}
