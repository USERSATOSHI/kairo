import { describe, expect, test } from 'bun:test';

import {
  estimateCostUsd,
  PRICING_RULES,
  pricingFor,
  pricingModelId,
  sumUsage,
} from '@kouro/domain';

describe('domain pricing estimates', () => {
  test('strips the provider prefix from opencode-style model ids', () => {
    expect(pricingModelId('openai/gpt-4o')).toBe('gpt-4o');
    expect(pricingModelId('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(pricingModelId('claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  test('estimates cost from per-token prices for a priced model', () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 200_000 }, 'gpt-4o');
    // 1M input @ $2.50/MTok + 200k output @ $10/MTok
    expect(cost).toBeCloseTo(4.5, 5);
  });

  test('accounts cache-read tokens at the cache rate', () => {
    const cost = estimateCostUsd(
      { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 400_000 },
      'claude-sonnet-4',
    );
    // 0.1M @ $3 + 0.02M @ $15 + 0.4M @ 0.3 (10% of $3 cache read)
    expect(cost).toBeCloseTo(0.3 + 0.3 + 0.12, 6);
  });

  test('does not estimate a partial cost when cache writes have no configured rate', () => {
    expect(
      estimateCostUsd(
        { inputTokens: 100_000, outputTokens: 20_000, cacheWriteTokens: 400_000 },
        'gpt-4o',
      ),
    ).toBeUndefined();
  });

  test('returns undefined for a model without a price or no model', () => {
    expect(
      estimateCostUsd({ inputTokens: 100, outputTokens: 50 }, 'my-custom-model-x7'),
    ).toBeUndefined();
    expect(estimateCostUsd({ inputTokens: 100, outputTokens: 50 })).toBeUndefined();
  });

  test('the price table matches real model prefixes', () => {
    expect(PRICING_RULES.length).toBeGreaterThan(0);
    expect(pricingFor('gpt-4o-mini')?.inputPerMTok).toBe(0.15);
    expect(pricingFor('claude-opus-4-1')?.outputPerMTok).toBe(75);
    expect(pricingFor('gemini-2.5-pro')).toBeDefined();
  });

  test('sums usage across attempts including optional cache fields', () => {
    const total = sumUsage([
      {
        inputTokens: 100_000,
        outputTokens: 50_000,
        cacheReadTokens: 10_000,
        reasoningTokens: 5_000,
      },
      { inputTokens: 200_000, outputTokens: 100_000 },
    ]);
    expect(total).toEqual({
      inputTokens: 300_000,
      outputTokens: 150_000,
      cacheReadTokens: 10_000,
      reasoningTokens: 5_000,
    });
  });
});
