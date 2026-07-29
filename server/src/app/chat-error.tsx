// Shared error rendering for the AI chat surfaces (HomeChat + ChatPane).
//
// Both surfaces call useChat() from @ai-sdk/react and both need to show
// the user something when the AI request fails — without this, a failed
// request just leaves whichever surface it happened on stuck on
// "Thinking…" forever with no explanation. Keep this the single source of
// truth for that treatment; do not re-implement it locally in either
// component (that drift is exactly how ChatPane missed the fix that
// shipped for HomeChat).

import type { ReactElement } from 'react';

// AI SDK errors arrive as JSON-stringified SSE error events. Pull out the
// underlying provider message so the user sees "You exceeded your current
// quota" rather than a wall of JSON.
export function readableError(raw: string | undefined): string {
  if (!raw) return 'unknown error';
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    const msg = parsed.error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  } catch {
    /* not JSON — fall through */
  }
  return raw;
}

/** Wine-coloured error bubble shown in place of the "Thinking…" indicator
 *  once useChat()'s `error` is set. Render only when `!isStreaming` — a
 *  transient error can still coexist with an in-flight retry. */
export function ChatErrorBubble({ message }: { message: string | undefined }): ReactElement {
  return (
    <div className="max-w-[min(92%,100%)] rounded-[10px] bg-[#F4E4E4] px-3 py-2 text-[12px] text-[#6B2F38]">
      Couldn't reach the AI: {readableError(message)}
    </div>
  );
}
