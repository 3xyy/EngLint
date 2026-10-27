import { describe, expect, it } from 'vitest';
import { findQuote } from '../../src/core/quotes';
import { cutForReview, MAX_REVIEW_CHARS } from '../../src/core/review';

describe('findQuote', () => {
  const text = 'I has a cat. She runs home.';

  it('finds an exact match', () => {
    expect(findQuote(text, 'She runs')).toEqual({ start: 13, end: 21 });
  });

  it('returns the first of two occurrences', () => {
    expect(findQuote('The cat sat. The cat ran.', 'The cat')).toEqual({ start: 0, end: 7 });
  });

  it('finds a straight-quoted quote in curled text, in the text’s own offsets', () => {
    const curled = 'Well, it’s a “long” day — really.';
    const at = findQuote(curled, `it's a "long" day - really`);
    expect(at).toEqual({ start: 6, end: curled.length - 1 });
    expect(curled.slice(at!.start, at!.end)).toBe('it’s a “long” day — really');
  });

  it('finds a curled-quote quote in straight text', () => {
    expect(findQuote("it's a \"long\" day", 'it’s a “long” day')).toEqual({ start: 0, end: 17 });
  });

  it('returns null for a quote that is not there, or one of 2 characters', () => {
    expect(findQuote(text, 'She walks')).toBeNull();
    expect(findQuote(text, 'I ')).toBeNull();
    expect(findQuote(text, 'ru')).toBeNull();
    expect(findQuote(text, '')).toBeNull();
    expect(findQuote('So… maybe', '…')).toBeNull(); // one character, though it folds to three
    expect(findQuote('So… maybe', '  ab ')).toBeNull();
  });

  it('never starts or ends inside a folded ellipsis', () => {
    expect(findQuote('So… maybe', '.. maybe')).toBeNull(); // starts in the middle of the …
    expect(findQuote('So… maybe', 'So..')).toBeNull(); // ends in the middle of it
    expect(findQuote('So… maybe', '... maybe')).toEqual({ start: 2, end: 9 });
    expect(findQuote('So… maybe', 'So...')).toEqual({ start: 0, end: 3 });
  });
});

describe('cutForReview', () => {
  it('cuts at the last paragraph break before the limit', () => {
    const text = 'a'.repeat(29_500) + '\n\n' + 'b'.repeat(31_000 - 29_502);
    expect(text.length).toBe(31_000);
    const r = cutForReview(text);
    expect(r.cut).toBe(true);
    expect(r.text).toBe('a'.repeat(29_500));
  });

  it('cuts hard at the limit when there is no break', () => {
    const r = cutForReview('a'.repeat(31_000));
    expect(r.cut).toBe(true);
    expect(r.text.length).toBe(MAX_REVIEW_CHARS);
    expect(MAX_REVIEW_CHARS).toBe(30_000);
  });

  it('ignores a break after the limit', () => {
    const r = cutForReview('a'.repeat(30_500) + '\n' + 'b'.repeat(100));
    expect(r.text.length).toBe(30_000);
  });

  it('cuts at a single line break too, since each line is a paragraph', () => {
    const r = cutForReview('a'.repeat(29_500) + '\n' + 'b'.repeat(1500));
    expect(r).toEqual({ text: 'a'.repeat(29_500), cut: true });
  });

  it('does not split a surrogate pair at the limit', () => {
    const r = cutForReview('a'.repeat(29_999) + '😀' + 'b'.repeat(100));
    expect(r.text).toBe('a'.repeat(29_999));
    expect(r.cut).toBe(true);
  });

  it('returns a short text unchanged', () => {
    expect(cutForReview('short\n\ntext')).toEqual({ text: 'short\n\ntext', cut: false });
    const exact = 'a'.repeat(30_000);
    expect(cutForReview(exact)).toEqual({ text: exact, cut: false });
  });
});
