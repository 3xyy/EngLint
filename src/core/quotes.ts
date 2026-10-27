import { foldTypography } from './typography';

/** The shortest quote worth looking for. */
const MIN_QUOTE_CHARS = 3;

/**
 * The first place `quote` occurs in `text`, in `text`'s own offsets, or null. Curled quotes, dashes, NBSP and
 * ellipses are folded on both sides (a model writes straight ones); a match starts and ends on whole characters
 * of the text, never inside a folded `…`.
 */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  if (quote.trim().length < MIN_QUOTE_CHARS) return null;
  const needle = foldTypography(quote).folded;
  const { folded, toOriginal } = foldTypography(text);
  const onBoundary = (i: number) => i === 0 || i === folded.length || toOriginal[i] !== toOriginal[i - 1];
  for (let i = folded.indexOf(needle); i !== -1; i = folded.indexOf(needle, i + 1)) {
    if (onBoundary(i) && onBoundary(i + needle.length)) return { start: toOriginal[i]!, end: toOriginal[i + needle.length]! };
  }
  return null;
}
