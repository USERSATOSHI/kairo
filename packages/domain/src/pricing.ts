import type { TokenUsage } from './types.ts';

/**
 * Best-effort per-model token pricing used to estimate attempt cost.
 *
 * Prices are USD per million tokens and follow each provider's published list
 * price at the time of writing. Kouro never persists money: cost is a derived
 * display value computed from durable token usage and this table.
 */

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** Reads from a prompt cache cost less; falls back to input price. */
  readonly cacheReadPerMTok?: number;
  /** Writes to a prompt cache require an explicit provider-specific rate. */
  readonly cacheWritePerMTok?: number;
}

export interface PricingRule {
  readonly match: RegExp;
  readonly pricing: ModelPricing;
}

export const PRICING_RULES: readonly PricingRule[] = [
  {
    match: /^claude-opus-4/,
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  },
  {
    match: /^claude-sonnet-4/,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  },
  {
    match: /^claude-haiku-3/,
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08 },
  },
  { match: /^gpt-5/, pricing: { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.625 } },
  {
    match: /^gpt-4o-mini/,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  },
  { match: /^gpt-4o/, pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 } },
  { match: /^gpt-4/, pricing: { inputPerMTok: 30, outputPerMTok: 60, cacheReadPerMTok: 15 } },
  { match: /^gemini-2\.5/, pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } },
  {
    match: /^gemini-2\.0-flash/,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  },
  { match: /^gemini-2\.0/, pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } },
  { match: /^o3-mini/, pricing: { inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.55 } },
  { match: /^o3/, pricing: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 1 } },
];

/**
 * Normalizes a model identifier for pricing lookup.
 *
 * OpenCode models arrive as `provider/model` while other harnesses accept a
 * bare id, so anything before the final slash is stripped. The comparison
 * itself is prefix-based because workflow authors use partial ids.
 */
export function pricingModelId(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1).toLowerCase();
}

export function pricingFor(model: string): ModelPricing | undefined {
  const normalized = pricingModelId(model);
  return PRICING_RULES.find(({ match }) => match.test(normalized))?.pricing;
}

/** Estimates the USD cost of one attempt's token usage, or undefined when the model is unpriced. */
export function estimateCostUsd(usage: TokenUsage, model?: string): number | undefined {
  const pricing = model ? pricingFor(model) : undefined;
  if (!pricing) return undefined;
  const input = (usage.inputTokens * pricing.inputPerMTok) / 1_000_000;
  const output = (usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
  const cacheReadPrice = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheRead = ((usage.cacheReadTokens ?? 0) * cacheReadPrice) / 1_000_000;
  if (usage.cacheWriteTokens && pricing.cacheWritePerMTok === undefined) return undefined;
  const cacheWrite = ((usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePerMTok ?? 0)) / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

/** Sums token usage across attempts so a task-level total can be displayed. */
export function sumUsage(usage: readonly TokenUsage[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let reasoningTokens: number | undefined;
  for (const item of usage) {
    inputTokens += item.inputTokens;
    outputTokens += item.outputTokens;
    if (item.cacheReadTokens !== undefined) {
      cacheReadTokens = (cacheReadTokens ?? 0) + item.cacheReadTokens;
    }
    if (item.cacheWriteTokens !== undefined) {
      cacheWriteTokens = (cacheWriteTokens ?? 0) + item.cacheWriteTokens;
    }
    if (item.reasoningTokens !== undefined) {
      reasoningTokens = (reasoningTokens ?? 0) + item.reasoningTokens;
    }
  }
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}
