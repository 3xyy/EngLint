/**
 * Pure scoring for the review eval. No side effects and no API: the unit tests import this module,
 * never run-review-eval.ts (which runs main() at import).
 */
import { findQuote } from '../src/core/quotes';
import type { Grading } from '../src/core/review-schema';

/** The share of `quotes` that findQuote locates in `text`; 0 when there are none. */
export function quoteHitRate(quotes: string[], text: string): number {
  if (quotes.length === 0) return 0;
  return quotes.filter((q) => findQuote(text, q) !== null).length / quotes.length;
}

/** The share of `seeds` whose first occurrence in `text` overlaps the range of at least one issue. */
export function seededRecall(text: string, issues: { start: number; end: number }[], seeds: { original: string }[]): number {
  if (seeds.length === 0) return 0;
  const hit = seeds.filter((s) => {
    const start = text.indexOf(s.original);
    if (start === -1) return false;
    const end = start + s.original.length;
    return issues.some((i) => i.start < end && start < i.end);
  });
  return hit.length / seeds.length;
}

/** True when there is a grading with at least one criterion and every criterion is rated strong. */
export function allRatingsStrong(grading: Grading | null): boolean {
  return !!grading && grading.criteria.length > 0 && grading.criteria.every((c) => c.rating === 'strong');
}
