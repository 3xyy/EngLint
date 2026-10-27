import { describe, expect, it } from 'vitest';
import { wordDiff } from '../../src/core/diff';

const isLetter = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

describe('wordDiff', () => {
  it('marks a swapped word', () => {
    expect(wordDiff('I has a cat', 'I have a cat')).toEqual([
      { op: 'same', text: 'I ' },
      { op: 'del', text: 'has' },
      { op: 'add', text: 'have' },
      { op: 'same', text: ' a cat' },
    ]);
  });
  it('folds a heavily rewritten sentence into one del and one add', () => {
    expect(wordDiff('We went to the store and bought milk', 'Then we walked to a shop and got some milk')).toEqual([
      { op: 'del', text: 'We went to the store and bought' },
      { op: 'add', text: 'Then we walked to a shop and got some' },
      { op: 'same', text: ' milk' },
    ]);
  });
  it('returns one same part for identical strings', () => {
    expect(wordDiff('no change', 'no change')).toEqual([{ op: 'same', text: 'no change' }]);
  });
  it('returns one add from empty', () => {
    expect(wordDiff('', 'new')).toEqual([{ op: 'add', text: 'new' }]);
  });
  it('returns one del to empty', () => {
    expect(wordDiff('old', '')).toEqual([{ op: 'del', text: 'old' }]);
  });
  it('returns nothing for two empty strings', () => {
    expect(wordDiff('', '')).toEqual([]);
  });
  it('merges adjacent parts and reproduces both sides', () => {
    const parts = wordDiff('The quick brown fox', 'A quick red fox jumps');
    for (let i = 1; i < parts.length; i++) expect(parts[i]?.op).not.toBe(parts[i - 1]?.op);
    expect(parts.filter((p) => p.op !== 'add').map((p) => p.text).join('')).toBe('The quick brown fox');
    expect(parts.filter((p) => p.op !== 'del').map((p) => p.text).join('')).toBe('A quick red fox jumps');
  });
  it('never splits a word, over 20 generated pairs', () => {
    const vocab = ['cat', 'cats', 'run', 'running', "don't", 'fast', 'a', 'the', 'over', 'dog', 'résumé', 'x2'];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const sentence = () =>
      Array.from({ length: 3 + rnd(6) }, () => vocab[rnd(vocab.length)]).join(rnd(2) ? ' ' : ', ') + (rnd(2) ? '.' : '');
    for (let n = 0; n < 20; n++) {
      const from = sentence();
      const to = sentence();
      const parts = wordDiff(from, to);
      expect(parts.filter((p) => p.op !== 'add').map((p) => p.text).join('')).toBe(from);
      expect(parts.filter((p) => p.op !== 'del').map((p) => p.text).join('')).toBe(to);
      // a del next to an add is a whole-word swap; what must hold is that neither side's text is cut mid-word
      for (const keep of [(p: { op: string }) => p.op !== 'add', (p: { op: string }) => p.op !== 'del']) {
        const side = parts.filter(keep);
        for (let i = 1; i < side.length; i++) {
          expect(isLetter(side[i - 1]?.text.slice(-1)) && isLetter(side[i]?.text[0])).toBe(false);
        }
      }
    }
  });
});
