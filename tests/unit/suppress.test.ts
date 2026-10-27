import { describe, expect, it } from 'vitest';
import { selectIssues, type SuggestionPolicy } from '../../src/core/match';
import { defaultFamilies } from '../../src/core/modes';
import { isCasualSuppressedEdit, isSuppressedEdit } from '../../src/core/suppress';
import type { Mode, Paragraph, RawIssue } from '../../src/core/types';

const policy = (mode: Mode, familiesOn = true): SuggestionPolicy => ({
  mode,
  families: familiesOn ? defaultFamilies(mode) : { clarity: false, engagement: false, delivery: false, generic: false },
  rules: new Set(),
  dictionary: new Set(),
});

describe('isSuppressedEdit', () => {
  it('serial comma added is suppressed', () => {
    expect(isSuppressedEdit('cheese and', 'cheese, and')).toBe(true);
    expect(isSuppressedEdit('tea or', 'tea, or')).toBe(true);
    expect(isSuppressedEdit('pens and paper', 'pens, and paper')).toBe(true);
  });

  it('serial comma removed is suppressed', () => {
    expect(isSuppressedEdit('cheese, and', 'cheese and')).toBe(true);
    expect(isSuppressedEdit('tea, or coffee', 'tea or coffee')).toBe(true);
  });

  it('comma elsewhere is not suppressed', () => {
    expect(isSuppressedEdit('However we', 'However, we')).toBe(false);
    expect(isSuppressedEdit('cheese andrew', 'cheese, andrew')).toBe(false);
    expect(isSuppressedEdit('closed, we', 'closed, and we')).toBe(false);
    expect(isSuppressedEdit('cheese and', 'cheese; and')).toBe(false);
    expect(isSuppressedEdit('cheese and', null)).toBe(false);
  });

  it('who→whom suppressed', () => {
    expect(isSuppressedEdit('Who should I', 'Whom should I')).toBe(true);
    expect(isSuppressedEdit('who', 'whom')).toBe(true);
  });

  it('whom→who suppressed', () => {
    expect(isSuppressedEdit('Whom we', 'Who we')).toBe(true);
    expect(isSuppressedEdit('Whom', 'who')).toBe(true);
  });

  it("whose/who's not suppressed", () => {
    expect(isSuppressedEdit("who's car", 'whose car')).toBe(false);
    expect(isSuppressedEdit('whose', "who's")).toBe(false);
    expect(isSuppressedEdit('who', 'whose')).toBe(false);
    expect(isSuppressedEdit("who's", 'who')).toBe(false);
    expect(isSuppressedEdit('whom', 'Whom')).toBe(false);
    expect(isSuppressedEdit('Whom we choose', 'Who they choose')).toBe(false);
  });
});

describe('selectIssues with suppressed edits', () => {
  const issue = (o: Partial<RawIssue>): RawIssue => ({
    original: 'x',
    replacement: 'y',
    before: '',
    category: 'grammar',
    severity: 'error',
    kind: 'k',
    reason: 'r',
    ...o,
  });
  const paragraph: Paragraph = { id: 'p0', text: 'Whom we hired bought bread, cheese and olves.', start: 0, hash: 'h1' };

  it('selectIssues drops suppressed issues', () => {
    const out = selectIssues(
      paragraph,
      [
        issue({ original: 'Whom we', replacement: 'Who we', kind: 'pronoun_agreement' }),
        issue({ original: 'cheese and', replacement: 'cheese, and', category: 'punctuation', kind: 'missing_comma' }),
        issue({ original: 'cheese and', replacement: 'cheese, and', severity: 'suggestion', category: 'clarity', kind: 'missing_comma' }),
        issue({ original: 'olves', replacement: 'olives', category: 'spelling', kind: 'spelling' }),
      ],
      policy('standard'),
    );
    expect(out.map((i) => i.original)).toEqual(['olves']);
  });
});

describe('isCasualSuppressedEdit', () => {
  it("cant→can't suppressed in casual", () => {
    expect(isCasualSuppressedEdit('cant', "can't")).toBe(true);
    expect(isCasualSuppressedEdit('didnt', 'didn’t')).toBe(true);
    expect(isCasualSuppressedEdit('thats', "That's")).toBe(true);
  });

  it("were→we're NOT suppressed", () => {
    expect(isCasualSuppressedEdit('were', "we're")).toBe(false);
    expect(isCasualSuppressedEdit('were', "We're")).toBe(false);
    expect(isCasualSuppressedEdit('were gonna', "we're gonna")).toBe(false);
  });

  it("its→it's NOT suppressed", () => {
    expect(isCasualSuppressedEdit('its', "it's")).toBe(false);
    expect(isCasualSuppressedEdit('Its', 'It’s')).toBe(false);
    expect(isCasualSuppressedEdit('ill', "I'll")).toBe(false);
  });

  it('goin→going suppressed', () => {
    expect(isCasualSuppressedEdit('goin', 'going')).toBe(true);
    expect(isCasualSuppressedEdit("nothin'", 'nothing')).toBe(true);
    expect(isCasualSuppressedEdit('goin', 'gone')).toBe(false);
  });

  it('gonna→going to suppressed', () => {
    expect(isCasualSuppressedEdit('gonna', 'going to')).toBe(true);
    expect(isCasualSuppressedEdit(' Tonite ', 'tonight')).toBe(true);
    expect(isCasualSuppressedEdit('ur', "you're")).toBe(true);
    expect(isCasualSuppressedEdit('gonna go', 'going to go')).toBe(false);
  });

  it("there→they're NOT suppressed", () => {
    expect(isCasualSuppressedEdit('there', "they're")).toBe(false);
    expect(isCasualSuppressedEdit('your', "you're")).toBe(false);
    expect(isCasualSuppressedEdit('agian', 'again')).toBe(false);
    expect(isCasualSuppressedEdit('cant', null)).toBe(false);
  });

  it('essay mode does not apply the casual filter', () => {
    const p: Paragraph = { id: 'p0', text: 'cant wait, goin home', start: 0, hash: 'h1' };
    const raw: RawIssue[] = [
      { original: 'cant', replacement: "can't", before: '', category: 'punctuation', severity: 'error', kind: 'apostrophe', reason: 'r' },
      { original: 'goin', replacement: 'going', before: 'cant wait,', category: 'spelling', severity: 'error', kind: 'spelling', reason: 'r' },
    ];
    expect(selectIssues(p, raw, policy('essay', false))).toHaveLength(2);
    expect(selectIssues(p, raw, policy('standard', false))).toHaveLength(2);
    expect(selectIssues(p, raw, policy('casual', false))).toHaveLength(0);
  });
});
