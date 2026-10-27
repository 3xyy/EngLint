export type ClaudeModelId = 'claude-haiku-5-5' | 'claude-sonnet-5-5';
/** A Claude id, or any other provider's model name. */
export type ModelId = ClaudeModelId | (string & {});

/** USD per million tokens. */
export const PRICES: Record<ClaudeModelId, { input: number; output: number; cacheWrite5m: number; cacheRead: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheRead: 0.1 },
};

/** What one web search costs, on top of the tokens. */
export const SEARCH_PRICE_USD = 0.01;

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  /** Server-side tool requests (web search), billed per request; absent or null when there were none. */
  server_tool_use?: { web_search_requests: number } | null;
}

/** Claude's prices for `model`, or undefined: an own key only, so a name like 'constructor' is no price. */
export function claudePrices(model: ModelId): (typeof PRICES)[ClaudeModelId] | undefined {
  return Object.hasOwn(PRICES, model) ? PRICES[model as ClaudeModelId] : undefined;
}

/** The writer's prices, by model id: USD per 1M tokens. */
export type CustomPrices = Record<string, { input: number; output: number }>;

const customPrice = (model: string, custom?: CustomPrices) => (custom && Object.hasOwn(custom, model) ? custom[model] : undefined);

/** The input and output prices for `model` (USD per 1M tokens): Claude's for a Claude id, else the writer's, else undefined. */
export function pricesOf(model: ModelId, custom?: CustomPrices): { input: number; output: number } | undefined {
  return claudePrices(model) ?? customPrice(model, custom);
}

/** Whether spending on `model` is tracked: a Claude model, or one the writer gave prices for. */
export function isPriced(model: ModelId, custom?: CustomPrices): boolean {
  return !!pricesOf(model, custom);
}

/**
 * What `u` cost on `model`: Claude's prices for a Claude id, else the writer's (cached input billed at the input
 * price), else 0.
 */
export function costFromUsage(model: ModelId, u: UsageLike, custom?: CustomPrices): number {
  const p = claudePrices(model);
  if (!p) {
    const c = customPrice(model, custom);
    if (!c) return 0;
    return ((u.input_tokens + (u.cache_read_input_tokens ?? 0)) * c.input + u.output_tokens * c.output) / 1_000_000;
  }
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite5m +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead) /
      1_000_000 +
    (u.server_tool_use?.web_search_requests ?? 0) * SEARCH_PRICE_USD
  );
}
