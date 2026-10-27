import { describe, expect, it } from 'vitest';
import { CHAT_CONTEXT_MAX, chatContext } from '../../src/core/chat-context';

/** A paragraph of about `len` characters whose first sentence names it, so a test can find it. */
const para = (n: number, len = 1000) => {
  const first = `Paragraph ${n} starts here.`;
  let body = first;
  for (let i = 0; body.length < len; i++) body += ` Sentence ${i} of paragraph ${n} adds more words to fill the space.`;
  return body.slice(0, len);
};
const doc = (count: number, len = 1000) => Array.from({ length: count }, (_, i) => para(i, len)).join('\n');

describe('chatContext', () => {
  it('uses 12,000 characters by default', () => {
    expect(CHAT_CONTEXT_MAX).toBe(12_000);
  });

  it('returns a 5,000-character text whole, blank lines and all', () => {
    const text = `${Array.from({ length: 5 }, (_, i) => para(i)).join('\n\n')}\n`;
    expect(text.length).toBeGreaterThan(4900);
    expect(text.length).toBeLessThanOrEqual(5100);
    expect(chatContext(text, null)).toBe(text);
    expect(chatContext(text, { start: 3000, end: 3000 })).toBe(text);
  });

  it('keeps a 40,000-character text under the cap, the focus paragraph whole and far paragraphs by their first sentence, in order', () => {
    const text = doc(40);
    expect(text.length).toBeGreaterThan(40_000);
    const at = text.indexOf(para(20));
    const out = chatContext(text, { start: at + 10, end: at + 30 });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain(para(20));
    // A paragraph far from the focus, at each end, by its first sentence only.
    expect(out).toContain('Paragraph 0 starts here.');
    expect(out).toContain('Paragraph 39 starts here.');
    expect(out).not.toContain(para(0));
    // Every paragraph appears, in document order.
    const positions = Array.from({ length: 40 }, (_, i) => out.indexOf(`Paragraph ${i} starts here.`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The neighbours on both sides come whole too.
    expect(out).toContain(para(21));
    expect(out).toContain(para(19));
  });

  it('marks text it left out with an ellipsis', () => {
    const out = chatContext(doc(40), null);
    expect(out).toContain('Paragraph 39 starts here. …');
  });

  it('uses the start of the text when there is no focus', () => {
    const text = doc(40);
    const out = chatContext(text, null);
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.startsWith(para(0))).toBe(true);
    expect(out).toContain(para(1));
  });

  it('respects a smaller cap', () => {
    const text = doc(40);
    const at = text.indexOf(para(10));
    const out = chatContext(text, { start: at, end: at }, 3000);
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out).toContain(para(10));
  });

  it('keeps the focus paragraph whole even when the first sentences no longer fit', () => {
    // 2,000 short paragraphs: their first sentences alone are far over the cap.
    const text = Array.from({ length: 2000 }, (_, i) => `Line ${i} is short.`).join('\n') + '\n' + para(5000, 6000);
    const at = text.indexOf('Paragraph 5000 starts here.');
    const out = chatContext(text, { start: at, end: at });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain(para(5000, 6000));
    expect(out).toContain('…');
  });

  it('stays within the cap for a focus paragraph one character short of it, with neighbours, marking both sides', () => {
    const big = para(1, 11_999);
    const text = [para(0, 500), big, para(2, 500)].join('\n');
    const at = text.indexOf(big) + 6000;
    const out = chatContext(text, { start: at, end: at });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain(big.slice(100, 11_900));
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('stays within the cap for a focus paragraph exactly the cap, with neighbours, marking the paragraphs left out', () => {
    const big = para(1, 12_000);
    const text = [para(0, 500), big, para(2, 500)].join('\n');
    const at = text.indexOf(big);
    const out = chatContext(text, { start: at, end: at });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out.startsWith(`…\n${big.slice(0, 100)}`)).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('stays within the cap for a two-paragraph selection that only fits without the gap lines', () => {
    const a = para(1, 6000);
    const b = para(2, 5998);
    const text = [para(0, 500), a, b, para(3, 500)].join('\n');
    const start = text.indexOf(a) + 10;
    const end = text.indexOf(b) + 10;
    const out = chatContext(text, { start, end });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain(a);
    // Too big together, so the first paragraph comes whole and the rest by their first sentences.
    expect(out).toContain('Paragraph 0 starts here.');
    expect(out).toContain('Paragraph 2 starts here.');
    expect(out).toContain('Paragraph 3 starts here.');
  });

  it('cuts a single paragraph longer than the cap around the focus', () => {
    const text = para(1, 30_000);
    const out = chatContext(text, { start: 20_000, end: 20_005 });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain(text.slice(19_000, 21_000));
    expect(out.startsWith('…')).toBe(true);
  });
});
