import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER, PRESETS } from '../../src/core/provider';
import { COST_UNKNOWN, costLabel, estimateCost, REVIEW_EXPECTED, smartPricing } from '../../src/core/review-cost';
import { profileBuildCost } from '../../src/core/style-profile';

const SONNET = { model: 'claude-sonnet-5-5' };

describe('estimateCost', () => {
  it('prices ceil(chars / 4) + 1500 input tokens and the output tokens', () => {
    expect(estimateCost(SONNET, 4000, 1200)).toBe(((1000 + 1500) * 2 + 1200 * 10) / 1e6);
    expect(estimateCost(SONNET, 4001, 0)).toBe(((1001 + 1500) * 2) / 1e6);
  });
  it('uses the model own prices', () => {
    expect(estimateCost({ model: 'claude-haiku-5-5' }, 4000, 1200)).toBe(((1000 + 1500) * 0.1 + 1200 * 0.5) / 1e6);
  });
  it('adds a cent per search', () => {
    expect(estimateCost(SONNET, 0, 0, 3)).toBeCloseTo((1500 * 2) / 1e6 + 0.03, 10);
  });
  it('prices another provider\'s model at the writer\'s prices', () => {
    const pricing = { model: 'gpt-b', prices: { 'gpt-b': { input: 2, output: 8 } } };
    expect(estimateCost(pricing, 4000, 1200)).toBe(((1000 + 1500) * 2 + 1200 * 8) / 1e6);
  });
  it('is null for a model with no prices, searches or not: never a guess, and never Claude\'s', () => {
    expect(estimateCost({ model: 'x' }, 4000, 1200, 2)).toBeNull();
    expect(estimateCost({ model: 'x' }, 4000, 1200)).toBeNull();
    expect(estimateCost({ model: 'gpt-b', prices: { 'gpt-a': { input: 1, output: 1 } } }, 4000, 1200)).toBeNull();
  });
  it.each(['constructor', 'toString', '__proto__'])('is null for %s: an object built-in is not a price', (model) => {
    expect(estimateCost({ model }, 4000, 1200, 1)).toBeNull();
    expect(estimateCost({ model, prices: {} }, 4000, 1200)).toBeNull();
  });
  it('has the expected output tokens per agent', () => {
    expect(REVIEW_EXPECTED).toEqual({ readers: 1200, grader: 1800, deepCheck: 3000, citations: 1500 });
  });
});

describe('smartPricing', () => {
  it('is Sonnet for Claude, and the smart model with the writer\'s prices for another provider', () => {
    expect(smartPricing(DEFAULT_PROVIDER)).toEqual(SONNET);
    const prices = { 'gpt-b': { input: 2, output: 8 } };
    const compat = { preset: 'openai' as const, baseURL: PRESETS.openai.baseURL, fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices };
    expect(smartPricing({ active: 'compatible', compatible: compat })).toEqual({ model: 'gpt-b', prices });
    // Saved but not in use: Claude still runs the reviews.
    expect(smartPricing({ active: 'anthropic', compatible: compat })).toEqual(SONNET);
  });
});

describe('profileBuildCost', () => {
  it('prices the build on the given model, and is null without prices', () => {
    expect(profileBuildCost(4000, SONNET)).toBe(estimateCost(SONNET, 4000, 600));
    expect(profileBuildCost(100, SONNET)).toBe(estimateCost(SONNET, 300, 600)); // the fewest characters a build takes
    expect(profileBuildCost(4000, { model: 'llama' })).toBeNull();
  });
});

describe('costLabel', () => {
  it('reads under a cent as "under $0.01"', () => {
    expect(costLabel(0.004)).toBe('under $0.01');
    expect(costLabel(0)).toBe('under $0.01');
    expect(costLabel(0.0099)).toBe('under $0.01');
  });
  it('rounds up to the cent otherwise', () => {
    expect(costLabel(0.0231)).toBe('about $0.03');
    expect(costLabel(0.01)).toBe('about $0.01');
    expect(costLabel(0.02)).toBe('about $0.02');
    expect(costLabel(1.2)).toBe('about $1.20');
  });
  it('is null for a cost that isn\'t known, which the cards say in words', () => {
    expect(costLabel(null)).toBeNull();
    expect(COST_UNKNOWN).toBe('Cost not known for this model.');
  });
});
