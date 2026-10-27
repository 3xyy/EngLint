import { describe, expect, it } from 'vitest';
import { MAX_VOICE_SAMPLE_CHARS, contextAround, sentenceAround, trimRange, voiceSampleAround } from '../../src/core/context';

describe('trimRange', () => {
  it('trims edge whitespace', () => {
    expect(trimRange('  hi  ', 0, 6)).toEqual({ start: 2, end: 4 });
  });
  it('returns null for an all-space range', () => {
    expect(trimRange('a    b', 1, 5)).toBeNull();
    expect(trimRange('abc', 1, 1)).toBeNull();
  });
  it('leaves a tight range alone', () => {
    expect(trimRange('one two', 4, 7)).toEqual({ start: 4, end: 7 });
  });
});

describe('contextAround', () => {
  it('stops at the paragraph newline on both sides', () => {
    const text = 'before para\nalpha BETA gamma\nafter para';
    const s = text.indexOf('BETA');
    expect(contextAround(text, s, s + 4)).toEqual({ before: 'alpha ', after: ' gamma' });
  });
  it('cuts at a word boundary within max', () => {
    const text = 'aaaa bbbb cccc [SEL] dddd eeee ffff';
    const s = text.indexOf('[SEL]');
    const c = contextAround(text, s, s + 5, 12);
    expect(c.before).toBe('bbbb cccc ');
    expect(c.after).toBe(' dddd eeee');
    expect(c.before.length).toBeLessThanOrEqual(12);
    expect(c.after.length).toBeLessThanOrEqual(12);
  });
  it('defaults to 300 characters each side', () => {
    const text = 'word '.repeat(200) + 'X' + ' word'.repeat(200);
    const s = text.indexOf('X');
    const c = contextAround(text, s, s + 1);
    expect(c.before.length).toBeLessThanOrEqual(300);
    expect(c.before.length).toBeGreaterThan(290);
    expect(c.after.length).toBeLessThanOrEqual(300);
  });
  it('never crosses a CRLF break', () => {
    const text = 'one\r\ntwo sel three\r\nfour';
    const s = text.indexOf('sel');
    expect(contextAround(text, s, s + 3)).toEqual({ before: 'two ', after: ' three' });
  });
});

describe('sentenceAround', () => {
  const text = 'One. Two words here! Three.';
  it('finds the sentence holding the range', () => {
    const r = sentenceAround(text, 6, 9);
    expect(text.slice(r.start, r.end)).toBe('Two words here!');
  });
  it('returns both sentences for a range that spans two', () => {
    const r = sentenceAround(text, 2, 8);
    expect(text.slice(r.start, r.end)).toBe('One. Two words here!');
  });
  it('handles the last sentence without a trailing space', () => {
    const r = sentenceAround(text, 22, 24);
    expect(text.slice(r.start, r.end)).toBe('Three.');
  });
  it('keeps a closing quote with its sentence', () => {
    const t = 'He said "go." Then left.';
    const r = sentenceAround(t, 1, 3);
    expect(t.slice(r.start, r.end)).toBe('He said "go."');
  });
  it('never crosses a newline', () => {
    const t = 'First line no stop\nSecond line. Third.';
    const r = sentenceAround(t, 22, 24);
    expect(t.slice(r.start, r.end)).toBe('Second line.');
    const r2 = sentenceAround(t, 2, 4);
    expect(t.slice(r2.start, r2.end)).toBe('First line no stop');
  });
});

describe('voiceSampleAround', () => {
  const TEXT = ['First one.', 'Second one.', 'The selected words sit here.', 'Third one.', 'Fourth one.'].join('\n');
  const sel = (text: string, part: string) => [text.indexOf(part), text.indexOf(part) + part.length] as const;

  it('takes the preceding paragraphs nearest first, then the following ones, never the selection\'s paragraph', () => {
    const [s, e] = sel(TEXT, 'selected words');
    expect(voiceSampleAround(TEXT, s, e)).toBe('Second one.\n\nFirst one.\n\nThird one.\n\nFourth one.');
  });
  it('leaves out every paragraph the selection touches, and blank lines', () => {
    const text = 'Alpha.\n\nBravo starts.\nCharlie ends.\n \nDelta.';
    const [s] = sel(text, 'starts');
    const e = text.indexOf('Charlie') + 7;
    expect(voiceSampleAround(text, s, e)).toBe('Alpha.\n\nDelta.');
  });
  it('is empty when the field has no other paragraph', () => {
    expect(voiceSampleAround('Only this one.', 0, 4)).toBe('');
  });
  it('stops at 1,500 characters: a paragraph that does not fit is cut at a word, and nothing after it is taken', () => {
    expect(MAX_VOICE_SAMPLE_CHARS).toBe(1500);
    const near = 'near '.repeat(200).trim(); // 999 characters
    const far = 'far '.repeat(200).trim(); // 799 characters
    const text = [far, near, 'Selected.', 'After.'].join('\n');
    const [s, e] = sel(text, 'Selected.');
    const out = voiceSampleAround(text, s, e);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.startsWith(`${near}\n\nfar far`)).toBe(true);
    expect(out).toMatch(/far$/); // cut between words
    expect(out).not.toContain('After.');
    expect(voiceSampleAround(text, s, e, 1000)).toBe(near);
  });
  it('after a cut paragraph nothing more is taken, even a short one that would fit', () => {
    const text = 'aaaa bbbbbbbbbbbbbbbbbbbbbbbb\nSelected.\nHi.';
    const [s, e] = sel(text, 'Selected.');
    expect(voiceSampleAround(text, s, e, 20)).toBe('aaaa');
  });
  it('a nearest paragraph longer than the limit gives its start, cut at a word', () => {
    const long = 'word '.repeat(400).trim();
    const text = `${long}\nSelected.`;
    const out = voiceSampleAround(text, text.indexOf('Selected.'), text.length);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.length).toBeGreaterThan(1490);
    expect(out).toMatch(/^word( word)*$/);
  });
});
