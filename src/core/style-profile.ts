import { estimateCost, type Pricing } from './review-cost';

/** The fewest and most characters of pasted writing a style profile is built from. */
export const MIN_PROFILE_SOURCE_CHARS = 300;
export const MAX_PROFILE_SOURCE_CHARS = 12_000;

/** Output tokens a build is expected to use (about 150 words, plus room for thinking), for the estimate shown before it. */
export const PROFILE_EXPECTED_OUTPUT = 600;

/** A build's expected cost in USD for `chars` characters of pasted writing, on the smart model (smartPricing); null without its prices. */
export const profileBuildCost = (chars: number, pricing: Pricing) =>
  estimateCost(pricing, Math.min(Math.max(chars, MIN_PROFILE_SOURCE_CHARS), MAX_PROFILE_SOURCE_CHARS), PROFILE_EXPECTED_OUTPUT);
