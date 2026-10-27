// @vitest-environment node
import { LocalLinter, SuggestionKind } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';
import { beforeAll, describe, expect, it, type Mock, vi } from 'vitest';
import { type LintLike, mapLints } from '../../src/core/harper-map';
import { kindInfo } from '../../src/core/kinds';
import { selectIssues } from '../../src/core/match';
import { mergeParagraph } from '../../src/core/merge';
import { defaultFamilies } from '../../src/core/modes';
import type { SourcedIssue } from '../../src/core/sources';

const { Replace, Remove, InsertAfter } = SuggestionKind;

interface FakeLint extends LintLike {
  free: Mock<() => void>;
  freedSuggestions: () => number;
  freedSpans: () => number;
}

/** A plain object shaped like Harper's Lint, over `paragraph.slice(start, end)`. */
function lint(
  start: number,
  end: number,
  o: { kind?: string; message?: string; suggestions?: [number, string][]; count?: number; throws?: boolean } = {},
): FakeLint {
  const suggestions = o.suggestions ?? [[Replace, 'x']];
  let freed = 0;
  let spansFreed = 0;
  return {
    span: () => {
      if (o.throws) throw new Error('span');
      return { start, end, free: () => void spansFreed++ };
    },
    lint_kind: () => o.kind ?? 'Grammar',
    message: () => o.message ?? 'a message',
    suggestion_count: () => o.count ?? suggestions.length,
    suggestions: () =>
      suggestions.map(([kind, text]) => ({ kind: () => kind, get_replacement_text: () => text, free: () => void freed++ })),
    free: vi.fn<() => void>(),
    freedSuggestions: () => freed,
    freedSpans: () => spansFreed,
  };
}

const APPLE = 'This is a apple.';

describe('mapLints', () => {
  it('maps a lint to a Harper issue: span text, start, preceding words, first fix, message, rule id and fix count', () => {
    const issues = mapLints(APPLE, {
      AnA: [lint(8, 9, { kind: 'Miscellaneous', message: 'Incorrect indefinite article.', suggestions: [[Replace, 'an']] })],
    });
    expect(issues).toEqual<SourcedIssue[]>([
      {
        original: 'a',
        replacement: 'an',
        before: 'This is',
        category: 'grammar',
        severity: 'error',
        kind: 'article',
        reason: 'Incorrect indefinite article.',
        source: 'harper',
        ruleId: 'harper:AnA',
        at: 8,
        suggestionCount: 1,
      },
    ]);
  });

  it('counts the fixes with suggestion_count() and offers the first one', () => {
    const text = 'I will recieve it.';
    const [issue] = mapLints(text, {
      SpellCheck: [lint(7, 14, { kind: 'Spelling', suggestions: [[Replace, 'receive'], [Replace, 'relieve'], [Replace, 'recipe']] })],
    });
    expect(issue).toMatchObject({ original: 'recieve', replacement: 'receive', suggestionCount: 3 });
  });

  it('turns each suggestion kind into a replacement: Replace, Remove and InsertAfter', () => {
    const text = 'However we went home , then left.';
    const [replace, remove, insert] = mapLints(text, {
      ModalOf: [lint(16, 20, { kind: 'WordChoice', suggestions: [[Replace, 'house']] })],
      // Harper gives a Remove no text; a removal stays a removal whatever text it carries.
      CommaFixes: [lint(20, 21, { kind: 'Punctuation', suggestions: [[Remove, ',']] })],
      IntroComma: [lint(0, 7, { kind: 'Punctuation', suggestions: [[InsertAfter, ',']] })],
    });
    expect(replace).toMatchObject({ original: 'home', replacement: 'house' });
    expect(remove).toMatchObject({ original: ' ', replacement: '', at: 20 });
    expect(insert).toMatchObject({ original: 'However', replacement: 'However,', at: 0 });
  });

  it('drops a lint with no suggestion, and one over no text', () => {
    expect(mapLints(APPLE, { AnA: [lint(8, 9, { suggestions: [] })] })).toEqual([]);
    expect(mapLints(APPLE, { Grammar: [lint(8, 8, { suggestions: [[InsertAfter, 'n']] })] })).toEqual([]);
  });

  it('files each correctness kind under its category, as an error', () => {
    const rows: [string, string][] = [
      ['Spelling', 'spelling'],
      ['Typo', 'spelling'],
      ['Agreement', 'grammar'],
      ['Grammar', 'grammar'],
      ['WordOrder', 'grammar'],
      ['BoundaryError', 'grammar'],
      ['Capitalization', 'grammar'],
      ['Punctuation', 'punctuation'],
      ['Formatting', 'punctuation'],
      ['WordChoice', 'word_choice'],
      ['Malapropism', 'word_choice'],
      ['Eggcorn', 'word_choice'],
      ['Usage', 'word_choice'],
      ['Nonstandard', 'word_choice'],
      ['Regionalism', 'word_choice'],
    ];
    for (const [kind, category] of rows) {
      const [issue] = mapLints(APPLE, { SomeRule: [lint(0, 4, { kind })] });
      expect(issue, kind).toMatchObject({ category, severity: 'error', original: 'This', at: 0, before: '' });
    }
  });

  it('drops the style kinds and any kind it does not know, for a rule outside its table', () => {
    for (const kind of ['Style', 'Readability', 'Redundancy', 'Repetition', 'Enhancement', 'Miscellaneous', 'Brand-new']) {
      expect(mapLints(APPLE, { SomeRule: [lint(0, 4, { kind })] }), kind).toEqual([]);
    }
  });

  it('keeps the rules in its table whatever kind Harper files them under, with the table’s kind and category', () => {
    const text = 'Its a apple and the the end, teh.';
    const issues = mapLints(text, {
      AnA: [lint(4, 5, { kind: 'Miscellaneous', suggestions: [[Replace, 'an']] })],
      RepeatedWords: [lint(16, 23, { kind: 'Repetition', suggestions: [[Replace, 'the']] })],
      ItsContraction: [lint(0, 3, { kind: 'Punctuation', suggestions: [[Replace, "It's"], [Replace, 'It has']] })],
      SpellCheck: [lint(29, 32, { kind: 'Style', suggestions: [[Replace, 'the']] })],
    });
    expect(issues.map((i) => [i.ruleId, i.original, i.kind, i.category, i.severity])).toEqual([
      ['harper:AnA', 'a', 'article', 'grammar', 'error'],
      ['harper:RepeatedWords', 'the the', 'article', 'grammar', 'error'],
      ['harper:ItsContraction', 'Its', 'its_vs_it_is', 'grammar', 'error'],
      ['harper:SpellCheck', 'teh', 'spelling', 'spelling', 'error'],
    ]);
    expect(issues[2]!.suggestionCount).toBe(2);
  });

  it('gives a doubled word the article kind, which no "Stop suggesting" rule hides', () => {
    const text = 'I saw the the cat.';
    const raw = mapLints(text, { RepeatedWords: [lint(6, 13, { kind: 'Repetition', suggestions: [[Replace, 'the']] })] });
    expect(kindInfo(raw[0]!.kind)?.ruleEligible).toBe(false);
    const paragraph = { id: 'p0', text, start: 0, hash: 'h' };
    for (const mode of ['essay', 'standard', 'casual'] as const) {
      const policy = { mode, families: defaultFamilies(mode), rules: new Set(['repeated_word']), dictionary: new Set<string>() };
      expect(selectIssues(paragraph, raw, policy), mode).toEqual([
        expect.objectContaining({ original: 'the the', replacement: 'the', kind: 'article', start: 6, end: 13 }),
      ]);
    }
  });

  it('falls back to the category’s own kind for any other rule', () => {
    const kindOf = (rule: string, lintKind: string) => mapLints(APPLE, { [rule]: [lint(0, 4, { kind: lintKind })] })[0]?.kind;
    expect(kindOf('The', 'Typo')).toBe('spelling');
    expect(kindOf('ModalOf', 'WordChoice')).toBe('word_choice');
    expect(kindOf('SentenceCapitalization', 'Grammar')).toBe('capitalization');
    expect(kindOf('UnitedOrganizations', 'Capitalization')).toBe('capitalization');
    expect(kindOf('WrongApostrophe', 'Punctuation')).toBe('apostrophe');
    expect(kindOf('PronounInflectionBe', 'Agreement')).toBe('word_choice');
  });

  it('takes `before` from up to five words ahead of the span, in the paragraph', () => {
    const text = 'One two  three four five six seven a apple.';
    const [issue] = mapLints(text, { AnA: [lint(text.indexOf(' a ') + 1, text.indexOf(' a ') + 2, { suggestions: [[Replace, 'an']] })] });
    expect(issue).toMatchObject({ original: 'a', at: 35, before: 'three four five six seven' });
  });

  it('frees every lint, span and suggestion it read', () => {
    const lints = [lint(8, 9), lint(0, 4, { kind: 'Style' }), lint(5, 7, { suggestions: [] })];
    mapLints(APPLE, { AnA: [lints[0]!], Other: [lints[1]!, lints[2]!] });
    for (const l of lints) expect(l.free).toHaveBeenCalledOnce();
    expect(lints[0]!.freedSuggestions()).toBe(1);
    expect(lints.map((l) => l.freedSpans())).toEqual([1, 0, 1]);
  });

  it('still frees every lint when one throws part-way, then rethrows', () => {
    const lints = [lint(8, 9), lint(0, 4, { throws: true }), lint(5, 7)];
    lints[0]!.free.mockImplementation(() => {
      throw new Error('already freed');
    });
    expect(() => mapLints(APPLE, { A: [lints[0]!], B: [lints[1]!], C: [lints[2]!] })).toThrow('span');
    for (const l of lints) expect(l.free).toHaveBeenCalledOnce();
  });
});

describe('mapLints over the harper.js binary', () => {
  let linter: LocalLinter;
  beforeAll(async () => {
    linter = new LocalLinter({ binary: slimBinary });
    await linter.setup();
  });
  const check = async (text: string) => mapLints(text, await linter.organizedLints(text, { language: 'plaintext', dedup: true }));

  it('gives "a apple" an AnA fix to "an" with one suggestion', async () => {
    expect(await check(APPLE)).toEqual([
      expect.objectContaining({ ruleId: 'harper:AnA', original: 'a', replacement: 'an', at: 8, kind: 'article', suggestionCount: 1 }),
    ]);
  });

  it('gives "the the" a RepeatedWords fix', async () => {
    expect(await check('I saw the the cat.')).toEqual([
      expect.objectContaining({ ruleId: 'harper:RepeatedWords', original: 'the the', replacement: 'the', at: 6, suggestionCount: 1 }),
    ]);
  });

  it('reads spans in UTF-16, as JavaScript strings do', async () => {
    expect(await check('😀 Café is a apple.')).toEqual([expect.objectContaining({ original: 'a', at: 11 })]);
  });

  it('flags correct doubled words too, which show neither before Claude answers nor after it answers clean', async () => {
    for (const text of ['I had had enough.', 'It was very very good.', 'He came in in a hurry.', 'What it is is a mess.']) {
      const harper = await check(text);
      expect(harper.map((i) => i.ruleId), text).toEqual(['harper:RepeatedWords']);
      expect(mergeParagraph(text, { harper }), text).toEqual([]);
      expect(mergeParagraph(text, { claude: [], harper }), text).toEqual([]);
    }
    const theThe = await check('I saw the the cat.');
    expect(mergeParagraph('I saw the the cat.', { harper: theThe })).toEqual(theThe);
    expect(mergeParagraph('I saw the the cat.', { claude: [], harper: theThe })).toEqual([]);
  });
});
