import { describe, expect, it } from 'vitest';
import { locateEdit } from '../../src/core/chat-format';
import { addedWords } from '../../src/core/match';
import { uniqueEdit } from '../../src/core/review-edit';

const at = (text: string, sub: string, n = 0) => {
  let i = -1;
  for (let k = 0; k <= n; k++) i = text.indexOf(sub, i + 1);
  return [i, i + sub.length] as const;
};

describe('uniqueEdit', () => {
  it('returns a unique original unchanged', () => {
    const text = 'I recieved your email today.';
    const [s, e] = at(text, 'recieved');
    expect(uniqueEdit(text, s, e, 'received')).toEqual({ original: 'recieved', replacement: 'received' });
  });

  it('grows "its" occurring three times to "know its", left word first', () => {
    const text = 'We know its limits. Over time its shape shifted, and its edge too.';
    const [s, e] = at(text, 'its', 0);
    expect(uniqueEdit(text, s, e, "it's")).toEqual({ original: 'know its', replacement: "know it's" });
  });

  it('grows to the right when the left word does not settle it', () => {
    const text = 'Say its name. Say its end. Say its name again.';
    const [s, e] = at(text, 'its', 0);
    const edit = uniqueEdit(text, s, e, "it's")!;
    expect(locateEdit(text, edit.original)).not.toBe('ambiguous');
    expect(locateEdit(text, edit.original)).not.toBe('missing');
    expect(edit.original).toBe('Say its name.');
    expect(edit.replacement).toBe("Say it's name.");
  });

  it('gives null when no window within 120 characters each side is unique', () => {
    const text = 'its '.repeat(200);
    const [s, e] = at(text, 'its', 100);
    expect(uniqueEdit(text, s, e, "it's")).toBeNull();
  });

  it('does not look further than 120 characters to the left for a unique window', () => {
    const seg = `${'ab '.repeat(80)}its ${'ab '.repeat(80)}`;
    const text = `ZED ${seg}${seg}`;
    const [s, e] = at(text, 'its', 0);
    expect(uniqueEdit(text, s, e, "it's")).toBeNull();
  });

  it('does not look further than 120 characters to the right for a unique window', () => {
    const seg = `${'ab '.repeat(80)}its ${'ab '.repeat(80)}`;
    const text = `${seg}${seg}ZED`;
    const [s, e] = at(text, 'its', 0);
    expect(uniqueEdit(text, s, e, "it's")).toBeNull();
  });

  it('widens by whole words, left and right', () => {
    const left = 'Aa its x. Bb its y.';
    expect(uniqueEdit(left, ...at(left, 'its', 0), "it's")).toEqual({ original: 'Aa its', replacement: "Aa it's" });
    const right = 'Say its aa. Say its bb.';
    expect(uniqueEdit(right, ...at(right, 'its', 0), "it's")).toEqual({ original: 'Say its aa.', replacement: "Say it's aa." });
  });

  it('gives null for a range that is empty or outside the text', () => {
    const text = 'One two three.';
    expect(uniqueEdit(text, 4, 4, 'x')).toBeNull();
    expect(uniqueEdit(text, 6, 4, 'x')).toBeNull();
    expect(uniqueEdit(text, -1, 3, 'x')).toBeNull();
    expect(uniqueEdit(text, 4, 99, 'x')).toBeNull();
  });

  it('carries the same prefix and suffix on the replacement', () => {
    const text = 'Alpha its beta. Gamma its delta.';
    const [s, e] = at(text, 'its', 1);
    const edit = uniqueEdit(text, s, e, "it's")!;
    const i = text.indexOf(edit.original);
    expect(edit.original.startsWith(text.slice(i, s))).toBe(true);
    expect(edit.replacement.startsWith(text.slice(i, s))).toBe(true);
    expect(edit.replacement.endsWith(text.slice(e, i + edit.original.length))).toBe(true);
  });

  it('keeps the added-word count of the core pair', () => {
    const text = 'We like it. We like it. We like it.';
    const [s, e] = at(text, 'like it', 1);
    const edit = uniqueEdit(text, s, e, 'like it a lot')!;
    expect(edit.original).not.toBe('like it');
    expect(addedWords(edit.original, edit.replacement)).toBe(addedWords('like it', 'like it a lot'));
  });

  it('finds the window in the text as it is, curled quotes included', () => {
    const text = 'He said “its” once. Then “its” twice.';
    const [s, e] = at(text, 'its', 1);
    const edit = uniqueEdit(text, s, e, "it's")!;
    expect(typeof locateEdit(text, edit.original)).toBe('object');
  });
});
