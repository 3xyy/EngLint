import { describe, expect, it } from 'vitest';
import { hashText, splitParagraphs } from '../../src/core/paragraphs';

describe('splitParagraphs', () => {
  it('splits on \\n and \\r\\n with correct offsets', () => {
    const ps = splitParagraphs('Hi there.\r\n\r\nSecond one.');
    expect(ps.map((p) => p.text)).toEqual(['Hi there.', 'Second one.']);
    expect(ps.map((p) => p.start)).toEqual([0, 13]);
    expect(ps.map((p) => p.id)).toEqual(['p0', 'p1']);
  });

  it('skips whitespace-only paragraphs', () => {
    expect(splitParagraphs('A\n   \nB')).toHaveLength(2);
  });

  it('skips paragraphs of only zero-width spaces (editor caret placeholders)', () => {
    const ps = splitParagraphs('A\n\u200b\n\ufeff\n \u200b\ufeff \nB\u200bC');
    expect(ps.map((p) => p.text)).toEqual(['A', 'B\u200bC']);
  });

  it('treats a lone \\r as a line break and keeps text untrimmed', () => {
    const ps = splitParagraphs('  A \rB');
    expect(ps.map((p) => p.text)).toEqual(['  A ', 'B']);
    expect(ps.map((p) => p.start)).toEqual([0, 5]);
  });

  it('keeps true offsets after skipped lines', () => {
    const ps = splitParagraphs('A\n  \nB');
    expect(ps[1]!.start).toBe(5);
    expect(ps[1]!.id).toBe('p1');
  });

  it('emoji keep UTF-16 offsets', () => {
    const ps = splitParagraphs('Hi 👋\nNext');
    expect(ps[1]!.start).toBe(6);
  });

  it('sets each paragraph hash from its text', () => {
    const ps = splitParagraphs('A\nB');
    expect(ps[0]!.hash).toBe(hashText('A'));
  });
});

describe('hashText', () => {
  it('is stable and content-sensitive', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('a')).not.toBe(hashText('b'));
    expect(hashText('a')).toMatch(/^[0-9a-f]+$/);
  });
});
