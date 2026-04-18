// End-to-end connection probe used by the settings pane's "Test" button.
// Runs three discrete stages — health, inventory, WebSocket — because a
// reverse proxy that passes HTTP often still drops `Upgrade: websocket`.
// Without the WS stage, a friend can see "connection OK" while sync is
// quietly dead. The probe uses the native `WebSocket` constructor rather
// than `y-websocket`'s provider to keep the lifecycle simple and the
// timeout tight.

import { requestUrl } from 'obsidian';
import { WS_PATH } from '@compendium/shared';
import type { HttpConfig } from './http';

export type PreflightStage = 'health' | 'inventory' | 'ws';

export type PreflightResult =
  | { ok: true }
  | { ok: false; stage: PreflightStage; reason: string };

const WS_OPEN_TIMEOUT_MS = 3000;
const WS_FIRST_MESSAGE_TIMEOUT_MS = 2000;

function httpBase(cfg: HttpConfig): string {
  return cfg.serverUrl.replace(/\/+$/, '');
}

function wsBase(cfg: HttpConfig): string {
  return cfg.serverUrl.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/+$/, '');
}

export async function preflight(cfg: HttpConfig): Promise<PreflightResult> {
  // Stage 1 — /api/health: unauthenticated liveness probe.
  try {
    const res = await requestUrl({
      url: `${httpBase(cfg)}/api/health`,
      method: 'GET',
      throw: false,
    });
    if (res.status !== 200) {
      return { ok: false, stage: 'health', reason: `health ${res.status}` };
    }
  } catch (err) {
    return { ok: false, stage: 'health', reason: describe(err) };
  }

  // Stage 2 — /api/inventory: confirms the token authenticates over HTTP.
  try {
    const res = await requestUrl({
      url: `${httpBase(cfg)}/api/inventory`,
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.authToken}` },
      throw: false,
    });
    if (res.status !== 200) {
      return { ok: false, stage: 'inventory', reason: `inventory ${res.status}` };
    }
  } catch (err) {
    return { ok: false, stage: 'inventory', reason: describe(err) };
  }

  // Stage 3 — WebSocket handshake to /sync/.preflight with token.
  return await wsProbe(cfg);
}

function wsProbe(cfg: HttpConfig): Promise<PreflightResult> {
  return new Promise<PreflightResult>((resolve) => {
    const url = `${wsBase(cfg)}${WS_PATH}/.preflight?token=${encodeURIComponent(cfg.authToken)}`;
    let settled = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let messageTimer: ReturnType<typeof setTimeout> | null = null;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      resolve({ ok: false, stage: 'ws', reason: describe(err) });
      return;
    }
    ws.binaryType = 'arraybuffer';

    const finish = (result: PreflightResult): void => {
      if (settled) return;
      settled = true;
      if (openTimer) clearTimeout(openTimer);
      if (messageTimer) clearTimeout(messageTimer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    openTimer = setTimeout(
      () => finish({ ok: false, stage: 'ws', reason: 'handshake timeout' }),
      WS_OPEN_TIMEOUT_MS,
    );

    ws.onopen = (): void => {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      messageTimer = setTimeout(
        () => finish({ ok: false, stage: 'ws', reason: 'no sync response' }),
        WS_FIRST_MESSAGE_TIMEOUT_MS,
      );
    };

    ws.onmessage = (): void => {
      finish({ ok: true });
    };

    ws.onerror = (): void => {
      finish({ ok: false, stage: 'ws', reason: 'connection error' });
    };

    ws.onclose = (event: CloseEvent): void => {
      // Server closes with 1000 after sending its sync-step-1 frame. If we
      // get here before onmessage (rare but possible on slow pipes), treat
      // the close code as the failure reason.
      if (event.code === 1000) {
        finish({ ok: true });
      } else if (event.code === 1008 || event.code === 4401) {
        finish({ ok: false, stage: 'ws', reason: 'auth rejected' });
      } else {
        finish({ ok: false, stage: 'ws', reason: `closed (${event.code || 'no code'})` });
      }
    };
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 120);
  if (typeof err === 'string') return err.slice(0, 120);
  return 'unknown error';
}
