import { describe, expect, it } from 'vitest';
import {
  addedWords,
  capFamily,
  issueId,
  locateIssue,
  MAX_PER_FAMILY,
  MAX_SUGGESTIONS,
  selectIssues,
  type SuggestionPolicy,
} from '../../src/core/match';
import { defaultFamilies } from '../../src/core/modes';
import type { FamilyToggles, Paragraph, RawIssue } from '../../src/core/types';
import { dictionaryForm } from '../../src/core/typography';

const raw = (o: Partial<RawIssue>): RawIssue => ({
  original: 'teh',
  replacement: 'the',
  before: '',
  category: 'spelling',
  severity: 'error',
  kind: 'typo',
  reason: 'r',
  ...o,
});
const para = (text: string, start = 0): Paragraph => ({ id: 'p0', text, start, hash: 'h1' });
const ALL_ON: FamilyToggles = { clarity: true, engagement: true, delivery: true, generic: true };
const policy = (o: Partial<SuggestionPolicy> = {}): SuggestionPolicy => ({
  mode: 'standard',
  families: ALL_ON,
  rules: new Set(),
  dictionary: new Set(),
  ...o,
});
const opts = policy();
const families = (o: Partial<FamilyToggles>): FamilyToggles => ({ ...ALL_ON, ...o });
/** A listed kind for each suggestion family, used when a test gives none. */
const KIND_OF: Record<string, string> = { clarity: 'wordy_phrase', engagement: 'repeated_word', delivery: 'hedging' };
/** A suggestion on `original`, with its replacement `original + 'x'` and a listed kind of its category unless given. */
const sug = (original: string, o: Partial<RawIssue> = {}): RawIssue => {
  const category = o.category ?? 'clarity';
  return raw({ original, replacement: original + 'x', severity: 'suggestion', category, kind: KIND_OF[category] ?? 'wordy_phrase', ...o });
};

describe('locateIssue', () => {
  it('unique occurrence', () => {
    expect(locateIssue('I has a cat.', { original: 'has', before: 'I' })).toEqual({ start: 2, end: 5 });
  });
  it('unique occurrence ignores a non-matching before', () => {
    expect(locateIssue('I has a cat.', { original: 'has', before: 'zzz' })).toEqual({ start: 2, end: 5 });
  });
  it('duplicate resolved by before', () => {
    expect(locateIssue('I saw the the dog and the cat.', { original: 'the', before: 'I saw the' })?.start).toBe(10);
  });
  it('ambiguous returns null', () => {
    expect(locateIssue('go go go', { original: 'go', before: 'go' })).toBeNull();
  });
  it('missing returns null', () => {
    expect(locateIssue('hello world', { original: 'teh', before: '' })).toBeNull();
  });
  it('before with NBSP', () => {
    expect(locateIssue('I saw teh cat. You saw teh dog.', { original: 'teh', before: 'I  saw' })?.start).toBe(6);
  });
  it('emoji before snippet', () => {
    expect(locateIssue('Hi 👋 teh cat', { original: 'teh', before: 'Hi 👋' })?.start).toBe(6);
  });
  it('empty before keeps only the occurrence with blank preceding text', () => {
    expect(locateIssue('teh and teh', { original: 'teh', before: '' })).toEqual({ start: 0, end: 3 });
  });

  describe('typography fallback', () => {
    it('finds a straight-quoted original in curled text', () => {
      expect(locateIssue('I don’t really know.', { original: "don't really", before: 'I' })).toEqual({ start: 2, end: 14 });
    });
    it('two folded matches and no disambiguating before: null', () => {
      expect(locateIssue('I don’t go and I don’t stay', { original: "don't", before: 'I' })).toBeNull();
    });
    it('a straight-quoted before disambiguates in curled text', () => {
      expect(locateIssue('I don’t know. You don’t know.', { original: 'know', before: "You don't" })).toEqual({
        start: 24,
        end: 28,
      });
    });
    it('a curled before disambiguates a straight-quoted original', () => {
      expect(locateIssue('I’m sure I don’t. You’re sure you don’t.', { original: "don't", before: 'I’m sure I' })).toEqual({
        start: 11,
        end: 16,
      });
    });
    it('maps an expanded ellipsis back to the one character', () => {
      expect(locateIssue('Wait… what', { original: 'Wait...', before: '' })).toEqual({ start: 0, end: 5 });
    });
    it('rejects a match that ends inside an expanded ellipsis', () => {
      expect(locateIssue('Wait… what', { original: 'Wait.', before: '' })).toBeNull();
    });
    it('rejects a match that starts inside an expanded ellipsis', () => {
      expect(locateIssue('Wait… what', { original: '. what', before: '' })).toBeNull();
    });
  });
});

describe('addedWords', () => {
  it('counts the words the replacement adds, as a case-insensitive multiset', () => {
    expect(addedWords('good', 'good in every single way')).toBe(4);
    expect(addedWords('a cat', 'a cat a cat a cat')).toBe(4);
    expect(addedWords('Good idea', 'good IDEA')).toBe(0);
    expect(addedWords('very big indeed', 'huge')).toBe(1);
  });
  it('treats ’ and \' alike inside a word', () => {
    expect(addedWords("don't go", 'don’t go')).toBe(0);
  });
});

describe('issueId', () => {
  it('joins hash, offset and kind', () => {
    expect(issueId('abc', 4, 'typo')).toBe('abc:4:typo');
  });
});

describe('selectIssues', () => {
  it('caps are 3 suggestions per paragraph and 2 per family', () => {
    expect([MAX_SUGGESTIONS, MAX_PER_FAMILY]).toEqual([3, 2]);
  });
  it('drops error without replacement', () => {
    expect(selectIssues(para('teh cat'), [raw({ replacement: null })], opts)).toEqual([]);
  });
  it('drops no-op', () => {
    expect(selectIssues(para('teh cat'), [raw({ replacement: 'teh' })], opts)).toEqual([]);
  });
  it('hides suggestions when clarity off', () => {
    const s = raw({ severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase' });
    expect(selectIssues(para('teh cat'), [s], policy({ families: families({ clarity: false }) }))).toEqual([]);
    expect(selectIssues(para('teh cat'), [s], opts)).toHaveLength(1);
  });
  it('a comment-only clarity note is located and kept when clarity is on', () => {
    const s = raw({ severity: 'suggestion', category: 'clarity', kind: 'unclear_reference', replacement: null });
    const out = selectIssues(para('a teh cat'), [s], opts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ original: 'teh', replacement: null, start: 2, end: 5 });
  });
  it('a comment-only clarity note is dropped when clarity is off', () => {
    const s = raw({ severity: 'suggestion', category: 'clarity', kind: 'unclear_reference', replacement: null });
    expect(selectIssues(para('teh cat'), [s], policy({ families: families({ clarity: false }) }))).toEqual([]);
    expect(selectIssues(para('teh cat'), [s], opts)).toHaveLength(1);
  });
  it('comment-only notes count toward the per-family cap', () => {
    const note = (original: string) => sug(original, { replacement: null });
    const out = selectIssues(para('aa bb cc dd'), [note('aa'), note('bb'), sug('cc')], opts);
    expect(out.map((i) => i.original)).toEqual(['aa', 'bb']);
  });
  it('drops unlocatable issues', () => {
    expect(selectIssues(para('hello'), [raw({})], opts)).toEqual([]);
  });
  it('keeps at most 2 suggestions from one family, the earliest first', () => {
    const out = selectIssues(para('aa bb cc dd'), [sug('dd'), sug('cc'), sug('bb')], opts);
    expect(out.map((i) => i.original)).toEqual(['bb', 'cc']);
  });
  it('error wins overlap', () => {
    const s = raw({ original: 'big cat', replacement: 'cat', severity: 'suggestion', kind: 'wordy_phrase' });
    const err = raw({ original: 'cat', replacement: 'cot', kind: 'e' });
    const out = selectIssues(para('a big cat'), [s, err], opts);
    expect(out.map((i) => i.kind)).toEqual(['e']);
    expect(selectIssues(para('a big cat'), [s], opts).map((i) => i.kind)).toEqual(['wordy_phrase']);
  });
  it('earlier start wins overlap between equal severities; touching ranges both stay', () => {
    const a = raw({ original: 'ab cd', replacement: 'x', kind: 'a' });
    const b = raw({ original: 'cd ef', replacement: 'y', kind: 'b' });
    expect(selectIssues(para('ab cd ef'), [b, a], opts).map((i) => i.kind)).toEqual(['a']);
    const c = raw({ original: 'ab', replacement: 'x', kind: 'c' });
    const d = raw({ original: 'cd', replacement: 'y', kind: 'd' });
    expect(selectIssues(para('abcd'), [d, c], opts).map((i) => i.kind)).toEqual(['c', 'd']);
  });
  it('absolute offsets add paragraph.start and ids use relative start', () => {
    const [i] = selectIssues(para('a teh b', 100), [raw({})], opts);
    expect(i).toMatchObject({ start: 102, end: 105, paragraphHash: 'h1', id: 'h1:2:typo' });
  });
  it('returns results sorted by start', () => {
    const a = raw({ original: 'cc', replacement: 'x', kind: 'a' });
    const b = raw({ original: 'aa', replacement: 'y', kind: 'b' });
    expect(selectIssues(para('aa bb cc'), [a, b], opts).map((i) => i.kind)).toEqual(['b', 'a']);
    const s = raw({ original: 'aa', replacement: 'y', severity: 'suggestion', kind: 'wordy_phrase' });
    expect(selectIssues(para('aa bb cc'), [a, s], opts).map((i) => i.kind)).toEqual(['wordy_phrase', 'a']);
  });

  describe('typography fallback', () => {
    it('takes original from the document and carries its apostrophe into the fix', () => {
      const s = sug("don't really", { before: 'I', replacement: "don't", kind: 'wordy_phrase' });
      const [i] = selectIssues(para('I don’t really know.', 100), [s], opts);
      expect(i).toMatchObject({ original: 'don’t really', replacement: 'don’t', start: 102, end: 114, id: 'h1:2:wordy_phrase' });
    });
    it("keeps the model's own original and replacement for the session's bookkeeping", () => {
      const s = sug("don't really", { before: 'I', replacement: "don't", kind: 'wordy_phrase' });
      const [i] = selectIssues(para('I don’t really know.'), [s], opts);
      expect(i!.model).toEqual({ original: "don't really", replacement: "don't" });
      const claim = sug('by 2025', { replacement: 'by next year', kind: 'wordy_phrase' });
      const [c] = selectIssues(para('We finish by 2025.'), [claim], opts);
      expect(c).toMatchObject({ replacement: null, model: { original: 'by 2025', replacement: 'by next year' } });
    });
    it('two folded matches and no disambiguating before: dropped', () => {
      const s = sug("don't", { before: 'I', replacement: 'do not' });
      expect(selectIssues(para('I don’t go and I don’t stay'), [s], opts)).toEqual([]);
    });
    it('an exact match whose span has ’ also carries it into the fix', () => {
      const s = sug('don’t really', { replacement: "don't", kind: 'wordy_phrase' });
      expect(selectIssues(para('I don’t really know.'), [s], opts)[0]).toMatchObject({ replacement: 'don’t' });
    });
    it('a fix that only curls what the document already curls is a no-op and dropped', () => {
      const e = raw({ original: "it's", replacement: 'it’s', category: 'punctuation', kind: 'apostrophe' });
      expect(selectIssues(para('I think it’s fine'), [e], opts)).toEqual([]);
    });
  });

  describe('suggestion policy', () => {
    it('a family toggle hides its suggestions; generic phrasing has its own toggle', () => {
      const delivery = sug('aa', { category: 'delivery', kind: 'hedging' });
      const generic = sug('bb', { category: 'delivery', kind: 'generic_phrasing' });
      const text = para('aa bb');
      const shown = (f: Partial<FamilyToggles>) =>
        selectIssues(text, [delivery, generic], policy({ families: families(f) })).map((i) => i.kind);
      expect(shown({})).toEqual(['hedging', 'generic_phrasing']);
      expect(shown({ delivery: false })).toEqual(['generic_phrasing']);
      expect(shown({ generic: false })).toEqual(['hedging']);
    });
    it('engagement has its own toggle', () => {
      const s = sug('aa', { category: 'engagement', kind: 'repeated_word' });
      expect(selectIssues(para('aa'), [s], policy({ families: families({ engagement: false }) }))).toEqual([]);
      expect(selectIssues(para('aa'), [s], policy({ families: families({ clarity: false, delivery: false }) }))).toHaveLength(1);
    });
    it('a clarity kind filed under an error category follows the clarity toggle', () => {
      const s = sug('aa', { category: 'word_choice', kind: 'wordy_phrase' });
      expect(selectIssues(para('aa'), [s], policy({ families: families({ clarity: false }) }))).toEqual([]);
      expect(selectIssues(para('aa'), [s], opts)).toHaveLength(1);
    });
    it('errors ignore the family toggles', () => {
      const off = families({ clarity: false, engagement: false, delivery: false, generic: false });
      expect(selectIssues(para('teh'), [raw({})], policy({ families: off }))).toHaveLength(1);
    });

    it('Essay drops an "off" kind and makes a "note" kind comment-only', () => {
      const hedging = sug('aa', { category: 'delivery', kind: 'hedging' });
      const vague = sug('bb', { category: 'engagement', kind: 'vague_word', replacement: 'big' });
      const essay = selectIssues(para('aa bb'), [hedging, vague], policy({ mode: 'essay' }));
      expect(essay.map((i) => [i.kind, i.replacement])).toEqual([['vague_word', null]]);
      const standard = selectIssues(para('aa bb'), [hedging, vague], opts);
      expect(standard.map((i) => [i.kind, i.replacement])).toEqual([
        ['hedging', 'aax'],
        ['vague_word', 'big'],
      ]);
    });
    it('a no-op suggestion is dropped before Essay could turn it into a note', () => {
      const s = sug('aa', { category: 'engagement', kind: 'vague_word', replacement: 'aa' });
      expect(selectIssues(para('aa'), [s], policy({ mode: 'essay' }))).toEqual([]);
    });
    it('a suggestion kind the model invents is hidden in Essay with the default families', () => {
      const text = para('I just think maybe');
      const invented = sug('I just think maybe', { category: 'delivery', kind: 'confidence', replacement: 'I think' });
      expect(selectIssues(text, [invented], policy({ mode: 'essay', families: defaultFamilies('essay') }))).toEqual([]);
    });
    it('a suggestion kind the model invents is hidden in Essay whatever its category, even with every family on', () => {
      for (const category of ['clarity', 'engagement', 'delivery', 'word_choice'] as const) {
        const s = sug('aa', { category, kind: 'made_up' });
        expect(selectIssues(para('aa'), [s], policy({ mode: 'essay', families: ALL_ON })), category).toEqual([]);
      }
    });
    it('in Standard, an invented clarity-category kind shows when Clarity is on and is hidden when Clarity is off', () => {
      const s = sug('aa', { category: 'clarity', kind: 'made_up', replacement: 'b' });
      const on = selectIssues(para('aa'), [s], policy({ mode: 'standard', families: families({ clarity: true }) }));
      expect(on.map((i) => [i.kind, i.replacement])).toEqual([['made_up', 'b']]);
      expect(selectIssues(para('aa'), [s], policy({ mode: 'standard', families: families({ clarity: false }) }))).toEqual([]);
    });
    it('a listed suggestion kind still shows in Essay and Standard', () => {
      const chairman = sug('chairman', { category: 'delivery', kind: 'inclusive_language', replacement: 'chair' });
      const essay = selectIssues(para('Ask the chairman'), [chairman], policy({ mode: 'essay', families: defaultFamilies('essay') }));
      expect(essay.map((i) => [i.kind, i.replacement])).toEqual([['inclusive_language', 'chair']]);
      const hedging = sug('I just think maybe', { category: 'delivery', kind: 'hedging', replacement: 'I think' });
      const standard = selectIssues(para('I just think maybe'), [hedging], policy({ mode: 'standard', families: ALL_ON }));
      expect(standard.map((i) => [i.kind, i.replacement])).toEqual([['hedging', 'I think']]);
    });
    it('an error with a kind the model invents is kept in every mode', () => {
      for (const mode of ['essay', 'standard', 'casual'] as const) {
        const shown = selectIssues(para('teh'), [raw({ kind: 'made_up' })], policy({ mode, families: defaultFamilies(mode) }));
        expect(shown.map((i) => [i.kind, i.replacement]), mode).toEqual([['made_up', 'the']]);
      }
    });
    it('Essay policy never touches errors', () => {
      const [e] = selectIssues(para('teh'), [raw({ kind: 'made_up' })], policy({ mode: 'essay' }));
      expect(e).toMatchObject({ replacement: 'the' });
    });

    it('Essay: a fix that adds more than 3 words becomes comment-only', () => {
      const wordy = (replacement: string) => sug('good', { kind: 'wordy_phrase', replacement });
      const fix = (replacement: string, mode: SuggestionPolicy['mode'] = 'essay') =>
        selectIssues(para('It was good.'), [wordy(replacement)], policy({ mode }))[0]?.replacement;
      expect(fix('good in every single way')).toBeNull();
      expect(fix('good in every way')).toBe('good in every way');
      expect(fix('good in every single way', 'standard')).toBe('good in every single way');
    });
    it('Essay: repeated words count as added words', () => {
      const s = sug('a cat', { kind: 'wordy_phrase', replacement: 'a cat a cat a cat' }); // a×2 and cat×2 added
      expect(selectIssues(para('a cat'), [s], policy({ mode: 'essay' }))[0]).toMatchObject({ replacement: null });
    });

    it('a suggestion that changes a claim becomes comment-only; an error keeps its fix', () => {
      const text = para('We finish by 2025.');
      const s = sug('by 2025', { replacement: 'by next year', kind: 'wordy_phrase' });
      expect(selectIssues(text, [s], opts)[0]).toMatchObject({ original: 'by 2025', replacement: null });
      const e = raw({ original: 'by 2025', replacement: 'by next year', category: 'grammar', kind: 'k' });
      expect(selectIssues(text, [e], opts)[0]).toMatchObject({ replacement: 'by next year' });
    });

    it('a rule hides its kind', () => {
      const s = sug('aa', { kind: 'passive_voice' });
      const other = sug('bb', { kind: 'wordy_phrase' });
      expect(selectIssues(para('aa bb'), [s, other], policy({ rules: new Set(['passive_voice']) })).map((i) => i.kind)).toEqual([
        'wordy_phrase',
      ]);
      expect(selectIssues(para('aa bb'), [s, other], opts)).toHaveLength(2);
    });

    it('a dictionary word hides a spelling error on it, ignoring case and punctuation', () => {
      const text = para('We use Kubernetes, daily.');
      const dictionary = new Set(['kubernetes']);
      const spelling = raw({ original: 'Kubernetes,', replacement: 'Kubernetes', category: 'spelling', kind: 'spelling' });
      expect(selectIssues(text, [spelling], policy({ dictionary }))).toEqual([]);
      expect(selectIssues(text, [spelling], opts)).toHaveLength(1);
      const grammar = raw({ original: 'Kubernetes,', replacement: 'the Kubernetes,', category: 'grammar', kind: 'article' });
      expect(selectIssues(text, [grammar], policy({ dictionary }))).toHaveLength(1);
    });

    it("a dictionary word added from the document's curled text hides the model's straight-quoted flag", () => {
      const text = para('I met O’Brien today.');
      const dictionary = new Set([dictionaryForm('O’Brien')]);
      const spelling = raw({ original: "O'Brien", replacement: "O'Brian", category: 'spelling', kind: 'spelling' });
      expect(selectIssues(text, [spelling], policy({ dictionary }))).toEqual([]);
      expect(selectIssues(text, [spelling], opts)).toHaveLength(1);
    });

    it('caps: family priority then position; errors uncapped; output in position order', () => {
      const text = para('aa bb cc dd ee ff gg hh ii jj');
      const issues = [
        sug('ff', { category: 'clarity' }),
        sug('aa', { category: 'delivery' }),
        sug('dd', { category: 'engagement' }),
        raw({ original: 'jj', replacement: 'x', kind: 'e4' }),
        sug('ee', { category: 'clarity' }),
        raw({ original: 'gg', replacement: 'x', kind: 'e1' }),
        sug('bb', { category: 'engagement' }),
        raw({ original: 'hh', replacement: 'x', kind: 'e2' }),
        sug('cc', { category: 'clarity' }),
        raw({ original: 'ii', replacement: 'x', kind: 'e3' }),
      ];
      const out = selectIssues(text, issues, opts);
      // 2 clarity (cc, ee), 1 engagement (bb), 0 delivery; all 4 errors.
      expect(out.map((i) => i.original)).toEqual(['bb', 'cc', 'ee', 'gg', 'hh', 'ii', 'jj']);
    });
    it('generic phrasing shares the delivery cap', () => {
      const issues = [
        sug('aa', { category: 'delivery', kind: 'hedging' }),
        sug('bb', { category: 'delivery', kind: 'generic_phrasing' }),
        sug('cc', { category: 'delivery', kind: 'formality' }),
      ];
      expect(selectIssues(para('aa bb cc'), issues, opts).map((i) => i.original)).toEqual(['aa', 'bb']);
    });

    it('a known kind filed under another category follows its own family for toggles and caps', () => {
      const vague = sug('cc', { category: 'clarity', kind: 'vague_word' });
      expect(capFamily(vague)).toBe('engagement');
      expect(selectIssues(para('cc'), [vague], policy({ families: families({ engagement: false }) }))).toEqual([]);
      expect(selectIssues(para('cc'), [vague], policy({ families: families({ clarity: false }) }))).toHaveLength(1);
      const issues = [
        sug('aa', { category: 'engagement', kind: 'repeated_word' }),
        sug('bb', { category: 'engagement', kind: 'overused_word' }),
        vague,
      ];
      expect(selectIssues(para('aa bb cc'), issues, opts).map((i) => i.original)).toEqual(['aa', 'bb']);
    });
    it('generic phrasing follows the generic toggle under any category', () => {
      for (const category of ['engagement', 'word_choice'] as const) {
        const s = sug('aa', { category, kind: 'generic_phrasing' });
        expect(capFamily(s), category).toBe('delivery');
        expect(selectIssues(para('aa'), [s], policy({ families: families({ generic: false }) })), category).toEqual([]);
        const onlyGeneric = families({ clarity: false, engagement: false, delivery: false });
        expect(selectIssues(para('aa'), [s], policy({ families: onlyGeneric })), category).toHaveLength(1);
      }
    });
    it('in Standard, an invented kind follows its category', () => {
      const s = sug('aa', { category: 'engagement', kind: 'made_up' });
      expect(capFamily(s)).toBe('engagement');
      expect(selectIssues(para('aa'), [s], policy({ families: families({ engagement: false }) }))).toEqual([]);
      expect(selectIssues(para('aa'), [s], policy({ families: families({ clarity: false }) }))).toHaveLength(1);
    });
    it('a suggestion with a known correctness kind is malformed and dropped; the same kind as an error is kept', () => {
      const s = sug('aa', { category: 'clarity', kind: 'word_choice', replacement: 'b' });
      for (const mode of ['essay', 'standard'] as const) {
        expect(selectIssues(para('aa'), [s], policy({ mode })), mode).toEqual([]);
      }
      const underError = sug('aa', { category: 'word_choice', kind: 'spelling', replacement: 'b' });
      expect(selectIssues(para('aa'), [underError], opts)).toEqual([]);
      const e = raw({ original: 'teh', replacement: 'the', category: 'word_choice', kind: 'word_choice' });
      for (const mode of ['essay', 'standard'] as const) {
        expect(selectIssues(para('teh'), [e], policy({ mode })).map((i) => i.kind), mode).toEqual(['word_choice']);
      }
    });
    it('in Standard, an unknown suggestion kind under an error category is a Clarity suggestion', () => {
      const s = sug('aa', { category: 'word_choice', kind: 'made_up', replacement: 'b' });
      expect(selectIssues(para('aa'), [s], opts)).toHaveLength(1);
      expect(selectIssues(para('aa'), [s], policy({ families: families({ clarity: false }) }))).toEqual([]);
      expect(capFamily(s)).toBe('clarity');
    });
    it('a retired kind the model invents is dropped in every mode', () => {
      const s = sug('aa', { category: 'delivery', kind: 'politeness', replacement: 'b' });
      for (const mode of ['essay', 'standard', 'casual'] as const) {
        expect(selectIssues(para('aa'), [s], policy({ mode })), mode).toEqual([]);
      }
      expect(selectIssues(para('teh'), [raw({ kind: 'politeness' })], opts)).toEqual([]);
    });

    it('Casual drops every suggestion whatever the toggles, and keeps errors', () => {
      const issues = [sug('aa'), sug('bb', { category: 'engagement' }), raw({ original: 'teh' })];
      expect(selectIssues(para('aa bb teh'), issues, policy({ mode: 'casual' })).map((i) => i.original)).toEqual(['teh']);
    });
  });
});
