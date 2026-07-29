// Guards against unbounded AI-provider spend from client-controlled input.
//
// Two call sites feed free-form, client- or user-authored text straight into
// a paid model call:
//   - POST /api/chat replays the ENTIRE client-side conversation on every
//     turn (the client is the source of truth for history — it reloads it
//     from localStorage). `stopWhen: stepCountIs(8)` in that route bounds
//     the tool-call LOOP, not the input, so nothing stops a client sending
//     thousands of historical messages before a single token streams back.
//   - POST /api/sessions/end reads a session note's body straight from the
//     DB and sends it as the prompt for a multi-step extraction pass. That
//     content is ordinary user-authored note text with no length cap of
//     its own.
//
// These checks are deliberately a character-length heuristic, not a real
// tokenizer — pulling in a tokenizer dependency for a cost-guard is not
// worth the weight. ~4 characters/token is a conservative rule of thumb
// for English prose and JSON, so a character ceiling with generous
// headroom bounds worst-case spend without ever tripping on a legitimate
// session.

export type InputBudgetResult =
  | { ok: true }
  | { ok: false; error: string; reason: string };

// Chat history (client-supplied UIMessage[] array).
//
// The UI nests a whole turn's tool calls/results as `parts` inside ONE
// UIMessage, so array length tracks conversation TURNS, not raw model
// steps. A genuinely long real-time session — hours of back-and-forth
// plus GM tool use — realistically runs to a few dozen turns (~60-120
// array entries). 300 entries is roughly a 150-turn conversation: far
// beyond anything a real session produces, but still a hard ceiling on
// a client that starts appending synthetic history.
export const MAX_CHAT_MESSAGES = 300;

// Total serialized size of the messages array. gpt-4o-mini-class models
// have context windows in the ~128k-token range; 400,000 characters is
// ~100k tokens at the 4-chars/token heuristic — big enough that no real
// conversation (even one full of large tool-result JSON blobs) should
// hit it, but small enough to cap worst-case per-request cost well
// before the request would otherwise fail from the provider's own
// context-length limit anyway.
export const MAX_CHAT_INPUT_CHARS = 400_000;

// Session-note body fed into the session-end extraction prompt. A
// session log is prose written by one GM/player after one session —
// realistically a few thousand words (tens of KB). 200,000 characters
// (~50k tokens) is generous enough to never affect a real write-up
// while bounding a pathological paste.
export const MAX_SESSION_NOTE_CHARS = 200_000;

/** Character-length heuristic for a JSON-serializable value. Never
 *  throws — an unserializable value is treated as "too big" so it
 *  fails closed rather than silently passing an unbounded payload
 *  through. */
function estimateChars(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return s ? s.length : 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Reject a chat history that is implausibly long before it reaches
 *  convertToModelMessages()/streamText(). Checked in two dimensions
 *  because either alone can be gamed: many tiny messages, or a
 *  handful of enormous ones. */
export function checkChatMessageBudget(messages: unknown[]): InputBudgetResult {
  if (messages.length > MAX_CHAT_MESSAGES) {
    return {
      ok: false,
      error: 'too_many_messages',
      reason: `messages array has ${messages.length} entries, exceeding the ${MAX_CHAT_MESSAGES}-entry limit`,
    };
  }
  const chars = estimateChars(messages);
  if (chars > MAX_CHAT_INPUT_CHARS) {
    return {
      ok: false,
      error: 'input_too_large',
      reason: `estimated message payload is ${chars} characters, exceeding the ${MAX_CHAT_INPUT_CHARS}-character limit`,
    };
  }
  return { ok: true };
}

/** Reject a session note body that is implausibly long before it is
 *  sent as the extraction prompt in /api/sessions/end. */
export function checkSessionNoteBudget(content: string): InputBudgetResult {
  if (content.length > MAX_SESSION_NOTE_CHARS) {
    return {
      ok: false,
      error: 'session_too_large',
      reason: `session note body is ${content.length} characters, exceeding the ${MAX_SESSION_NOTE_CHARS}-character limit`,
    };
  }
  return { ok: true };
}
