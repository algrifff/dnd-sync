// Thin HTTP helper around Obsidian's requestUrl — which bypasses Electron's
// CORS enforcement (fetch() doesn't work against some self-hosted backends
// without this). All requests carry the Bearer token.

import { requestUrl } from 'obsidian';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

export type HttpConfig = {
  serverUrl: string;
  authToken: string;
};

export type InventoryResponse = {
  textDocs: Array<{ path: string; updatedAt: number; bytes: number }>;
  binaryFiles: Array<{
    path: string;
    mimeType: string;
    size: number;
    updatedAt: number;
    contentHash: string;
  }>;
};

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function fetchInventory(cfg: HttpConfig): Promise<InventoryResponse> {
  const res = await doRequest(cfg, {
    url: `${normalizeBase(cfg.serverUrl)}/api/inventory`,
    method: 'GET',
  });
  if (res.status !== 200) throw new Error(`inventory failed: ${res.status}`);
  return JSON.parse(res.text) as InventoryResponse;
}

export async function putBinary(
  cfg: HttpConfig,
  path: string,
  data: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  const res = await doRequest(cfg, {
    url: `${normalizeBase(cfg.serverUrl)}/api/files/${encodePath(path)}`,
    method: 'PUT',
    contentType: mimeType,
    body: data,
  });
  if (res.status !== 200) throw new Error(`upload failed: ${res.status}`);
}

export async function getBinary(cfg: HttpConfig, path: string): Promise<ArrayBuffer | null> {
  const res = await doRequest(cfg, {
    url: `${normalizeBase(cfg.serverUrl)}/api/files/${encodePath(path)}`,
    method: 'GET',
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`download failed: ${res.status}`);
  return res.arrayBuffer;
}

export async function deleteBinary(cfg: HttpConfig, path: string): Promise<void> {
  const res = await doRequest(cfg, {
    url: `${normalizeBase(cfg.serverUrl)}/api/files/${encodePath(path)}`,
    method: 'DELETE',
  });
  if (res.status !== 200 && res.status !== 404) {
    throw new Error(`delete failed: ${res.status}`);
  }
}

export async function fetchPluginVersion(cfg: HttpConfig): Promise<{ hash: string }> {
  const res = await doRequest(cfg, {
    url: `${normalizeBase(cfg.serverUrl)}/api/plugin/version`,
    method: 'GET',
  });
  if (res.status !== 200) throw new Error(`plugin version failed: ${res.status}`);
  return JSON.parse(res.text) as { hash: string };
}

export async function fetchPluginBundle(cfg: HttpConfig): Promise<ArrayBuffer> {
  const res = await doRequest(cfg, {
    url: `${normalizeBase(cfg.serverUrl)}/api/plugin/bundle`,
    method: 'GET',
  });
  if (res.status !== 200) throw new Error(`plugin bundle failed: ${res.status}`);
  return res.arrayBuffer;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function doRequest(cfg: HttpConfig, opts: RequestUrlParam): Promise<RequestUrlResponse> {
  return requestUrl({
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${cfg.authToken}`,
    },
    throw: false,
  });
}
