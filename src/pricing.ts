/**
 * Single source of truth for Claude token pricing + cost estimation, shared by
 * the usage report (`usage.ts`), the live budget tracker (`workflows.ts`), and
 * the per-role perf report (`perf.ts`). These previously carried three
 * divergent copies — two of them Sonnet-flat ($3/$15 for every role) — so an
 * Opus advisor/lab session was mispriced and a rate-card change meant editing
 * three files. fab sums the token counts the API returns (there is no
 * client-side tokenizer), so these rates are the only thing to keep current.
 *
 * Per-MTok (USD, mid-2026): Opus 4.x $5/$25, Sonnet 4.x $3/$15, Haiku 4.x $1/$5.
 * Cache reads bill at 0.1x the input rate; 5-minute cache writes at 1.25x.
 */

export interface ModelRate {
  input: number;
  output: number;
}

export const MODEL_RATES: Record<'opus' | 'sonnet' | 'haiku', ModelRate> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Resolve a model id to its tier rate; unknown ids fall back to Sonnet. */
export function rateFor(modelId: string | undefined): ModelRate {
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('opus')) return MODEL_RATES.opus;
  if (id.includes('haiku')) return MODEL_RATES.haiku;
  return MODEL_RATES.sonnet; // default covers sonnet and any unmapped id
}

/** Token counts an estimate can price; cache fields optional/nullable. */
export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Estimate USD cost for one usage block at the given model's tier rate. */
export function estimateCost(usage: UsageTokens, modelId: string | undefined): number {
  const rate = rateFor(modelId);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputCost =
    (usage.input_tokens / 1_000_000) * rate.input +
    (cacheRead / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER +
    (cacheWrite / 1_000_000) * rate.input * CACHE_WRITE_MULTIPLIER;
  const outputCost = (usage.output_tokens / 1_000_000) * rate.output;
  return inputCost + outputCost;
}
