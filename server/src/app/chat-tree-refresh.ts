'use client';

// Shared helpers so HomeChat + ChatPane stay aligned: AI tool mutations
// that add/move notes must trigger the same refresh path as FileTree
// (router.refresh + awareness bump for peers).

import { useEffect, useRef } from 'react';
import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai';
import { isToolUIPart } from 'ai';
import { broadcastTreeChange } from '@/lib/tree-sync';

export function noteEditorHref(notePath: string): string {
  const clean = notePath.trim();
  if (!clean) return '/notes';
  return `/notes/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

function toolNameFromPart(part: UIMessagePart<UIDataTypes, UITools>): string {
  if (!isToolUIPart(part)) return '';
  const p = part as { toolName?: string; type?: string };
  if (typeof p.toolName === 'string' && p.toolName.length > 0) return p.toolName;
  const t = p.type;
  if (typeof t === 'string' && t.startsWith('tool-')) return t.slice('tool-'.length);
  return '';
}

function toolDedupeKey(
  msg: UIMessage,
  partIndex: number,
  part: UIMessagePart<UIDataTypes, UITools>,
): string {
  const mid = typeof msg.id === 'string' && msg.id.length > 0 ? msg.id : '_';
  const p = part as { toolCallId?: string };
  const tc =
    typeof p.toolCallId === 'string' && p.toolCallId.length > 0
      ? p.toolCallId
      : String(partIndex);
  return `${mid}:${tc}`;
}

/** When the model finishes entity_create / entity_move, refresh the
 *  server-rendered sidebar (same as manual creates). PresenceClient
 *  skips self-refresh on local tree bumps, so we call `refresh()`
 *  explicitly here. */
export function useRefreshTreeOnAiNoteMutations(
  messages: UIMessage[],
  refresh: () => void,
): void {
  const seen = useRef(new Set<string>());

  useEffect(() => {
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (!msg || msg.role !== 'assistant') continue;
      const parts = msg.parts;
      if (!Array.isArray(parts)) continue;
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        if (!part) continue;
        const tn = toolNameFromPart(part);
        if (tn !== 'entity_create' && tn !== 'entity_move') continue;
        if (!isToolUIPart(part)) continue;
        const state = (part as { state?: string }).state;
        if (state !== 'output-available') continue;
        const out = (part as { output?: unknown }).output as
          | { ok?: boolean; path?: string }
          | undefined;
        if (!out?.ok || typeof out.path !== 'string' || !out.path) continue;
        const key = `${toolDedupeKey(msg, pi, part)}:${tn}:${out.path}`;
        if (seen.current.has(key)) continue;
        seen.current.add(key);
        refresh();
        broadcastTreeChange();
      }
    }
  }, [messages, refresh]);
}
