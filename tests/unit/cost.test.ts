import { describe, expect, it } from 'vitest';
import { costFromUsage, isPriced, SEARCH_PRICE_USD, type UsageLike } from '../../src/core/cost';
import { SEARCH_PRICE_USD as REVIEW_SEARCH_PRICE } from '../../src/core/review-cost';

const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe('costFromUsage', () => {
  it('haiku 1M in + 1M out = 0.60', () => {
    expect(costFromUsage('claude-haiku-5-5', { ...zero, input_tokens: 1e6, output_tokens: 1e6 })).toBeCloseTo(0.6);
  });
  it('cache read 1M = 0.01', () => {
    expect(costFromUsage('claude-haiku-5-5', { ...zero, cache_read_input_tokens: 1e6 })).toBeCloseTo(0.01);
  });
  it('cache write 1M = 0.125', () => {
    expect(costFromUsage('claude-haiku-5-5', { ...zero, cache_creation_input_tokens: 1e6 })).toBeCloseTo(0.125);
  });
  it('null cache fields count as 0', () => {
    const u = { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null };
    expect(costFromUsage('claude-haiku-5-5', u)).toBeCloseTo(0.1);
  });
  it('missing (undefined) cache fields count as 0, not NaN', () => {
    const u = { input_tokens: 1e6, output_tokens: 0 } as unknown as UsageLike;
    expect(costFromUsage('claude-haiku-5-5', u)).toBeCloseTo(0.1);
  });
  it('sonnet 1M out = 10', () => {
    expect(costFromUsage('claude-sonnet-5-5', { ...zero, output_tokens: 1e6 })).toBeCloseTo(10);
  });
});

describe('costFromUsage for a model without prices', () => {
  const lots = { ...zero, input_tokens: 1e6, output_tokens: 1e6 };
  it('costs an unknown model nothing', () => {
    expect(costFromUsage('x', lots)).toBe(0);
  });
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('costs %s nothing: an object built-in is not a price', (model) => {
    expect(costFromUsage(model, lots)).toBe(0);
  });
});

describe('costFromUsage with web searches', () => {
  const tokens = { input_tokens: 1e6, output_tokens: 1e5, cache_creation_input_tokens: null, cache_read_input_tokens: null };
  const tokenCost = 2 + 1; // Sonnet: 1M in at $2, 100k out at $10

  it('adds $0.01 per web search request to the token cost', () => {
    expect(costFromUsage('claude-sonnet-5-5', { ...tokens, server_tool_use: { web_search_requests: 3 } })).toBeCloseTo(tokenCost + 0.03, 10);
  });
  it('a null or missing server_tool_use adds nothing', () => {
    expect(costFromUsage('claude-sonnet-5-5', { ...tokens, server_tool_use: null })).toBeCloseTo(tokenCost, 10);
    expect(costFromUsage('claude-sonnet-5-5', tokens)).toBeCloseTo(tokenCost, 10);
  });
  it('zero searches add nothing', () => {
    expect(costFromUsage('claude-sonnet-5-5', { ...tokens, server_tool_use: { web_search_requests: 0 } })).toBeCloseTo(tokenCost, 10);
  });
  it('the search price is a cent, shared with the estimate', () => {
    expect(SEARCH_PRICE_USD).toBe(0.01);
    expect(REVIEW_SEARCH_PRICE).toBe(SEARCH_PRICE_USD);
  });
});

describe('costFromUsage with the writer\'s prices', () => {
  const prices = { 'gpt-x': { input: 0.5, output: 2 } };
  it('prices a model from its entry, per million tokens', () => {
    expect(costFromUsage('gpt-x', { ...zero, input_tokens: 1e6 }, prices)).toBeCloseTo(0.5);
    expect(costFromUsage('gpt-x', { ...zero, output_tokens: 1e6 }, prices)).toBeCloseTo(2);
  });
  it('bills cached reads at the input price, and no cache writes', () => {
    expect(costFromUsage('gpt-x', { ...zero, cache_read_input_tokens: 1e6 }, prices)).toBeCloseTo(0.5);
    expect(costFromUsage('gpt-x', { ...zero, cache_creation_input_tokens: 1e6 }, prices)).toBe(0);
  });
  it('costs a model with no entry nothing, and an object built-in is no entry', () => {
    expect(costFromUsage('other', { ...zero, input_tokens: 1e6 }, prices)).toBe(0);
    expect(costFromUsage('constructor', { ...zero, input_tokens: 1e6 }, prices)).toBe(0);
    expect(costFromUsage('gpt-x', { ...zero, input_tokens: 1e6 })).toBe(0);
  });
  it('keeps Claude\'s own prices for a Claude id, whatever the writer typed', () => {
    const typed = { 'claude-haiku-5-5': { input: 99, output: 99 } };
    expect(costFromUsage('claude-haiku-5-5', { ...zero, input_tokens: 1e6 }, typed)).toBeCloseTo(0.1);
  });
});

describe('isPriced', () => {
  it('is true for a Claude model and a model the writer priced, false otherwise', () => {
    expect(isPriced('claude-sonnet-5-5')).toBe(true);
    expect(isPriced('gpt-x', { 'gpt-x': { input: 0, output: 0 } })).toBe(true);
    expect(isPriced('gpt-x', {})).toBe(false);
    expect(isPriced('gpt-x')).toBe(false);
    expect(isPriced('constructor', {})).toBe(false);
  });
});
