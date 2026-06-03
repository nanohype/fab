import { describe, it, expect } from 'vitest';
import { rateFor, estimateCost, MODEL_RATES } from '../src/pricing.js';

describe('rateFor', () => {
  it('maps opus / sonnet / haiku by substring (incl. bedrock-prefixed ids)', () => {
    expect(rateFor('claude-opus-4-8')).toBe(MODEL_RATES.opus);
    expect(rateFor('claude-sonnet-4-6')).toBe(MODEL_RATES.sonnet);
    expect(rateFor('claude-haiku-4-5')).toBe(MODEL_RATES.haiku);
    expect(rateFor('anthropic.claude-opus-4-8')).toBe(MODEL_RATES.opus);
  });

  it('falls back to sonnet for unknown or undefined ids', () => {
    expect(rateFor(undefined)).toBe(MODEL_RATES.sonnet);
    expect(rateFor('gpt-4')).toBe(MODEL_RATES.sonnet);
  });
});

describe('estimateCost', () => {
  it('prices input + output at the resolved model tier', () => {
    expect(estimateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-sonnet-4-6')).toBeCloseTo(18); // 3 + 15
    expect(estimateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-opus-4-8')).toBeCloseTo(30); // 5 + 25
    expect(estimateCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-haiku-4-5')).toBeCloseTo(6); // 1 + 5
  });

  it('prices cache reads at 0.1x input and writes at 1.25x input', () => {
    const c = estimateCost(
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(c).toBeCloseTo(0.3 + 3.75); // sonnet input $3 → read 0.1x, write 1.25x
  });

  it('treats null / absent cache fields as zero', () => {
    expect(
      estimateCost({ input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: null }, 'claude-sonnet-4-6'),
    ).toBeCloseTo(3);
  });
});
