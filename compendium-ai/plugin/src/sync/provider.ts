// Wraps y-websocket's WebsocketProvider with the URL + auth shape our server
// expects, and exposes a typed status stream.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { WS_PATH } from '@compendium/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type SyncConfig = {
  serverUrl: string;
  authToken: string;
};

function toWsBase(httpOrWsUrl: string): string {
  return httpOrWsUrl.replace(/^http(s?):\/\//, 'ws$1://').replace(/\/+$/, '');
}

export function buildProvider(
  config: SyncConfig,
  docName: string,
  doc: Y.Doc,
): WebsocketProvider {
  const base = toWsBase(config.serverUrl) + WS_PATH;
  // y-websocket passes `params` as the query string on the handshake URL.
  // Our server accepts the token via ?token=... for this reason.
  return new WebsocketProvider(base, docName, doc, {
    params: { token: config.authToken },
    connect: true,
    disableBc: true, // no broadcast-channel cross-tab sync
  });
}
