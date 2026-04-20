// Per-model cost estimates for OpenAI usage. Keyed by model slug.
// Prices are USD per million tokens and are rough — OpenAI's pricing
// page is the source of truth; treat these as "good enough for the
// running-cost display". Unknown models fall back to GPT-5-mini rates
// with a console warning so the number is an honest over-estimate.

export type ModelRates = {
  inputPerMTok: number;
  outputPerMTok: number;  // reasoning_tokens are billed at this rate too
};

const RATES: Record<string, ModelRates> = {
  // GPT-5 family (Responses API)
  'gpt-5':       { inputPerMTok: 1.25,  outputPerMTok: 10.0 },
  'gpt-5-mini':  { inputPerMTok: 0.25,  outputPerMTok: 2.0 },
  'gpt-5-nano':  { inputPerMTok: 0.05,  outputPerMTok: 0.4 },
  // Legacy reasoning line (o3 / o4)
  'o3':          { inputPerMTok: 2.0,   outputPerMTok: 8.0 },
  'o3-mini':     { inputPerMTok: 1.1,   outputPerMTok: 4.4 },
  'o4-mini':     { inputPerMTok: 1.1,   outputPerMTok: 4.4 },
  // GPT-4 family (Chat Completions)
  'gpt-4o':      { inputPerMTok: 2.5,   outputPerMTok: 10.0 },
  'gpt-4o-mini': { inputPerMTok: 0.15,  outputPerMTok: 0.6 },
  'gpt-4.1':     { inputPerMTok: 2.0,   outputPerMTok: 8.0 },
  'gpt-4.1-mini':{ inputPerMTok: 0.4,   outputPerMTok: 1.6 },
};

const FALLBACK: ModelRates = RATES['gpt-5-mini']!;

export function ratesFor(model: string): ModelRates {
  // Match by longest-prefix so dated variants like 'gpt-5-mini-2025-xx-xx'
  // still hit the canonical rate.
  const keys = Object.keys(RATES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (model === k || model.startsWith(k + '-') || model.startsWith(k + '.')) {
      return RATES[k]!;
    }
  }
  console.warn(`[ai/pricing] no rate for model "${model}" — using GPT-5-mini rate`);
  return FALLBACK;
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;       // visible output
  reasoningTokens: number;    // billed like output but not returned
};

export function costUsd(model: string, u: TokenUsage): number {
  const r = ratesFor(model);
  const outputBilled = u.outputTokens + u.reasoningTokens;
  return (
    (u.inputTokens * r.inputPerMTok + outputBilled * r.outputPerMTok) / 1_000_000
  );
}
