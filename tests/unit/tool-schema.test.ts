import { describe, expect, it } from 'vitest';
import {
  CRITIQUE_JSON_SCHEMA,
  FOLLOW_UP_JSON_SCHEMA,
  STYLE_PROFILE_JSON_SCHEMA,
  SYNONYMS_JSON_SCHEMA,
  VARIANTS_JSON_SCHEMA,
  VOICE_JSON_SCHEMA,
  WORD_LIMIT_JSON_SCHEMA,
  cleanCritique,
  cleanFollowUp,
  cleanStyleProfile,
  cleanSynonyms,
  cleanVariants,
  cleanVoice,
  cleanWordLimit,
  matchCase,
  MAX_WEAKNESS_CHARS,
} from '../../src/core/tool-schema';

describe('JSON schemas', () => {
  it('have no $schema and name the expected fields', () => {
    for (const s of [VARIANTS_JSON_SCHEMA, CRITIQUE_JSON_SCHEMA, SYNONYMS_JSON_SCHEMA, FOLLOW_UP_JSON_SCHEMA]) expect(s).not.toHaveProperty('$schema');
    expect(Object.keys((CRITIQUE_JSON_SCHEMA.properties as object))).toEqual(['weakness', 'light_fix']);
    expect(Object.keys((VARIANTS_JSON_SCHEMA.properties as object))).toEqual(['variants']);
    expect(Object.keys((SYNONYMS_JSON_SCHEMA.properties as object))).toEqual(['options']);
    expect(Object.keys((FOLLOW_UP_JSON_SCHEMA.properties as object))).toEqual(['message', 'variants']);
    expect(FOLLOW_UP_JSON_SCHEMA.required).toEqual(['message', 'variants']);
  });
});

describe('cleanFollowUp', () => {
  it('trims the message and each variant, and drops copies of the original, blanks and duplicates', () => {
    const data = { message: '  Try these.  ', variants: [' I own a cat. ', 'I has a cat.', 'I own a cat.', ' ', 'I keep a cat.\n'] };
    expect(cleanFollowUp(data, ' I has a cat. ', 'standard')).toEqual({ message: 'Try these.', variants: ['I own a cat.', 'I keep a cat.'] });
  });
  it('keeps at most 3 variants in Standard and Casual, and 1 in Essay', () => {
    const data = { message: 'm', variants: ['a', 'b', 'c', 'd'] };
    expect(cleanFollowUp(data, 'x', 'standard')?.variants).toEqual(['a', 'b', 'c']);
    expect(cleanFollowUp(data, 'x', 'casual')?.variants).toEqual(['a', 'b', 'c']);
    expect(cleanFollowUp(data, 'x', 'essay')?.variants).toEqual(['a']);
  });
  it('null variants, or none left, is an answer with no variants', () => {
    expect(cleanFollowUp({ message: 'It reads well.', variants: null }, 'x', 'standard')).toEqual({ message: 'It reads well.', variants: [] });
    expect(cleanFollowUp({ message: 'm', variants: ['x', ' '] }, 'x', 'essay')).toEqual({ message: 'm', variants: [] });
  });
  it('an empty or blank message is null', () => {
    expect(cleanFollowUp({ message: '', variants: ['a'] }, 'x', 'standard')).toBeNull();
    expect(cleanFollowUp({ message: ' \n ', variants: ['a'] }, 'x', 'standard')).toBeNull();
  });
  it('a wrong shape is null', () => {
    expect(cleanFollowUp({ message: 'm' }, 'x', 'standard')).toBeNull();
    expect(cleanFollowUp({ variants: ['a'] }, 'x', 'standard')).toBeNull();
  });
});

describe('cleanVariants', () => {
  it('keeps the first 3 of 4', () => expect(cleanVariants({ variants: ['a', 'b', 'c', 'd'] }, 'x')).toEqual(['a', 'b', 'c']));
  it('fails on 2', () => expect(cleanVariants({ variants: ['a', 'b'] }, 'x')).toBeNull());
  it('drops copies of the original and blanks', () => {
    expect(cleanVariants({ variants: [' x ', 'a', ' ', 'b', 'c'] }, 'x')).toEqual(['a', 'b', 'c']);
    expect(cleanVariants({ variants: ['x', 'a', 'b'] }, 'x')).toBeNull();
  });
  it('fails on a wrong shape', () => expect(cleanVariants({ nope: 1 }, 'x')).toBeNull());
  it('trims each kept variant, so an apply never doubles or eats a space', () => {
    expect(cleanVariants({ variants: [' I own a cat.', 'I keep a cat. ', '\nA cat is mine.\n'] }, 'I has a cat.')).toEqual([
      'I own a cat.',
      'I keep a cat.',
      'A cat is mine.',
    ]);
  });
});

describe('cleanCritique', () => {
  it('maps light_fix to lightFix', () => {
    expect(cleanCritique({ weakness: ' w ', light_fix: ' f ' })).toEqual({ weakness: 'w', lightFix: 'f' });
  });
  it('fails on blank parts', () => expect(cleanCritique({ weakness: '', light_fix: 'f' })).toBeNull());
  it('clamps a 300-character weakness to at most 140 characters at a word boundary, marked with "…"', () => {
    const words = 'The opening sentence repeats the same idea twice and buries the point under filler words'.split(' ');
    let long = '';
    for (let i = 0; long.length < 300; i++) long += (long ? ' ' : '') + words[i % words.length];
    long = long.slice(0, 300);
    const { weakness } = cleanCritique({ weakness: long, light_fix: 'f' })!;
    expect(weakness.length).toBeLessThanOrEqual(MAX_WEAKNESS_CHARS);
    expect(MAX_WEAKNESS_CHARS).toBe(140);
    expect(weakness.endsWith('…')).toBe(true);
    const kept = weakness.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' '); // cut where a word ended
    expect(kept.length).toBeGreaterThan(100); // not cut far short
  });
  it('keeps a weakness of 140 characters or fewer as it is', () => {
    const exact = `${'word '.repeat(27)}words`; // 140
    expect(exact).toHaveLength(140);
    expect(cleanCritique({ weakness: exact, light_fix: 'f' })!.weakness).toBe(exact);
  });
  it('cuts a weakness with no space in reach mid-word rather than not at all', () => {
    const { weakness } = cleanCritique({ weakness: 'x'.repeat(300), light_fix: 'f' })!;
    expect(weakness).toBe(`${'x'.repeat(139)}…`);
  });
});

describe('matchCase', () => {
  it('capitalizes after a capitalized target', () => expect(matchCase('Happy', 'glad')).toBe('Glad'));
  it('upper-cases after an ALL CAPS target', () => expect(matchCase('HAPPY', 'glad')).toBe('GLAD'));
  it('leaves a lowercase target alone', () => expect(matchCase('happy', 'glad')).toBe('glad'));
  it('treats a single capital letter as a capital, not ALL CAPS', () => expect(matchCase('A', 'one of the')).toBe('One of the'));
});

describe('cleanSynonyms', () => {
  const opts = (...t: string[]) => ({ options: t.map((text) => ({ text, nuance: 'n' })) });
  it('drops the target (any case), duplicates and blanks, and keeps at most 8', () => {
    const out = cleanSynonyms(opts('happy', 'Glad', 'glad', ' ', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'), 'Happy');
    expect(out?.map((o) => o.text)).toEqual(['Glad', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
  });
  it('is null when nothing is left', () => expect(cleanSynonyms(opts('happy'), 'happy')).toBeNull());
  it('gives ALL CAPS options for an ALL CAPS target', () => {
    expect(cleanSynonyms(opts('glad'), 'HAPPY')?.[0]?.text).toBe('GLAD');
  });
});

describe('style profile', () => {
  it('the schema asks for one profile string and has no $schema', () => {
    expect(STYLE_PROFILE_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(Object.keys(STYLE_PROFILE_JSON_SCHEMA.properties as object)).toEqual(['profile']);
    expect(STYLE_PROFILE_JSON_SCHEMA.required).toEqual(['profile']);
  });
  it('cleanStyleProfile trims, and cuts to 1,200 characters', () => {
    expect(cleanStyleProfile({ profile: '  Short sentences.  ' })).toBe('Short sentences.');
    expect(cleanStyleProfile({ profile: 'a'.repeat(1200) })).toBe('a'.repeat(1200));
    expect(cleanStyleProfile({ profile: 'a'.repeat(1500) })).toBe('a'.repeat(1200));
  });
  it('cleanStyleProfile gives null when the profile is empty, blank or the wrong shape', () => {
    expect(cleanStyleProfile({ profile: '' })).toBeNull();
    expect(cleanStyleProfile({ profile: ' \n ' })).toBeNull();
    expect(cleanStyleProfile({ profile: 3 })).toBeNull();
    expect(cleanStyleProfile(null)).toBeNull();
  });
});

describe('Sound like me', () => {
  it('the schema asks for the tells and the final version, and has no $schema', () => {
    expect(VOICE_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(Object.keys(VOICE_JSON_SCHEMA.properties as object)).toEqual(['tells', 'final']);
    expect(VOICE_JSON_SCHEMA.required).toEqual(['tells', 'final']);
  });
  it('cleanVoice trims the final version and each tell, and drops blank or repeated tells', () => {
    expect(cleanVoice({ tells: [' a staged contrast ', '', 'an inflated claim', 'a staged contrast', ' '], final: ' I own a cat. ' }, 'I has a cat.')).toEqual({
      tells: ['a staged contrast', 'an inflated claim'],
      final: 'I own a cat.',
    });
  });
  it('cleanVoice keeps at most 5 tells, each cut to 80 characters', () => {
    const out = cleanVoice({ tells: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], final: 'y' }, 'x');
    expect(out?.tells).toEqual(['a', 'b', 'c', 'd', 'e']);
    const long = cleanVoice({ tells: [`${'w'.repeat(79)} more words`], final: 'y' }, 'x');
    expect(long?.tells).toEqual(['w'.repeat(79)]);
    expect(cleanVoice({ tells: ['t'.repeat(80)], final: 'y' }, 'x')?.tells).toEqual(['t'.repeat(80)]);
  });
  it('no tells is still a result', () => {
    expect(cleanVoice({ tells: [], final: 'I own a cat.' }, 'I has a cat.')).toEqual({ tells: [], final: 'I own a cat.' });
  });
  it('an empty final version, or one equal to the original while it names tells, is null', () => {
    expect(cleanVoice({ tells: ['a staged contrast'], final: '' }, 'x')).toBeNull();
    expect(cleanVoice({ tells: [], final: ' \n ' }, 'x')).toBeNull();
    expect(cleanVoice({ tells: ['a staged contrast'], final: ' I has a cat. ' }, '\nI has a cat.')).toBeNull();
  });
  it('the original back with no tells is a result: it already sounds like the writer', () => {
    expect(cleanVoice({ tells: [], final: ' I has a cat. ' }, '\nI has a cat.')).toEqual({ tells: [], final: 'I has a cat.' });
    expect(cleanVoice({ tells: [' ', ''], final: 'I has a cat.' }, 'I has a cat.')).toEqual({ tells: [], final: 'I has a cat.' });
  });
  it('cleanVoice collapses whitespace inside a tell and drops repeats whatever their case', () => {
    expect(cleanVoice({ tells: [' a  staged\ncontrast ', 'A Staged Contrast', 'an\tinflated claim'], final: 'y' }, 'x')?.tells).toEqual([
      'a staged contrast',
      'an inflated claim',
    ]);
  });
  it('a wrong shape is null', () => {
    expect(cleanVoice({ final: 'y' }, 'x')).toBeNull();
    expect(cleanVoice({ tells: ['a'] }, 'x')).toBeNull();
    expect(cleanVoice({ tells: 'a', final: 'y' }, 'x')).toBeNull();
    expect(cleanVoice(null, 'x')).toBeNull();
  });
});

describe('cleanWordLimit', () => {
  const SEL = 'In order to win the final, we really practiced every single day after school in 2019.'; // 16 words
  const raw = (cuts: { original: string; replacement: string; why?: string }[], version = '') => ({ cuts: cuts.map((c) => ({ why: 'filler', ...c })), version });

  it('finds each cut in the selection by its offsets and counts its savings locally', () => {
    const out = cleanWordLimit(raw([{ original: 'In order to', replacement: 'To' }, { original: 'every single day', replacement: 'daily', why: '  says it  twice ' }]), SEL, 12)!;
    expect(out.cuts).toEqual([
      { start: 0, end: 11, original: 'In order to', replacement: 'To', why: 'filler', saves: 2, changesFacts: false },
      { start: 47, end: 63, original: 'every single day', replacement: 'daily', why: 'says it twice', saves: 2, changesFacts: false },
    ]);
  });
  it('drops a cut whose original is not in the selection, or only inside a word', () => {
    const out = cleanWordLimit(raw([{ original: 'In order for', replacement: 'For' }, { original: 'act', replacement: '' }, { original: 'really', replacement: '' }]), SEL, 12)!;
    expect(out.cuts.map((c) => c.original)).toEqual(['really']);
  });
  it('drops a cut that overlaps one kept before it, or one already shown', () => {
    const out = cleanWordLimit(raw([{ original: 'every single day', replacement: 'daily' }, { original: 'single day after', replacement: 'day after' }, { original: 'really', replacement: '' }]), SEL, 12, [{ start: 30, end: 36 }])!;
    expect(out.cuts.map((c) => c.original)).toEqual(['every single day']);
  });
  it('a repeated original takes its first unused occurrence', () => {
    const sel = 'It was very, very cold.';
    const out = cleanWordLimit(raw([{ original: 'very', replacement: '' }, { original: 'very', replacement: '' }, { original: 'very', replacement: '' }]), sel, 3)!;
    expect(out.cuts.map((c) => [c.start, c.end])).toEqual([[7, 11], [13, 17]]);
  });
  it('drops a cut that saves no word by the local count, whatever the model meant', () => {
    const out = cleanWordLimit(raw([{ original: 'win', replacement: 'take' }, { original: 'In order to', replacement: 'So as to' }, { original: 'final,', replacement: 'final' }]), SEL, 12)!;
    expect(out.cuts).toEqual([]);
  });
  it('flags a cut that changes a number, name, date or quote, by the strict rule', () => {
    const out = cleanWordLimit(raw([{ original: 'after school in 2019', replacement: 'after school' }, { original: 'really', replacement: '' }]), SEL, 12)!;
    expect(out.cuts.map((c) => [c.original, c.changesFacts])).toEqual([['after school in 2019', true], ['really', false]]);
  });
  it('keeps the version only at or under the target, by the local count', () => {
    const v12 = 'To win the final, we practiced daily after school in 2019.'; // 11 words
    expect(cleanWordLimit(raw([], v12), SEL, 12)!.version).toBe(v12);
    expect(cleanWordLimit(raw([], `  ${v12}  `), SEL, 11)!.version).toBe(v12);
    expect(cleanWordLimit(raw([], v12), SEL, 10)!.version).toBeNull();
    expect(cleanWordLimit(raw([], '   '), SEL, 12)!.version).toBeNull();
  });
  it('drops a version under 80% of the target: a summary, not a fit', () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
    expect(cleanWordLimit(raw([], words(8)), SEL, 10)!.version).toBe(words(8)); // exactly 80%
    expect(cleanWordLimit(raw([], words(7)), SEL, 10)!.version).toBeNull(); // just under
    expect(cleanWordLimit(raw([], words(10)), SEL, 12)!.version).toBe(words(10)); // 83%
    expect(cleanWordLimit(raw([], words(9)), SEL, 12)!.version).toBeNull(); // 75%: 9.6 is the floor
    expect(cleanWordLimit(raw([], 'To win, we practiced.'), SEL, 15)!.version).toBeNull(); // 4 words for 15
  });
  it('flags a version that changes a number, name, date or quote, with sentence openers free to change; none without a version', () => {
    const kept = 'To win the final, we practiced daily after school in 2019.'; // 11 words
    const dropped = 'To win the final, we practiced daily after school.'; // 9 words
    expect(cleanWordLimit(raw([], kept), SEL, 12)).toMatchObject({ version: kept, versionChangesFacts: false });
    expect(cleanWordLimit(raw([], dropped), SEL, 11)).toMatchObject({ version: dropped, versionChangesFacts: true });
    expect(cleanWordLimit(raw([], 'We trained daily after school in 2019. Then we won the final.'), SEL, 12)).toMatchObject({ versionChangesFacts: false }); // a new opener
    expect(cleanWordLimit(raw([{ original: 'really', replacement: '' }], dropped), SEL, 5)).toMatchObject({ version: null, versionChangesFacts: false });
  });
  it('keeps at most 12 cuts, and a why of at most 80 characters', () => {
    const sel = Array.from({ length: 20 }, (_, i) => `word${i} extra${i}`).join(' ');
    const out = cleanWordLimit(raw(Array.from({ length: 20 }, (_, i) => ({ original: `extra${i}`, replacement: '', why: 'x '.repeat(60) }))), sel, 20)!;
    expect(out.cuts).toHaveLength(12);
    expect(out.cuts.every((c) => c.why.length <= 80)).toBe(true);
  });
  it('an answer that does not match the schema is null', () => {
    expect(cleanWordLimit({ cuts: [{ original: 'a' }], version: '' }, SEL, 12)).toBeNull();
    expect(cleanWordLimit(null, SEL, 12)).toBeNull();
  });
  it('the schema names cuts (original, replacement, why) and version', () => {
    expect(WORD_LIMIT_JSON_SCHEMA).not.toHaveProperty('$schema');
    expect(Object.keys(WORD_LIMIT_JSON_SCHEMA.properties as object)).toEqual(['cuts', 'version']);
    const item = (WORD_LIMIT_JSON_SCHEMA.properties as any).cuts.items;
    expect(Object.keys(item.properties)).toEqual(['original', 'replacement', 'why']);
  });
});
