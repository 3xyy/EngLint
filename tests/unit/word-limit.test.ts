import { describe, expect, it } from 'vitest';
import { countWords } from '../../src/core/doc-stats';
import {
  LIMIT_CHIPS,
  MAX_WORD_LIMIT_CHARS,
  applyCuts,
  counterText,
  defaultTarget,
  limitChips,
  preselect,
  savedText,
  validTarget,
  versionFits,
  versionFloor,
  withFound,
  wordsAfter,
  type WordLimitCut,
} from '../../src/core/word-limit';

/** A cut of `original` (its first occurrence in `text`) by `replacement`, saving what the counter says. */
function cut(text: string, original: string, replacement: string, over: Partial<WordLimitCut> = {}): WordLimitCut {
  const start = text.indexOf(original);
  if (start < 0) throw new Error(`"${original}" not in text`);
  return { start, end: start + original.length, original, replacement, why: '', saves: countWords(original) - countWords(replacement), changesFacts: false, ...over };
}

describe('the target picker', () => {
  it('starts at 85% of the words, rounded to 5', () => {
    expect(defaultTarget(312)).toBe(265);
    expect(defaultTarget(700)).toBe(595);
    expect(defaultTarget(100)).toBe(85);
    expect(defaultTarget(41)).toBe(35);
  });
  it('stays at least 1 and under the words a small selection has', () => {
    expect(defaultTarget(3)).toBe(2);
    expect(defaultTarget(5)).toBe(4);
    expect(defaultTarget(2)).toBe(1);
  });
  it('offers the common limits below the selection only', () => {
    expect(LIMIT_CHIPS).toEqual([150, 250, 500, 650]);
    expect(limitChips(700)).toEqual([150, 250, 500, 650]);
    expect(limitChips(312)).toEqual([150, 250]);
    expect(limitChips(250)).toEqual([150]);
    expect(limitChips(150)).toEqual([]);
  });
  it('a target is a whole number from 1 to one under the words', () => {
    expect(validTarget(250, 312)).toBe(true);
    expect(validTarget(1, 2)).toBe(true);
    expect(validTarget(311, 312)).toBe(true);
    expect(validTarget(312, 312)).toBe(false);
    expect(validTarget(0, 312)).toBe(false);
    expect(validTarget(12.5, 312)).toBe(false);
    expect(validTarget(Number.NaN, 312)).toBe(false);
  });
  it('the full version should have at least 90% of the target, rounded up, with no float drift', () => {
    expect([versionFloor(650), versionFloor(250), versionFloor(333), versionFloor(10), versionFloor(1)]).toEqual([585, 225, 300, 9, 1]);
  });
  it('a full version fits from 80% of the target up to the target: further under is a summary', () => {
    expect([versionFits(250, 250), versionFits(200, 250), versionFits(199, 250), versionFits(251, 250)]).toEqual([true, true, false, false]);
    expect([versionFits(10, 12), versionFits(9, 12), versionFits(12, 250)]).toEqual([true, false, false]);
  });
  it('takes up to 5,000 characters', () => {
    expect(MAX_WORD_LIMIT_CHARS).toBe(5000);
  });
});

describe('applyCuts', () => {
  const TEXT = 'In order to win the final, we really practiced every single day after school.';
  it('applies each cut in place, by its offsets in the selection, in one string', () => {
    const cuts = [cut(TEXT, 'In order to', 'To'), cut(TEXT, 'every single day', 'daily')];
    expect(applyCuts(TEXT, cuts)).toBe('To win the final, we really practiced daily after school.');
    expect(applyCuts(TEXT, [...cuts].reverse())).toBe('To win the final, we really practiced daily after school.'); // any order
    expect(applyCuts(TEXT, [])).toBe(TEXT);
  });
  it('a deletion takes one of the spaces around it, never a word', () => {
    expect(applyCuts(TEXT, [cut(TEXT, 'really', '')])).toBe('In order to win the final, we practiced every single day after school.');
    expect(applyCuts(TEXT, [cut(TEXT, ' after school', '')])).toBe('In order to win the final, we really practiced every single day.');
    expect(applyCuts(TEXT, [cut(TEXT, 'after school', '')])).toBe('In order to win the final, we really practiced every single day.');
  });
  it('a deletion at either edge of the selection leaves no edge space', () => {
    expect(applyCuts(TEXT, [cut(TEXT, 'In order to win the final,', '')])).toBe('we really practiced every single day after school.');
    const part = 'we really practiced every single day after school';
    expect(applyCuts(part, [cut(part, 'after school', '')])).toBe('we really practiced every single day');
  });
  it('adjacent cuts compose: one ending where the next starts, and deletions side by side', () => {
    const t = 'It was a very, very long day.';
    expect(applyCuts(t, [cut(t, 'very,', ''), cut(t, ' very long', ' long')])).toBe('It was a long day.');
    const u = 'a bb cc d';
    expect(applyCuts(u, [cut(u, 'bb', ''), cut(u, 'cc', '')])).toBe('a d');
    expect(applyCuts(u, [cut(u, 'bb ', 'x'), cut(u, 'cc', 'y')])).toBe('a xy d');
  });
  it('deleting the last sentence of a paragraph keeps the paragraph break and leaves no trailing space', () => {
    const t = 'We won. We cheered.\n\nThen we went home.';
    expect(applyCuts(t, [cut(t, 'We cheered.', '')])).toBe('We won.\n\nThen we went home.');
    expect(applyCuts(t, [cut(t, 'Then we went home.', '')])).toBe('We won. We cheered.');
  });
  it('deleting a whole paragraph leaves one paragraph break, and none at the selection\'s start', () => {
    const t = 'We won.\n\nWe cheered.\n\nThen we went home.';
    expect(applyCuts(t, [cut(t, 'We cheered.', '')])).toBe('We won.\n\nThen we went home.');
    expect(applyCuts(t, [cut(t, 'We won.', '')])).toBe('We cheered.\n\nThen we went home.');
  });
  it('a deletion between two words with no space left keeps them apart', () => {
    const t = 'It was—really—good.';
    expect(applyCuts(t, [cut(t, '—really—', '')])).toBe('It was good.');
  });
});

describe('the live counter', () => {
  const TEXT = 'In order to win the final, we really practiced every single day after school.'; // 14 words
  const cuts = [cut(TEXT, 'In order to', 'To'), cut(TEXT, 'really', ''), cut(TEXT, 'every single day', 'daily')];
  it('counts the words the selection would have with the chosen cuts, locally', () => {
    expect(countWords(TEXT)).toBe(14);
    expect(wordsAfter(TEXT, cuts, [false, false, false])).toBe(14);
    expect(wordsAfter(TEXT, cuts, [true, false, false])).toBe(12);
    expect(wordsAfter(TEXT, cuts, [true, true, true])).toBe(9);
  });
  it('says how many words are left to go, or that the selection is at or under the target', () => {
    expect(counterText(268, 250)).toBe('Selected cuts: 268 words (18 to go)');
    expect(counterText(251, 250)).toBe('Selected cuts: 251 words (1 to go)');
    expect(counterText(250, 250)).toBe('Selected cuts: 250 words (at the limit)');
    expect(counterText(243, 250)).toBe('Selected cuts: 243 words (7 under)');
  });
  it('a cut says what it saves', () => {
    expect(savedText(7)).toBe('−7 words');
    expect(savedText(1)).toBe('−1 word');
  });
});

describe('greedy preselection', () => {
  // 14 words; the cuts save 2, 1, 2 and 2.
  const TEXT = 'In order to win the final, we really practiced every single day after school.';
  const cuts = [cut(TEXT, 'In order to', 'To'), cut(TEXT, 'really', ''), cut(TEXT, 'every single day', 'daily'), cut(TEXT, ' after school', '')];
  it('picks cuts in order until the target is reached, and no more', () => {
    expect(preselect(TEXT, cuts, 13)).toEqual([true, false, false, false]); // 12 after the first
    expect(preselect(TEXT, cuts, 11)).toEqual([true, true, false, false]); // 11
    expect(preselect(TEXT, cuts, 10)).toEqual([true, true, true, false]); // 9
  });
  it('picks them all when even all of them fall short', () => {
    expect(preselect(TEXT, cuts, 3)).toEqual([true, true, true, true]);
  });
  it('never picks a cut that changes a fact, and goes on to the next', () => {
    const flagged = cuts.map((c, i) => (i === 0 ? { ...c, changesFacts: true } : c));
    expect(preselect(TEXT, flagged, 13)).toEqual([false, true, false, false]);
  });
  it('continues from a selection already made: the earlier choices stay, new cuts are picked only while over the target', () => {
    expect(preselect(TEXT, cuts, 11, [false, true])).toEqual([false, true, true, false]); // 13, then 11 after the third
    expect(preselect(TEXT, cuts, 13, [true, false])).toEqual([true, false, false, false]); // already at 12
  });
});

describe('the cuts after a search', () => {
  const TEXT = 'In order to win the final, we really practiced every single day after school.'; // 14 words
  const [a, b, c, d] = [cut(TEXT, 'In order to', 'To'), cut(TEXT, 'really', ''), cut(TEXT, 'every single day', 'daily'), cut(TEXT, ' after school', '')];
  it('the first search: its cuts, picked in order while over the target, and its version', () => {
    expect(withFound(TEXT, 12, { cuts: [a, b, c], version: 'v' })).toEqual({ target: 12, cuts: [a, b, c], selected: [true, false, false], version: 'v', versionChangesFacts: false });
    expect(withFound(TEXT, 12, { cuts: [a], version: null }).version).toBeNull();
  });
  it('a search for more: the cuts shown and the writer\'s picks first, then the new ones, picked only while still over; the first version stays', () => {
    const prior = { target: 10, cuts: [a, b], selected: [false, true], version: 'first', versionChangesFacts: false };
    expect(withFound(TEXT, 10, { cuts: [c, d], version: 'second' }, prior)).toEqual({ target: 10, cuts: [a, b, c, d], selected: [false, true, true, true], version: 'first', versionChangesFacts: false });
    expect(withFound(TEXT, 10, { cuts: [], version: 'second' }, { ...prior, version: null }).version).toBe('second');
  });
  it('the version\'s fact flag goes with the version kept, and is off without one', () => {
    expect(withFound(TEXT, 12, { cuts: [a], version: 'v', versionChangesFacts: true }).versionChangesFacts).toBe(true);
    expect(withFound(TEXT, 12, { cuts: [a], version: 'v' }).versionChangesFacts).toBe(false);
    expect(withFound(TEXT, 12, { cuts: [a], version: null, versionChangesFacts: true }).versionChangesFacts).toBe(false);
    const prior = { target: 10, cuts: [a, b], selected: [false, true], version: 'first', versionChangesFacts: false };
    expect(withFound(TEXT, 10, { cuts: [c], version: 'second', versionChangesFacts: true }, prior)).toMatchObject({ version: 'first', versionChangesFacts: false });
    expect(withFound(TEXT, 10, { cuts: [c], version: 'second', versionChangesFacts: true }, { ...prior, version: null })).toMatchObject({ version: 'second', versionChangesFacts: true });
  });
});
