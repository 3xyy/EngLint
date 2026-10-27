import { describe, expect, it } from 'vitest';
import { locateIssue } from '../../src/core/match';
import { mergeParagraph } from '../../src/core/merge';
import { HARPER_INSTANT, HARPER_TRUSTED, NEVER_DOUBLED, type SourcedIssue } from '../../src/core/sources';
import type { RawIssue } from '../../src/core/types';

const TEXT = 'Its a apple, and the the team is a testamant to teh Cokk.';
const at = (sub: string, from = 0) => {
  const i = TEXT.indexOf(sub, from);
  if (i === -1) throw new Error(`not in the text: ${sub}`);
  return i;
};

const claude = (original: string, o: Partial<RawIssue> = {}): RawIssue => ({
  original,
  replacement: `${original}!`,
  before: '',
  category: 'spelling',
  severity: 'error',
  kind: 'spelling',
  reason: 'claude',
  ...o,
});
/** A Harper issue on the first `original` in TEXT (or the one at `o.at`), with one suggestion unless given. */
const harper = (rule: string, original: string, o: Partial<SourcedIssue> = {}): SourcedIssue => ({
  original,
  replacement: `${original}!`,
  before: '',
  category: 'grammar',
  severity: 'error',
  kind: 'word_choice',
  reason: 'harper',
  source: 'harper',
  ruleId: `harper:${rule}`,
  at: at(original),
  suggestionCount: 1,
  ...o,
});
const tell = (name: string, original: string, o: Partial<SourcedIssue> = {}): SourcedIssue => ({
  original,
  replacement: null,
  before: '',
  category: 'delivery',
  severity: 'suggestion',
  kind: 'generic_phrasing',
  reason: 'tell',
  source: 'tells',
  ruleId: `tell:${name}`,
  at: at(original),
  ...o,
});

// Harper's AnA lint covers the article alone; `at` says which "a" it means.
const AN_A = harper('AnA', 'a', { replacement: 'an', kind: 'article', at: at('a apple') });
const REPEATED = harper('RepeatedWords', 'the the', { replacement: 'the', kind: 'repeated_word' });
const ITS = harper('ItsContraction', 'Its', { replacement: 'It’s', kind: 'its_vs_it_is' });
const SPELL_LOWER = harper('SpellCheck', 'teh', { replacement: 'the', category: 'spelling', kind: 'spelling' });
const SPELL_CAPITAL = harper('SpellCheck', 'Cokk', { replacement: 'Cook', category: 'spelling', kind: 'spelling' });
const SPELL_TESTAMENT = harper('SpellCheck', 'testamant', { replacement: 'testament', category: 'spelling', kind: 'spelling' });
const INFLATED = tell('inflated', 'a testamant to');

/** A Harper issue on `original` as a whole word in `text`, with one suggestion. */
const harperIn = (text: string, rule: string, original: string, replacement: string, o: Partial<SourcedIssue> = {}): SourcedIssue => {
  const index = text.search(new RegExp(`(?<!\\p{L})${original}(?!\\p{L})`, 'u'));
  if (index === -1) throw new Error(`not in the text: ${original}`);
  return { ...harper(rule, 'a'), original, replacement, at: index, ...o };
};

describe('the Harper rule sets', () => {
  it('hold rule names without the harper: prefix', () => {
    expect([...HARPER_INSTANT].sort()).toEqual(['AnA', 'ItsContraction', 'RepeatedWords', 'SpellCheck']);
    expect([...HARPER_TRUSTED].sort()).toEqual(['AnA']);
  });

  it('name the words never written twice in a row, on which a doubled word is instant', () => {
    expect([...NEVER_DOUBLED].sort()).toEqual(['a', 'an', 'and', 'for', 'from', 'my', 'of', 'our', 'the', 'their', 'to', 'with', 'your']);
  });
});

describe('mergeParagraph', () => {
  it('with only Claude, the merged list is Claude’s own list', () => {
    const list = [claude('teh', { before: 'testamant to' }), claude('Its', { replacement: 'It’s', kind: 'its_vs_it_is' })];
    expect(mergeParagraph(TEXT, { claude: list })).toBe(list);
    expect(mergeParagraph(TEXT, { claude: list, harper: [], tells: [] })).toBe(list);
    expect(mergeParagraph(TEXT, {})).toEqual([]);
  });

  describe('before Claude answers the paragraph', () => {
    it('only Harper issues on an instant rule with exactly one suggestion survive', () => {
      const twoFixes = { ...REPEATED, suggestionCount: 2 };
      const { suggestionCount: _, ...countUnknown } = ITS;
      expect(mergeParagraph(TEXT, { harper: [AN_A, twoFixes, countUnknown, SPELL_LOWER] })).toEqual([AN_A, SPELL_LOWER]);
    });

    it('a SpellCheck issue on a capitalized word does not survive', () => {
      expect(mergeParagraph(TEXT, { harper: [SPELL_CAPITAL, SPELL_LOWER] })).toEqual([SPELL_LOWER]);
    });

    it('a doubled word is instant only when the word is never written twice ("the the", "to to"), in any case', () => {
      const doubled = (text: string, original: string): SourcedIssue => ({
        ...REPEATED,
        original,
        replacement: original.split(' ')[0]!,
        at: text.indexOf(original),
      });
      const shown = (text: string, original: string) => mergeParagraph(text, { harper: [doubled(text, original)] }).length;
      expect(shown('I saw the the cat.', 'the the')).toBe(1);
      expect(shown('I want to to go home.', 'to to')).toBe(1);
      expect(shown('The The cat sat.', 'The The')).toBe(1);
      expect(shown('I had had enough.', 'had had')).toBe(0);
      expect(shown('It was very very good.', 'very very')).toBe(0);
      expect(shown('He came in in a hurry.', 'in in')).toBe(0);
      expect(shown('What it is is a mess.', 'is is')).toBe(0);
      expect(shown('I saw the cat cat.', 'the cat')).toBe(0); // not one word doubled
    });

    it('a SpellCheck fix that turns a lowercase word into another, capitalized word (a name) does not survive', () => {
      const text = 'My abuela taught me to post on instagram.';
      const name = harperIn(text, 'SpellCheck', 'abuela', 'Manuela', { category: 'spelling', kind: 'spelling' });
      const capitalOnly = harperIn(text, 'SpellCheck', 'instagram', 'Instagram', { category: 'spelling', kind: 'spelling' });
      expect(mergeParagraph(text, { harper: [name, capitalOnly] })).toEqual([capitalOnly]);
    });

    it('a SpellCheck issue on the last word of the paragraph, perhaps still being typed, does not survive', () => {
      const shown = (text: string) =>
        mergeParagraph(text, { harper: [harperIn(text, 'SpellCheck', 'opportu', 'opportune', { category: 'spelling', kind: 'spelling' })] }).length;
      expect(shown('I want the opportu')).toBe(0);
      expect(shown('I want the opportu​')).toBe(0); // the caret parked in a zero-width space
      expect(shown('I want the opportu.')).toBe(1);
      expect(shown('I want the opportu ')).toBe(1);
      expect(shown('My opportu came early')).toBe(1);
    });

    it('a rule outside the instant set does not survive', () => {
      const capitalization = harper('SentenceCapitalization', 'teh', { replacement: 'Teh', kind: 'capitalization' });
      expect(mergeParagraph(TEXT, { harper: [capitalization] })).toEqual([]);
    });
  });

  describe('once Claude answers the paragraph', () => {
    it('a Harper issue on a rule outside the trusted set is gone, also when Claude found nothing', () => {
      expect(mergeParagraph(TEXT, { claude: [], harper: [ITS, SPELL_LOWER] })).toEqual([]);
      const elsewhere = claude('Cokk', { replacement: 'Cook' });
      expect(mergeParagraph(TEXT, { claude: [elsewhere], harper: [ITS, SPELL_LOWER] })).toEqual([elsewhere]);
    });

    it('a trusted Harper issue that overlaps a Claude error is gone', () => {
      const wider = claude('a apple', { replacement: 'an apple', category: 'grammar', kind: 'article' });
      expect(mergeParagraph(TEXT, { claude: [wider], harper: [AN_A] })).toEqual([wider]);
      const same = claude('the the', { replacement: 'the', category: 'grammar', kind: 'repeated_word', before: 'Its a apple, and' });
      expect(mergeParagraph(TEXT, { claude: [same], harper: [REPEATED] })).toEqual([same]);
    });

    it('overlap uses the same locating as selection: a Claude error found through the typography fold still blocks', () => {
      const curled = 'It’s a apple.';
      const straight = claude("It's a", { replacement: "It's an", category: 'grammar', kind: 'article' });
      const anA = harper('AnA', 'a', { replacement: 'an', kind: 'article', at: 5 });
      expect(curled.slice(5, 6)).toBe('a');
      expect(mergeParagraph(curled, { claude: [straight], harper: [anA] })).toEqual([straight]);
    });

    it('a Claude suggestion does not block a trusted Harper issue (selection settles that overlap)', () => {
      const wordy = claude('a apple, and', { replacement: 'an apple and', category: 'clarity', severity: 'suggestion', kind: 'wordy_phrase' });
      expect(mergeParagraph(TEXT, { claude: [wordy], harper: [AN_A] })).toEqual([wordy, AN_A]);
    });

    it('a trusted Harper issue that does not overlap is kept, after the Claude issues', () => {
      const typo = claude('teh', { replacement: 'the' });
      expect(mergeParagraph(TEXT, { harper: [AN_A, REPEATED], claude: [typo] })).toEqual([typo, AN_A]);
    });

    it('a doubled word is not trusted: once Claude answers, even "the the" is Claude’s call', () => {
      expect(mergeParagraph(TEXT, { claude: [], harper: [REPEATED] })).toEqual([]);
    });
  });

  describe('an article before an acronym', () => {
    // Harper reads some all-caps words letter by letter and others as words, so its article fix there is unreliable.
    const shown = (text: string, original: string, replacement: string) => {
      const issue = harperIn(text, 'AnA', original, replacement, { kind: 'article' });
      return [mergeParagraph(text, { harper: [issue] }).length, mergeParagraph(text, { claude: [], harper: [issue] }).length];
    };

    it.each([
      ['I joined a STEM program.', 'a', 'an'],
      ['I built a STEAM lab.', 'a', 'an'],
      ['I hired an SAT tutor.', 'an', 'a'],
      ['I visited an MIT lab.', 'an', 'a'],
      ['I attended an MUN conference.', 'an', 'a'],
      ['I joined a STEM-focused club.', 'a', 'an'],
      ['I took a “STEM” class.', 'a', 'an'],
      ['A STEM camp changed my summer.', 'A', 'An'],
      ['She worked for a NGO.', 'a', 'an'], // right, but Claude still catches it
      ["I studied for an SAT's math section.", 'an', 'a'],
      ['I studied for an SAT’s math section.', 'an', 'a'],
      ["I toured an MIT's lab last summer.", 'an', 'a'],
      ['I hired an SATs tutor.', 'an', 'a'],
    ])('is dropped before and after Claude answers: %s', (text, original, replacement) => {
      expect(shown(text, original, replacement)).toEqual([0, 0]);
    });

    it.each([
      ['She ate a apple.', 'a', 'an'],
      ['He is a honest man.', 'a', 'an'],
      ['I saw an unicorn.', 'an', 'a'],
      ['I took a Uber home.', 'a', 'an'],
      ['He had a X-ray taken.', 'a', 'an'],
      ['She got a A on the test.', 'a', 'an'],
    ])('is kept before and after Claude answers before a word that is not an acronym: %s', (text, original, replacement) => {
      expect(shown(text, original, replacement)).toEqual([1, 1]);
    });
  });

  describe('tells', () => {
    it('a tell overlapping a Claude issue or a kept Harper issue is gone', () => {
      const typo = claude('testamant', { replacement: 'testament' });
      expect(mergeParagraph(TEXT, { claude: [typo], tells: [INFLATED] })).toEqual([typo]);
      expect(mergeParagraph(TEXT, { harper: [SPELL_TESTAMENT], tells: [INFLATED] })).toEqual([SPELL_TESTAMENT]);
    });

    it('a Harper issue the merge drops does not hide a tell', () => {
      expect(mergeParagraph(TEXT, { claude: [], harper: [SPELL_TESTAMENT], tells: [INFLATED] })).toEqual([INFLATED]);
    });

    it('a Harper issue with no fix is not instant, so it hides no tell', () => {
      const noFix = { ...SPELL_TESTAMENT, replacement: null };
      expect(mergeParagraph(TEXT, { harper: [noFix], tells: [INFLATED] })).toEqual([INFLATED]);
    });

    it('a tell that overlaps nothing is kept, last', () => {
      const typo = claude('teh', { replacement: 'the' });
      expect(mergeParagraph(TEXT, { tells: [INFLATED], harper: [AN_A], claude: [typo] })).toEqual([typo, AN_A, INFLATED]);
    });

    it('a Claude generic_phrasing issue wins over an overlapping tell', () => {
      const generic = claude('is a testamant to', {
        replacement: null,
        category: 'delivery',
        severity: 'suggestion',
        kind: 'generic_phrasing',
      });
      expect(mergeParagraph(TEXT, { claude: [generic], tells: [INFLATED] })).toEqual([generic]);
    });
  });
});

describe('locateIssue with at', () => {
  const text = 'the cat saw the dog';
  it('a correct at locates the second of two identical words', () => {
    expect(locateIssue(text, { original: 'the', before: '', at: 12 })).toEqual({ start: 12, end: 15 });
  });
  it('a wrong at falls back to the search', () => {
    expect(locateIssue(text, { original: 'the', before: '', at: 5 })).toEqual({ start: 0, end: 3 });
    expect(locateIssue(text, { original: 'the', before: 'cat saw', at: 99 })).toEqual({ start: 12, end: 15 });
  });
  it('a negative at falls back to the search, though slice would count it from the end', () => {
    expect(text.slice(-7, -4)).toBe('the');
    expect(locateIssue(text, { original: 'the', before: '', at: -7 })).toEqual({ start: 0, end: 3 });
  });
});
