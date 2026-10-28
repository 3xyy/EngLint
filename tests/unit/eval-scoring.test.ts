import { describe, expect, it } from 'vitest';
import { allRatingsStrong, quoteHitRate, seededRecall } from '../../evals/review-scoring';
import { reportLabelledSuggestions, scoreSuggestions, type ScoredFixture } from '../../evals/suggestion-scoring';
import {
  instantCandidates,
  pruneInstant,
  scoreFlags,
  scoreTells,
  type Flag,
  type RuleTally,
} from '../../evals/sources-scoring';
import type { Grading, Rating } from '../../src/core/review-schema';
import type { LocatedIssue, RawIssue } from '../../src/core/types';

const TEXT = 'We met in order to plan the trip. It was very good and the weather held.';

function shown(over: Partial<LocatedIssue> & { start: number; end: number }): LocatedIssue {
  const original = TEXT.slice(over.start, over.end);
  return {
    original,
    replacement: null,
    before: '',
    category: 'clarity',
    severity: 'suggestion',
    kind: 'wordy_phrase',
    reason: 'x',
    model: { original, replacement: null },
    id: `p:${over.start}:k`,
    paragraphHash: 'h',
    ...over,
  };
}

const at = (sub: string) => ({ start: TEXT.indexOf(sub), end: TEXT.indexOf(sub) + sub.length });

const fixture: ScoredFixture = {
  text: TEXT,
  suggest: [{ original: 'in order to', family: 'clarity' }],
  acceptable: [{ original: 'very good', family: 'engagement' }],
};

describe('scoreSuggestions', () => {
  it('counts a suggestion overlapping a suggest span of the same family as correct', () => {
    const r = scoreSuggestions(fixture, [shown({ ...at('order to') })]);
    expect(r.correct).toBe(1);
    expect(r.falsePositive).toBe(0);
    expect(r.perFamily.clarity).toEqual({ correct: 1, flagged: 1 });
  });

  it('counts the same span under a different family as a false positive', () => {
    const r = scoreSuggestions(fixture, [shown({ ...at('in order to'), category: 'engagement', kind: 'vague_word' })]);
    expect(r.correct).toBe(0);
    expect(r.falsePositive).toBe(1);
    expect(r.perFamily.engagement).toEqual({ correct: 0, flagged: 1 });
    expect(r.perFamily.clarity).toEqual({ correct: 0, flagged: 0 });
  });

  it('counts a suggestion overlapping an acceptable span as correct', () => {
    const r = scoreSuggestions(fixture, [shown({ ...at('very good'), category: 'engagement', kind: 'vague_word' })]);
    expect(r.correct).toBe(1);
    expect(r.falsePositive).toBe(0);
  });

  it('counts any suggestion on a fixture with no labels as a false positive', () => {
    const r = scoreSuggestions({ text: TEXT }, [shown({ ...at('in order to') })]);
    expect(r).toMatchObject({ correct: 0, falsePositive: 1 });
    expect(r.perFamily.clarity).toEqual({ correct: 0, flagged: 1 });
  });

  it('scores a comment-only note by span and family, and files generic phrasing under delivery', () => {
    const note = shown({ ...at('very good'), replacement: null, category: 'engagement', kind: 'vague_word' });
    expect(scoreSuggestions(fixture, [note]).correct).toBe(1);
    const generic = shown({ ...at('plan the trip'), category: 'delivery', kind: 'generic_phrasing' });
    const f: ScoredFixture = { text: TEXT, suggest: [{ original: 'plan the trip', family: 'delivery' }] };
    const r = scoreSuggestions(f, [generic]);
    expect(r.perFamily.delivery).toEqual({ correct: 1, flagged: 1 });
  });

  it('does not count errors', () => {
    const err = shown({ ...at('in order to'), severity: 'error', category: 'grammar', kind: 'word_choice', replacement: 'to' });
    const r = scoreSuggestions({ text: TEXT }, [err]);
    expect(r).toEqual({
      correct: 0,
      falsePositive: 0,
      perFamily: {
        clarity: { correct: 0, flagged: 0 },
        engagement: { correct: 0, flagged: 0 },
        delivery: { correct: 0, flagged: 0 },
      },
      perToggle: {
        clarity: { correct: 0, flagged: 0 },
        engagement: { correct: 0, flagged: 0 },
        delivery: { correct: 0, flagged: 0 },
        generic: { correct: 0, flagged: 0 },
      },
    });
  });

  it('scores a suggestion filed under an error category as clarity, as selectIssues shows it', () => {
    const odd = shown({ ...at('in order to'), category: 'word_choice', kind: 'wordy_phrase' });
    const r = scoreSuggestions(fixture, [odd]);
    expect(r).toMatchObject({ correct: 1, falsePositive: 0 });
    expect(r.perFamily.clarity).toEqual({ correct: 1, flagged: 1 });
    const wrong = scoreSuggestions({ text: TEXT }, [odd]);
    expect(wrong).toMatchObject({ correct: 0, falsePositive: 1 });
  });

  it('scores a known kind by its own family, not the category the model filed it under', () => {
    const vague = shown({ ...at('very good'), category: 'clarity', kind: 'vague_word' });
    const r = scoreSuggestions(fixture, [vague]);
    expect(r).toMatchObject({ correct: 1, falsePositive: 0 });
    expect(r.perFamily.engagement).toEqual({ correct: 1, flagged: 1 });
    expect(r.perFamily.clarity).toEqual({ correct: 0, flagged: 0 });
  });

  it('scores generic phrasing as delivery even when the model filed it under clarity', () => {
    const f: ScoredFixture = { text: TEXT, suggest: [{ original: 'plan the trip', family: 'delivery' }] };
    const generic = shown({ ...at('plan the trip'), category: 'clarity', kind: 'generic_phrasing' });
    const r = scoreSuggestions(f, [generic]);
    expect(r).toMatchObject({ correct: 1, falsePositive: 0 });
    expect(r.perFamily.delivery).toEqual({ correct: 1, flagged: 1 });
    expect(r.perFamily.clarity).toEqual({ correct: 0, flagged: 0 });
  });

  it('aggregates a correct generic_phrasing suggestion under the generic toggle, not delivery', () => {
    const f: ScoredFixture = { text: TEXT, suggest: [{ original: 'plan the trip', family: 'delivery' }] };
    const generic = shown({ ...at('plan the trip'), category: 'delivery', kind: 'generic_phrasing' });
    const r = scoreSuggestions(f, [generic]);
    expect(r.correct).toBe(1);
    expect(r.perToggle.generic).toEqual({ correct: 1, flagged: 1 });
    expect(r.perToggle.delivery).toEqual({ correct: 0, flagged: 0 });
  });

  it('aggregates a false-positive hedging suggestion under delivery', () => {
    const hedge = shown({ ...at('very good'), category: 'delivery', kind: 'hedging' });
    const r = scoreSuggestions({ text: TEXT }, [hedge]);
    expect(r.falsePositive).toBe(1);
    expect(r.perToggle.delivery).toEqual({ correct: 0, flagged: 1 });
    expect(r.perToggle.generic).toEqual({ correct: 0, flagged: 0 });
  });
});

describe('reportLabelledSuggestions', () => {
  const labelled: ScoredFixture = {
    text: TEXT,
    suggest: [
      { original: 'in order to', family: 'clarity', kind: 'wordy_phrase', replacement: 'to' },
      { original: 'very good', family: 'engagement', kind: 'vague_word' },
    ],
    acceptable: [{ original: 'the weather held', family: 'clarity' }],
  };
  const model = (o: Partial<RawIssue>): RawIssue => ({
    original: 'x',
    replacement: 'y',
    before: '',
    category: 'clarity',
    severity: 'suggestion',
    kind: 'wordy_phrase',
    reason: 'r',
    ...o,
  });

  it('marks each shown suggestion OK on a label of its family, else FP, and leaves errors out', () => {
    const ok = shown({ ...at('in order to'), replacement: 'to' });
    const fp = shown({ ...at('plan the trip'), replacement: 'plan' });
    const wrongFamily = shown({ ...at('the weather held'), category: 'engagement', kind: 'vague_word' });
    const err = shown({ ...at('It was'), severity: 'error', category: 'grammar', kind: 'k', replacement: 'Was' });
    const { details, tally } = reportLabelledSuggestions('f1', labelled, [ok, fp, wrongFamily, err], []);
    expect(tally).toMatchObject({ ok: 1, fp: 2 });
    expect(details).toContain('SUGGEST OK   [f1] "in order to" -> "to" (clarity/wordy_phrase)');
    expect(details).toContain('SUGGEST FP   [f1] "plan the trip" -> "plan" (clarity/wordy_phrase)');
    expect(details).toContain('SUGGEST FP   [f1] "the weather held" -> null (engagement/vague_word)');
    expect(details.join('\n')).not.toContain('It was');
  });

  it('counts a suggest label found when a shown suggestion of its family overlaps it, and reports a MISS otherwise', () => {
    const otherFamily = shown({ ...at('very good'), replacement: 'good', category: 'clarity', kind: 'wordy_phrase' });
    const { details, tally } = reportLabelledSuggestions('f1', labelled, [shown({ ...at('order'), replacement: null }), otherFamily], []);
    expect(tally).toMatchObject({ found: 1, total: 2 });
    expect(details).toContain('SUGGEST MISS [f1] "very good" (engagement/vague_word)');
    expect(details.some((d) => d.startsWith('SUGGEST MISS') && d.includes('in order to'))).toBe(false);
  });

  it('a label that names its fix gets FIX OK when a shown replacement holds it as a whole word, in any case', () => {
    const report = (replacement: string | null) => reportLabelledSuggestions('f1', labelled, [shown({ ...at('in order to'), replacement })], []);
    expect(report('To').tally).toMatchObject({ fixes: 1, fixTotal: 1 });
    expect(report('To').details).toContain('FIX OK   [f1] "in order to": expected "to", shown "To"');
    expect(report('so as to').tally).toMatchObject({ fixes: 1, fixTotal: 1 });
    for (const replacement of ['toward', null]) {
      const r = report(replacement);
      expect(r.tally, String(replacement)).toMatchObject({ found: 1, fixes: 0, fixTotal: 1 });
      expect(r.details.some((d) => d.startsWith('FIX DIFF [f1] "in order to": expected "to"')), String(replacement)).toBe(true);
    }
    expect(report('to').details.some((d) => d.includes('very good') && d.startsWith('FIX'))).toBe(false); // names no fix
  });

  it('lists each suggestion the model gave that is not shown as HIDDEN, and never an error', () => {
    const kept = model({ original: 'in order to', replacement: 'to' });
    const capped = model({ original: 'very good', replacement: 'valuable', category: 'engagement', kind: 'vague_word' });
    const error = model({ original: 'It was', replacement: 'Was', severity: 'error', category: 'grammar', kind: 'k' });
    const shownKept = shown({ ...at('in order to'), replacement: 'to', model: { original: 'in order to', replacement: 'to' } });
    const { details } = reportLabelledSuggestions('f1', labelled, [shownKept], [kept, capped, error]);
    expect(details.filter((d) => d.startsWith('HIDDEN'))).toEqual([
      'HIDDEN   [f1] "very good" -> "valuable" (engagement/vague_word) given by the model, not shown',
    ]);
  });
});

describe('review scoring helpers', () => {
  const TEXT_R = 'The garden was “quiet” and we waited — long.';
  const issueAt = (sub: string) => shown({ start: TEXT_R.indexOf(sub), end: TEXT_R.indexOf(sub) + sub.length });

  it('quoteHitRate is the share of quotes found in the text, folding typography', () => {
    expect(quoteHitRate(['The garden was "quiet"', 'we waited - long', 'not in the text'], TEXT_R)).toBeCloseTo(2 / 3);
  });
  it('quoteHitRate is 0 for no quotes', () => {
    expect(quoteHitRate([], TEXT_R)).toBe(0);
  });

  it('seededRecall counts a seed when an issue range overlaps its original', () => {
    const seeds = [{ original: 'garden' }, { original: 'waited' }, { original: 'long' }];
    expect(seededRecall(TEXT_R, [issueAt('garden was'), issueAt('wait')], seeds)).toBeCloseTo(2 / 3);
  });
  it('seededRecall ignores an issue that only touches the seed edge and a seed missing from the text', () => {
    expect(seededRecall(TEXT_R, [issueAt('The ')], [{ original: 'garden' }, { original: 'absent' }])).toBe(0);
  });

  const grading = (...ratings: Rating[]): Grading => ({
    criteria: ratings.map((rating, i) => ({ name: `c${i}`, rating, evidence: [], raise: '' })),
    grade: null,
  });
  it('allRatingsStrong is true only when every criterion is strong', () => {
    expect(allRatingsStrong(grading('strong', 'strong'))).toBe(true);
    expect(allRatingsStrong(grading('strong', 'solid'))).toBe(false);
    expect(allRatingsStrong(grading('needs_work'))).toBe(false);
  });
  it('allRatingsStrong is false for no grading or no criteria', () => {
    expect(allRatingsStrong(null)).toBe(false);
    expect(allRatingsStrong(grading())).toBe(false);
  });
});

describe('scoreFlags', () => {
  const text = 'She said teh thing, and its not true.';
  const gold = [
    { original: 'teh', replacement: 'the' },
    { original: 'its', replacement: "it's" },
  ];
  const flag = (rule: string, original: string, replacement: string | null, suggestionCount = 1): Flag => ({
    rule,
    original,
    replacement,
    at: text.indexOf(original),
    suggestionCount,
  });

  it('counts a flag on a gold span with the same fix as matched', () => {
    const t = scoreFlags([{ text, flags: [flag('The', 'teh', 'the')], gold }]);
    expect(t.The).toEqual({ flags: 1, overlapping: 1, matched: 1, manyFixes: 0 });
  });
  it('counts an overlapping flag with another fix as overlapping but not matched', () => {
    const t = scoreFlags([{ text, flags: [flag('SpellCheck', 'teh', 'tea')], gold }]);
    expect(t.SpellCheck).toEqual({ flags: 1, overlapping: 1, matched: 0, manyFixes: 0 });
  });
  it('counts a flag away from every gold span as neither', () => {
    const t = scoreFlags([{ text, flags: [flag('SpellCheck', 'thing', 'things')], gold }]);
    expect(t.SpellCheck).toEqual({ flags: 1, overlapping: 0, matched: 0, manyFixes: 0 });
  });
  it('compares fixes after carrying the document typography', () => {
    const curly = 'They didn’t go.';
    const f: Flag = { rule: 'Agreement', original: 'didn’t', replacement: "wasn't", at: 5, suggestionCount: 1 };
    const t = scoreFlags([{ text: curly, flags: [f], gold: [{ original: 'didn’t', replacement: 'wasn’t' }] }]);
    expect(t.Agreement).toEqual({ flags: 1, overlapping: 1, matched: 1, manyFixes: 0 });
  });
  it('matches a flag that fixes a narrower span when the corrected text comes out the same', () => {
    const year = 'Darwin spent nearly an year aboard the ship.';
    const f: Flag = { rule: 'AnA', original: 'an', replacement: 'a', at: year.indexOf('an year'), suggestionCount: 1 };
    const t = scoreFlags([{ text: year, flags: [f], gold: [{ original: 'an year', replacement: 'a year' }] }]);
    expect(t.AnA).toEqual({ flags: 1, overlapping: 1, matched: 1, manyFixes: 0 });
  });
  it('does not match a narrower flag whose corrected text differs from the gold fix', () => {
    const year = 'Darwin spent nearly an year aboard the ship.';
    const f: Flag = { rule: 'AnA', original: 'an', replacement: 'the', at: year.indexOf('an year'), suggestionCount: 1 };
    const t = scoreFlags([{ text: year, flags: [f], gold: [{ original: 'an year', replacement: 'a year' }] }]);
    expect(t.AnA?.matched).toBe(0);
  });
  it('counts flags with several fixes', () => {
    const t = scoreFlags([{ text, flags: [flag('ItsContraction', 'its', "it's", 2)], gold }]);
    expect(t.ItsContraction).toEqual({ flags: 1, overlapping: 1, matched: 1, manyFixes: 1 });
  });
  it('adds up across paragraphs', () => {
    const t = scoreFlags([
      { text, flags: [flag('The', 'teh', 'the')], gold },
      { text, flags: [flag('The', 'thing', 'things')], gold: [] },
    ]);
    expect(t.The).toEqual({ flags: 2, overlapping: 1, matched: 1, manyFixes: 0 });
  });
});

describe('instant list from tallies', () => {
  const tally = (flags: number, matched: number, manyFixes = 0): RuleTally => ({ flags, overlapping: matched, matched, manyFixes });
  const tallies = {
    Good: tally(40, 40),
    Edge: tally(100, 95),
    Over: tally(100, 94),
    Many: tally(50, 50, 3),
  };
  it('proposes a rule at or under the false-flag limit that always gives one fix', () => {
    expect(instantCandidates(tallies, 0.05)).toEqual(['Edge', 'Good']);
  });
  it('proposes no rule that has not flagged anything', () => {
    expect(instantCandidates({ Silent: tally(0, 0) }, 0.05)).toEqual([]);
  });
  it('prunes a listed rule above the limit and keeps one with no flags', () => {
    expect(pruneInstant(new Set(['Good', 'Edge', 'Over', 'Silent']), tallies, 0.05)).toEqual(['Edge', 'Good', 'Silent']);
  });
});

describe('scoreTells labels', () => {
  it('ignores a label whose text is not in the paragraph', () => {
    const r = scoreTells({ text: 'It is plain.', expect: [{ pattern: 'runup', original: 'absent phrase' }] }, [
      { ruleId: 'tell:runup', original: 'It', at: 0 },
    ]);
    expect(r.runup).toEqual({ tp: 0, fp: 1, fn: 1 });
  });
});

describe('scoreTells', () => {
  const text = 'It is important to note that we left. It stands as a testament to luck.';
  const hit = (pattern: string, original: string) => ({ ruleId: `tell:${pattern}`, original, at: text.indexOf(original) });
  it('scores a hit on a labeled span of the same pattern as a true positive, a missing label as a miss', () => {
    const r = scoreTells(
      { text, expect: [{ pattern: 'runup', original: 'It is important to note that' }, { pattern: 'inflated', original: 'stands as a testament to' }] },
      [hit('runup', 'It is important to note that')],
    );
    expect(r.runup).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(r.inflated).toEqual({ tp: 0, fp: 0, fn: 1 });
  });
  it('scores a hit with no label as a false positive, also under another pattern', () => {
    const r = scoreTells(
      { text, expect: [{ pattern: 'runup', original: 'It is important to note that' }] },
      [hit('serves_as', 'stands as')],
    );
    expect(r.serves_as).toEqual({ tp: 0, fp: 1, fn: 0 });
    expect(r.runup).toEqual({ tp: 0, fp: 0, fn: 1 });
  });
  it('does not match a label of another pattern on the same span', () => {
    const r = scoreTells({ text, expect: [{ pattern: 'inflated', original: 'stands as a testament to' }] }, [
      hit('serves_as', 'stands as'),
    ]);
    expect(r.serves_as?.fp).toBe(1);
    expect(r.inflated?.fn).toBe(1);
  });
});
