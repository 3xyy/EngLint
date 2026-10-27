import { pricesOf, SEARCH_PRICE_USD, type CustomPrices, type ModelId } from './cost';
import type { ProviderConfig } from './provider';

export { SEARCH_PRICE_USD };

/** What an estimate is priced on: the model the run uses, and the writer's prices (Claude's are built in). */
export interface Pricing {
  model: ModelId;
  prices?: CustomPrices;
}

/** The smart model the reviews and the style profile run on: Claude's Sonnet, or the active provider's with the writer's prices. */
export function smartPricing(c: ProviderConfig): Pricing {
  return c.active === 'compatible' && c.compatible ? { model: c.compatible.smartModel, prices: c.compatible.prices } : { model: 'claude-sonnet-5-5' };
}

/** What the cards show, in words, in place of an estimate for a model with no prices. */
export const COST_UNKNOWN = 'Cost not known for this model.';

/** The most web searches one Citation finder run makes (the tool's max_uses). */
export const CITATION_MAX_SEARCHES = 3;
/** Input the search results add to a Citation finder run, in characters, for its estimate (about 10,000 tokens for 3 searches). */
export const CITATION_RESULTS_CHARS = 40_000;

/** Output tokens each agent is expected to write, for the estimate shown before a run. */
export const REVIEW_EXPECTED = { readers: 1200, grader: 1800, deepCheck: 3000, citations: 1500 } as const;

/**
 * A run's expected cost: ceil(inputChars / 4) + 1500 input tokens, `outputTokens` output tokens and `searches`
 * searches, at `pricing`'s prices. null for a model with no prices: never a guess, and never another model's price.
 */
export function estimateCost(pricing: Pricing, inputChars: number, outputTokens: number, searches = 0): number | null {
  const p = pricesOf(pricing.model, pricing.prices);
  if (!p) return null;
  const input = Math.ceil(inputChars / 4) + 1500;
  return (input * p.input + outputTokens * p.output) / 1_000_000 + searches * SEARCH_PRICE_USD;
}

/** "under $0.01" below a cent, otherwise "about $X.XX" rounded up to the cent; null for a cost that isn't known. */
export function costLabel(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd < 0.01) return 'under $0.01';
  // Float noise (0.07 * 100 = 7.000000000000001) must not push an exact cent up.
  return `about $${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`;
}
