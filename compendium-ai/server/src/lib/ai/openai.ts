// OpenAI client wrapper.
//
// Exposes a single `generateStructured` method that hides the
// request/response shape differences between the two API surfaces we
// care about:
//
//   * Responses API (/v1/responses)   — GPT-5 family, o3 / o4 reasoning
//                                       models. Uses `input[]`, `text.format`
//                                       for the json_schema, and optional
//                                       `reasoning.effort`. Returns output
//                                       tokens split into visible +
//                                       reasoning counters.
//   * Chat Completions (/v1/chat/completions) — GPT-4o, GPT-4.1 families.
//                                       Uses `messages[]` + `response_format`.
//                                       Reasoning tokens aren't reported
//                                       because these models don't have
//                                       them.
//
// Dispatch is by model prefix; the request/response shape differences
// are handled internally so callers don't care which endpoint the
// model uses. Returns a typed `data` object validated against the
// caller's JSON schema (the server enforces strict mode) plus a
// normalised token-usage counter for the cost display.

import { costUsd, type TokenUsage } from './pricing';

const OPENAI_BASE = 'https://api.openai.com/v1';

export type StructuredRequest<T> = {
  /** Single system/developer message. */
  systemPrompt: string;
  /** Single user message. Keep it self-contained (no interleaved turns). */
  userContent: string;
  /** JSON Schema with `additionalProperties: false` and all properties in
   *  `required` — OpenAI's strict mode requires both. */
  schema: Record<string, unknown>;
  /** Short identifier for the schema; shows up in server logs if the
   *  model fails to produce valid JSON. */
  schemaName: string;
  /** Override the env-configured model for this specific call. */
  modelOverride?: string;
  /** Abort signal — the worker cancels in-flight calls when the job
   *  is cancelled. */
  signal?: AbortSignal;
  /** Marks the caller so we can thread through the parsed result type. */
  _t?: T;
};

export type StructuredResult<T> = {
  data: T;
  usage: TokenUsage;
  model: string;
  costUsd: number;
  rawOutputText: string;       // for debugging / audit
};

// ── Entry point ────────────────────────────────────────────────────────

export async function generateStructured<T>(
  req: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  const model = req.modelOverride ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini';
  const useResponsesApi = shouldUseResponsesApi(model);

  // One retry on schema-validation failure. Reasoning models with
  // `strict: true` almost never fail but we'd rather degrade to
  // "unclassified" than throw out of the worker.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return useResponsesApi
        ? await callResponsesApi<T>({ req, model, apiKey })
        : await callChatCompletions<T>({ req, model, apiKey });
    } catch (err) {
      lastErr = err;
      // Retry only on schema / parse errors. Network failures + HTTP
      // 4xx/5xx responses should surface on the first attempt.
      if (!(err instanceof StructuredParseError)) throw err;
    }
  }
  throw lastErr;
}

class StructuredParseError extends Error {
  constructor(message: string, readonly rawText: string) {
    super(message);
    this.name = 'StructuredParseError';
  }
}

// ── Responses API ──────────────────────────────────────────────────────

async function callResponsesApi<T>(args: {
  req: StructuredRequest<T>;
  model: string;
  apiKey: string;
}): Promise<StructuredResult<T>> {
  const { req, model, apiKey } = args;
  const effort =
    process.env.OPENAI_REASONING_EFFORT ?? 'minimal';

  const body: Record<string, unknown> = {
    model,
    input: [
      {
        role: 'developer',
        content: [{ type: 'input_text', text: req.systemPrompt }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: req.userContent }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: req.schemaName,
        strict: true,
        schema: req.schema,
      },
    },
    reasoning: { effort },
  };

  const res = await fetchOpenAi('/responses', apiKey, body, req.signal);

  // Responses-API payload:
  //   { output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  //     usage: { input_tokens, output_tokens,
  //              output_tokens_details: { reasoning_tokens } } }
  const json = (await res.json()) as ResponsesPayload;
  const text = pickResponsesOutputText(json);
  if (!text) {
    throw new StructuredParseError(
      'Responses API returned no output text',
      JSON.stringify(json),
    );
  }

  const parsed = tryParseJson<T>(text);

  const usage: TokenUsage = {
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    reasoningTokens: json.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };

  return {
    data: parsed,
    usage,
    model: json.model ?? model,
    costUsd: costUsd(json.model ?? model, usage),
    rawOutputText: text,
  };
}

type ResponsesPayload = {
  model?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

function pickResponsesOutputText(p: ResponsesPayload): string | null {
  for (const item of p.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return null;
}

// ── Chat Completions fallback ─────────────────────────────────────────

async function callChatCompletions<T>(args: {
  req: StructuredRequest<T>;
  model: string;
  apiKey: string;
}): Promise<StructuredResult<T>> {
  const { req, model, apiKey } = args;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: req.schemaName,
        strict: true,
        schema: req.schema,
      },
    },
  };

  const res = await fetchOpenAi('/chat/completions', apiKey, body, req.signal);
  const json = (await res.json()) as ChatPayload;
  const text = json.choices?.[0]?.message?.content ?? null;
  if (!text) {
    throw new StructuredParseError(
      'Chat Completions returned no content',
      JSON.stringify(json),
    );
  }

  const parsed = tryParseJson<T>(text);
  const usage: TokenUsage = {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    reasoningTokens: 0,
  };
  return {
    data: parsed,
    usage,
    model: json.model ?? model,
    costUsd: costUsd(json.model ?? model, usage),
    rawOutputText: text,
  };
}

type ChatPayload = {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// ── Shared ────────────────────────────────────────────────────────────

async function fetchOpenAi(
  path: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const res = await fetch(OPENAI_BASE + path, init);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // 400 for unsupported `reasoning` on some models — let the caller
    // strip + retry if they want. For now, surface the text.
    throw new Error(
      `OpenAI ${path} responded ${res.status}: ${errText.slice(0, 400)}`,
    );
  }
  return res;
}

function tryParseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new StructuredParseError(
      `OpenAI returned non-JSON output: ${err instanceof Error ? err.message : 'parse error'}`,
      text,
    );
  }
}

function shouldUseResponsesApi(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  );
}
